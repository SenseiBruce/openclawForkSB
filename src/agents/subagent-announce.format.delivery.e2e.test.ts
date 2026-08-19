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

  it("keeps direct completion announce delivery immediate even when sibling counters are non-zero", async () => {
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-self-pending",
      },
      "agent:main:main": {
        sessionId: "requester-session-self-pending",
      },
    };
    chatHistoryMock.mockResolvedValueOnce({
      messages: [{ role: "assistant", content: [{ type: "text", text: "final answer: done" }] }],
    });
    subagentRegistryMock.countPendingDescendantRuns.mockImplementation((sessionKey: string) =>
      sessionKey === "agent:main:main" ? 2 : 0,
    );
    subagentRegistryMock.countPendingDescendantRunsExcludingRun.mockImplementation(
      (sessionKey: string, runId: string) =>
        sessionKey === "agent:main:main" && runId === "run-direct-self-pending" ? 1 : 2,
    );

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct-self-pending",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(agentSpy).toHaveBeenCalledTimes(1);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.deliver).toBe(true);
    expect(call?.params?.channel).toBe("discord");
    expect(call?.params?.to).toBe("channel:12345");
  });

  it("suppresses completion delivery when subagent reply is ANNOUNCE_SKIP", async () => {
    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct-completion-skip",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      roundOneReply: "ANNOUNCE_SKIP",
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(agentSpy).not.toHaveBeenCalled();
  });

  it("suppresses announce flow for whitespace-padded ANNOUNCE_SKIP and still runs cleanup", async () => {
    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct-skip-whitespace",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
      cleanup: "delete",
      roundOneReply: "  ANNOUNCE_SKIP  ",
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(agentSpy).not.toHaveBeenCalled();
    expect(sessionsDeleteSpy).toHaveBeenCalledTimes(1);
  });

  it("suppresses completion delivery when subagent reply is NO_REPLY", async () => {
    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct-completion-no-reply",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "slack", to: "channel:C123", accountId: "acct-1" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      roundOneReply: " NO_REPLY ",
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(agentSpy).not.toHaveBeenCalled();
  });

  it("uses fallback reply when wake continuation returns NO_REPLY", async () => {
    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct-completion-no-reply:wake",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "slack", to: "channel:C123", accountId: "acct-1" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      roundOneReply: " NO_REPLY ",
      fallbackReply: "final summary from prior completion",
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(agentSpy).toHaveBeenCalledTimes(1);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    expect(call?.params?.message).toContain("final summary from prior completion");
  });

  it("retries completion direct agent announce on transient channel-unavailable errors", async () => {
    agentSpy
      .mockRejectedValueOnce(new Error("Error: No active WhatsApp Web listener (account: default)"))
      .mockRejectedValueOnce(new Error("UNAVAILABLE: listener reconnecting"))
      .mockResolvedValueOnce({ runId: "run-main", status: "ok" });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct-completion-retry",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "whatsapp", to: "+15550000000", accountId: "default" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      roundOneReply: "final answer",
    });

    expect(didAnnounce).toBe(true);
    expect(agentSpy).toHaveBeenCalledTimes(3);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("does not retry completion direct agent announce on permanent channel errors", async () => {
    agentSpy.mockRejectedValueOnce(new Error("unsupported channel: telegram"));

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct-completion-no-retry",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "telegram", to: "telegram:1234" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      roundOneReply: "final answer",
    });

    expect(didAnnounce).toBe(false);
    expect(agentSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("retries direct agent announce on transient channel-unavailable errors", async () => {
    agentSpy
      .mockRejectedValueOnce(new Error("No active WhatsApp Web listener (account: default)"))
      .mockRejectedValueOnce(new Error("UNAVAILABLE: delivery temporarily unavailable"))
      .mockResolvedValueOnce({ runId: "run-main", status: "ok" });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct-agent-retry",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "whatsapp", to: "+15551112222", accountId: "default" },
      ...defaultOutcomeAnnounce,
      roundOneReply: "worker result",
    });

    expect(didAnnounce).toBe(true);
    expect(agentSpy).toHaveBeenCalledTimes(3);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("delivers completion-mode announces immediately even when sibling runs are still active", async () => {
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-coordinated",
      },
      "agent:main:main": {
        sessionId: "requester-session-coordinated",
      },
    };
    chatHistoryMock.mockResolvedValueOnce({
      messages: [{ role: "assistant", content: [{ type: "text", text: "final answer: 2" }] }],
    });
    subagentRegistryMock.countActiveDescendantRuns.mockImplementation((sessionKey: string) =>
      sessionKey === "agent:main:main" ? 1 : 0,
    );

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct-coordinated",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(agentSpy).toHaveBeenCalledTimes(1);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    const rawMessage = call?.params?.message;
    const msg = typeof rawMessage === "string" ? rawMessage : "";
    expect(call?.params?.deliver).toBe(true);
    expect(call?.params?.channel).toBe("discord");
    expect(call?.params?.to).toBe("channel:12345");
    expect(msg).not.toContain("There are still");
    expect(msg).not.toContain("wait for the remaining results");
  });
});
