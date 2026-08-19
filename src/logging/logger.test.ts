import { describe, expect, it } from "vitest";
import logger from "./logger.js";

describe("structured pino logger", () => {
  it("exports a pino logger instance", () => {
    expect(logger.bindings().name).toBe("openclaw");
    const previous = logger.level;
    logger.level = "silent";
    expect(() => logger.info({ component: "logging" }, "started")).not.toThrow();
    logger.level = previous;
  });
});
