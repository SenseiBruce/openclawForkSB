import pino from "pino";
import { createSubsystemLogger } from "../../logging/subsystem.js";

export const embeddedPino = pino({
  name: "agent-embedded",
  level: process.env.OPENCLAW_LOG_LEVEL ?? "info",
  base: { service: "openclaw", component: "agents" },
});

export const log = createSubsystemLogger("agent/embedded");
