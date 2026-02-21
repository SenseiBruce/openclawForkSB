// Defaults for agent metadata when upstream does not supply them.
// Model id uses pi-ai's built-in Anthropic catalog.
export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-opus-4-6";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;

// Waterfall routing defaults
export const DEFAULT_MANAGER_PROVIDER = process.env.LLM_MANAGER_PROVIDER || "mistralai";
export const DEFAULT_MANAGER_MODEL = process.env.LLM_MANAGER_MODEL || "mistral-small";
export const DEFAULT_CREATIVE_PROVIDER = process.env.LLM_CREATIVE_PROVIDER || "xai";
export const DEFAULT_CREATIVE_MODEL = process.env.LLM_CREATIVE_MODEL || "grok-beta";
export const DEFAULT_WORKER_PROVIDER = process.env.LLM_WORKER_PROVIDER || "ollama";
export const DEFAULT_WORKER_MODEL = process.env.LLM_WORKER_MODEL || "qwen2.5:7b";
export const DEFAULT_LOCAL_URL = "http://localhost:11434/v1";
export const DEFAULT_CONTEXT_MESSAGE_THRESHOLD = 30;
export const DEFAULT_CONTEXT_TOKEN_THRESHOLD = 25000;
