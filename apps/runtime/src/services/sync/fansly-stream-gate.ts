import type { FanslyBulkSyncStream } from "@agency_hub_core/db";
import type { AppConfig } from "@agency_hub_core/shared";

// Stream gates control egress, never capture. Only the two legacy streams use
// the shared empty-allowlist = ALL rule; each newer lane fails closed.
export const GATED_FANSLY_STREAMS = [
  { stream: "fan_earnings", enabledField: "fanslyFanEarningsSyncEnabled", failClosedAllowlistField: null },
  { stream: "purchase_history", enabledField: "fanslyPurchaseHistorySyncEnabled", failClosedAllowlistField: null },
  {
    stream: "stats_snapshot",
    enabledField: "fanslyStatsSnapshotSyncEnabled",
    failClosedAllowlistField: "fanslyStatsSnapshotPageAllowlist",
  },
  {
    stream: "notifications",
    enabledField: "fanslyNotificationsSyncEnabled",
    failClosedAllowlistField: "fanslyNotificationsPageAllowlist",
  },
  {
    stream: "catalog",
    enabledField: "fanslyCatalogSyncEnabled",
    failClosedAllowlistField: "fanslyCatalogPageAllowlist",
  },
  {
    stream: "post_replies",
    enabledField: "fanslyPostRepliesSyncEnabled",
    failClosedAllowlistField: "fanslyPostRepliesPageAllowlist",
  },
  {
    stream: "payouts",
    enabledField: "fanslyPayoutsSyncEnabled",
    failClosedAllowlistField: "fanslyPayoutsPageAllowlist",
  },
  {
    stream: "media_stats",
    enabledField: "fanslyMediaStatsSyncEnabled",
    failClosedAllowlistField: "fanslyMediaStatsPageAllowlist",
  },
] as const satisfies readonly {
  stream: FanslyBulkSyncStream;
  enabledField: keyof AppConfig;
  failClosedAllowlistField: keyof AppConfig | null;
}[];

type FanslyStreamGate = (typeof GATED_FANSLY_STREAMS)[number];
type GatedFanslyStream = FanslyStreamGate["stream"];
type FanslyGateConfigKey = FanslyStreamGate["enabledField"]
  | Exclude<FanslyStreamGate["failClosedAllowlistField"], null>
  | "fanslyNewStreamPageAllowlist";
type FanslyGateConfig = Partial<Pick<AppConfig, FanslyGateConfigKey>>;

/**
 * The CANONICAL fail-closed allowlist: an empty, blank or unset CSV allows NO
 * page. Every new gated mode uses this one; `fanslyNewStreamAllowed` below is
 * NOT a template for new code.
 */
export function isPageAllowlisted(csv: string | undefined, pageLabel: string): boolean {
  // Empty (or unset) = NONE — the allowlist fails CLOSED.
  if (!csv) {
    return false;
  }
  return csv
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .includes(pageLabel);
}

/**
 * FROZEN legacy semantic — empty/blank CSV = every page allowed (the Stage 16
 * ramp's "fully open" state). It gates ONLY `fan_earnings` and
 * `purchase_history`; wherever their allowlist key is empty, tightening this
 * to fail-closed would silently stop both streams. New modes
 * use `isPageAllowlisted` above.
 */
export function fanslyNewStreamAllowed(
  allowlistCsv: string | undefined,
  pageLabel: string,
) {
  const entries = (allowlistCsv ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length === 0 || entries.includes(pageLabel);
}

export type FanslyStreamGateState = "ramped" | "flag_off" | "not_allowlisted";

/** The same flag/allowlist verdict feeds scheduling, wake-ups, reporting and
 * the executor's live recheck before egress. Platform checks stay at callers. */
export function evaluateFanslyStreamGate(
  config: FanslyGateConfig,
  stream: GatedFanslyStream,
  pageLabel: string,
): { state: FanslyStreamGateState; flagEnabled: boolean; allowlisted: boolean } {
  const gate = GATED_FANSLY_STREAMS.find((entry) => entry.stream === stream)!;
  const flagEnabled = config[gate.enabledField] === true;
  const allowlisted = gate.failClosedAllowlistField === null
    ? fanslyNewStreamAllowed(config.fanslyNewStreamPageAllowlist, pageLabel)
    : isPageAllowlisted(config[gate.failClosedAllowlistField], pageLabel);
  return {
    state: !flagEnabled ? "flag_off" : allowlisted ? "ramped" : "not_allowlisted",
    flagEnabled,
    allowlisted,
  };
}
