import { afterEach, describe, expect, it } from "vitest";
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
  });

  it("is a no-op when SENTRY_DSN is unset", () => {
    delete process.env.SENTRY_DSN;
    expect(() => initGatewaySentry()).not.toThrow();
    expect(isGatewaySentryEnabled()).toBe(false);
    expect(() => captureGatewayException(new Error("unused"))).not.toThrow();
  });

  it("does not throw when initializing with a blank DSN", () => {
    process.env.SENTRY_DSN = " ";
    expect(() => initGatewaySentry()).not.toThrow();
    expect(isGatewaySentryEnabled()).toBe(false);
  });
});
