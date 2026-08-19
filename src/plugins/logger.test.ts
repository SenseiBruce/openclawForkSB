import { describe, expect, it, vi } from "vitest";
import { createPluginLoaderLogger, pluginLogger } from "./logger.js";

describe("plugins/logger", () => {
  it("forwards logger methods", () => {
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const debug = vi.fn();
    const logger = createPluginLoaderLogger({ info, warn, error, debug });

    logger.info("i");
    logger.warn("w");
    logger.error("e");
    logger.debug?.("d");

    expect(info).toHaveBeenCalledWith("i");
    expect(warn).toHaveBeenCalledWith("w");
    expect(error).toHaveBeenCalledWith("e");
    expect(debug).toHaveBeenCalledWith("d");
  });

  it("exposes a pino plugin logger", () => {
    expect(pluginLogger.bindings().component).toBe("plugins");
  });
});
