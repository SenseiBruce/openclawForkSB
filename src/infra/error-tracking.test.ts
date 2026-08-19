import { afterEach, describe, expect, it } from "vitest";
import {
  captureException,
  initErrorTracking,
  isErrorTrackingEnabled,
  resetErrorTrackingForTests,
} from "./error-tracking.js";

describe("sentry error tracking", () => {
  afterEach(() => {
    delete process.env.SENTRY_DSN;
    resetErrorTrackingForTests();
  });

  it("stays disabled when SENTRY_DSN is missing", () => {
    delete process.env.SENTRY_DSN;
    initErrorTracking();
    expect(isErrorTrackingEnabled()).toBe(false);
    expect(() => captureException(new Error("unused"))).not.toThrow();
  });

  it("does not initialize from a blank DSN", () => {
    process.env.SENTRY_DSN = "   ";
    initErrorTracking();
    expect(isErrorTrackingEnabled()).toBe(false);
  });
});
