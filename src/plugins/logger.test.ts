import { describe, expect, it } from "vitest";
import { pluginLogger } from "./logger.js";

describe("plugin structured logger", () => {
  it("creates a pino logger for plugins", () => {
    expect(pluginLogger.bindings().component).toBe("plugins");
    const previous = pluginLogger.level;
    pluginLogger.level = "silent";
    expect(() => pluginLogger.info("plugin loaded")).not.toThrow();
    pluginLogger.level = previous;
  });
});
