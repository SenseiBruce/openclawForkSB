import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { DEFAULT_WORKER_MODEL } from "../defaults.js";

const DEFAULT_LOCAL_URL = "http://localhost:11434/v1";
const DEFAULT_TIMEOUT_MS = 30000;

type OllamaResponse = {
  message?: {
    content?: string;
  };
  error?: {
    message?: string;
  };
};

export const LocalProcessorTool: AnyAgentTool = {
  label: "LocalProcessor",
  name: "local_processor",
  description:
    "Process data using a local AI model. Use for heavy data processing tasks like JSON formatting, " +
    "syntax fixing, timestamp extraction, or data transformation. This is a fast, stateless processor " +
    "that outputs only the requested format without explanations.",

  parameters: Type.Object({
    instruction: Type.String({
      description:
        "Clear instruction for what to do with the data. Be specific about the output format. " +
        "Example: 'Extract all timestamps and format as ISO 8601' or 'Fix JSON syntax errors'",
    }),
    data: Type.String({
      description: "The data to process. Can be JSON, text, logs, or any string data.",
    }),
  }),

  async execute(_toolCallId, args): Promise<AgentToolResult<unknown>> {
    const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const instruction = typeof record.instruction === "string" ? record.instruction.trim() : "";
    const data = typeof record.data === "string" ? record.data : "";

    if (!instruction) {
      throw new Error("instruction required");
    }
    if (!data) {
      throw new Error("data required");
    }

    const localUrl = process.env.LLM_LOCAL_URL?.trim() || DEFAULT_LOCAL_URL;
    const baseUrl = localUrl.replace("/v1", "");
    const workerModel = process.env.LLM_WORKER_MODEL || DEFAULT_WORKER_MODEL;
    const endpoint = `${baseUrl}/api/chat`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      const systemPrompt =
        "You are a data processing engine. Output ONLY the requested format. No explanations, no filler, no markdown formatting unless explicitly requested. Just the processed data.";

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: workerModel,
          messages: [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: `${instruction}\n\nData:\n${data}`,
            },
          ],
          stream: false,
          think: false,
          options: {
            temperature: 0.1,
            num_predict: 4096,
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(`Local processor HTTP ${response.status}: ${errorText}`);
      }

      const result = (await response.json()) as OllamaResponse;

      if (result.error) {
        throw new Error(`Local processor error: ${result.error.message ?? "Unknown error"}`);
      }

      const processedData = result.message?.content?.trim();

      if (!processedData) {
        throw new Error("Local processor returned empty response");
      }

      return {
        content: [
          {
            type: "text",
            text: processedData,
          },
        ],
        details: {
          instruction,
          inputLength: data.length,
          outputLength: processedData.length,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error in local processor";

      console.error(`[LocalProcessor] Failed to process data: ${errorMessage}`);

      return {
        content: [
          {
            type: "text",
            text: `Error: Local processor unavailable or failed. ${errorMessage}`,
          },
        ],
        details: {
          error: errorMessage,
          instruction,
          fallback: true,
        },
      };
    }
  },
};
