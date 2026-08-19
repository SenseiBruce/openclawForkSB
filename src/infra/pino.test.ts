import { afterEach, describe, expect, it } from "vitest";
import { logError, logInfo, logWarn, structuredLogger } from "./pino.js";

describe("infra pino structured logger", () => {
  afterEach(() => {
    structuredLogger.level = "silent";
  });

  it("exposes a pino logger with json bindings", () => {
    expect(structuredLogger.bindings().name).toBe("openclaw");
    expect(structuredLogger.bindings().service).toBe("openclaw");
    expect(typeof structuredLogger.info).toBe("function");
  });

  it("accepts structured log calls without throwing", () => {
    structuredLogger.level = "silent";
    expect(() => logInfo("started", { component: "infra" })).not.toThrow();
    expect(() => logWarn("degraded", { component: "infra" })).not.toThrow();
    expect(() => logError("failed", { component: "infra" })).not.toThrow();
  });
});
