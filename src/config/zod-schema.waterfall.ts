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
