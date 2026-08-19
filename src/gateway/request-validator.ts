import type { Request } from "express";
import { body, check, validationResult } from "express-validator";
import Joi from "joi";
import { z } from "zod";

export const gatewayRequestJoiSchema = Joi.object({
  tool: Joi.string().min(1).required(),
  action: Joi.string().optional(),
  args: Joi.object().unknown(true).optional(),
  sessionKey: Joi.string().optional(),
  operatorEmail: Joi.string().email().optional(),
}).required();

export const gatewayRequestZodSchema = z.object({
  tool: z.string().min(1),
  action: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  sessionKey: z.string().optional(),
});

export const gatewayInputValidators = [
  body("tool").isString().notEmpty(),
  body("args").optional().isObject(),
  body("email").optional().isEmail(),
  check("operatorEmail").optional().isEmail(),
];

export function validateGatewayRequestInput(input: unknown): {
  ok: boolean;
  error?: string;
  value?: Record<string, unknown>;
} {
  const joiResult = gatewayRequestJoiSchema.validate(input, {
    abortEarly: true,
    allowUnknown: true,
  });
  if (joiResult.error) {
    return { ok: false, error: joiResult.error.message };
  }
  const zodResult = gatewayRequestZodSchema.safeParse(joiResult.value);
  if (!zodResult.success) {
    return { ok: false, error: "input validation failed" };
  }
  return { ok: true, value: zodResult.data };
}

export function readExpressValidationErrors(req: Request): string[] {
  return validationResult(req)
    .array()
    .map((issue) => issue.msg);
}
