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

  it("does not re-wake an already woken run id", async () => {
    sessionStore = {
      "agent:main:subagent:parent": {
        sessionId: "session-parent",
      },
    };

    subagentRegistryMock.countPendingDescendantRuns.mockReturnValue(0);
    subagentRegistryMock.listSubagentRunsForRequester.mockImplementation(
      (sessionKey: string, scope?: { requesterRunId?: string }) => {
        if (sessionKey !== "agent:main:subagent:parent") {
          return [];
        }
        if (scope?.requesterRunId !== "run-parent-phase-2:wake") {
          return [];
        }
        return [
          {
            runId: "run-child-a",
            childSessionKey: "agent:main:subagent:parent:subagent:a",
            requesterSessionKey: "agent:main:subagent:parent",
            requesterDisplayKey: "parent",
            task: "child task a",
            label: "child-a",
            cleanup: "keep",
            createdAt: 10,
            endedAt: 20,
            cleanupCompletedAt: 21,
            frozenResultText: "result from child a",
            outcome: { status: "ok" },
          },
        ];
      },
    );

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:parent",
      childRunId: "run-parent-phase-2:wake",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
      wakeOnDescendantSettle: true,
      roundOneReply: "waiting for children",
    });

    expect(didAnnounce).toBe(true);
    expect(subagentRegistryMock.replaceSubagentRunAfterSteer).not.toHaveBeenCalled();
    expect(agentSpy).toHaveBeenCalledTimes(1);
    const call = agentSpy.mock.calls[0]?.[0] as {
      params?: { sessionKey?: string; message?: string };
    };
    expect(call?.params?.sessionKey).toBe("agent:main:main");
    const message = call?.params?.message ?? "";
    expect(message).toContain("Child completion results:");
    expect(message).toContain("result from child a");
    expect(message).not.toContain("All pending descendants for that run have now settled");
  });

  it("nested completion chains re-check child then parent deterministically", async () => {
    const parentSessionKey = "agent:main:subagent:parent";
    const childSessionKey = "agent:main:subagent:parent:subagent:child";
    let parentPending = 1;

    subagentRegistryMock.countPendingDescendantRuns.mockImplementation((sessionKey: string) => {
      if (sessionKey === parentSessionKey) {
        return parentPending;
      }
      return 0;
    });
    subagentRegistryMock.listSubagentRunsForRequester.mockImplementation((sessionKey: string) => {
      if (sessionKey === childSessionKey) {
        return [
          {
            runId: "run-grandchild",
            childSessionKey: `${childSessionKey}:subagent:grandchild`,
            requesterSessionKey: childSessionKey,
            requesterDisplayKey: "child",
            task: "grandchild task",
            label: "grandchild",
            cleanup: "keep",
            createdAt: 10,
            endedAt: 20,
            cleanupCompletedAt: 21,
            frozenResultText: "grandchild final output",
            outcome: { status: "ok" },
          },
        ];
      }
      if (sessionKey === parentSessionKey && parentPending === 0) {
        return [
          {
            runId: "run-child",
            childSessionKey,
            requesterSessionKey: parentSessionKey,
            requesterDisplayKey: "parent",
            task: "child task",
            label: "child",
            cleanup: "keep",
            createdAt: 11,
            endedAt: 21,
            cleanupCompletedAt: 22,
            frozenResultText: "child synthesized output from grandchild",
            outcome: { status: "ok" },
          },
        ];
      }
      return [];
    });

    const parentDeferred = await runSubagentAnnounceFlow({
      childSessionKey: parentSessionKey,
      childRunId: "run-parent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
    });
    expect(parentDeferred).toBe(false);
    expect(agentSpy).not.toHaveBeenCalled();

    const childAnnounced = await runSubagentAnnounceFlow({
      childSessionKey,
      childRunId: "run-child",
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: parentSessionKey,
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
    });
    expect(childAnnounced).toBe(true);

    parentPending = 0;
    const parentAnnounced = await runSubagentAnnounceFlow({
      childSessionKey: parentSessionKey,
      childRunId: "run-parent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
    });
    expect(parentAnnounced).toBe(true);
    expect(agentSpy).toHaveBeenCalledTimes(2);

    const childCall = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    expect(childCall?.params?.message ?? "").toContain("grandchild final output");

    const parentCall = agentSpy.mock.calls[1]?.[0] as { params?: { message?: string } };
    expect(parentCall?.params?.message ?? "").toContain("child synthesized output from grandchild");
  });

  it("ignores post-completion announce traffic for completed run-mode requester sessions", async () => {
    // Regression guard: late announces for ended run-mode orchestrators must be ignored.
    subagentRegistryMock.isSubagentSessionRunActive.mockReturnValue(false);
    subagentRegistryMock.shouldIgnorePostCompletionAnnounceForSession.mockReturnValue(true);
    subagentRegistryMock.countPendingDescendantRuns.mockReturnValue(2);
    sessionStore = {
      "agent:main:subagent:orchestrator": {
        sessionId: "orchestrator-session-id",
      },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:leaf",
      childRunId: "run-leaf-late",
      requesterSessionKey: "agent:main:subagent:orchestrator",
      requesterDisplayKey: "agent:main:subagent:orchestrator",
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    expect(agentSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(subagentRegistryMock.countPendingDescendantRuns).not.toHaveBeenCalled();
    expect(subagentRegistryMock.resolveRequesterForChildSession).not.toHaveBeenCalled();
  });

  it("bubbles child announce to parent requester when requester subagent session is missing", async () => {
    subagentRegistryMock.isSubagentSessionRunActive.mockReturnValue(false);
    subagentRegistryMock.resolveRequesterForChildSession.mockReturnValue({
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "whatsapp", to: "+1555", accountId: "acct-main" },
    });
    sessionStore = {
      "agent:main:subagent:orchestrator": undefined as unknown as Record<string, unknown>,
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:leaf",
      childRunId: "run-leaf",
      requesterSessionKey: "agent:main:subagent:orchestrator",
      requesterDisplayKey: "agent:main:subagent:orchestrator",
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.sessionKey).toBe("agent:main:main");
    expect(call?.params?.deliver).toBe(true);
    expect(call?.params?.channel).toBe("whatsapp");
    expect(call?.params?.to).toBe("+1555");
    expect(call?.params?.accountId).toBe("acct-main");
  });
});
