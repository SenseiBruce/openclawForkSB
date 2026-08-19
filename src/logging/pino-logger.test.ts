import { afterEach, describe, expect, it } from "vitest";
import { createPinoLogger, getPinoLogger, resetPinoLogger } from "./pino-logger.js";

describe("pino structured logger", () => {
  afterEach(() => {
    resetPinoLogger();
  });

  it("creates a pino logger with the openclaw service name", () => {
    const logger = createPinoLogger("silent");
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
    expect(logger.bindings().name).toBe("openclaw");
  });

  it("reuses a singleton until reset", () => {
    const first = getPinoLogger("silent");
    const second = getPinoLogger("silent");
    expect(first).toBe(second);
    resetPinoLogger();
    expect(getPinoLogger("silent")).not.toBe(first);
  });
});
