# OpenClaw Enhancement: 3-Tier Waterfall + Dual Brain Memory

## Quick Reference

Apply these changes to a fresh `main` branch clone to add:
- **3-Tier Waterfall**: Route prompts to Worker (local/free) → Artist (creative) → Manager (full capability)
- **AI Router**: Local model reclassifies "general" intents to minimize API costs
- **Saved Token Tracking**: Track tokens processed by local models separately from billed usage
- **Dual Brain Memory**: LanceDB (working memory) + Cognee (knowledge graph)
- **Auto-Distillation**: Background fact extraction from conversations
- **IdleService**: Background task runner for memory synthesis

---

## Architecture

```
User Prompt → Keyword Detection
    ├─ DATA → Worker (Ollama/qwen2.5:7b) [Zero Cost]
    ├─ CREATIVE → Artist (configurable) [Medium Cost]
    └─ GENERAL → AI Router (optional)
           ├─ reclassified → Worker/Artist
           └─ confirmed → Manager (Claude/GPT) [High Cost]
```

Worker: stateless, tools disabled (except save_memory), thinking off
Artist: creative specialist, full tools
Manager: full capability, all tools

---

## Implementation Steps

### 1. NEW: `src/agents/waterfall-routing.ts`

```typescript
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
```

### 2. NEW: `src/config/types.waterfall.ts`

```typescript
export type IntentType = "creative" | "general" | "data";

export type ContextCompressionConfig = {
  enabled?: boolean;
  messageThreshold?: number;
  tokenThreshold?: number;
};

export type WaterfallConfig = {
  creativeModel?: string;
  creativeProvider?: string;
  workerModel?: string;
  workerProvider?: string;
  managerModel?: string;
  managerProvider?: string;
  localUrl?: string;
  aiRouter?: boolean;
  contextCompression?: ContextCompressionConfig;
  rag?: {
    enabled?: boolean;
    embeddingModel?: string;
    dbPath?: string;
  };
};
```

### 3. NEW: `src/config/zod-schema.waterfall.ts`

```typescript
import { z } from "zod";

export const WaterfallSchema = z.object({
  managerModel: z.string().optional(),
  creativeModel: z.string().optional(),
  localUrl: z.string().optional(),
  aiRouter: z.boolean().optional(),
  contextCompression: z.object({
    enabled: z.boolean().optional(),
    messageThreshold: z.number().int().positive().optional(),
    tokenThreshold: z.number().int().positive().optional(),
  }).strict().optional(),
  rag: z.object({
    enabled: z.boolean().optional(),
    embeddingModel: z.string().optional(),
    dbPath: z.string().optional(),
  }).strict().optional(),
}).strict().optional();

export const ProvidersConfigSchema = z.record(
  z.string(),
  z.object({
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
  }).strict()
).optional();
```

### 4. MODIFY: `src/config/types.ts`

Add to `OpenClawConfig`:
```typescript
import type { WaterfallConfig } from "./types.waterfall.js";

// Add these fields to OpenClawConfig type:
waterfall?: WaterfallConfig;
providers?: Record<string, { apiKey?: string; baseUrl?: string }>;
```

### 5. MODIFY: `src/config/zod-schema.ts`

```typescript
import { WaterfallSchema, ProvidersConfigSchema } from "./zod-schema.waterfall.js";

// Add to root schema object:
waterfall: WaterfallSchema,
providers: ProvidersConfigSchema,
```

### 6. MODIFY: `src/agents/defaults.ts`

Add after existing exports:
```typescript
export const DEFAULT_MANAGER_PROVIDER = process.env.LLM_MANAGER_PROVIDER || "mistralai";
export const DEFAULT_MANAGER_MODEL = process.env.LLM_MANAGER_MODEL || "mistral-small";
export const DEFAULT_CREATIVE_PROVIDER = process.env.LLM_CREATIVE_PROVIDER || "xai";
export const DEFAULT_CREATIVE_MODEL = process.env.LLM_CREATIVE_MODEL || "grok-beta";
export const DEFAULT_WORKER_PROVIDER = process.env.LLM_WORKER_PROVIDER || "ollama";
export const DEFAULT_WORKER_MODEL = process.env.LLM_WORKER_MODEL || "qwen2.5:7b";
export const DEFAULT_LOCAL_URL = "http://localhost:11434/v1";
export const DEFAULT_CONTEXT_MESSAGE_THRESHOLD = 30;
export const DEFAULT_CONTEXT_TOKEN_THRESHOLD = 25000;
```

### 7. NEW: `src/agents/tools/local-processor-tool.ts`

See actual implementation in `/Users/kinshuk.prasad/openclaw-backup/src/agents/tools/local-processor-tool.ts`

Key points:
- Calls Ollama `/api/chat` (not `/v1/chat/completions`)
- Sets `think: false` to disable thinking mode
- Returns error as tool result (doesn't throw) for graceful handling
- 30s timeout via AbortController

### 8. SKIP (already done in openclaw-tools.ts)

`LocalProcessorTool` is already imported and added to tools array.

### 9-10. NEW: Memory files

See implementations in:
- `/Users/kinshuk.prasad/openclaw-backup/src/memory/VectorStoreService.ts`
- `/Users/kinshuk.prasad/openclaw-backup/src/memory/auto-distill.ts`

### 11. MODIFY: `src/agents/tools/memory-tool.ts`

In `createSaveMemoryTool` execute function, after `vectorStore.saveMemory()`:
```typescript
// Dual write to Cognee
let cogneeStatus = "";
try {
  const scriptPath = path.join(process.cwd(), "skills/cognee_memory/scripts/cognee_memory.py");
  const cmd = "/opt/homebrew/bin/python3";
  const result = await runCommandWithTimeout([cmd, scriptPath, "add", content], { timeoutMs: 30000 });
  if (result.stdout?.trim()) console.log(`[Cognee] ${result.stdout.trim()}`);
  if (result.stderr?.trim()) console.log(`[Cognee] ${result.stderr.trim()}`);
  cogneeStatus = " (and synced to Cognee Graph)";
} catch (cogneeErr) {
  cogneeStatus = ` (Cognee sync failed: ${cogneeErr instanceof Error ? cogneeErr.message : String(cogneeErr)})`;
  console.error(`[Cognee Error]`, cogneeErr);
}
return jsonResult({ success: true, message: "Memory saved successfully" + cogneeStatus + "." });
```

In `createMemorySearchTool` execute function, after `rawResults = await manager.search()`:
```typescript
// Dual read from Cognee
try {
  const scriptPath = path.join(process.cwd(), "skills/cognee_memory/scripts/cognee_memory.py");
  const cmd = "/opt/homebrew/bin/python3";
  const result = await runCommandWithTimeout([cmd, scriptPath, "query", query], { timeoutMs: 30000 });
  if (result.stdout?.trim()) {
    const output = result.stdout.trim();
    console.log(`[Cognee Search] Found: ${output}`);
    rawResults.unshift({
      path: "COGNEE_KNOWLEDGE_GRAPH",
      snippet: output,
      score: 1.0,
      startLine: 1,
      endLine: 1,
      source: "memory",
    });
  }
} catch (cogneeErr) {
  console.error(`[Cognee Search Error]`, cogneeErr);
}
```

### 12-13. NEW: Cognee skill

Create `skills/cognee_memory/SKILL.md` and `skills/cognee_memory/scripts/cognee_memory.py`

See actual files in the repo.

### 14-16. NEW: IdleService

See implementations in:
- `/Users/kinshuk.prasad/openclaw-backup/src/infra/idle-service.ts`
- `/Users/kinshuk.prasad/openclaw-backup/src/infra/idle/memory-synthesizer.ts`
- `/Users/kinshuk.prasad/openclaw-backup/src/infra/idle/codebase-indexer.ts`

### 17-18. MODIFY: Gateway server

In `src/gateway/server.impl.ts`, after server starts:
```typescript
import { IdleService } from "../infra/idle-service.js";
import { memorySynthesizerTask } from "../infra/idle/memory-synthesizer.js";
import { codebaseIndexerTask } from "../infra/idle/codebase-indexer.js";

const idleService = new IdleService(config, (taskName, summary) => {
  log.info(`[idle-service] ${taskName}: ${summary}`);
});
idleService.registerTask(memorySynthesizerTask);
idleService.registerTask(codebaseIndexerTask);
idleService.start();
// Store instance for cleanup
```

In `src/gateway/server-close.ts`:
```typescript
idleService.stop();
```

### 19. MODIFY: `src/agents/pi-embedded-runner/run.ts` (CORE CHANGE)

After resolving `provider` and `modelId`, before `resolveModel()`:

```typescript
let selectedProvider = provider;
let selectedModelId = modelId;
let waterfallTier: "worker" | "manager" | "artist" = "manager";
let ragContext = "";

const waterfallEnabled = params.config?.waterfall !== undefined;
if (waterfallEnabled) {
  const { detectIntent, selectModelForIntent, ROUTER_PROMPT } = await import("../waterfall-routing.js");
  let intent = detectIntent(params.prompt);
  log.info(`[waterfall] Initial keyword intent: ${intent.toUpperCase()}`);

  const aiRouterEnabled = params.config?.waterfall?.aiRouter === true;
  if (intent === "general" && aiRouterEnabled) {
    try {
      const workerChoice = selectModelForIntent("data", params.config);
      const { model: routeModel, authStorage: routeAuthStorage, modelRegistry: routeModelRegistry } = 
        resolveModel(workerChoice.provider, workerChoice.model, agentDir, params.config);
      
      if (routeModel) {
        try {
          const routeAuth = await getApiKeyForModel({ model: routeModel, cfg: params.config, agentDir });
          if (routeAuth.apiKey) routeAuthStorage.setRuntimeApiKey(routeModel.provider, routeAuth.apiKey);
        } catch (authErr) {
          log.debug(`[waterfall] AI Router auth resolution failed: ${authErr}`);
        }

        const routePrompt = `User Prompt: "${params.prompt}"\n\nTask: Classify this prompt based on the instructions.`;
        log.info(`[waterfall] AI Router active. Sending prompt to ${workerChoice.provider}/${workerChoice.model}`);
        
        const routeAttempt = await runEmbeddedAttempt({
          ...params,
          prompt: routePrompt,
          extraSystemPrompt: ROUTER_PROMPT,
          provider: workerChoice.provider,
          modelId: workerChoice.model,
          model: routeModel,
          authStorage: routeAuthStorage,
          modelRegistry: routeModelRegistry,
          disableTools: true,
          thinkLevel: "off",
          sessionId: `router-${params.sessionId}`,
          sessionFile: undefined,
          promptMode: "none",
          images: [],
          enforceFinalTag: false,
        });

        mergeUsageIntoAccumulator(savedUsageAccumulator, routeAttempt.attemptUsage);
        const aiChoice = routeAttempt.assistantTexts.join(" ").trim().toLowerCase();
        log.info(`[waterfall] AI Router raw response: "${aiChoice}"`);

        if (aiChoice === "worker" || aiChoice === "data") {
          intent = "data";
          log.info(`[waterfall] AI Router reclassified intent to DATA`);
        } else if (aiChoice === "creative" || aiChoice === "artist") {
          intent = "creative";
          log.info(`[waterfall] AI Router reclassified intent to CREATIVE`);
        }
      }
    } catch (err) {
      log.warn(`[waterfall] AI routing failed, falling back to keyword intent: ${err}`);
    }
  }

  const modelChoice = selectModelForIntent(intent, params.config);
  selectedProvider = modelChoice.provider;
  selectedModelId = modelChoice.model;

  if (intent === "data") {
    waterfallTier = "worker";
    log.info(`[waterfall] Routing to Worker tier (${selectedProvider}/${selectedModelId})`);
  } else if (intent === "creative") {
    waterfallTier = "artist";
    log.info(`[waterfall] Routing to Artist tier (${selectedProvider}/${selectedModelId})`);
  } else {
    waterfallTier = "manager";
    log.info(`[waterfall] Routing to Manager tier (${selectedProvider}/${selectedModelId})`);
  }

  // RAG Retrieval
  const ragConfig = params.config?.waterfall?.rag;
  if (ragConfig?.enabled) {
    try {
      log.info(`[rag] Fetching long-term memory...`);
      const workerChoice = selectModelForIntent("data", params.config);
      const { model: ragModel, authStorage: ragAuthStorage, modelRegistry: ragModelRegistry } = 
        resolveModel(workerChoice.provider, workerChoice.model, agentDir, params.config);

      if (ragModel) {
        try {
          const ragAuth = await getApiKeyForModel({ model: ragModel, cfg: params.config, agentDir });
          if (ragAuth.apiKey) ragAuthStorage.setRuntimeApiKey(ragModel.provider, ragAuth.apiKey);
        } catch (authErr) {
          log.debug(`[rag] RAG auth resolution failed: ${authErr}`);
        }

        const keywordPrompt = `User Prompt: "${params.prompt}"\n\nTask: Extract the core subject of this query for a database search. Output ONLY the keyword.`;
        const keywordAttempt = await runEmbeddedAttempt({
          ...params,
          prompt: keywordPrompt,
          provider: workerChoice.provider,
          modelId: workerChoice.model,
          model: ragModel,
          authStorage: ragAuthStorage,
          modelRegistry: ragModelRegistry,
          disableTools: true,
          thinkLevel: "off",
          sessionId: `rag-extract-${params.sessionId}`,
          sessionFile: undefined,
          promptMode: "none",
          images: [],
          enforceFinalTag: false,
        });

        const keyword = keywordAttempt.assistantTexts.join(" ").trim();
        log.info(`[rag] Extracted keyword: "${keyword}"`);
        mergeUsageIntoAccumulator(savedUsageAccumulator, keywordAttempt.attemptUsage);

        if (keyword && keyword.toLowerCase() !== "none") {
          const vectorStore = VectorStoreService.getInstance({
            dbPath: ragConfig.dbPath || "./data/memory.lance",
            embeddingModel: ragConfig.embeddingModel || "nomic-embed-text",
            localUrl: params.config?.waterfall?.localUrl || "http://localhost:11434/v1",
          });

          const memories = await vectorStore.queryMemory(keyword, 3);
          if (memories.length > 0) {
            const memoryText = memories.map(m => `- [${m.metadata.category || "Fact"}]: ${m.text}`).join("\n");
            ragContext = `\n\n## RELEVANT LONG-TERM MEMORY\n${memoryText}`;
            log.info(`[rag] Injected ${memories.length} relevant memories into system prompt.`);
          }
        }
      }
    } catch (err) {
      log.warn(`[rag] Memory retrieval failed: ${err}`);
    }
  }
}
```

Then in the main `runEmbeddedAttempt` call:
```typescript
disableTools: params.disableTools || waterfallTier === "worker",
toolAllowlist: waterfallTier === "worker" ? ["save_memory"] : undefined,
thinkLevel: waterfallTier === "worker" ? "off" : thinkLevel,
extraSystemPrompt: (params.extraSystemPrompt ?? 
  (waterfallTier === "worker" 
    ? "You are a specialized data processing model. Provide the requested output directly. Avoid conversational filler." 
    : "")) + ragContext || undefined,
promptMode: waterfallTier === "worker" ? "local-minimal" : undefined,
```

After attempt completes:
```typescript
const currentUsage = attempt.attemptUsage ?? normalizeUsage(lastAssistant?.usage as UsageLike);
if (waterfallTier === "worker") {
  mergeUsageIntoAccumulator(savedUsageAccumulator, currentUsage);
} else {
  mergeUsageIntoAccumulator(usageAccumulator, currentUsage);
}
```

In return value:
```typescript
savedUsage: toNormalizedUsage(savedUsageAccumulator),
```

### 20. MODIFY: `src/auto-reply/reply/session-usage.ts`

Add `savedUsage?: NormalizedUsage` to params.

In `updateSessionStoreEntry`:
```typescript
const savedTotal = params.savedUsage?.total ?? 
  (params.savedUsage?.input ?? 0) + (params.savedUsage?.output ?? 0);

// Add to patch:
savedTokens: (entry.savedTokens ?? 0) + savedTotal,
```

### 21-23. SKIP (already exist)

- `savedTokens` already in `SessionEntry`
- `savedUsage` already in `EmbeddedPiAgentMeta`
- All params already in `EmbeddedRunAttemptParams`

### 24. MODIFY: `src/gateway/server-chat.ts`

When building usage footer, include:
```typescript
if (agentMeta.savedUsage?.total) {
  footer += ` | Saved: ${agentMeta.savedUsage.total}t`;
}
```

### 25. MODIFY: `src/auto-reply/reply/agent-runner.ts`

Pass `savedUsage` from `agentMeta` to `persistSessionUsageUpdate`.

---

## Configuration Example

`~/.openclaw/openclaw.json`:
```json
{
  "waterfall": {
    "managerModel": "google-antigravity/gemini-3-flash",
    "creativeModel": "google-antigravity/gemini-3-flash",
    "workerModel": "qwen2.5:7b",
    "workerProvider": "ollama",
    "localUrl": "http://localhost:11434/v1",
    "aiRouter": true,
    "rag": {
      "enabled": true,
      "embeddingModel": "nomic-embed-text",
      "dbPath": "./data/memory.lance"
    }
  }
}
```

## Prerequisites

1. `ollama serve` running on port 11434
2. `ollama pull qwen2.5:7b`
3. `ollama pull nomic-embed-text`
4. `pip install cognee` (Python 3.10+)
5. `@lancedb/lancedb` in package.json

## Testing

```bash
# Worker tier (local)
openclaw agent --message "format this json: {name: 'test', value: 1}"

# Manager tier (API)
openclaw agent --message "what is the capital of France?"

# Memory (dual write)
openclaw agent --message "remember my deadline is March 15"

# Check saved tokens in response footer
```