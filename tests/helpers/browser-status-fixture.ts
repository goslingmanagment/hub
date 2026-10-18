import type { AgentSyncBrowserStatus } from "@agency_hub_core/contracts";

// A page's browser as `/api/v1/sync/pages` says it (Project Browser PR 17):
// a browser that works, as of `BROWSER_NOW`; tests override what they show.

export const BROWSER_NOW = "2026-10-14T12:00:00.000Z";
const ago = (ms: number) => new Date(new Date(BROWSER_NOW).getTime() - ms).toISOString();

export function browserStatus(overrides: Partial<AgentSyncBrowserStatus> = {}): AgentSyncBrowserStatus {
  return {
    profileId: "11111111-2222-4333-8444-555555555555",
    container: "page-browser-lilly-1",
    transport: "browser",
    leavePendingSince: null,
    link: { lastStateAt: ago(4_000), stateAgeMs: 4_000, error: null },
    state: { step: "ready", stopReason: null, retryAt: null, exitOpen: true, mode: "automation", downSince: null, stopSince: null },
    ownerStop: null,
    halt: null,
    login: { needed: false, why: null },
    session: { present: true, accountId: "300000000000000001" },
    proxy: { pinnedExitIp: "203.0.113.7", pinnedAt: ago(86_400_000), exitIp: "203.0.113.7", matches: true, problem: null },
    buffer: { bytes: 1_572_864, oldestAgeMs: 900, percent: 0.1, capBytes: 2 * 1024 ** 3, capAgeMs: 72 * 3_600_000, haltedReason: null, haltedAt: null, undrainedSince: null },
    delivery: { lastEventAt: ago(3_000), lastCommitAt: ago(2_900), p50Ms: 45, p95Ms: 180, at: ago(30_000) },
    versions: { chrome: "155.0.7339.80", operator: "d8cb9ac" },
    selfTest: { ok: true, at: ago(3_600_000), failed: null },
    hubSend: { allowed: true, reason: null, since: null, forMs: null },
    crashDumps: { completed: { count: 0, newestAt: null }, pending: { count: 0, newestAt: null }, countedAt: ago(3_600_000) },
    egressFailures: { since: ago(86_400_000), socks: [], dnr: [] },
    lastAlarm: null,
    alerts: [],
    ...overrides,
  };
}
