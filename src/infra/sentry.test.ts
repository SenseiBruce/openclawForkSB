import { describe, expect, it } from "vitest";
import { initInfraSentry } from "./sentry.js";

describe("infra Sentry error tracking", () => {
  it("does not throw when SENTRY_DSN is unset", () => {
    const previous = process.env.SENTRY_DSN;
    delete process.env.SENTRY_DSN;
    expect(() => initInfraSentry()).not.toThrow();
    if (previous === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = previous;
    }
  });
});
