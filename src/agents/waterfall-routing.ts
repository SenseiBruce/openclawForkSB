import type { OpenClawConfig } from "../config/types.js";
import type { IntentType } from "../config/types.waterfall.js";
import {
  DEFAULT_CONTEXT_MESSAGE_THRESHOLD,
  DEFAULT_CONTEXT_TOKEN_THRESHOLD,
  DEFAULT_LOCAL_URL,
  DEFAULT_MANAGER_MODEL,
  DEFAULT_MANAGER_PROVIDER,
  DEFAULT_CREATIVE_MODEL,
  DEFAULT_CREATIVE_PROVIDER,
  DEFAULT_WORKER_MODEL,
  DEFAULT_WORKER_PROVIDER,
} from "./defaults.js";

const CREATIVE_KEYWORDS = ["write_script", "story", "creative_hook", "scriptwriting", "storytelling", "write a story", "creative writing", "screenplay", "narrative", "fiction"];
const DATA_KEYWORDS = ["json", "fix syntax", "format data", "local_processor", "local processor", "extract timestamps", "parse logs", "fix code syntax", "syntax"];
const GENERAL_KEYWORDS = ["remember", "save to memory", "save memory", "recall", "forget"];

export const ROUTER_PROMPT = `You are a high-speed request router. Classify the user's intent into exactly one of these three tiers:
- worker: For data processing, JSON, syntax fixing, parsing, or simple code transformation.
- creative: For storytelling, scriptwriting, poetry, or imaginative content.
- manager: For general logic, planning, research, answering questions about facts, or complex instructions.

Reply with ONLY the word: worker, creative, or manager. Do not explain your choice.`;

export const DISTILLER_PROMPT = `You are a memory distiller. Extract only concrete, reusable facts from the conversation (user preferences, project names, decisions, deadlines). Output as bullet points. If there are no facts worth saving, output only the word NONE.`;

export function detectIntent(prompt: string): IntentType {
  const lowerPrompt = prompt.toLowerCase();
  for (const keyword of GENERAL_KEYWORDS) {
    if (lowerPrompt.includes(keyword)) return "general";
  }
  for (const keyword of DATA_KEYWORDS) {
    if (lowerPrompt.includes(keyword)) return "data";
  }
  for (const keyword of CREATIVE_KEYWORDS) {
    if (lowerPrompt.includes(keyword)) return "creative";
  }
  return "general";
}

export function selectModelForIntent(intent: IntentType, config?: OpenClawConfig): { provider: string; model: string } {
  const waterfallConfig = config?.waterfall;
  let selection: string;
  let defaultProvider: string;

  if (intent === "data") {
    selection = process.env.LLM_WORKER_MODEL || waterfallConfig?.workerModel || DEFAULT_WORKER_MODEL;
    defaultProvider = process.env.LLM_WORKER_PROVIDER || waterfallConfig?.workerProvider || DEFAULT_WORKER_PROVIDER;
  } else if (intent === "creative") {
    selection = process.env.LLM_CREATIVE_MODEL || waterfallConfig?.creativeModel || DEFAULT_CREATIVE_MODEL;
    defaultProvider = process.env.LLM_CREATIVE_PROVIDER || waterfallConfig?.creativeProvider || DEFAULT_CREATIVE_PROVIDER;
  } else {
    selection = process.env.LLM_MANAGER_MODEL || waterfallConfig?.managerModel || DEFAULT_MANAGER_MODEL;
    defaultProvider = process.env.LLM_MANAGER_PROVIDER || waterfallConfig?.managerProvider || DEFAULT_MANAGER_PROVIDER;
  }

  const slashIndex = selection.indexOf("/");
  if (slashIndex !== -1 && slashIndex > 0) {
    const provider = selection.substring(0, slashIndex);
    const model = selection.substring(slashIndex + 1);
    if (provider && model) return { provider, model };
  }
  return { provider: defaultProvider, model: selection };
}

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export function shouldCompressContext(params: { messageCount: number; estimatedTokens: number; config?: OpenClawConfig }): boolean {
  const compressionConfig = params.config?.waterfall?.contextCompression;
  if (compressionConfig?.enabled === false) return false;
  const messageThreshold = compressionConfig?.messageThreshold ?? DEFAULT_CONTEXT_MESSAGE_THRESHOLD;
  const tokenThreshold = compressionConfig?.tokenThreshold ?? DEFAULT_CONTEXT_TOKEN_THRESHOLD;
  return params.messageCount > messageThreshold || params.estimatedTokens > tokenThreshold;
}

export function getLocalProcessorUrl(config?: OpenClawConfig): string {
  return process.env.LLM_LOCAL_URL?.trim() || config?.waterfall?.localUrl?.trim() || DEFAULT_LOCAL_URL;
}

export function buildCompressionInstruction(messageCount: number): string {
  const messagesToSummarize = Math.floor(messageCount / 2);
  return `Summarize the first ${messagesToSummarize} messages of this conversation into 5 key bullet points. Focus on important context, decisions, and outcomes. Be concise.`;
}
