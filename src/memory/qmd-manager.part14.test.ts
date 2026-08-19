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

  describe("model cache symlink", () => {
    let defaultModelsDir: string;
    let customModelsDir: string;
    let savedXdgCacheHome: string | undefined;

    beforeEach(async () => {
      // Redirect XDG_CACHE_HOME so symlinkSharedModels finds our fake models
      // directory instead of the real ~/.cache.
      savedXdgCacheHome = process.env.XDG_CACHE_HOME;
      const fakeCacheHome = path.join(tmpRoot, "fake-cache");
      process.env.XDG_CACHE_HOME = fakeCacheHome;

      defaultModelsDir = path.join(fakeCacheHome, "qmd", "models");
      await fs.mkdir(defaultModelsDir, { recursive: true });
      await fs.writeFile(path.join(defaultModelsDir, "model.bin"), "fake-model");

      customModelsDir = path.join(stateDir, "agents", agentId, "qmd", "xdg-cache", "qmd", "models");
    });

    afterEach(() => {
      if (savedXdgCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = savedXdgCacheHome;
      }
    });

    it("handles first-run symlink, existing dir preservation, and missing default cache", async () => {
      const cases: Array<{
        name: string;
        setup?: () => Promise<void>;
        assert: () => Promise<void>;
      }> = [
        {
          name: "symlinks default cache on first run",
          assert: async () => {
            const stat = await fs.lstat(customModelsDir);
            expect(stat.isSymbolicLink()).toBe(true);
            const target = await fs.readlink(customModelsDir);
            expect(target).toBe(defaultModelsDir);
            const content = await fs.readFile(path.join(customModelsDir, "model.bin"), "utf-8");
            expect(content).toBe("fake-model");
          },
        },
        {
          name: "does not overwrite existing models directory",
          setup: async () => {
            await fs.mkdir(customModelsDir, { recursive: true });
            await fs.writeFile(path.join(customModelsDir, "custom-model.bin"), "custom");
          },
          assert: async () => {
            const stat = await fs.lstat(customModelsDir);
            expect(stat.isSymbolicLink()).toBe(false);
            expect(stat.isDirectory()).toBe(true);
            const content = await fs.readFile(
              path.join(customModelsDir, "custom-model.bin"),
              "utf-8",
            );
            expect(content).toBe("custom");
          },
        },
        {
          name: "skips symlink when default models are absent",
          setup: async () => {
            await fs.rm(defaultModelsDir, { recursive: true, force: true });
          },
          assert: async () => {
            await expect(fs.lstat(customModelsDir)).rejects.toThrow();
            expect(logWarnMock).not.toHaveBeenCalledWith(
              expect.stringContaining("failed to symlink qmd models directory"),
            );
          },
        },
      ];

      for (const testCase of cases) {
        await fs.rm(customModelsDir, { recursive: true, force: true });
        await fs.mkdir(defaultModelsDir, { recursive: true });
        await fs.writeFile(path.join(defaultModelsDir, "model.bin"), "fake-model");
        logWarnMock.mockClear();
        await testCase.setup?.();
        const { manager } = await createManager({ mode: "full" });
        expect(manager, testCase.name).toBeTruthy();
        try {
          await testCase.assert();
        } finally {
          await manager.close();
        }
      }
    });
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
