import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import {
  __testing as sessionBindingServiceTesting,
  registerSessionBindingAdapter,
} from "../infra/outbound/session-binding-service.js";

type AgentCallRequest = { method?: string; params?: Record<string, unknown> };
type RequesterResolution = {
  requesterSessionKey: string;
  requesterOrigin?: Record<string, unknown>;
} | null;
type SubagentDeliveryTargetResult = {
  origin?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
};
type MockSubagentRun = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterDisplayKey: string;
  task: string;
  cleanup: "keep" | "delete";
  createdAt: number;
  endedAt?: number;
  cleanupCompletedAt?: number;
  label?: string;
  frozenResultText?: string | null;
  outcome?: {
    status: "ok" | "timeout" | "error" | "unknown";
    error?: string;
  };
};

const agentSpy = vi.fn(async (_req: AgentCallRequest) => ({ runId: "run-main", status: "ok" }));
const sendSpy = vi.fn(async (_req: AgentCallRequest) => ({ runId: "send-main", status: "ok" }));
const sessionsDeleteSpy = vi.fn((_req: AgentCallRequest) => undefined);
const readLatestAssistantReplyMock = vi.fn(
  async (_sessionKey?: string): Promise<string | undefined> => "raw subagent reply",
);
const embeddedRunMock = {
  isEmbeddedPiRunActive: vi.fn(() => false),
  isEmbeddedPiRunStreaming: vi.fn(() => false),
  queueEmbeddedPiMessage: vi.fn(() => false),
  waitForEmbeddedPiRunEnd: vi.fn(async () => true),
};
const subagentRegistryMock = {
  isSubagentSessionRunActive: vi.fn(() => true),
  shouldIgnorePostCompletionAnnounceForSession: vi.fn((_sessionKey: string) => false),
  countActiveDescendantRuns: vi.fn((_sessionKey: string) => 0),
  countPendingDescendantRuns: vi.fn((_sessionKey: string) => 0),
  countPendingDescendantRunsExcludingRun: vi.fn((_sessionKey: string, _runId: string) => 0),
  listSubagentRunsForRequester: vi.fn(
    (_sessionKey: string, _scope?: { requesterRunId?: string }): MockSubagentRun[] => [],
  ),
  replaceSubagentRunAfterSteer: vi.fn(
    (_params: { previousRunId: string; nextRunId: string }) => true,
  ),
  resolveRequesterForChildSession: vi.fn((_sessionKey: string): RequesterResolution => null),
};
const subagentDeliveryTargetHookMock = vi.fn(
  async (_event?: unknown, _ctx?: unknown): Promise<SubagentDeliveryTargetResult | undefined> =>
    undefined,
);
let hasSubagentDeliveryTargetHook = false;
const hookRunnerMock = {
  hasHooks: vi.fn(
    (hookName: string) => hookName === "subagent_delivery_target" && hasSubagentDeliveryTargetHook,
  ),
  runSubagentDeliveryTarget: vi.fn((event: unknown, ctx: unknown) =>
    subagentDeliveryTargetHookMock(event, ctx),
  ),
};
const chatHistoryMock = vi.fn(async (_sessionKey?: string) => ({
  messages: [] as Array<unknown>,
}));
let sessionStore: Record<string, Record<string, unknown>> = {};
let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};
const defaultOutcomeAnnounce = {
  task: "do thing",
  timeoutMs: 10,
  cleanup: "keep" as const,
  waitForCompletion: false,
  startedAt: 10,
  endedAt: 20,
  outcome: { status: "ok" } as const,
};

async function getSingleAgentCallParams() {
  expect(agentSpy).toHaveBeenCalledTimes(1);
  const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
  return call?.params ?? {};
}

function loadSessionStoreFixture(): Record<string, Record<string, unknown>> {
  return new Proxy(sessionStore, {
    get(target, key: string | symbol) {
      if (typeof key === "string" && !(key in target) && key.includes(":subagent:")) {
        return { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      }
      return target[key as keyof typeof target];
    },
  });
}

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (req: unknown) => {
    const typed = req as { method?: string; params?: { message?: string; sessionKey?: string } };
    if (typed.method === "agent") {
      return await agentSpy(typed);
    }
    if (typed.method === "send") {
      return await sendSpy(typed);
    }
    if (typed.method === "agent.wait") {
      return { status: "error", startedAt: 10, endedAt: 20, error: "boom" };
    }
    if (typed.method === "chat.history") {
      return await chatHistoryMock(typed.params?.sessionKey);
    }
    if (typed.method === "sessions.patch") {
      return {};
    }
    if (typed.method === "sessions.delete") {
      sessionsDeleteSpy(typed);
      return {};
    }
    return {};
  }),
}));

vi.mock("./tools/agent-step.js", () => ({
  readLatestAssistantReply: readLatestAssistantReplyMock,
}));

vi.mock("../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions.js")>();
  return {
    ...actual,
    loadSessionStore: vi.fn(() => loadSessionStoreFixture()),
    resolveAgentIdFromSessionKey: () => "main",
    resolveStorePath: () => "/tmp/sessions.json",
    resolveMainSessionKey: () => "agent:main:main",
    readSessionUpdatedAt: vi.fn(() => undefined),
    recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("./pi-embedded.js", () => embeddedRunMock);

vi.mock("./subagent-registry.js", () => subagentRegistryMock);
vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookRunnerMock,
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
  };
});

describe("subagent announce formatting", () => {
  let previousFastTestEnv: string | undefined;
  let runSubagentAnnounceFlow: (typeof import("./subagent-announce.js"))["runSubagentAnnounceFlow"];

  beforeAll(async () => {
    // Set FAST_TEST_MODE before importing the module to ensure the module-level
    // constant picks it up. This fixes flaky Windows CI failures where the test
    // timeout budget is too tight without fast mode enabled.
    // See: https://github.com/openclaw/openclaw/issues/31298
    previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_TEST_FAST = "1";
    ({ runSubagentAnnounceFlow } = await import("./subagent-announce.js"));
  });

  afterAll(() => {
    if (previousFastTestEnv === undefined) {
      delete process.env.OPENCLAW_TEST_FAST;
      return;
    }
    process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
  });

  beforeEach(() => {
    // OPENCLAW_TEST_FAST is set in beforeAll before module import
    // to ensure the module-level constant picks it up.
    agentSpy
      .mockClear()
      .mockImplementation(async (_req: AgentCallRequest) => ({ runId: "run-main", status: "ok" }));
    sendSpy
      .mockClear()
      .mockImplementation(async (_req: AgentCallRequest) => ({ runId: "send-main", status: "ok" }));
    sessionsDeleteSpy.mockClear().mockImplementation((_req: AgentCallRequest) => undefined);
    embeddedRunMock.isEmbeddedPiRunActive.mockClear().mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockClear().mockReturnValue(false);
    embeddedRunMock.queueEmbeddedPiMessage.mockClear().mockReturnValue(false);
    embeddedRunMock.waitForEmbeddedPiRunEnd.mockClear().mockResolvedValue(true);
    subagentRegistryMock.isSubagentSessionRunActive.mockClear().mockReturnValue(true);
    subagentRegistryMock.shouldIgnorePostCompletionAnnounceForSession
      .mockClear()
      .mockReturnValue(false);
    subagentRegistryMock.countActiveDescendantRuns.mockClear().mockReturnValue(0);
    subagentRegistryMock.countPendingDescendantRuns
      .mockClear()
      .mockImplementation((sessionKey: string) =>
        subagentRegistryMock.countActiveDescendantRuns(sessionKey),
      );
    subagentRegistryMock.countPendingDescendantRunsExcludingRun
      .mockClear()
      .mockImplementation((sessionKey: string, _runId: string) =>
        subagentRegistryMock.countPendingDescendantRuns(sessionKey),
      );
    subagentRegistryMock.listSubagentRunsForRequester.mockClear().mockReturnValue([]);
    subagentRegistryMock.replaceSubagentRunAfterSteer.mockClear().mockReturnValue(true);
    subagentRegistryMock.resolveRequesterForChildSession.mockClear().mockReturnValue(null);
    hasSubagentDeliveryTargetHook = false;
    hookRunnerMock.hasHooks.mockClear();
    hookRunnerMock.runSubagentDeliveryTarget.mockClear();
    subagentDeliveryTargetHookMock.mockReset().mockResolvedValue(undefined);
    readLatestAssistantReplyMock.mockClear().mockResolvedValue("raw subagent reply");
    chatHistoryMock.mockReset().mockResolvedValue({ messages: [] });
    sessionStore = {};
    sessionBindingServiceTesting.resetSessionBindingAdaptersForTests();
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
  });

  it("keeps announce retryable when missing requester subagent session has no fallback requester", async () => {
    subagentRegistryMock.isSubagentSessionRunActive.mockReturnValue(false);
    subagentRegistryMock.resolveRequesterForChildSession.mockReturnValue(null);
    sessionStore = {
      "agent:main:subagent:orchestrator": undefined as unknown as Record<string, unknown>,
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:leaf",
      childRunId: "run-leaf-missing-fallback",
      requesterSessionKey: "agent:main:subagent:orchestrator",
      requesterDisplayKey: "agent:main:subagent:orchestrator",
      ...defaultOutcomeAnnounce,
      cleanup: "delete",
    });

    expect(didAnnounce).toBe(false);
    expect(subagentRegistryMock.resolveRequesterForChildSession).toHaveBeenCalledWith(
      "agent:main:subagent:orchestrator",
    );
    expect(agentSpy).not.toHaveBeenCalled();
    expect(sessionsDeleteSpy).not.toHaveBeenCalled();
  });

  it("defers announce when child run stays active after settle timeout", async () => {
    const cases = [
      {
        childRunId: "run-child-active",
        task: "context-stress-test",
        expectsCompletionMessage: false,
      },
      {
        childRunId: "run-child-active-completion",
        task: "completion-context-stress-test",
        expectsCompletionMessage: true,
      },
    ] as const;

    for (const testCase of cases) {
      agentSpy.mockClear();
      sendSpy.mockClear();
      embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
      embeddedRunMock.waitForEmbeddedPiRunEnd.mockResolvedValue(false);
      sessionStore = {
        "agent:main:subagent:test": {
          sessionId: "child-session-active",
        },
      };

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:test",
        childRunId: testCase.childRunId,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        ...defaultOutcomeAnnounce,
        task: testCase.task,
        ...(testCase.expectsCompletionMessage ? { expectsCompletionMessage: true } : {}),
      });

      expect(didAnnounce).toBe(false);
      expect(agentSpy).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
    }
  });

  it("prefers requesterOrigin channel over stale session lastChannel in queued announce", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    // Session store has stale whatsapp channel, but the requesterOrigin says bluebubbles.
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-stale",
        lastChannel: "whatsapp",
        queueMode: "collect",
        queueDebounceMs: 0,
      },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-stale-channel",
      requesterSessionKey: "main",
      requesterOrigin: { channel: "telegram", to: "telegram:123" },
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    expect(agentSpy).toHaveBeenCalledTimes(1);

    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    // The channel should match requesterOrigin, NOT the stale session entry.
    expect(call?.params?.channel).toBe("telegram");
    expect(call?.params?.to).toBe("telegram:123");
  });

  it("routes or falls back for ended parent subagent sessions (#18037)", async () => {
    const cases = [
      {
        name: "routes to parent when parent session still exists",
        childSessionKey: "agent:main:subagent:newton:subagent:birdie",
        childRunId: "run-birdie",
        requesterSessionKey: "agent:main:subagent:newton",
        requesterDisplayKey: "subagent:newton",
        sessionStoreFixture: {
          "agent:main:subagent:newton": {
            sessionId: "newton-session-id-alive",
            inputTokens: 100,
            outputTokens: 50,
          },
          "agent:main:subagent:newton:subagent:birdie": {
            sessionId: "birdie-session-id",
            inputTokens: 20,
            outputTokens: 10,
          },
        },
        expectedSessionKey: "agent:main:subagent:newton",
        expectedDeliver: false,
        expectedChannel: undefined,
      },
      {
        name: "falls back when parent session is deleted",
        childSessionKey: "agent:main:subagent:birdie",
        childRunId: "run-birdie-orphan",
        requesterSessionKey: "agent:main:subagent:newton",
        requesterDisplayKey: "subagent:newton",
        sessionStoreFixture: {
          "agent:main:subagent:newton": undefined as unknown as Record<string, unknown>,
          "agent:main:subagent:birdie": {
            sessionId: "birdie-session-id",
            inputTokens: 20,
            outputTokens: 10,
          },
        },
        expectedSessionKey: "agent:main:main",
        expectedDeliver: true,
        expectedChannel: "discord",
      },
      {
        name: "falls back when parent sessionId is blank",
        childSessionKey: "agent:main:subagent:newton:subagent:birdie",
        childRunId: "run-birdie-empty-parent",
        requesterSessionKey: "agent:main:subagent:newton",
        requesterDisplayKey: "subagent:newton",
        sessionStoreFixture: {
          "agent:main:subagent:newton": {
            sessionId: " ",
            inputTokens: 100,
            outputTokens: 50,
          },
          "agent:main:subagent:newton:subagent:birdie": {
            sessionId: "birdie-session-id",
            inputTokens: 20,
            outputTokens: 10,
          },
        },
        expectedSessionKey: "agent:main:main",
        expectedDeliver: true,
        expectedChannel: "discord",
      },
    ] as const;

    for (const testCase of cases) {
      agentSpy.mockClear();
      embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
      embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
      subagentRegistryMock.isSubagentSessionRunActive.mockReturnValue(false);
      sessionStore = testCase.sessionStoreFixture as Record<string, Record<string, unknown>>;
      subagentRegistryMock.resolveRequesterForChildSession.mockReturnValue({
        requesterSessionKey: "agent:main:main",
        requesterOrigin: { channel: "discord", accountId: "jaris-account" },
      });

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: testCase.childSessionKey,
        childRunId: testCase.childRunId,
        requesterSessionKey: testCase.requesterSessionKey,
        requesterDisplayKey: testCase.requesterDisplayKey,
        ...defaultOutcomeAnnounce,
        task: "QA task",
      });

      expect(didAnnounce, testCase.name).toBe(true);
      const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
      expect(call?.params?.sessionKey, testCase.name).toBe(testCase.expectedSessionKey);
      expect(call?.params?.deliver, testCase.name).toBe(testCase.expectedDeliver);
      expect(call?.params?.channel, testCase.name).toBe(testCase.expectedChannel);
    }
  });
});
