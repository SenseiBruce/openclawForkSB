import { describe, expect, it } from "vitest";
import { validateToolsInvokeInput } from "./http-input-validation.js";

describe("HTTP input validation", () => {
  it("accepts a valid tools.invoke body via joi + zod", () => {
    const result = validateToolsInvokeInput({
      tool: "agents_list",
      action: "json",
      args: {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tool).toBe("agents_list");
    }
  });

  it("rejects a missing tool with the stable HTTP error", () => {
    const result = validateToolsInvokeInput({ args: {} });
    expect(result).toEqual({ ok: false, error: "tools.invoke requires body.tool" });
  });

  it("rejects a non-object payload", () => {
    const result = validateToolsInvokeInput("not-json-object");
    expect(result.ok).toBe(false);
  });
});
