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

  it("keeps session-mode completion delivery on the bound destination when sibling runs are active", async () => {
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-bound",
      },
      "agent:main:main": {
        sessionId: "requester-session-bound",
      },
    };
    chatHistoryMock.mockResolvedValueOnce({
      messages: [{ role: "assistant", content: [{ type: "text", text: "bound answer: 2" }] }],
    });
    subagentRegistryMock.countActiveDescendantRuns.mockImplementation((sessionKey: string) =>
      sessionKey === "agent:main:main" ? 1 : 0,
    );
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "acct-1",
      listBySession: (targetSessionKey: string) =>
        targetSessionKey === "agent:main:subagent:test"
          ? [
              {
                bindingId: "discord:acct-1:thread-bound-1",
                targetSessionKey,
                targetKind: "subagent",
                conversation: {
                  channel: "discord",
                  accountId: "acct-1",
                  conversationId: "thread-bound-1",
                  parentConversationId: "parent-main",
                },
                status: "active",
                boundAt: Date.now(),
              },
            ]
          : [],
      resolveByConversation: () => null,
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-session-bound-direct",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      spawnMode: "session",
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(agentSpy).toHaveBeenCalledTimes(1);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.channel).toBe("discord");
    expect(call?.params?.to).toBe("channel:thread-bound-1");
  });

  it("does not duplicate to main channel when two active bound sessions complete from the same requester channel", async () => {
    sessionStore = {
      "agent:main:subagent:child-a": {
        sessionId: "child-session-a",
      },
      "agent:main:subagent:child-b": {
        sessionId: "child-session-b",
      },
      "agent:main:main": {
        sessionId: "requester-session-main",
      },
    };

    // Simulate active sibling runs so non-bound paths would normally coordinate via agent().
    subagentRegistryMock.countActiveDescendantRuns.mockImplementation((sessionKey: string) =>
      sessionKey === "agent:main:main" ? 2 : 0,
    );
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "acct-1",
      listBySession: (targetSessionKey: string) => {
        if (targetSessionKey === "agent:main:subagent:child-a") {
          return [
            {
              bindingId: "discord:acct-1:thread-child-a",
              targetSessionKey,
              targetKind: "subagent",
              conversation: {
                channel: "discord",
                accountId: "acct-1",
                conversationId: "thread-child-a",
                parentConversationId: "main-parent-channel",
              },
              status: "active",
              boundAt: Date.now(),
            },
          ];
        }
        if (targetSessionKey === "agent:main:subagent:child-b") {
          return [
            {
              bindingId: "discord:acct-1:thread-child-b",
              targetSessionKey,
              targetKind: "subagent",
              conversation: {
                channel: "discord",
                accountId: "acct-1",
                conversationId: "thread-child-b",
                parentConversationId: "main-parent-channel",
              },
              status: "active",
              boundAt: Date.now(),
            },
          ];
        }
        return [];
      },
      resolveByConversation: () => null,
    });

    await Promise.all([
      runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:child-a",
        childRunId: "run-child-a",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        requesterOrigin: {
          channel: "discord",
          to: "channel:main-parent-channel",
          accountId: "acct-1",
        },
        ...defaultOutcomeAnnounce,
        expectsCompletionMessage: true,
        spawnMode: "session",
      }),
      runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:child-b",
        childRunId: "run-child-b",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        requesterOrigin: {
          channel: "discord",
          to: "channel:main-parent-channel",
          accountId: "acct-1",
        },
        ...defaultOutcomeAnnounce,
        expectsCompletionMessage: true,
        spawnMode: "session",
      }),
    ]);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(agentSpy).toHaveBeenCalledTimes(2);

    const directTargets = agentSpy.mock.calls.map(
      (call) => (call?.[0] as { params?: { to?: string } })?.params?.to,
    );
    expect(directTargets).toEqual(
      expect.arrayContaining(["channel:thread-child-a", "channel:thread-child-b"]),
    );
    expect(directTargets).not.toContain("channel:main-parent-channel");
  });

  it("includes completion status details for error and timeout outcomes", async () => {
    const cases = [
      {
        childSessionId: "child-session-direct-error",
        requesterSessionId: "requester-session-error",
        childRunId: "run-direct-completion-error",
        replyText: "boom details",
        outcome: { status: "error", error: "boom" } as const,
        expectedStatus: "failed: boom",
        spawnMode: "session" as const,
      },
      {
        childSessionId: "child-session-direct-timeout",
        requesterSessionId: "requester-session-timeout",
        childRunId: "run-direct-completion-timeout",
        replyText: "partial output",
        outcome: { status: "timeout" } as const,
        expectedStatus: "timed out",
        spawnMode: undefined,
      },
    ] as const;

    for (const testCase of cases) {
      agentSpy.mockClear();
      sessionStore = {
        "agent:main:subagent:test": {
          sessionId: testCase.childSessionId,
        },
        "agent:main:main": {
          sessionId: testCase.requesterSessionId,
        },
      };
      chatHistoryMock.mockResolvedValueOnce({
        messages: [{ role: "assistant", content: [{ type: "text", text: testCase.replyText }] }],
      });
      readLatestAssistantReplyMock.mockResolvedValue("");

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:test",
        childRunId: testCase.childRunId,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
        ...defaultOutcomeAnnounce,
        outcome: testCase.outcome,
        expectsCompletionMessage: true,
        ...(testCase.spawnMode ? { spawnMode: testCase.spawnMode } : {}),
      });

      expect(didAnnounce).toBe(true);
      expect(sendSpy).not.toHaveBeenCalled();
      expect(agentSpy).toHaveBeenCalledTimes(1);
      const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
      const rawMessage = call?.params?.message;
      const msg = typeof rawMessage === "string" ? rawMessage : "";
      expect(msg).toContain(testCase.expectedStatus);
      expect(msg).toContain(testCase.replyText);
      expect(msg).not.toContain("✅ Subagent");
    }
  });
});
