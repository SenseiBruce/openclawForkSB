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

  it("runs qmd searches via mcporter and warns when startDaemon=false", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();

    logWarnMock.mockClear();
    await expect(
      manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);

    const mcporterCalls = spawnMock.mock.calls.filter((call: unknown[]) =>
      isMcporterCommand(call[0]),
    );
    expect(mcporterCalls.length).toBeGreaterThan(0);
    expect(mcporterCalls.some((call: unknown[]) => (call[1] as string[])[0] === "daemon")).toBe(
      false,
    );
    expect(logWarnMock).toHaveBeenCalledWith(expect.stringContaining("cold-start"));

    await manager.close();
  });

  it("resolves mcporter to a direct Windows entrypoint without enabling shell mode", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const previousPath = process.env.PATH;
    try {
      const nodeModulesDir = path.join(tmpRoot, "node_modules");
      const shimDir = path.join(nodeModulesDir, ".bin");
      const packageDir = path.join(nodeModulesDir, "mcporter");
      const scriptPath = path.join(packageDir, "dist", "cli.js");
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.mkdir(shimDir, { recursive: true });
      await fs.writeFile(path.join(shimDir, "mcporter.cmd"), "@echo off\r\n", "utf8");
      await fs.writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: "mcporter", version: "0.0.0", bin: { mcporter: "dist/cli.js" } }),
        "utf8",
      );
      await fs.writeFile(scriptPath, "module.exports = {};\n", "utf8");
      process.env.PATH = `${shimDir};${previousPath ?? ""}`;

      cfg = {
        ...cfg,
        memory: {
          backend: "qmd",
          qmd: {
            includeDefaultMemory: false,
            update: { interval: "0s", debounceMs: 60_000, onBoot: false },
            paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
            mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
          },
        },
      } as OpenClawConfig;

      spawnMock.mockImplementation((_cmd: string, args: string[]) => {
        const child = createMockChild({ autoClose: false });
        if (args[0] === "call") {
          emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
          return child;
        }
        emitAndClose(child, "stdout", "[]");
        return child;
      });

      const { manager } = await createManager();
      await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });

      const mcporterCall = spawnMock.mock.calls.find((call: unknown[]) =>
        (call[1] as string[] | undefined)?.includes("call"),
      );
      expect(mcporterCall).toBeDefined();
      const callCommand = mcporterCall?.[0];
      expect(typeof callCommand).toBe("string");
      const options = mcporterCall?.[2] as { shell?: boolean } | undefined;
      expect(callCommand).not.toBe("mcporter.cmd");
      expect(options?.shell).not.toBe(true);

      await manager.close();
    } finally {
      platformSpy.mockRestore();
      process.env.PATH = previousPath;
    }
  });

  it("fails closed on Windows EINVAL cmd-shim failures instead of retrying through the shell", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const previousPath = process.env.PATH;
    try {
      const shimDir = await fs.mkdtemp(path.join(tmpRoot, "mcporter-shim-"));
      await fs.writeFile(path.join(shimDir, "mcporter.cmd"), "@echo off\n");
      process.env.PATH = `${shimDir};${previousPath ?? ""}`;

      cfg = {
        ...cfg,
        memory: {
          backend: "qmd",
          qmd: {
            includeDefaultMemory: false,
            update: { interval: "0s", debounceMs: 60_000, onBoot: false },
            paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
            mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
          },
        },
      } as OpenClawConfig;

      let firstCallCommand: string | null = null;
      spawnMock.mockImplementation((cmd: string, args: string[]) => {
        if (args[0] === "call" && firstCallCommand === null) {
          firstCallCommand = cmd;
        }
        if (args[0] === "call" && typeof cmd === "string" && cmd.toLowerCase().endsWith(".cmd")) {
          const child = createMockChild({ autoClose: false });
          queueMicrotask(() => {
            const err = Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" });
            child.emit("error", err);
          });
          return child;
        }
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      });

      const { manager } = await createManager();
      await expect(
        manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" }),
      ).rejects.toThrow(/without shell execution|EINVAL/);
      const attemptedCmdShim = (firstCallCommand ?? "").toLowerCase().endsWith(".cmd");
      if (attemptedCmdShim) {
        expect(
          spawnMock.mock.calls.some(
            (call: unknown[]) =>
              call[0] === "mcporter" &&
              (call[2] as { shell?: boolean } | undefined)?.shell === true,
          ),
        ).toBe(false);
      }
      await manager.close();
    } finally {
      platformSpy.mockRestore();
      process.env.PATH = previousPath;
    }
  });

  it("passes manager-scoped XDG env to mcporter commands", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });

    const mcporterCall = spawnMock.mock.calls.find(
      (call: unknown[]) => isMcporterCommand(call[0]) && (call[1] as string[])[0] === "call",
    );
    expect(mcporterCall).toBeDefined();
    const spawnOpts = mcporterCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    const normalizePath = (value?: string) => value?.replace(/\\/g, "/");
    expect(normalizePath(spawnOpts?.env?.XDG_CONFIG_HOME)).toContain("/agents/main/qmd/xdg-config");
    expect(normalizePath(spawnOpts?.env?.XDG_CACHE_HOME)).toContain("/agents/main/qmd/xdg-cache");

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
