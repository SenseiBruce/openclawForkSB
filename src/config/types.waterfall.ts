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
