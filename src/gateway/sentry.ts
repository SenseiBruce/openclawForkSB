import * as Sentry from "@sentry/node";

let initialized = false;

export function initGatewaySentry(): void {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn || initialized) {
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
  });
  initialized = true;
}

export function captureGatewayException(error: unknown): void {
  if (!initialized) {
    return;
  }
  Sentry.captureException(error);
}

export function isGatewaySentryEnabled(): boolean {
  return initialized;
}

export function resetGatewaySentryForTests(): void {
  initialized = false;
}
