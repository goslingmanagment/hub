import type { FanslyBulkSyncStream } from "@agency_hub_core/db";
import type { AppConfig } from "@agency_hub_core/shared";

// The legacy executor's ramp gate, now only for the two money streams the
// legacy Fansly handlers still carry (fan_earnings, purchase_history). The
// content lanes and their fail-closed gates are gone (step 4, S4-18); this file
// goes with the money handlers (S4-16). Stream gates control egress, never
// capture.
export const GATED_FANSLY_STREAMS = [
  { stream: "fan_earnings", enabledField: "fanslyFanEarningsSyncEnabled" },
  { stream: "purchase_history", enabledField: "fanslyPurchaseHistorySyncEnabled" },
] as const satisfies readonly {
  stream: FanslyBulkSyncStream;
  enabledField: keyof AppConfig;
}[];

type FanslyStreamGate = (typeof GATED_FANSLY_STREAMS)[number];
type GatedFanslyStream = FanslyStreamGate["stream"];
type FanslyGateConfig = Partial<Pick<AppConfig, FanslyStreamGate["enabledField"] | "fanslyNewStreamPageAllowlist">>;

/**
 * FROZEN legacy semantic — empty/blank CSV = every page allowed (the Stage 16
 * ramp's "fully open" state). It gates ONLY `fan_earnings` and
 * `purchase_history`; wherever their allowlist key is empty, tightening this
 * to fail-closed would silently stop both streams. Every other allowlist
 * fails closed (`isPageAllowlisted` in `@agency_hub_core/shared`).
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

/** The flag/allowlist verdict the executor rechecks before egress. Platform
 *  checks stay at callers. */
export function evaluateFanslyStreamGate(
  config: FanslyGateConfig,
  stream: GatedFanslyStream,
  pageLabel: string,
): { state: FanslyStreamGateState } {
  const gate = GATED_FANSLY_STREAMS.find((entry) => entry.stream === stream)!;
  if (config[gate.enabledField] !== true) return { state: "flag_off" };
  return { state: fanslyNewStreamAllowed(config.fanslyNewStreamPageAllowlist, pageLabel) ? "ramped" : "not_allowlisted" };
}
