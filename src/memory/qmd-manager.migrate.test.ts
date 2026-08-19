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

  it("avoids destructive rebind when qmd only reports collection names", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          sessions: { enabled: true },
        },
      },
    } as OpenClawConfig;

    const sessionCollectionName = `sessions-${agentId}`;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([`workspace-${agentId}`, sessionCollectionName]),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    const commands = spawnMock.mock.calls.map((call: unknown[]) => call[1] as string[]);
    const removeCalls = commands.filter((args) => args[0] === "collection" && args[1] === "remove");
    expect(removeCalls).toHaveLength(0);

    const addCalls = commands.filter((args) => args[0] === "collection" && args[1] === "add");
    expect(addCalls).toHaveLength(0);
  });

  it("migrates unscoped legacy collections before adding scoped names", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    const legacyCollections = new Map<
      string,
      {
        path: string;
        mask: string;
      }
    >([
      ["memory-root", { path: workspaceDir, mask: "MEMORY.md" }],
      ["memory-alt", { path: workspaceDir, mask: "memory.md" }],
      ["memory-dir", { path: path.join(workspaceDir, "memory"), mask: "**/*.md" }],
    ]);
    const removeCalls: string[] = [];

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify(
            [...legacyCollections.entries()].map(([name, info]) => ({
              name,
              path: info.path,
              mask: info.mask,
            })),
          ),
        );
        return child;
      }
      if (args[0] === "collection" && args[1] === "remove") {
        const child = createMockChild({ autoClose: false });
        const name = args[2] ?? "";
        removeCalls.push(name);
        legacyCollections.delete(name);
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        const pathArg = args[2] ?? "";
        const name = args[args.indexOf("--name") + 1] ?? "";
        const mask = args[args.indexOf("--mask") + 1] ?? "";
        const hasConflict = [...legacyCollections.entries()].some(
          ([existingName, info]) =>
            existingName !== name && info.path === pathArg && info.mask === mask,
        );
        if (hasConflict) {
          emitAndClose(child, "stderr", "collection already exists", 1);
          return child;
        }
        legacyCollections.set(name, { path: pathArg, mask });
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(removeCalls).toEqual(["memory-root", "memory-alt", "memory-dir"]);
    expect(legacyCollections.has("memory-root-main")).toBe(true);
    expect(legacyCollections.has("memory-alt-main")).toBe(true);
    expect(legacyCollections.has("memory-dir-main")).toBe(true);
    expect(legacyCollections.has("memory-root")).toBe(false);
    expect(legacyCollections.has("memory-alt")).toBe(false);
    expect(legacyCollections.has("memory-dir")).toBe(false);
  });

  it("rebinds conflicting collection name when path+pattern slot is already occupied", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    const listedCollections = new Map<
      string,
      {
        path: string;
        mask: string;
      }
    >([["memory-root-sonnet", { path: workspaceDir, mask: "MEMORY.md" }]]);
    const removeCalls: string[] = [];

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify(
            [...listedCollections.entries()].map(([name, info]) => ({
              name,
              path: info.path,
              mask: info.mask,
            })),
          ),
        );
        return child;
      }
      if (args[0] === "collection" && args[1] === "remove") {
        const child = createMockChild({ autoClose: false });
        const name = args[2] ?? "";
        removeCalls.push(name);
        listedCollections.delete(name);
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        const pathArg = args[2] ?? "";
        const name = args[args.indexOf("--name") + 1] ?? "";
        const mask = args[args.indexOf("--mask") + 1] ?? "";
        const hasConflict = [...listedCollections.entries()].some(
          ([existingName, info]) =>
            existingName !== name && info.path === pathArg && info.mask === mask,
        );
        if (hasConflict) {
          emitAndClose(child, "stderr", "A collection already exists for this path and pattern", 1);
          return child;
        }
        listedCollections.set(name, { path: pathArg, mask });
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(removeCalls).toContain("memory-root-sonnet");
    expect(listedCollections.has("memory-root-main")).toBe(true);
    expect(logWarnMock).toHaveBeenCalledWith(expect.stringContaining("rebinding"));
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
