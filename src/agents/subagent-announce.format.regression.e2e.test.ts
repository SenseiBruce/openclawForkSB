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

  it("keeps queued idempotency unique for same-ms distinct child runs", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-followup",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        queueMode: "followup",
        queueDebounceMs: 0,
      },
    };
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:worker",
        childRunId: "run-1",
        requesterSessionKey: "main",
        requesterDisplayKey: "main",
        ...defaultOutcomeAnnounce,
        task: "first task",
      });
      await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:worker",
        childRunId: "run-2",
        requesterSessionKey: "main",
        requesterDisplayKey: "main",
        ...defaultOutcomeAnnounce,
        task: "second task",
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(agentSpy).toHaveBeenCalledTimes(2);
    const idempotencyKeys = agentSpy.mock.calls
      .map((call) => (call[0] as { params?: Record<string, unknown> })?.params?.idempotencyKey)
      .filter((value): value is string => typeof value === "string");
    expect(idempotencyKeys).toContain("announce:v1:agent:main:subagent:worker:run-1");
    expect(idempotencyKeys).toContain("announce:v1:agent:main:subagent:worker:run-2");
    expect(new Set(idempotencyKeys).size).toBe(2);
  });

  it("prefers direct delivery first for completion-mode and then queues on direct failure", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-collect",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        queueMode: "collect",
        queueDebounceMs: 0,
      },
    };
    agentSpy
      .mockRejectedValueOnce(new Error("direct delivery unavailable"))
      .mockResolvedValueOnce({ runId: "run-main", status: "ok" });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-completion-direct-fallback",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      expectsCompletionMessage: true,
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(agentSpy).toHaveBeenCalledTimes(2);
    expect(agentSpy.mock.calls[0]?.[0]).toMatchObject({
      method: "agent",
      params: { sessionKey: "agent:main:main", channel: "whatsapp", to: "+1555", deliver: true },
    });
    expect(agentSpy.mock.calls[1]?.[0]).toMatchObject({
      method: "agent",
      params: { sessionKey: "agent:main:main" },
    });
  });

  it("falls back to internal requester-session injection when completion route is missing", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "requester-session-no-route",
      },
    };
    agentSpy.mockImplementationOnce(async (req: AgentCallRequest) => {
      const deliver = req.params?.deliver;
      const channel = req.params?.channel;
      if (deliver === true && typeof channel !== "string") {
        throw new Error("Channel is required when deliver=true");
      }
      return { runId: "run-main", status: "ok" };
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-completion-missing-route",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      expectsCompletionMessage: true,
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(0);
    expect(agentSpy).toHaveBeenCalledTimes(1);
    expect(agentSpy.mock.calls[0]?.[0]).toMatchObject({
      method: "agent",
      params: {
        sessionKey: "agent:main:main",
        deliver: false,
      },
    });
  });

  it("uses direct completion delivery when explicit channel+to route is available", async () => {
    sessionStore = {
      "agent:main:main": {
        sessionId: "requester-session-direct-route",
      },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-completion-explicit-route",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      expectsCompletionMessage: true,
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(agentSpy).toHaveBeenCalledTimes(1);
    expect(agentSpy.mock.calls[0]?.[0]).toMatchObject({
      method: "agent",
      params: {
        sessionKey: "agent:main:main",
        channel: "discord",
        to: "channel:12345",
        deliver: true,
      },
    });
  });

  it("returns failure for completion-mode when direct delivery fails and queue fallback is unavailable", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-direct-only",
        lastChannel: "whatsapp",
        lastTo: "+1555",
      },
    };
    agentSpy.mockRejectedValueOnce(new Error("direct delivery unavailable"));

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-completion-direct-fail",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      expectsCompletionMessage: true,
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(agentSpy).toHaveBeenCalledTimes(1);
  });

  it("uses assistant output for completion-mode when latest assistant text exists", async () => {
    chatHistoryMock.mockResolvedValueOnce({
      messages: [
        {
          role: "toolResult",
          content: [{ type: "text", text: "old tool output" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "assistant completion text" }],
        },
      ],
    });
    readLatestAssistantReplyMock.mockResolvedValue("");

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-completion-assistant-output",
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
    expect(msg).toContain("assistant completion text");
    expect(msg).not.toContain("old tool output");
  });
});
