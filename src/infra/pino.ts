import pino from "pino";

export const structuredLogger = pino({
  name: "openclaw",
  level: process.env.OPENCLAW_LOG_LEVEL ?? "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: "openclaw", component: "infra" },
});

export function logInfo(message: string, extra?: Record<string, unknown>): void {
  structuredLogger.info(extra ?? {}, message);
}

export function logError(message: string, extra?: Record<string, unknown>): void {
  structuredLogger.error(extra ?? {}, message);
}

export function logWarn(message: string, extra?: Record<string, unknown>): void {
  structuredLogger.warn(extra ?? {}, message);
}
