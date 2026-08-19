import { body, check, validationResult } from "express-validator";
import Joi from "joi";
import { z } from "zod";

export const inboundMessageJoiSchema = Joi.object({
  channel: Joi.string().min(1).required(),
  sender: Joi.string().min(1).required(),
  text: Joi.string().allow("").required(),
  email: Joi.string().email().optional(),
});

export const inboundMessageZodSchema = z.object({
  channel: z.string().min(1),
  sender: z.string().min(1),
  text: z.string(),
  email: z.string().email().optional(),
});

export const inboundMessageValidators = [
  body("channel").isString().notEmpty(),
  body("sender").isString().notEmpty(),
  body("text").isString(),
  check("email").optional().isEmail(),
];

export function validateInboundMessage(input: unknown): {
  ok: boolean;
  error?: string;
} {
  const joiResult = inboundMessageJoiSchema.validate(input, { abortEarly: true });
  if (joiResult.error) {
    return { ok: false, error: joiResult.error.message };
  }
  const parsed = inboundMessageZodSchema.safeParse(joiResult.value);
  if (!parsed.success) {
    return { ok: false, error: "input validation failed" };
  }
  return { ok: true };
}

export { validationResult };
