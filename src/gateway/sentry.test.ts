import { afterEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  init: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  init: sentryMocks.init,
  captureException: sentryMocks.captureException,
  close: vi.fn(),
}));

import { agentLogger } from "../agents/structured-logger.js";
import { structuredLogger } from "../infra/pino.js";
import {
  captureGatewayException,
  initGatewaySentry,
  isGatewaySentryEnabled,
  resetGatewaySentryForTests,
} from "./sentry.js";

describe("gateway Sentry error tracking", () => {
  afterEach(() => {
    delete process.env.SENTRY_DSN;
    resetGatewaySentryForTests();
    sentryMocks.init.mockReset();
    sentryMocks.captureException.mockReset();
  });

  it("is a no-op when SENTRY_DSN is unset", () => {
    delete process.env.SENTRY_DSN;
    expect(() => initGatewaySentry()).not.toThrow();
    expect(isGatewaySentryEnabled()).toBe(false);
    expect(() => captureGatewayException(new Error("unused"))).not.toThrow();
    expect(sentryMocks.captureException).not.toHaveBeenCalled();
  });

  it("does not throw when initializing with a blank DSN", () => {
    process.env.SENTRY_DSN = " ";
    expect(() => initGatewaySentry()).not.toThrow();
    expect(isGatewaySentryEnabled()).toBe(false);
  });

  it("emits one structured JSON log line and one Sentry event for an uncaught gateway error", () => {
    process.env.SENTRY_DSN = "https://public@o0.ingest.sentry.io/0";
    initGatewaySentry();
    expect(sentryMocks.init).toHaveBeenCalled();
    expect(isGatewaySentryEnabled()).toBe(true);

    const previousPino = structuredLogger.level;
    const previousAgent = agentLogger.level;
    structuredLogger.level = "silent";
    agentLogger.level = "silent";
    const err = new Error("uncaught gateway error");
    structuredLogger.error({ err, component: "gateway" }, "uncaught");
    captureGatewayException(err);
    structuredLogger.level = previousPino;
    agentLogger.level = previousAgent;

    expect(sentryMocks.captureException).toHaveBeenCalledTimes(1);
    expect(sentryMocks.captureException).toHaveBeenCalledWith(err);
  });
});
