import { expect } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SecurityAuditOptions, SecurityAuditReport } from "./audit.js";
import { runSecurityAudit } from "./audit.js";

export { runSecurityAudit };

export const isWindows = process.platform === "win32";
export const windowsAuditEnv = {
  USERNAME: "Tester",
  USERDOMAIN: "DESKTOP-TEST",
};
export const execDockerRawUnavailable: NonNullable<
  SecurityAuditOptions["execDockerRawFn"]
> = async () => {
  return {
    stdout: Buffer.alloc(0),
    stderr: Buffer.from("docker unavailable"),
    code: 1,
  };
};

export function stubChannelPlugin(params: {
  id: "discord" | "slack" | "telegram" | "zalouser";
  label: string;
  resolveAccount: (cfg: OpenClawConfig, accountId: string | null | undefined) => unknown;
  inspectAccount?: (cfg: OpenClawConfig, accountId: string | null | undefined) => unknown;
  listAccountIds?: (cfg: OpenClawConfig) => string[];
  isConfigured?: (account: unknown, cfg: OpenClawConfig) => boolean;
  isEnabled?: (account: unknown, cfg: OpenClawConfig) => boolean;
}): ChannelPlugin {
  return {
    id: params.id,
    meta: {
      id: params.id,
      label: params.label,
      selectionLabel: params.label,
      docsPath: "/docs/testing",
      blurb: "test stub",
    },
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    security: {},
    config: {
      listAccountIds:
        params.listAccountIds ??
        ((cfg) => {
          const enabled = Boolean(
            (cfg.channels as Record<string, unknown> | undefined)?.[params.id],
          );
          return enabled ? ["default"] : [];
        }),
      inspectAccount: params.inspectAccount,
      resolveAccount: (cfg, accountId) => params.resolveAccount(cfg, accountId),
      isEnabled: (account, cfg) => params.isEnabled?.(account, cfg) ?? true,
      isConfigured: (account, cfg) => params.isConfigured?.(account, cfg) ?? true,
    },
  };
}

export const discordPlugin = stubChannelPlugin({
  id: "discord",
  label: "Discord",
  listAccountIds: (cfg) => {
    const ids = Object.keys(cfg.channels?.discord?.accounts ?? {});
    return ids.length > 0 ? ids : ["default"];
  },
  resolveAccount: (cfg, accountId) => {
    const resolvedAccountId = typeof accountId === "string" && accountId ? accountId : "default";
    const base = cfg.channels?.discord ?? {};
    const account = cfg.channels?.discord?.accounts?.[resolvedAccountId] ?? {};
    return { config: { ...base, ...account } };
  },
});

export const slackPlugin = stubChannelPlugin({
  id: "slack",
  label: "Slack",
  listAccountIds: (cfg) => {
    const ids = Object.keys(cfg.channels?.slack?.accounts ?? {});
    return ids.length > 0 ? ids : ["default"];
  },
  resolveAccount: (cfg, accountId) => {
    const resolvedAccountId = typeof accountId === "string" && accountId ? accountId : "default";
    const base = cfg.channels?.slack ?? {};
    const account = cfg.channels?.slack?.accounts?.[resolvedAccountId] ?? {};
    return { config: { ...base, ...account } };
  },
});

export const telegramPlugin = stubChannelPlugin({
  id: "telegram",
  label: "Telegram",
  listAccountIds: (cfg) => {
    const ids = Object.keys(cfg.channels?.telegram?.accounts ?? {});
    return ids.length > 0 ? ids : ["default"];
  },
  resolveAccount: (cfg, accountId) => {
    const resolvedAccountId = typeof accountId === "string" && accountId ? accountId : "default";
    const base = cfg.channels?.telegram ?? {};
    const account = cfg.channels?.telegram?.accounts?.[resolvedAccountId] ?? {};
    return { config: { ...base, ...account } };
  },
});

export const zalouserPlugin = stubChannelPlugin({
  id: "zalouser",
  label: "Zalo Personal",
  listAccountIds: (cfg) => {
    const channel = (cfg.channels as Record<string, unknown> | undefined)?.zalouser as
      | { accounts?: Record<string, unknown> }
      | undefined;
    const ids = Object.keys(channel?.accounts ?? {});
    return ids.length > 0 ? ids : ["default"];
  },
  resolveAccount: (cfg, accountId) => {
    const resolvedAccountId = typeof accountId === "string" && accountId ? accountId : "default";
    const channel = (cfg.channels as Record<string, unknown> | undefined)?.zalouser as
      | { accounts?: Record<string, unknown> }
      | undefined;
    const base = (channel ?? {}) as Record<string, unknown>;
    const account = channel?.accounts?.[resolvedAccountId] ?? {};
    return { config: { ...base, ...account } };
  },
});

export function successfulProbeResult(url: string) {
  return {
    ok: true,
    url,
    connectLatencyMs: 1,
    error: null,
    close: null,
    health: null,
    status: null,
    presence: null,
    configSnapshot: null,
  };
}

export async function audit(
  cfg: OpenClawConfig,
  extra?: Omit<SecurityAuditOptions, "config">,
): Promise<SecurityAuditReport> {
  return runSecurityAudit({
    config: cfg,
    includeFilesystem: false,
    includeChannelSecurity: false,
    ...extra,
  });
}

export function hasFinding(res: SecurityAuditReport, checkId: string, severity?: string): boolean {
  return res.findings.some(
    (f) => f.checkId === checkId && (severity == null || f.severity === severity),
  );
}

export function expectFinding(res: SecurityAuditReport, checkId: string, severity?: string): void {
  expect(hasFinding(res, checkId, severity)).toBe(true);
}

export function expectNoFinding(res: SecurityAuditReport, checkId: string): void {
  expect(hasFinding(res, checkId)).toBe(false);
}
