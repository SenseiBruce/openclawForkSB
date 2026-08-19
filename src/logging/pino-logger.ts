import pino, { type Logger as PinoLogger } from "pino";
import type { LogLevel } from "./levels.js";

let cached: PinoLogger | null = null;
let cachedLevel: LogLevel | null = null;

function resolvePinoLevel(level: LogLevel): pino.LevelWithSilent {
  if (level === "silent") {
    return "silent";
  }
  if (
    level === "trace" ||
    level === "debug" ||
    level === "info" ||
    level === "warn" ||
    level === "error" ||
    level === "fatal"
  ) {
    return level;
  }
  return "info";
}

export function createPinoLogger(level: LogLevel): PinoLogger {
  const silentForTests =
    process.env.VITEST === "true" && process.env.OPENCLAW_TEST_FILE_LOG !== "1";
  return pino({
    name: "openclaw",
    level: silentForTests ? "silent" : resolvePinoLevel(level),
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { service: "openclaw" },
  });
}

export function getPinoLogger(level: LogLevel = "info"): PinoLogger {
  if (!cached || cachedLevel !== level) {
    cached = createPinoLogger(level);
    cachedLevel = level;
  }
  return cached;
}

export function resetPinoLogger(): void {
  cached = null;
  cachedLevel = null;
}
