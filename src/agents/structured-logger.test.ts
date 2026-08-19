import { describe, expect, it } from "vitest";
import { agentLogger } from "./structured-logger.js";

describe("agent structured logger", () => {
  it("creates a pino logger for the agents subsystem", () => {
    expect(agentLogger.bindings().name).toBe("openclaw-agent");
    expect(agentLogger.bindings().component).toBe("agents");
    const previous = agentLogger.level;
    agentLogger.level = "silent";
    expect(() => agentLogger.info({ runId: "test" }, "agent started")).not.toThrow();
    agentLogger.level = previous;
  });
});
