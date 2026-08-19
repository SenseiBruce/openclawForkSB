import { describe, expect, it } from "vitest";
import { validateInboundMessage } from "./input-validation.js";

describe("gateway inbound input validation", () => {
  it("accepts a well-formed channel payload", () => {
    expect(
      validateInboundMessage({
        channel: "telegram",
        sender: "123",
        text: "hello",
      }).ok,
    ).toBe(true);
  });

  it("rejects missing sender through joi and zod", () => {
    const result = validateInboundMessage({ channel: "telegram", text: "hello" });
    expect(result.ok).toBe(false);
  });
});
