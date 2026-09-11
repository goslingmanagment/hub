import { createHash } from "node:crypto";
import type { FanEarningsReceipt, FanEarningsRefreshWindow } from "@agency_hub_core/db";
import { parseFanslyEarningsObservation } from "../canonicalize/fansly-earnings.ts";

/** Reuse the monetary parser against the exact captured payload. A response
 * for a different fan or an empty result cannot certify this requested fan. */
export function buildFanEarningsReceipt(input: {
  pageId: number;
  fanRef: string;
  window: FanEarningsRefreshWindow;
  observationId: number | null;
  payload: unknown;
  checkedAt: Date;
}): FanEarningsReceipt {
  const receipt: FanEarningsReceipt = {
    outcome: "invalid", observationId: input.observationId,
    fingerprint: null, checkedAt: input.checkedAt,
  };
  if (input.observationId === null) return receipt;
  const parsed = parseFanslyEarningsObservation({
    id: input.observationId, source: "pull", producer: "sync:fansly:fan_earnings",
    platform: "fansly", accountId: input.pageId,
    kind: input.window === "lifetime" ? "fan_earnings_stats" : "fan_earnings_monthly",
    payload: input.payload, observedAt: input.checkedAt, receivedAt: input.checkedAt,
  });
  if (parsed.rejection || parsed.events.some((event) => event.fanIdentityRef !== input.fanRef)) {
    return receipt;
  }
  if (parsed.events.length === 0) return { ...receipt, outcome: "empty" };
  const windows = parsed.events.map((event) => [event.data.window, event.data.contentFingerprint]);
  windows.sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return {
    ...receipt, outcome: "observed",
    fingerprint: createHash("sha256").update(JSON.stringify(windows)).digest("hex"),
  };
}
