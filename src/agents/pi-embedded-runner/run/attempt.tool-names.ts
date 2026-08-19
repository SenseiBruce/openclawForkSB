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

function resolveCaseInsensitiveAllowedToolName(
  rawName: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }
  const folded = rawName.toLowerCase();
  let caseInsensitiveMatch: string | null = null;
  for (const name of allowedToolNames) {
    if (name.toLowerCase() !== folded) {
      continue;
    }
    if (caseInsensitiveMatch && caseInsensitiveMatch !== name) {
      return null;
    }
    caseInsensitiveMatch = name;
  }
  return caseInsensitiveMatch;
}

function resolveExactAllowedToolName(
  rawName: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }
  if (allowedToolNames.has(rawName)) {
    return rawName;
  }
  const normalized = normalizeToolName(rawName);
  if (allowedToolNames.has(normalized)) {
    return normalized;
  }
  return (
    resolveCaseInsensitiveAllowedToolName(rawName, allowedToolNames) ??
    resolveCaseInsensitiveAllowedToolName(normalized, allowedToolNames)
  );
}

function buildStructuredToolNameCandidates(rawName: string): string[] {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return [];
  }

  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (value: string) => {
    const candidate = value.trim();
    if (!candidate || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    candidates.push(candidate);
  };

  addCandidate(trimmed);
  addCandidate(normalizeToolName(trimmed));

  const normalizedDelimiter = trimmed.replace(/\//g, ".");
  addCandidate(normalizedDelimiter);
  addCandidate(normalizeToolName(normalizedDelimiter));

  const segments = normalizedDelimiter
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length > 1) {
    for (let index = 1; index < segments.length; index += 1) {
      const suffix = segments.slice(index).join(".");
      addCandidate(suffix);
      addCandidate(normalizeToolName(suffix));
    }
  }

  return candidates;
}

function resolveStructuredAllowedToolName(
  rawName: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }

  const candidateNames = buildStructuredToolNameCandidates(rawName);
  for (const candidate of candidateNames) {
    if (allowedToolNames.has(candidate)) {
      return candidate;
    }
  }

  for (const candidate of candidateNames) {
    const caseInsensitiveMatch = resolveCaseInsensitiveAllowedToolName(candidate, allowedToolNames);
    if (caseInsensitiveMatch) {
      return caseInsensitiveMatch;
    }
  }

  return null;
}

function inferToolNameFromToolCallId(
  rawId: string | undefined,
  allowedToolNames?: Set<string>,
): string | null {
  if (!rawId || !allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }
  const id = rawId.trim();
  if (!id) {
    return null;
  }

  const candidateTokens = new Set<string>();
  const addToken = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    candidateTokens.add(trimmed);
    candidateTokens.add(trimmed.replace(/[:._/-]\d+$/, ""));
    candidateTokens.add(trimmed.replace(/\d+$/, ""));

    const normalizedDelimiter = trimmed.replace(/\//g, ".");
    candidateTokens.add(normalizedDelimiter);
    candidateTokens.add(normalizedDelimiter.replace(/[:._-]\d+$/, ""));
    candidateTokens.add(normalizedDelimiter.replace(/\d+$/, ""));

    for (const prefixPattern of [/^functions?[._-]?/i, /^tools?[._-]?/i]) {
      const stripped = normalizedDelimiter.replace(prefixPattern, "");
      if (stripped !== normalizedDelimiter) {
        candidateTokens.add(stripped);
        candidateTokens.add(stripped.replace(/[:._-]\d+$/, ""));
        candidateTokens.add(stripped.replace(/\d+$/, ""));
      }
    }
  };

  const preColon = id.split(":")[0] ?? id;
  for (const seed of [id, preColon]) {
    addToken(seed);
  }

  let singleMatch: string | null = null;
  for (const candidate of candidateTokens) {
    const matched = resolveStructuredAllowedToolName(candidate, allowedToolNames);
    if (!matched) {
      continue;
    }
    if (singleMatch && singleMatch !== matched) {
      return null;
    }
    singleMatch = matched;
  }

  return singleMatch;
}

function looksLikeMalformedToolNameCounter(rawName: string): boolean {
  const normalizedDelimiter = rawName.trim().replace(/\//g, ".");
  return (
    /^(?:functions?|tools?)[._-]?/i.test(normalizedDelimiter) &&
    /(?:[:._-]\d+|\d+)$/.test(normalizedDelimiter)
  );
}

function normalizeToolCallNameForDispatch(
  rawName: string,
  allowedToolNames?: Set<string>,
  rawToolCallId?: string,
): string {
  const trimmed = rawName.trim();
  if (!trimmed) {
    // Keep whitespace-only placeholders unchanged unless we can safely infer
    // a canonical name from toolCallId and allowlist.
    return inferToolNameFromToolCallId(rawToolCallId, allowedToolNames) ?? rawName;
  }
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return trimmed;
  }

  const exact = resolveExactAllowedToolName(trimmed, allowedToolNames);
  if (exact) {
    return exact;
  }
  // Some providers put malformed toolCallId-like strings into `name`
  // itself (for example `functionsread3`). Recover conservatively from the
  // name token before consulting the separate id so explicit names like
  // `someOtherTool` are preserved.
  const inferredFromName = inferToolNameFromToolCallId(trimmed, allowedToolNames);
  if (inferredFromName) {
    return inferredFromName;
  }

  // If the explicit name looks like a provider-mangled tool-call id with a
  // numeric suffix, fail closed when inference is ambiguous instead of routing
  // to whichever structured candidate happens to match.
  if (looksLikeMalformedToolNameCounter(trimmed)) {
    return trimmed;
  }

  return resolveStructuredAllowedToolName(trimmed, allowedToolNames) ?? trimmed;
}

export function isToolCallBlockType(type: unknown): boolean {
  return type === "toolCall" || type === "toolUse" || type === "functionCall";
}

function normalizeToolCallIdsInMessage(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }

  const usedIds = new Set<string>();
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; id?: unknown };
    if (!isToolCallBlockType(typedBlock.type) || typeof typedBlock.id !== "string") {
      continue;
    }
    const trimmedId = typedBlock.id.trim();
    if (!trimmedId) {
      continue;
    }
    usedIds.add(trimmedId);
  }

  let fallbackIndex = 1;
  const assignedIds = new Set<string>();
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; id?: unknown };
    if (!isToolCallBlockType(typedBlock.type)) {
      continue;
    }
    if (typeof typedBlock.id === "string") {
      const trimmedId = typedBlock.id.trim();
      if (trimmedId) {
        if (!assignedIds.has(trimmedId)) {
          if (typedBlock.id !== trimmedId) {
            typedBlock.id = trimmedId;
          }
          assignedIds.add(trimmedId);
          continue;
        }
      }
    }

    let fallbackId = "";
    while (!fallbackId || usedIds.has(fallbackId) || assignedIds.has(fallbackId)) {
      fallbackId = `call_auto_${fallbackIndex++}`;
    }
    typedBlock.id = fallbackId;
    usedIds.add(fallbackId);
    assignedIds.add(fallbackId);
  }
}

function trimWhitespaceFromToolCallNamesInMessage(
  message: unknown,
  allowedToolNames?: Set<string>,
): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; name?: unknown; id?: unknown };
    if (!isToolCallBlockType(typedBlock.type)) {
      continue;
    }
    const rawId = typeof typedBlock.id === "string" ? typedBlock.id : undefined;
    if (typeof typedBlock.name === "string") {
      const normalized = normalizeToolCallNameForDispatch(typedBlock.name, allowedToolNames, rawId);
      if (normalized !== typedBlock.name) {
        typedBlock.name = normalized;
      }
      continue;
    }
    const inferred = inferToolNameFromToolCallId(rawId, allowedToolNames);
    if (inferred) {
      typedBlock.name = inferred;
    }
  }
  normalizeToolCallIdsInMessage(message);
}

function wrapStreamTrimToolCallNames(
  stream: ReturnType<typeof streamSimple>,
  allowedToolNames?: Set<string>,
): ReturnType<typeof streamSimple> {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    trimWhitespaceFromToolCallNamesInMessage(message, allowedToolNames);
    return message;
  };

  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      return {
        async next() {
          const result = await iterator.next();
          if (!result.done && result.value && typeof result.value === "object") {
            const event = result.value as {
              partial?: unknown;
              message?: unknown;
            };
            trimWhitespaceFromToolCallNamesInMessage(event.partial, allowedToolNames);
            trimWhitespaceFromToolCallNamesInMessage(event.message, allowedToolNames);
          }
          return result;
        },
        async return(value?: unknown) {
          return iterator.return?.(value) ?? { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          return iterator.throw?.(error) ?? { done: true as const, value: undefined };
        },
      };
    };

  return stream;
}

export function wrapStreamFnTrimToolCallNames(
  baseFn: StreamFn,
  allowedToolNames?: Set<string>,
): StreamFn {
  return (model, context, options) => {
    const maybeStream = baseFn(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamTrimToolCallNames(stream, allowedToolNames),
      );
    }
    return wrapStreamTrimToolCallNames(maybeStream, allowedToolNames);
  };
}
