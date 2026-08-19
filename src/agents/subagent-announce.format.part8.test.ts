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

  it("injects direct announce into requester subagent session as a user-turn agent call", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-worker",
      requesterSessionKey: "agent:main:subagent:orchestrator",
      requesterOrigin: { channel: "whatsapp", accountId: "acct-123", to: "+1555" },
      requesterDisplayKey: "agent:main:subagent:orchestrator",
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.sessionKey).toBe("agent:main:subagent:orchestrator");
    expect(call?.params?.deliver).toBe(false);
    expect(call?.params?.channel).toBeUndefined();
    expect(call?.params?.to).toBeUndefined();
    expect((call?.params as { role?: unknown } | undefined)?.role).toBeUndefined();
    expect(call?.params?.inputProvenance).toMatchObject({
      kind: "inter_session",
      sourceSessionKey: "agent:main:subagent:worker",
      sourceTool: "subagent_announce",
    });
  });

  it("keeps completion-mode announce internal for nested requester subagent sessions", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:orchestrator:subagent:worker",
      childRunId: "run-worker-nested-completion",
      requesterSessionKey: "agent:main:subagent:orchestrator",
      requesterOrigin: { channel: "whatsapp", accountId: "acct-123", to: "+1555" },
      requesterDisplayKey: "agent:main:subagent:orchestrator",
      expectsCompletionMessage: true,
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.sessionKey).toBe("agent:main:subagent:orchestrator");
    expect(call?.params?.deliver).toBe(false);
    expect(call?.params?.channel).toBeUndefined();
    expect(call?.params?.to).toBeUndefined();
    expect(call?.params?.inputProvenance).toMatchObject({
      kind: "inter_session",
      sourceSessionKey: "agent:main:subagent:orchestrator:subagent:worker",
      sourceTool: "subagent_announce",
    });
    const message = typeof call?.params?.message === "string" ? call.params.message : "";
    expect(message).toContain(
      "Convert this completion into a concise internal orchestration update for your parent agent",
    );
  });

  it("retries reading subagent output when early lifecycle completion had no text", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValueOnce(true).mockReturnValue(false);
    embeddedRunMock.waitForEmbeddedPiRunEnd.mockResolvedValue(true);
    readLatestAssistantReplyMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("Read #12 complete.");
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-1",
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    };

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "context-stress-test",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(embeddedRunMock.waitForEmbeddedPiRunEnd).toHaveBeenCalledWith("child-session-1", 1000);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    expect(call?.params?.message).toContain("Read #12 complete.");
    expect(call?.params?.message).not.toContain("(no output)");
  });

  it("does not include batching guidance when sibling subagents are still active", async () => {
    subagentRegistryMock.countActiveDescendantRuns.mockImplementation((sessionKey: string) =>
      sessionKey === "agent:main:main" ? 2 : 0,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
    });

    const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message as string;
    expect(msg).not.toContain("There are still");
    expect(msg).not.toContain("wait for the remaining results");
    expect(msg).not.toContain(
      "If they are unrelated, respond normally using only the result above.",
    );
  });

  it("defers announces while any descendant runs remain pending", async () => {
    const cases: Array<{
      childRunId: string;
      pendingCount: number;
      expectsCompletionMessage?: boolean;
      roundOneReply?: string;
    }> = [
      {
        childRunId: "run-parent",
        pendingCount: 1,
      },
      {
        childRunId: "run-parent-completion",
        pendingCount: 1,
        expectsCompletionMessage: true,
      },
      {
        childRunId: "run-parent-one-child-pending",
        pendingCount: 1,
        expectsCompletionMessage: true,
        roundOneReply: "waiting for one child completion",
      },
      {
        childRunId: "run-parent-two-children-pending",
        pendingCount: 2,
        expectsCompletionMessage: true,
        roundOneReply: "waiting for both completion events",
      },
    ];

    for (const testCase of cases) {
      agentSpy.mockClear();
      sendSpy.mockClear();
      subagentRegistryMock.countPendingDescendantRuns.mockImplementation((sessionKey: string) =>
        sessionKey === "agent:main:subagent:parent" ? testCase.pendingCount : 0,
      );

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:parent",
        childRunId: testCase.childRunId,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        ...defaultOutcomeAnnounce,
        ...(testCase.expectsCompletionMessage ? { expectsCompletionMessage: true } : {}),
        ...(testCase.roundOneReply ? { roundOneReply: testCase.roundOneReply } : {}),
      });

      expect(didAnnounce).toBe(false);
      expect(agentSpy).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
    }
  });

  it("keeps single subagent announces self contained without batching hints", async () => {
    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-self-contained",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
    });

    const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message as string;
    expect(msg).not.toContain("There are still");
    expect(msg).not.toContain("wait for the remaining results");
  });

  it("announces completion immediately when no descendants are pending", async () => {
    subagentRegistryMock.countPendingDescendantRuns.mockReturnValue(0);
    subagentRegistryMock.countActiveDescendantRuns.mockReturnValue(0);

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:leaf",
      childRunId: "run-leaf-no-children",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      roundOneReply: "single leaf result",
    });

    expect(didAnnounce).toBe(true);
    expect(agentSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).not.toHaveBeenCalled();
    const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message ?? "";
    expect(msg).toContain("single leaf result");
  });
});
