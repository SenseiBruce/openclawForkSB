import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Mock } from "vitest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { logWarnMock, logDebugMock, logInfoMock } = vi.hoisted(() => ({
  logWarnMock: vi.fn(),
  logDebugMock: vi.fn(),
  logInfoMock: vi.fn(),
}));

type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: NodeJS.Signals) => void;
  closeWith: (code?: number | null) => void;
};

function createMockChild(params?: { autoClose?: boolean; closeDelayMs?: number }): MockChild {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as MockChild;
  child.stdout = stdout;
  child.stderr = stderr;
  child.closeWith = (code = 0) => {
    child.emit("close", code);
  };
  child.kill = () => {
    // Let timeout rejection win in tests that simulate hung QMD commands.
  };
  if (params?.autoClose !== false) {
    const delayMs = params?.closeDelayMs ?? 0;
    if (delayMs <= 0) {
      queueMicrotask(() => {
        child.emit("close", 0);
      });
    } else {
      setTimeout(() => {
        child.emit("close", 0);
      }, delayMs);
    }
  }
  return child;
}

function emitAndClose(
  child: MockChild,
  stream: "stdout" | "stderr",
  data: string,
  code: number = 0,
) {
  queueMicrotask(() => {
    child[stream].emit("data", data);
    child.closeWith(code);
  });
}

function isMcporterCommand(cmd: unknown): boolean {
  if (typeof cmd !== "string") {
    return false;
  }
  return /(^|[\\/])mcporter(?:\.cmd)?$/i.test(cmd);
}

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => {
    const logger = {
      warn: logWarnMock,
      debug: logDebugMock,
      info: logInfoMock,
      child: () => logger,
    };
    return logger;
  },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { spawn as mockedSpawn } from "node:child_process";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";
import { QmdMemoryManager } from "./qmd-manager.js";
import { requireNodeSqlite } from "./sqlite.js";

const spawnMock = mockedSpawn as unknown as Mock;
const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;
const originalWindowsPath = (process.env as NodeJS.ProcessEnv & { Path?: string }).Path;

describe("QmdMemoryManager", () => {
  let fixtureRoot: string;
  let fixtureCount = 0;
  let tmpRoot: string;
  let workspaceDir: string;
  let stateDir: string;
  let cfg: OpenClawConfig;
  const agentId = "main";

  async function createManager(params?: { mode?: "full" | "status"; cfg?: OpenClawConfig }) {
    const cfgToUse = params?.cfg ?? cfg;
    const resolved = resolveMemoryBackendConfig({ cfg: cfgToUse, agentId });
    const manager = await QmdMemoryManager.create({
      cfg: cfgToUse,
      agentId,
      resolved,
      mode: params?.mode ?? "status",
    });
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }
    return { manager, resolved };
  }

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qmd-manager-test-fixtures-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    spawnMock.mockClear();
    spawnMock.mockImplementation(() => createMockChild());
    logWarnMock.mockClear();
    logDebugMock.mockClear();
    logInfoMock.mockClear();
    tmpRoot = path.join(fixtureRoot, `case-${fixtureCount++}`);
    workspaceDir = path.join(tmpRoot, "workspace");
    stateDir = path.join(tmpRoot, "state");
    await fs.mkdir(tmpRoot);
    // Only workspace must exist for configured collection paths; state paths are
    // created lazily by manager code when needed.
    await fs.mkdir(workspaceDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    // Keep the default Windows path unresolved for most tests so spawn mocks can
    // match the logical package command. Tests that verify wrapper resolution
    // install explicit shim fixtures inline.
    cfg = {
      agents: {
        list: [{ id: agentId, default: true, workspace: workspaceDir }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.OPENCLAW_STATE_DIR;
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalPathExt === undefined) {
      delete process.env.PATHEXT;
    } else {
      process.env.PATHEXT = originalPathExt;
    }
    if (originalWindowsPath === undefined) {
      delete (process.env as NodeJS.ProcessEnv & { Path?: string }).Path;
    } else {
      (process.env as NodeJS.ProcessEnv & { Path?: string }).Path = originalWindowsPath;
    }
    delete (globalThis as Record<string, unknown>).__openclawMcporterDaemonStart;
    delete (globalThis as Record<string, unknown>).__openclawMcporterColdStartWarned;
  });

  it("debounces back-to-back sync calls", async () => {
    const { manager, resolved } = await createManager();

    const baselineCalls = spawnMock.mock.calls.length;

    await manager.sync({ reason: "manual" });
    expect(spawnMock.mock.calls.length).toBe(baselineCalls + 1);

    await manager.sync({ reason: "manual-again" });
    expect(spawnMock.mock.calls.length).toBe(baselineCalls + 1);

    (manager as unknown as { lastUpdateAt: number | null }).lastUpdateAt =
      Date.now() - (resolved.qmd?.update.debounceMs ?? 0) - 10;

    await manager.sync({ reason: "after-wait" });
    // `search` mode does not require qmd embed side effects.
    expect(spawnMock.mock.calls.length).toBe(baselineCalls + 2);

    await manager.close();
  });

  it("runs boot update in background by default", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: true },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    let releaseUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        releaseUpdate = () => child.closeWith(0);
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    expect(releaseUpdate).not.toBeNull();
    (releaseUpdate as (() => void) | null)?.();
    await manager?.close();
  });

  it("skips qmd command side effects in status mode initialization", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "5m", debounceMs: 60_000, onBoot: true },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "status" });
    expect(spawnMock).not.toHaveBeenCalled();
    await manager?.close();
  });

  it("can be configured to block startup on boot update", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: {
            interval: "0s",
            debounceMs: 60_000,
            onBoot: true,
            waitForBootSync: true,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const updateSpawned = createDeferred<void>();
    let releaseUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        releaseUpdate = () => child.closeWith(0);
        updateSpawned.resolve();
        return child;
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const createPromise = QmdMemoryManager.create({ cfg, agentId, resolved, mode: "full" });
    await updateSpawned.promise;
    let created = false;
    void createPromise.then(() => {
      created = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(created).toBe(false);
    (releaseUpdate as (() => void) | null)?.();
    const manager = await createPromise;
    await manager?.close();
  });

  it("times out collection bootstrap commands", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: {
            interval: "0s",
            debounceMs: 60_000,
            onBoot: false,
            commandTimeoutMs: 15,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        return createMockChild({ autoClose: false });
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager?.close();
  });

  it("rebinds sessions collection when existing collection path targets another agent", async () => {
    const devAgentId = "dev";
    const devWorkspaceDir = path.join(tmpRoot, "workspace-dev");
    await fs.mkdir(devWorkspaceDir);
    cfg = {
      ...cfg,
      agents: {
        list: [
          { id: agentId, default: true, workspace: workspaceDir },
          { id: devAgentId, workspace: devWorkspaceDir },
        ],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: devWorkspaceDir, pattern: "**/*.md", name: "workspace" }],
          sessions: { enabled: true },
        },
      },
    } as OpenClawConfig;

    const sessionCollectionName = `sessions-${devAgentId}`;
    const wrongSessionsPath = path.join(stateDir, "agents", agentId, "qmd", "sessions");
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            { name: sessionCollectionName, path: wrongSessionsPath, mask: "**/*.md" },
          ]),
        );
        return child;
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfig({ cfg, agentId: devAgentId });
    const manager = await QmdMemoryManager.create({
      cfg,
      agentId: devAgentId,
      resolved,
      mode: "full",
    });
    expect(manager).toBeTruthy();
    await manager?.close();

    const commands = spawnMock.mock.calls.map((call: unknown[]) => call[1] as string[]);
    const removeSessions = commands.find(
      (args) =>
        args[0] === "collection" && args[1] === "remove" && args[2] === sessionCollectionName,
    );
    expect(removeSessions).toBeDefined();

    const addSessions = commands.find((args) => {
      if (args[0] !== "collection" || args[1] !== "add") {
        return false;
      }
      const nameIdx = args.indexOf("--name");
      return nameIdx >= 0 && args[nameIdx + 1] === sessionCollectionName;
    });
    expect(addSessions).toBeDefined();
    expect(addSessions?.[2]).toBe(path.join(stateDir, "agents", devAgentId, "qmd", "sessions"));
  });
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
