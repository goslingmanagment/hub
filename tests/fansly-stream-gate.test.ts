import { describe, expect, it } from "vitest";

import { FANSLY_BULK_SYNC_STREAMS } from "@agency_hub_core/db";
import {
  evaluateFanslyStreamGate,
  fanslyNewStreamAllowed,
  GATED_FANSLY_STREAMS,
  isPageAllowlisted,
} from "../apps/runtime/src/services/sync/fansly-stream-gate.ts";

describe("Fansly allowlist primitives", () => {
  it.each([undefined, "", "  ", " , ,"])("keeps opposite empty CSV semantics for %j", (csv) => {
    expect(fanslyNewStreamAllowed(csv, "lilly-1")).toBe(true);
    expect(isPageAllowlisted(csv, "lilly-1")).toBe(false);
  });

  it.each([fanslyNewStreamAllowed, isPageAllowlisted])("matches labels exactly after trimming CSV whitespace", (allows) => {
    expect(allows("lilly-1", "lilly-1")).toBe(true);
    expect(allows(" lilly-1 , ari-2", "ari-2")).toBe(true);
    expect(allows("lilly-1,ari-2", "lora-3")).toBe(false);
    expect(allows("lilly", "lilly-1")).toBe(false);
    expect(allows("Lilly-1", "lilly-1")).toBe(false);
  });
});

// Expected wiring is explicit so a swapped flag/allowlist cannot pass by
// deriving both the fixture and the assertion from the production table.
const cases = [
  ["fan_earnings", "fanslyFanEarningsSyncEnabled", "fanslyNewStreamPageAllowlist", true],
  ["purchase_history", "fanslyPurchaseHistorySyncEnabled", "fanslyNewStreamPageAllowlist", true],
  ["stats_snapshot", "fanslyStatsSnapshotSyncEnabled", "fanslyStatsSnapshotPageAllowlist", false],
  ["notifications", "fanslyNotificationsSyncEnabled", "fanslyNotificationsPageAllowlist", false],
  ["catalog", "fanslyCatalogSyncEnabled", "fanslyCatalogPageAllowlist", false],
  ["post_replies", "fanslyPostRepliesSyncEnabled", "fanslyPostRepliesPageAllowlist", false],
  ["payouts", "fanslyPayoutsSyncEnabled", "fanslyPayoutsPageAllowlist", false],
  ["media_stats", "fanslyMediaStatsSyncEnabled", "fanslyMediaStatsPageAllowlist", false],
] as const;

describe("Fansly stream gates", () => {
  it("covers every durable bulk stream exactly once", () => {
    expect(GATED_FANSLY_STREAMS.map((gate) => gate.stream)).toEqual([...FANSLY_BULK_SYNC_STREAMS]);
  });

  describe.each(cases)("%s", (stream, enabledField, allowlistField, emptyAllows) => {
    it.each([undefined, "", "  ", " , ,"])("keeps its own empty allowlist rule for %j", (csv) => {
      expect(evaluateFanslyStreamGate({
        [enabledField]: true,
        [allowlistField]: csv,
      }, stream, "lilly-1")).toEqual({
        state: emptyAllows ? "ramped" : "not_allowlisted",
        flagEnabled: true,
        allowlisted: emptyAllows,
      });
    });

    it("uses its configured keys and reports independent flag/allowlist facts", () => {
      expect(evaluateFanslyStreamGate({
        [enabledField]: true,
        [allowlistField]: " lilly-1 , ari-2 ",
      }, stream, "lilly-1")).toEqual({ state: "ramped", flagEnabled: true, allowlisted: true });
      expect(evaluateFanslyStreamGate({
        [enabledField]: false,
        [allowlistField]: "lilly-1",
      }, stream, "lilly-1")).toEqual({ state: "flag_off", flagEnabled: false, allowlisted: true });
      expect(evaluateFanslyStreamGate({
        [enabledField]: true,
        [allowlistField]: "other-page",
      }, stream, "lilly-1")).toEqual({ state: "not_allowlisted", flagEnabled: true, allowlisted: false });
      expect(evaluateFanslyStreamGate({
        [enabledField]: false,
        [allowlistField]: "other-page",
      }, stream, "lilly-1")).toEqual({ state: "flag_off", flagEnabled: false, allowlisted: false });
    });

    it("does not borrow a different stream's flag or allowlist", () => {
      const unrelated = Object.fromEntries(cases
        .filter(([, flag]) => flag !== enabledField)
        .flatMap(([, flag, allowlist]) => [[flag, true], [allowlist, "lilly-1"]]));
      expect(evaluateFanslyStreamGate(unrelated, stream, "lilly-1").state).toBe("flag_off");
      if (!emptyAllows) {
        expect(evaluateFanslyStreamGate({
          ...unrelated,
          [enabledField]: true,
        }, stream, "lilly-1").state).toBe("not_allowlisted");
      }
    });
  });
});
