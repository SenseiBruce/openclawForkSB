import { body } from "express-validator";
import Joi from "joi";
import { z } from "zod";

export const toolsInvokeExpressValidators = [
  body("tool").isString().notEmpty(),
  body("args").optional().isObject(),
];

export const operatorEmailSchema = Joi.string().email().optional();

export const toolsInvokeZodSchema = z
  .object({
    tool: z.string().min(1),
    action: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    sessionKey: z.string().optional(),
    dryRun: z.unknown().optional(),
  })
  .passthrough();

export const toolsInvokeJoiSchema = Joi.object({
  tool: Joi.string().min(1).required(),
  action: Joi.string().optional(),
  args: Joi.object().unknown(true).optional(),
  sessionKey: Joi.string().optional(),
  operatorEmail: operatorEmailSchema,
  dryRun: Joi.any().optional(),
}).unknown(true);

export type ToolsInvokeInput = z.infer<typeof toolsInvokeZodSchema>;

export function validateToolsInvokeInput(
  input: unknown,
): { ok: true; value: ToolsInvokeInput } | { ok: false; error: string } {
  const joiResult = toolsInvokeJoiSchema.validate(input, {
    abortEarly: true,
    allowUnknown: true,
    stripUnknown: false,
  });
  if (joiResult.error) {
    const firstPath = joiResult.error.details[0]?.path[0];
    if (firstPath === "tool") {
      return { ok: false, error: "tools.invoke requires body.tool" };
    }
    return { ok: false, error: `input validation failed: ${joiResult.error.message}` };
  }

  const zodResult = toolsInvokeZodSchema.safeParse(joiResult.value);
  if (!zodResult.success) {
    return { ok: false, error: "tools.invoke requires body.tool" };
  }
  return { ok: true, value: zodResult.data };
}
