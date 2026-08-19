import { z } from "zod";

export const ConnectParamsSchema = z
  .object({
    minProtocol: z.number().int().min(1),
    maxProtocol: z.number().int().min(1),
    client: z
      .object({
        id: z.string().min(1),
        displayName: z.string().min(1).optional(),
        version: z.string().min(1),
        platform: z.string().min(1),
        mode: z.string().min(1).optional(),
      })
      .passthrough(),
    caps: z.array(z.string()).optional(),
    role: z.string().optional(),
    scopes: z.array(z.string()).optional(),
    auth: z
      .object({
        token: z.string().optional(),
        password: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

export const RequestFrameSchema = z
  .object({
    type: z.literal("req"),
    id: z.string().min(1),
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .passthrough();

export type GatewayRequestFrame = z.infer<typeof RequestFrameSchema>;
export type GatewayConnectParams = z.infer<typeof ConnectParamsSchema>;

export function parseRequestFrame(input: unknown): GatewayRequestFrame {
  return RequestFrameSchema.parse(input);
}

export function parseConnectParams(input: unknown): GatewayConnectParams {
  return ConnectParamsSchema.parse(input);
}

export function safeParseRequestFrame(input: unknown): {
  ok: boolean;
  error?: string;
  value?: GatewayRequestFrame;
} {
  const result = RequestFrameSchema.safeParse(input);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true, value: result.data };
}
