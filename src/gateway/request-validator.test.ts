import { describe, expect, it } from "vitest";
import { validateGatewayRequestInput } from "./request-validator.js";

describe("gateway request validator", () => {
  it("accepts a valid tools.invoke payload via joi and zod", () => {
    const result = validateGatewayRequestInput({
      tool: "agents_list",
      args: {},
    });
    expect(result.ok).toBe(true);
    expect(result.value?.tool).toBe("agents_list");
  });

  it("rejects missing tool through input validation patterns", () => {
    const result = validateGatewayRequestInput({ args: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/tool/i);
  });
});
