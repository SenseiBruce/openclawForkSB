import pino from "pino";

export const agentLogger = pino({
  name: "openclaw-agent",
  level: process.env.OPENCLAW_LOG_LEVEL ?? "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: "openclaw", component: "agents" },
});
