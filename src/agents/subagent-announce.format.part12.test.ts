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

  describe("subagent announce regression matrix for nested completion delivery", () => {
    function makeChildCompletion(params: {
      runId: string;
      childSessionKey: string;
      requesterSessionKey: string;
      task: string;
      createdAt: number;
      frozenResultText: string;
      outcome?: { status: "ok" | "error" | "timeout"; error?: string };
      endedAt?: number;
      cleanupCompletedAt?: number;
      label?: string;
    }) {
      return {
        runId: params.runId,
        childSessionKey: params.childSessionKey,
        requesterSessionKey: params.requesterSessionKey,
        requesterDisplayKey: params.requesterSessionKey,
        task: params.task,
        label: params.label,
        cleanup: "keep" as const,
        createdAt: params.createdAt,
        endedAt: params.endedAt ?? params.createdAt + 1,
        cleanupCompletedAt: params.cleanupCompletedAt ?? params.createdAt + 2,
        frozenResultText: params.frozenResultText,
        outcome: params.outcome ?? ({ status: "ok" } as const),
      };
    }

    it("regression simple announce, leaf subagent with no children announces immediately", async () => {
      // Regression guard: repeated refactors accidentally delayed leaf completion announces.
      subagentRegistryMock.countPendingDescendantRuns.mockReturnValue(0);

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:leaf-simple",
        childRunId: "run-leaf-simple",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        ...defaultOutcomeAnnounce,
        expectsCompletionMessage: true,
        roundOneReply: "leaf says done",
      });

      expect(didAnnounce).toBe(true);
      expect(agentSpy).toHaveBeenCalledTimes(1);
      const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
      expect(call?.params?.message ?? "").toContain("leaf says done");
    });

    it("regression nested 2-level, parent announces direct child frozen result instead of placeholder text", async () => {
      // Regression guard: parent announce once used stale waiting text instead of child completion output.
      subagentRegistryMock.countPendingDescendantRuns.mockReturnValue(0);
      subagentRegistryMock.listSubagentRunsForRequester.mockImplementation((sessionKey: string) =>
        sessionKey === "agent:main:subagent:parent-2-level"
          ? [
              makeChildCompletion({
                runId: "run-child-2-level",
                childSessionKey: "agent:main:subagent:parent-2-level:subagent:child",
                requesterSessionKey: "agent:main:subagent:parent-2-level",
                task: "child task",
                createdAt: 10,
                frozenResultText: "child final answer",
              }),
            ]
          : [],
      );

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:parent-2-level",
        childRunId: "run-parent-2-level",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        ...defaultOutcomeAnnounce,
        expectsCompletionMessage: true,
        roundOneReply: "placeholder waiting text",
      });

      expect(didAnnounce).toBe(true);
      const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
      const message = call?.params?.message ?? "";
      expect(message).toContain("Child completion results:");
      expect(message).toContain("child final answer");
      expect(message).not.toContain("placeholder waiting text");
    });

    it("regression parallel fan-out, parent defers until both children settle and then includes both outputs", async () => {
      // Regression guard: fan-out paths previously announced after the first child and dropped the sibling.
      let pending = 1;
      subagentRegistryMock.countPendingDescendantRuns.mockImplementation((sessionKey: string) =>
        sessionKey === "agent:main:subagent:parent-fanout" ? pending : 0,
      );
      subagentRegistryMock.listSubagentRunsForRequester.mockImplementation((sessionKey: string) =>
        sessionKey === "agent:main:subagent:parent-fanout"
          ? [
              makeChildCompletion({
                runId: "run-fanout-a",
                childSessionKey: "agent:main:subagent:parent-fanout:subagent:a",
                requesterSessionKey: "agent:main:subagent:parent-fanout",
                task: "child a",
                createdAt: 10,
                frozenResultText: "result A",
              }),
              makeChildCompletion({
                runId: "run-fanout-b",
                childSessionKey: "agent:main:subagent:parent-fanout:subagent:b",
                requesterSessionKey: "agent:main:subagent:parent-fanout",
                task: "child b",
                createdAt: 11,
                frozenResultText: "result B",
              }),
            ]
          : [],
      );

      const deferred = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:parent-fanout",
        childRunId: "run-parent-fanout",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        ...defaultOutcomeAnnounce,
        expectsCompletionMessage: true,
      });
      expect(deferred).toBe(false);
      expect(agentSpy).not.toHaveBeenCalled();

      pending = 0;
      const announced = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:parent-fanout",
        childRunId: "run-parent-fanout",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        ...defaultOutcomeAnnounce,
        expectsCompletionMessage: true,
      });
      expect(announced).toBe(true);
      expect(agentSpy).toHaveBeenCalledTimes(1);
      const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
      const message = call?.params?.message ?? "";
      expect(message).toContain("result A");
      expect(message).toContain("result B");
    });

    it("regression parallel timing difference, fast child cannot trigger early parent announce before slow child settles", async () => {
      // Regression guard: timing skew once allowed partial parent announces with only fast-child output.
      let pendingSlowChild = 1;
      subagentRegistryMock.countPendingDescendantRuns.mockImplementation((sessionKey: string) =>
        sessionKey === "agent:main:subagent:parent-timing" ? pendingSlowChild : 0,
      );
      subagentRegistryMock.listSubagentRunsForRequester.mockImplementation((sessionKey: string) =>
        sessionKey === "agent:main:subagent:parent-timing"
          ? [
              makeChildCompletion({
                runId: "run-fast",
                childSessionKey: "agent:main:subagent:parent-timing:subagent:fast",
                requesterSessionKey: "agent:main:subagent:parent-timing",
                task: "fast child",
                createdAt: 10,
                endedAt: 11,
                frozenResultText: "fast child result",
              }),
              makeChildCompletion({
                runId: "run-slow",
                childSessionKey: "agent:main:subagent:parent-timing:subagent:slow",
                requesterSessionKey: "agent:main:subagent:parent-timing",
                task: "slow child",
                createdAt: 11,
                endedAt: 40,
                frozenResultText: "slow child result",
              }),
            ]
          : [],
      );

      const prematureAttempt = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:parent-timing",
        childRunId: "run-parent-timing",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        ...defaultOutcomeAnnounce,
        expectsCompletionMessage: true,
      });
      expect(prematureAttempt).toBe(false);
      expect(agentSpy).not.toHaveBeenCalled();

      pendingSlowChild = 0;
      const settledAttempt = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:parent-timing",
        childRunId: "run-parent-timing",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        ...defaultOutcomeAnnounce,
        expectsCompletionMessage: true,
      });
      expect(settledAttempt).toBe(true);
      const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
      const message = call?.params?.message ?? "";
      expect(message).toContain("fast child result");
      expect(message).toContain("slow child result");
    });

    it("regression nested parallel, middle waits for two children then parent receives the synthesized middle result", async () => {
      // Regression guard: nested fan-out previously leaked incomplete middle-agent output to the parent.
      const middleSessionKey = "agent:main:subagent:parent-nested:subagent:middle";
      let middlePending = 2;
      subagentRegistryMock.countPendingDescendantRuns.mockImplementation((sessionKey: string) => {
        if (sessionKey === middleSessionKey) {
          return middlePending;
        }
        return 0;
      });
      subagentRegistryMock.listSubagentRunsForRequester.mockImplementation((sessionKey: string) => {
        if (sessionKey === middleSessionKey) {
          return [
            makeChildCompletion({
              runId: "run-middle-a",
              childSessionKey: `${middleSessionKey}:subagent:a`,
              requesterSessionKey: middleSessionKey,
              task: "middle child a",
              createdAt: 10,
              frozenResultText: "middle child result A",
            }),
            makeChildCompletion({
              runId: "run-middle-b",
              childSessionKey: `${middleSessionKey}:subagent:b`,
              requesterSessionKey: middleSessionKey,
              task: "middle child b",
              createdAt: 11,
              frozenResultText: "middle child result B",
            }),
          ];
        }
        if (sessionKey === "agent:main:subagent:parent-nested") {
          return [
            makeChildCompletion({
              runId: "run-middle",
              childSessionKey: middleSessionKey,
              requesterSessionKey: "agent:main:subagent:parent-nested",
              task: "middle orchestrator",
              createdAt: 12,
              frozenResultText: "middle synthesized output from A and B",
            }),
          ];
        }
        return [];
      });

      const middleDeferred = await runSubagentAnnounceFlow({
        childSessionKey: middleSessionKey,
        childRunId: "run-middle",
        requesterSessionKey: "agent:main:subagent:parent-nested",
        requesterDisplayKey: "agent:main:subagent:parent-nested",
        ...defaultOutcomeAnnounce,
        expectsCompletionMessage: true,
      });
      expect(middleDeferred).toBe(false);

      middlePending = 0;
      const middleAnnounced = await runSubagentAnnounceFlow({
        childSessionKey: middleSessionKey,
        childRunId: "run-middle",
        requesterSessionKey: "agent:main:subagent:parent-nested",
        requesterDisplayKey: "agent:main:subagent:parent-nested",
        ...defaultOutcomeAnnounce,
        expectsCompletionMessage: true,
      });
      expect(middleAnnounced).toBe(true);

      const parentAnnounced = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:parent-nested",
        childRunId: "run-parent-nested",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        ...defaultOutcomeAnnounce,
        expectsCompletionMessage: true,
      });
      expect(parentAnnounced).toBe(true);
      expect(agentSpy).toHaveBeenCalledTimes(2);

      const parentCall = agentSpy.mock.calls[1]?.[0] as { params?: { message?: string } };
      expect(parentCall?.params?.message ?? "").toContain("middle synthesized output from A and B");
    });

    it("regression sequential spawning, parent preserves child output order across child 1 then child 2 then child 3", async () => {
      // Regression guard: synthesized child summaries must stay deterministic for sequential orchestration chains.
      subagentRegistryMock.countPendingDescendantRuns.mockReturnValue(0);
      subagentRegistryMock.listSubagentRunsForRequester.mockImplementation((sessionKey: string) =>
        sessionKey === "agent:main:subagent:parent-sequential"
          ? [
              makeChildCompletion({
                runId: "run-seq-1",
                childSessionKey: "agent:main:subagent:parent-sequential:subagent:1",
                requesterSessionKey: "agent:main:subagent:parent-sequential",
                task: "step one",
                createdAt: 10,
                frozenResultText: "result one",
              }),
              makeChildCompletion({
                runId: "run-seq-2",
                childSessionKey: "agent:main:subagent:parent-sequential:subagent:2",
                requesterSessionKey: "agent:main:subagent:parent-sequential",
                task: "step two",
                createdAt: 20,
                frozenResultText: "result two",
              }),
              makeChildCompletion({
                runId: "run-seq-3",
                childSessionKey: "agent:main:subagent:parent-sequential:subagent:3",
                requesterSessionKey: "agent:main:subagent:parent-sequential",
                task: "step three",
                createdAt: 30,
                frozenResultText: "result three",
              }),
            ]
          : [],
      );

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:parent-sequential",
        childRunId: "run-parent-sequential",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        ...defaultOutcomeAnnounce,
        expectsCompletionMessage: true,
      });

      expect(didAnnounce).toBe(true);
      const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
      const message = call?.params?.message ?? "";
      const firstIndex = message.indexOf("result one");
      const secondIndex = message.indexOf("result two");
      const thirdIndex = message.indexOf("result three");
      expect(firstIndex).toBeGreaterThanOrEqual(0);
      expect(secondIndex).toBeGreaterThan(firstIndex);
      expect(thirdIndex).toBeGreaterThan(secondIndex);
    });

    it("regression child error handling, parent announce includes child error status and preserved child output", async () => {
      // Regression guard: failed child outcomes must still surface through parent completion synthesis.
      subagentRegistryMock.countPendingDescendantRuns.mockReturnValue(0);
      subagentRegistryMock.listSubagentRunsForRequester.mockImplementation((sessionKey: string) =>
        sessionKey === "agent:main:subagent:parent-error"
          ? [
              makeChildCompletion({
                runId: "run-child-error",
                childSessionKey: "agent:main:subagent:parent-error:subagent:child-error",
                requesterSessionKey: "agent:main:subagent:parent-error",
                task: "error child",
                createdAt: 10,
                frozenResultText: "traceback: child exploded",
                outcome: { status: "error", error: "child exploded" },
              }),
            ]
          : [],
      );

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:parent-error",
        childRunId: "run-parent-error",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        ...defaultOutcomeAnnounce,
        expectsCompletionMessage: true,
      });

      expect(didAnnounce).toBe(true);
      const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
      const message = call?.params?.message ?? "";
      expect(message).toContain("status: error: child exploded");
      expect(message).toContain("traceback: child exploded");
    });

    it("regression descendant count gating, announce defers at pending > 0 then fires at pending = 0", async () => {
      // Regression guard: completion gating depends on countPendingDescendantRuns and must remain deterministic.
      let pending = 2;
      subagentRegistryMock.countPendingDescendantRuns.mockImplementation((sessionKey: string) =>
        sessionKey === "agent:main:subagent:parent-gated" ? pending : 0,
      );
      subagentRegistryMock.listSubagentRunsForRequester.mockImplementation((sessionKey: string) =>
        sessionKey === "agent:main:subagent:parent-gated"
          ? [
              makeChildCompletion({
                runId: "run-gated-child",
                childSessionKey: "agent:main:subagent:parent-gated:subagent:child",
                requesterSessionKey: "agent:main:subagent:parent-gated",
                task: "gated child",
                createdAt: 10,
                frozenResultText: "gated child output",
              }),
            ]
          : [],
      );

      const first = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:parent-gated",
        childRunId: "run-parent-gated",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        ...defaultOutcomeAnnounce,
        expectsCompletionMessage: true,
      });
      expect(first).toBe(false);
      expect(agentSpy).not.toHaveBeenCalled();

      pending = 0;
      const second = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:parent-gated",
        childRunId: "run-parent-gated",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        ...defaultOutcomeAnnounce,
        expectsCompletionMessage: true,
      });
      expect(second).toBe(true);
      expect(subagentRegistryMock.countPendingDescendantRuns).toHaveBeenCalledWith(
        "agent:main:subagent:parent-gated",
      );
      expect(agentSpy).toHaveBeenCalledTimes(1);
    });

    it("regression deep 3-level re-check chain, child announce then parent re-check emits synthesized parent output", async () => {
      // Regression guard: child completion must unblock parent announce on deterministic re-check.
      const parentSessionKey = "agent:main:subagent:parent-recheck";
      const childSessionKey = `${parentSessionKey}:subagent:child`;
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
            makeChildCompletion({
              runId: "run-grandchild",
              childSessionKey: `${childSessionKey}:subagent:grandchild`,
              requesterSessionKey: childSessionKey,
              task: "grandchild task",
              createdAt: 10,
              frozenResultText: "grandchild settled output",
            }),
          ];
        }
        if (sessionKey === parentSessionKey && parentPending === 0) {
          return [
            makeChildCompletion({
              runId: "run-child",
              childSessionKey,
              requesterSessionKey: parentSessionKey,
              task: "child task",
              createdAt: 20,
              frozenResultText: "child synthesized from grandchild",
            }),
          ];
        }
        return [];
      });

      const parentDeferred = await runSubagentAnnounceFlow({
        childSessionKey: parentSessionKey,
        childRunId: "run-parent-recheck",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        ...defaultOutcomeAnnounce,
        expectsCompletionMessage: true,
      });
      expect(parentDeferred).toBe(false);

      const childAnnounced = await runSubagentAnnounceFlow({
        childSessionKey,
        childRunId: "run-child-recheck",
        requesterSessionKey: parentSessionKey,
        requesterDisplayKey: parentSessionKey,
        ...defaultOutcomeAnnounce,
        expectsCompletionMessage: true,
      });
      expect(childAnnounced).toBe(true);

      parentPending = 0;
      const parentAnnounced = await runSubagentAnnounceFlow({
        childSessionKey: parentSessionKey,
        childRunId: "run-parent-recheck",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        ...defaultOutcomeAnnounce,
        expectsCompletionMessage: true,
      });
      expect(parentAnnounced).toBe(true);
      expect(agentSpy).toHaveBeenCalledTimes(2);

      const childCall = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
      expect(childCall?.params?.message ?? "").toContain("grandchild settled output");
      const parentCall = agentSpy.mock.calls[1]?.[0] as { params?: { message?: string } };
      expect(parentCall?.params?.message ?? "").toContain("child synthesized from grandchild");
    });
  });
});
