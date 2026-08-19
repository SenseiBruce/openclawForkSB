import { describe, expect, it } from "vitest";
import { parseConnectParams, parseRequestFrame, safeParseRequestFrame } from "./schemas.js";

describe("gateway RequestFrame and ConnectParams schemas", () => {
  it("parses a valid request frame", () => {
    const frame = parseRequestFrame({
      type: "req",
      id: "1",
      method: "connect",
      params: {},
    });
    expect(frame.method).toBe("connect");
  });

  it("rejects a malformed request frame", () => {
    const result = safeParseRequestFrame({ type: "event", id: "1" });
    expect(result.ok).toBe(false);
    expect(() => parseRequestFrame({ type: "req" })).toThrow();
  });

  it("rejects connect params missing protocol bounds", () => {
    expect(() =>
      parseConnectParams({
        client: { id: "cli", version: "1", platform: "test" },
      }),
    ).toThrow();
  });
});
