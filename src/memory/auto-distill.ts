import {
  DISTILLER_PROMPT,
  getLocalProcessorUrl,
  selectModelForIntent,
} from "../agents/waterfall-routing.js";
import { OpenClawConfig } from "../config/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { VectorStoreService } from "./VectorStoreService.js";

const log = createSubsystemLogger("memory/auto-distill");

export async function autoDistillConversation(params: {
  transcript: string;
  config: OpenClawConfig;
  sessionKey?: string;
}): Promise<void> {
  const ragConfig = params.config.waterfall?.rag;
  if (!ragConfig?.enabled) {
    return;
  }

  try {
    const workerChoice = selectModelForIntent("data", params.config);
    const localUrl = getLocalProcessorUrl(params.config).replace("/v1", "");

    log.info(`[auto-distill] Extracting facts from session: ${params.sessionKey ?? "unknown"}`);

    const response = await fetch(`${localUrl}/api/generate`, {
      method: "POST",
      body: JSON.stringify({
        model: workerChoice.model,
        system: DISTILLER_PROMPT,
        prompt: `Conversation history:\n---\n${params.transcript}\n---\n\nExtract facts:`,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama generation failed: ${response.statusText}`);
    }

    const data = (await response.json()) as { response: string };
    const distilledText = data.response.trim();

    if (distilledText.toUpperCase() === "NONE" || !distilledText) {
      log.info(`[auto-distill] No new facts extracted.`);
      return;
    }

    log.info(`[auto-distill] Extracted facts:\n${distilledText}`);

    const vectorStore = VectorStoreService.getInstance({
      dbPath: ragConfig.dbPath || "./data/memory.lance",
      embeddingModel: ragConfig.embeddingModel || "nomic-embed-text",
      localUrl: getLocalProcessorUrl(params.config),
    });

    const facts = distilledText
      .split("\n")
      .map((f) => f.replace(/^[-*•]\s+/, "").trim())
      .filter((f) => f.length > 10);

    for (const fact of facts) {
      await vectorStore.saveMemory(fact, {
        category: "auto-distilled",
        sourceSession: params.sessionKey,
      });
    }

    log.info(`[auto-distill] Successfully saved ${facts.length} facts to long-term memory.`);
  } catch (err) {
    log.error(`[auto-distill] Distillation failed: ${err}`);
  }
}
