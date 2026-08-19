import pino from "pino";
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

import {
  captureGatewayException,
  initGatewaySentry,
  resetGatewaySentryForTests,
} from "./sentry.js";

describe("gateway observability integration", () => {
  afterEach(() => {
    delete process.env.SENTRY_DSN;
    resetGatewaySentryForTests();
    sentryMocks.captureException.mockReset();
  });

  it("writes one JSON log line and captures one Sentry event", () => {
    process.env.SENTRY_DSN = "https://public@o0.ingest.sentry.io/0";
    initGatewaySentry();

    const lines: string[] = [];
    const logger = pino(
      { level: "error", base: { service: "openclaw" } },
      {
        write(msg: string) {
          lines.push(msg);
        },
      },
    );
    const err = new Error("gateway crash");
    logger.error({ err }, "uncaught gateway error");
    captureGatewayException(err);

    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0] ?? "{}") as { msg?: string; service?: string };
    expect(payload.msg).toBe("uncaught gateway error");
    expect(payload.service).toBe("openclaw");
    expect(sentryMocks.captureException).toHaveBeenCalledTimes(1);
    expect(sentryMocks.captureException).toHaveBeenCalledWith(err);
  });
});
