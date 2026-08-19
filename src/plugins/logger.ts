import pino from "pino";
import type { PluginLogger } from "./types.js";

export const pluginLogger = pino({
  name: "openclaw-plugin",
  level: process.env.OPENCLAW_LOG_LEVEL ?? "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: "openclaw", component: "plugins" },
});

type LoggerLike = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
};

export function createPluginLoaderLogger(logger: LoggerLike): PluginLogger {
  return {
    info: (msg) => logger.info(msg),
    warn: (msg) => logger.warn(msg),
    error: (msg) => logger.error(msg),
    debug: (msg) => logger.debug?.(msg),
  };
}
