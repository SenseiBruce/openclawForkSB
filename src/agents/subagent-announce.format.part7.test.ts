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

  it("falls back to latest tool output for completion-mode when assistant output is empty", async () => {
    chatHistoryMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "" }],
        },
        {
          role: "toolResult",
          content: [{ type: "text", text: "tool output only" }],
        },
      ],
    });
    readLatestAssistantReplyMock.mockResolvedValue("");

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-completion-tool-output",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      expectsCompletionMessage: true,
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(agentSpy).toHaveBeenCalledTimes(1);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message as string;
    expect(msg).toContain("tool output only");
  });

  it("ignores user text when deriving fallback completion output", async () => {
    chatHistoryMock.mockResolvedValueOnce({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "user prompt should not be announced" }],
        },
      ],
    });
    readLatestAssistantReplyMock.mockResolvedValue("");

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-completion-ignore-user",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      expectsCompletionMessage: true,
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(agentSpy).toHaveBeenCalledTimes(1);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message as string;
    expect(msg).toContain("(no output)");
    expect(msg).not.toContain("user prompt should not be announced");
  });

  it("queues announce delivery back into requester subagent session", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:subagent:orchestrator": {
        sessionId: "session-orchestrator",
        spawnDepth: 1,
        queueMode: "collect",
        queueDebounceMs: 0,
      },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-worker-queued",
      requesterSessionKey: "agent:main:subagent:orchestrator",
      requesterDisplayKey: "agent:main:subagent:orchestrator",
      requesterOrigin: { channel: "whatsapp", to: "+1555", accountId: "acct" },
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    expect(agentSpy).toHaveBeenCalledTimes(1);

    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.sessionKey).toBe("agent:main:subagent:orchestrator");
    expect(call?.params?.deliver).toBe(false);
    expect(call?.params?.channel).toBeUndefined();
    expect(call?.params?.to).toBeUndefined();
  });

  it.each([
    {
      testName: "includes threadId when origin has an active topic/thread",
      childRunId: "run-thread",
      expectedThreadId: "42",
      requesterOrigin: undefined,
    },
    {
      testName: "prefers requesterOrigin.threadId over session entry threadId",
      childRunId: "run-thread-override",
      expectedThreadId: "99",
      requesterOrigin: {
        channel: "telegram",
        to: "telegram:123",
        threadId: 99,
      },
    },
  ] as const)("thread routing: $testName", async (testCase) => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-thread",
        lastChannel: "telegram",
        lastTo: "telegram:123",
        lastThreadId: 42,
        queueMode: "collect",
        queueDebounceMs: 0,
      },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: testCase.childRunId,
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      ...(testCase.requesterOrigin ? { requesterOrigin: testCase.requesterOrigin } : {}),
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    const params = await getSingleAgentCallParams();
    expect(params.channel).toBe("telegram");
    expect(params.to).toBe("telegram:123");
    expect(params.threadId).toBe(testCase.expectedThreadId);
  });

  it("splits collect-mode queues when accountId differs", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-acc-split",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        queueMode: "collect",
        queueDebounceMs: 0,
      },
    };

    await Promise.all([
      runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:test-a",
        childRunId: "run-a",
        requesterSessionKey: "main",
        requesterDisplayKey: "main",
        requesterOrigin: { accountId: "acct-a" },
        ...defaultOutcomeAnnounce,
      }),
      runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:test-b",
        childRunId: "run-b",
        requesterSessionKey: "main",
        requesterDisplayKey: "main",
        requesterOrigin: { accountId: "acct-b" },
        ...defaultOutcomeAnnounce,
      }),
    ]);

    await vi.waitFor(() => {
      expect(agentSpy).toHaveBeenCalledTimes(2);
    });
    const accountIds = agentSpy.mock.calls.map(
      (call) => (call?.[0] as { params?: { accountId?: string } })?.params?.accountId,
    );
    expect(accountIds).toEqual(expect.arrayContaining(["acct-a", "acct-b"]));
  });

  it.each([
    {
      testName: "uses requester origin for direct announce when not queued",
      childRunId: "run-direct",
      requesterOrigin: { channel: "whatsapp", accountId: "acct-123" },
      expectedChannel: "whatsapp",
      expectedAccountId: "acct-123",
    },
    {
      testName: "normalizes requesterOrigin for direct announce delivery",
      childRunId: "run-direct-origin",
      requesterOrigin: { channel: " whatsapp ", accountId: " acct-987 " },
      expectedChannel: "whatsapp",
      expectedAccountId: "acct-987",
    },
  ] as const)("direct announce: $testName", async (testCase) => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: testCase.childRunId,
      requesterSessionKey: "agent:main:main",
      requesterOrigin: testCase.requesterOrigin,
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    const call = agentSpy.mock.calls[0]?.[0] as {
      params?: Record<string, unknown>;
      expectFinal?: boolean;
    };
    expect(call?.params?.channel).toBe(testCase.expectedChannel);
    expect(call?.params?.accountId).toBe(testCase.expectedAccountId);
    expect(call?.expectFinal).toBe(true);
  });
});
