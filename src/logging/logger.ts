import pino from "pino";

export const logger = pino({
  name: "openclaw",
  level: process.env.OPENCLAW_LOG_LEVEL ?? "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: "openclaw", component: "logging" },
});

export default logger;
