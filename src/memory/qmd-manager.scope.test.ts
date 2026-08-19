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

  it("normalizes mixed Han-script BM25 queries before qmd search", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("記憶系統升級 QMD", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);

    const searchCall = spawnMock.mock.calls.find(
      (call: unknown[]) => (call[1] as string[])?.[0] === "search",
    );
    expect(searchCall?.[1]).toEqual([
      "search",
      "記憶 憶系 系統 統升 升級 qmd",
      "--json",
      "-n",
      String(maxResults),
      "-c",
      "workspace-main",
    ]);
    await manager.close();
  });

  it("falls back to the original query when Han normalization yields no BM25 tokens", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    await expect(manager.search("記", { sessionKey: "agent:main:slack:dm:u123" })).resolves.toEqual(
      [],
    );

    const searchCall = spawnMock.mock.calls.find(
      (call: unknown[]) => (call[1] as string[])?.[0] === "search",
    );
    expect(searchCall?.[1]?.[1]).toBe("記");
    await manager.close();
  });

  it("keeps original Han queries in qmd query mode", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    await expect(
      manager.search("記憶系統升級 QMD", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);

    const queryCall = spawnMock.mock.calls.find(
      (call: unknown[]) => (call[1] as string[])?.[0] === "query",
    );
    expect(queryCall?.[1]?.[1]).toBe("記憶系統升級 QMD");
    await manager.close();
  });

  it("retries search with qmd query when configured mode rejects flags", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stderr", "unknown flag: --json", 2);
        return child;
      }
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);

    const searchAndQueryCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1])
      .filter(
        (args): args is string[] => Array.isArray(args) && ["search", "query"].includes(args[0]),
      );
    expect(searchAndQueryCalls).toEqual([
      ["search", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
      ["query", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
    ]);
    await manager.close();
  });

  it("queues a forced sync behind an in-flight update", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: {
            interval: "0s",
            debounceMs: 0,
            onBoot: false,
            updateTimeoutMs: 1_000,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const firstUpdateSpawned = createDeferred<void>();
    let updateCalls = 0;
    let releaseFirstUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        if (updateCalls === 1) {
          const first = createMockChild({ autoClose: false });
          releaseFirstUpdate = () => first.closeWith(0);
          firstUpdateSpawned.resolve();
          return first;
        }
        return createMockChild();
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    const inFlight = manager.sync({ reason: "interval" });
    const forced = manager.sync({ reason: "manual", force: true });

    await firstUpdateSpawned.promise;
    expect(updateCalls).toBe(1);
    if (!releaseFirstUpdate) {
      throw new Error("first update release missing");
    }
    (releaseFirstUpdate as () => void)();

    await Promise.all([inFlight, forced]);
    expect(updateCalls).toBe(2);
    await manager.close();
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
