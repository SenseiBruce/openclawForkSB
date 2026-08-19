import pino from "pino";

export const pluginLogger = pino({
  name: "openclaw-plugin",
  level: process.env.OPENCLAW_LOG_LEVEL ?? "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: "openclaw", component: "plugins" },
});
