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

  it("uses configured qmd search mode command", async () => {
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
      manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);

    const searchCall = spawnMock.mock.calls.find(
      (call: unknown[]) => (call[1] as string[])?.[0] === "search",
    );
    expect(searchCall?.[1]).toEqual([
      "search",
      "test",
      "--json",
      "-n",
      String(resolved.qmd?.limits.maxResults),
      "-c",
      "workspace-main",
    ]);
    expect(
      spawnMock.mock.calls.some((call: unknown[]) => (call[1] as string[])?.[0] === "query"),
    ).toBe(false);
    expect(maxResults).toBeGreaterThan(0);
    await manager.close();
  });

  it("repairs missing managed collections and retries search once", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    const expectedDocId = "abc123";
    let missingCollectionSeen = false;
    let addCallsAfterMissing = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        if (missingCollectionSeen) {
          addCallsAfterMissing += 1;
        }
        return createMockChild();
      }
      if (args[0] === "search") {
        const collectionFlagIndex = args.indexOf("-c");
        const collection = collectionFlagIndex >= 0 ? args[collectionFlagIndex + 1] : "";
        if (collection === "memory-root-main" && !missingCollectionSeen) {
          missingCollectionSeen = true;
          const child = createMockChild({ autoClose: false });
          emitAndClose(child, "stderr", "Collection not found: memory-root-main", 1);
          return child;
        }
        if (collection === "memory-root-main") {
          const child = createMockChild({ autoClose: false });
          emitAndClose(
            child,
            "stdout",
            JSON.stringify([{ docid: expectedDocId, score: 1, snippet: "@@ -1,1\nremember this" }]),
          );
          return child;
        }
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    const inner = manager as unknown as {
      db: { prepare: (query: string) => { all: (arg: unknown) => unknown }; close: () => void };
    };
    inner.db = {
      prepare: (_query: string) => ({
        all: (arg: unknown) => {
          if (typeof arg === "string" && arg.startsWith(expectedDocId)) {
            return [{ collection: "memory-root-main", path: "MEMORY.md" }];
          }
          return [];
        },
      }),
      close: () => {},
    };

    await expect(
      manager.search("remember", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([
      {
        path: "MEMORY.md",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "@@ -1,1\nremember this",
        source: "memory",
      },
    ]);
    expect(addCallsAfterMissing).toBeGreaterThan(0);
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("repairing collections and retrying once"),
    );

    await manager.close();
  });

  it("resolves bare qmd command to a Windows-compatible spawn invocation", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const previousPath = process.env.PATH;
    try {
      const nodeModulesDir = path.join(tmpRoot, "node_modules");
      const shimDir = path.join(nodeModulesDir, ".bin");
      const packageDir = path.join(nodeModulesDir, "qmd");
      const scriptPath = path.join(packageDir, "dist", "cli.js");
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.mkdir(shimDir, { recursive: true });
      await fs.writeFile(path.join(shimDir, "qmd.cmd"), "@echo off\r\n", "utf8");
      await fs.writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: "qmd", version: "0.0.0", bin: { qmd: "dist/cli.js" } }),
        "utf8",
      );
      await fs.writeFile(scriptPath, "module.exports = {};\n", "utf8");
      process.env.PATH = `${shimDir};${previousPath ?? ""}`;

      const { manager } = await createManager({ mode: "status" });
      await manager.sync({ reason: "manual" });

      const qmdCalls = spawnMock.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[] | undefined;
        return (
          Array.isArray(args) &&
          args.some((token) => token === "update" || token === "search" || token === "query")
        );
      });
      expect(qmdCalls.length).toBeGreaterThan(0);
      for (const call of qmdCalls) {
        const command = String(call[0]);
        const options = call[2] as { shell?: boolean } | undefined;
        expect(command).not.toMatch(/(^|[\\/])qmd\.cmd$/i);
        expect(options?.shell).not.toBe(true);
      }

      await manager.close();
    } finally {
      platformSpy.mockRestore();
      process.env.PATH = previousPath;
    }
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
