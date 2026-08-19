import * as Sentry from "@sentry/node";

let initialized = false;

export function initErrorTracking(): void {
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

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!initialized) {
    return;
  }
  Sentry.captureException(error, { extra: context });
}

export async function flushErrorTracking(timeoutMs = 2000): Promise<boolean> {
  if (!initialized) {
    return true;
  }
  return Sentry.close(timeoutMs);
}

export function isErrorTrackingEnabled(): boolean {
  return initialized;
}

export function resetErrorTrackingForTests(): void {
  initialized = false;
}
