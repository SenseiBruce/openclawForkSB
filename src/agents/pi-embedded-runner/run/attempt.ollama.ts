import fs from "node:fs/promises";
import os from "node:os";
import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { resolveSignalReactionLevel } from "../../../../extensions/signal/src/reaction-level.js";
import { resolveTelegramInlineButtonsScope } from "../../../../extensions/telegram/src/inline-buttons.js";
import { resolveTelegramReactionLevel } from "../../../../extensions/telegram/src/reaction-level.js";
import { resolveHeartbeatPrompt } from "../../../auto-reply/heartbeat.js";
import { resolveChannelCapabilities } from "../../../config/channel-capabilities.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { getMachineDisplayName } from "../../../infra/machine-name.js";
import {
  ensureGlobalUndiciEnvProxyDispatcher,
  ensureGlobalUndiciStreamTimeouts,
} from "../../../infra/net/undici-global-dispatcher.js";
import { MAX_IMAGE_BYTES } from "../../../media/constants.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforePromptBuildResult,
} from "../../../plugins/types.js";
import { isCronSessionKey, isSubagentSessionKey } from "../../../routing/session-key.js";
import { joinPresentTextSegments } from "../../../shared/text/join-segments.js";
import { buildTtsSystemPromptHint } from "../../../tts/tts.js";
import { resolveUserPath } from "../../../utils.js";
import { normalizeMessageChannel } from "../../../utils/message-channel.js";
import { isReasoningTagProvider } from "../../../utils/provider-utils.js";
import { resolveOpenClawAgentDir } from "../../agent-paths.js";
import { resolveSessionAgentIds } from "../../agent-scope.js";
import { createAnthropicPayloadLogger } from "../../anthropic-payload-log.js";
import {
  analyzeBootstrapBudget,
  buildBootstrapPromptWarning,
  buildBootstrapTruncationReportMeta,
  buildBootstrapInjectionStats,
} from "../../bootstrap-budget.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "../../bootstrap-files.js";
import { createCacheTrace } from "../../cache-trace.js";
import {
  listChannelSupportedActions,
  resolveChannelMessageToolHints,
} from "../../channel-tools.js";
import { ensureCustomApiRegistered } from "../../custom-api-registry.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import { resolveOpenClawDocsPath } from "../../docs-path.js";
import { isTimeoutError } from "../../failover-error.js";
import { resolveImageSanitizationLimits } from "../../image-sanitization.js";
import { resolveModelAuthMode } from "../../model-auth.js";
import { normalizeProviderId, resolveDefaultModelForAgent } from "../../model-selection.js";
import { supportsModelTools } from "../../model-tool-support.js";
import { createConfiguredOllamaStreamFn } from "../../ollama-stream.js";
import { createOpenAIWebSocketStreamFn, releaseWsSession } from "../../openai-ws-stream.js";
import { resolveOwnerDisplaySetting } from "../../owner-display.js";
import {
  downgradeOpenAIFunctionCallReasoningPairs,
  isCloudCodeAssistFormatError,
  resolveBootstrapMaxChars,
  resolveBootstrapPromptTruncationWarningMode,
  resolveBootstrapTotalMaxChars,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "../../pi-embedded-helpers.js";
import { subscribeEmbeddedPiSession } from "../../pi-embedded-subscribe.js";
import { createPreparedEmbeddedPiSettingsManager } from "../../pi-project-settings.js";
import { applyPiAutoCompactionGuard } from "../../pi-settings.js";
import { toClientToolDefinitions } from "../../pi-tool-definition-adapter.js";
import { createOpenClawCodingTools, resolveToolLoopDetectionConfig } from "../../pi-tools.js";
import { resolveSandboxContext } from "../../sandbox.js";
import { resolveSandboxRuntimeStatus } from "../../sandbox/runtime-status.js";
import { isXaiProvider } from "../../schema/clean-for-xai.js";
import { repairSessionFileIfNeeded } from "../../session-file-repair.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairing } from "../../session-transcript-repair.js";
import {
  acquireSessionWriteLock,
  resolveSessionLockMaxHoldFromTimeout,
} from "../../session-write-lock.js";
import { detectRuntimeShell } from "../../shell-utils.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  resolveSkillsPromptForRun,
} from "../../skills.js";
import { buildSystemPromptParams } from "../../system-prompt-params.js";
import { buildSystemPromptReport } from "../../system-prompt-report.js";
import { sanitizeToolCallIdsForCloudCodeAssist } from "../../tool-call-id.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../../tool-fs-policy.js";
import { normalizeToolName } from "../../tool-policy.js";
import { resolveTranscriptPolicy } from "../../transcript-policy.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../../workspace.js";
import { isRunnerAbortError } from "../abort.js";
import { appendCacheTtlTimestamp, isCacheTtlEligibleProvider } from "../cache-ttl.js";
import type { CompactEmbeddedPiSessionParams } from "../compact.js";
import { resolveCompactionTimeoutMs } from "../compaction-safety-timeout.js";
import { buildEmbeddedExtensionFactories } from "../extensions.js";
import { applyExtraParamsToAgent } from "../extra-params.js";
import {
  logToolSchemasForGoogle,
  sanitizeSessionHistory,
  sanitizeToolsForGoogle,
} from "../google.js";
import { getDmHistoryLimitFromSessionKey, limitHistoryTurns } from "../history.js";
import { log } from "../logger.js";
import { buildModelAliasLines } from "../model.js";
import {
  clearActiveEmbeddedRun,
  type EmbeddedPiQueueHandle,
  setActiveEmbeddedRun,
  updateActiveEmbeddedRunSnapshot,
} from "../runs.js";
import { buildEmbeddedSandboxInfo } from "../sandbox-info.js";
import { prewarmSessionFile, trackSessionManagerAccess } from "../session-manager-cache.js";
import { prepareSessionManagerForRun } from "../session-manager-init.js";
import { resolveEmbeddedRunSkillEntries } from "../skills-runtime.js";
import {
  applySystemPromptOverrideToSession,
  buildEmbeddedSystemPrompt,
  createSystemPromptOverride,
} from "../system-prompt.js";
import { dropThinkingBlocks } from "../thinking.js";
import { collectAllowedToolNames } from "../tool-name-allowlist.js";
import { installToolResultContextGuard } from "../tool-result-context-guard.js";
import { splitSdkTools } from "../tool-split.js";
import { describeUnknownError, mapThinkingLevel } from "../utils.js";
import { flushPendingToolResultsAfterIdle } from "../wait-for-idle-before-flush.js";
import { waitForCompactionRetryWithAggregateTimeout } from "./compaction-retry-aggregate-timeout.js";
import {
  resolveRunTimeoutDuringCompaction,
  resolveRunTimeoutWithCompactionGraceMs,
  selectCompactionTimeoutSnapshot,
  shouldFlagCompactionTimeout,
} from "./compaction-timeout.js";
import { pruneProcessedHistoryImages } from "./history-image-prune.js";
import { detectAndLoadPromptImages } from "./images.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

type PromptBuildHookRunner = {
  hasHooks: (hookName: "before_prompt_build" | "before_agent_start") => boolean;
  runBeforePromptBuild: (
    event: { prompt: string; messages: unknown[] },
    ctx: PluginHookAgentContext,
  ) => Promise<PluginHookBeforePromptBuildResult | undefined>;
  runBeforeAgentStart: (
    event: { prompt: string; messages: unknown[] },
    ctx: PluginHookAgentContext,
  ) => Promise<PluginHookBeforeAgentStartResult | undefined>;
};

export function isOllamaCompatProvider(model: {
  provider?: string;
  baseUrl?: string;
  api?: string;
}): boolean {
  const providerId = normalizeProviderId(model.provider ?? "");
  if (providerId === "ollama") {
    return true;
  }
  if (!model.baseUrl) {
    return false;
  }
  try {
    const parsed = new URL(model.baseUrl);
    const hostname = parsed.hostname.toLowerCase();
    const isLocalhost =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]";
    if (isLocalhost && parsed.port === "11434") {
      return true;
    }

    // Allow remote/LAN Ollama OpenAI-compatible endpoints when the provider id
    // itself indicates Ollama usage (e.g. "my-ollama").
    const providerHintsOllama = providerId.includes("ollama");
    const isOllamaPort = parsed.port === "11434";
    const isOllamaCompatPath = parsed.pathname === "/" || /^\/v1\/?$/i.test(parsed.pathname);
    return providerHintsOllama && isOllamaPort && isOllamaCompatPath;
  } catch {
    return false;
  }
}

export function resolveOllamaCompatNumCtxEnabled(params: {
  config?: OpenClawConfig;
  providerId?: string;
}): boolean {
  const providerId = params.providerId?.trim();
  if (!providerId) {
    return true;
  }
  const providers = params.config?.models?.providers;
  if (!providers) {
    return true;
  }
  const direct = providers[providerId];
  if (direct) {
    return direct.injectNumCtxForOpenAICompat ?? true;
  }
  const normalized = normalizeProviderId(providerId);
  for (const [candidateId, candidate] of Object.entries(providers)) {
    if (normalizeProviderId(candidateId) === normalized) {
      return candidate.injectNumCtxForOpenAICompat ?? true;
    }
  }
  return true;
}

export function shouldInjectOllamaCompatNumCtx(params: {
  model: { api?: string; provider?: string; baseUrl?: string };
  config?: OpenClawConfig;
  providerId?: string;
}): boolean {
  // Restrict to the OpenAI-compatible adapter path only.
  if (params.model.api !== "openai-completions") {
    return false;
  }
  if (!isOllamaCompatProvider(params.model)) {
    return false;
  }
  return resolveOllamaCompatNumCtxEnabled({
    config: params.config,
    providerId: params.providerId,
  });
}

export function wrapOllamaCompatNumCtx(baseFn: StreamFn | undefined, numCtx: number): StreamFn {
  const streamFn = baseFn ?? streamSimple;
  return (model, context, options) =>
    streamFn(model, context, {
      ...options,
      onPayload: (payload: unknown) => {
        if (!payload || typeof payload !== "object") {
          return options?.onPayload?.(payload, model);
        }
        const payloadRecord = payload as Record<string, unknown>;
        if (!payloadRecord.options || typeof payloadRecord.options !== "object") {
          payloadRecord.options = {};
        }
        (payloadRecord.options as Record<string, unknown>).num_ctx = numCtx;
        return options?.onPayload?.(payload, model);
      },
    });
}
