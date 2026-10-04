import { describe, expect, it } from "vitest";

import {
  getSyncStreamsForPlatform,
  isLegacyExecutorStream,
  SYNC_DOMAIN_POLICY,
  SYNC_STREAM_DEPENDENCIES,
  SYNC_STREAM_POLICY,
  SYNC_STREAMS,
} from "@agency_hub_core/db";
import { CONFIG_DESCRIPTORS, ENV_CONFIG_KEYS } from "@agency_hub_core/shared";

import { MONITORED_SYNC_STREAMS } from "../apps/runtime/src/services/sync-monitor.ts";

// The Fansly content lanes of the WP-F series (stats_snapshot, notifications,
// catalog, post_replies, payouts, media_stats), fan_earnings and
// purchase_history were legacy page-sync streams with a policy row, a seed
// rule, a rollout gate and a monitor entry each. Step 4 deleted the lanes
// (S4-16, S4-18) and then their rows (S4-24): the Fansly Sync Engine's registry
// reads these resources. What is pinned here is that nothing of the legacy
// wiring is left for them, their config keys included (S4-26).

const FORMER_FANSLY_LANES = [
  "followers", "followers_reconcile", "dm_messages", "fan_earnings", "purchase_history",
  "stats_snapshot", "notifications", "catalog", "post_replies", "payouts", "media_stats",
] as const;

describe("the former Fansly lanes have no legacy wiring", () => {
  it("keeps each name in the stream vocabulary (the database enum and its rows stay)", () => {
    for (const stream of FORMER_FANSLY_LANES) expect(SYNC_STREAMS, stream).toContain(stream);
  });

  it("gives none a policy row, a dependency, a block or a monitor entry", () => {
    const policyRows = Object.keys(SYNC_STREAM_POLICY);
    const dependencyStreams = [...Object.keys(SYNC_STREAM_DEPENDENCIES), ...Object.values(SYNC_STREAM_DEPENDENCIES).flat()];
    const blockStreams = Object.values(SYNC_DOMAIN_POLICY)
      .flatMap((domain) => [...domain.primaryStreams, ...domain.supportingStreams]);
    for (const stream of FORMER_FANSLY_LANES) {
      expect(isLegacyExecutorStream(stream), stream).toBe(false);
      expect(policyRows, stream).not.toContain(stream);
      expect(dependencyStreams, stream).not.toContain(stream);
      expect(blockStreams, stream).not.toContain(stream);
      expect(MONITORED_SYNC_STREAMS, stream).not.toContain(stream);
    }
  });

  it("the legacy executor runs no stream on a Fansly page", () => {
    expect(getSyncStreamsForPlatform("fansly")).toEqual([]);
  });

  // A28-4's negative pins. These mechanisms were DELETED, and a key reappearing
  // is how a deleted mechanism comes back without a decision.
  it("adds no global per-page request cap, no byte ceiling and no per-egress-key day counter", () => {
    const keys = new Set(CONFIG_DESCRIPTORS.map((descriptor) => descriptor.key));
    // [A19]: no global per-page daily request cap.
    expect(keys.has("fanslyPageDailyRequestCap")).toBe(false);
    // [A20]: no byte ceiling, and therefore no byte-budget deferral anywhere.
    expect(keys.has("fanslyUntrimmedCaptureByteCeilingPerDay")).toBe(false);
    expect(keys.has("syncRateLimitDays")).toBe(false);
    // A28-4: the §3.5 per-egress-key DAY counter and the 2×-of-norm ops signal
    // were deleted.
    expect(keys.has("fanslyEgressKeyDailyRequestCap")).toBe(false);
    expect(keys.has("syncRateLimitDaysRetentionDays")).toBe(false);
  });
});

// Step 4 retired the legacy content lanes: the Fansly Sync Engine's registry
// paces these resources, so their stream flags, page allowlists, daily call
// budgets, hourly switches, long-tail cycle and continuation delay had no
// reader, and S4-26 removed the keys (and their stored overrides) together.
describe("the legacy content lanes left no config key", () => {
  it("registers no switch, page allowlist, call budget or cadence of a content lane", () => {
    const laneKey = /^fansly(StatsSnapshot|StatsHourly|Notifications|Catalog|PostReplies|Replies|Payouts|MediaStats|PostEngagement|BackfillContinuation)/;
    expect(CONFIG_DESCRIPTORS.map((descriptor) => descriptor.key).filter((key) => laneKey.test(key)))
      .toEqual(["fanslyRepliesRewalkCycleDays"]);
    const laneEnv = /^FANSLY_(STATS_SNAPSHOT|STATS_HOURLY|NOTIFICATIONS|CATALOG|POST_REPLIES|REPLIES|PAYOUTS|MEDIA_STATS|POST_ENGAGEMENT|BACKFILL_CONTINUATION)_/;
    expect(ENV_CONFIG_KEYS.filter((key) => laneEnv.test(key))).toEqual(["FANSLY_REPLIES_REWALK_CYCLE_DAYS"]);
    // No key of any kind is a daily call budget of a Fansly lane: the route
    // budgets are code constants (the engine's route table).
    expect(CONFIG_DESCRIPTORS.filter((descriptor) => /^fansly.*DailyCallBudget$/.test(descriptor.key))).toEqual([]);
  });

  it("keeps the replies re-walk cycle live: it changes which posts, never the request rate", () => {
    const cycle = CONFIG_DESCRIPTORS.find((descriptor) => descriptor.key === "fanslyRepliesRewalkCycleDays");
    expect(cycle?.kind).toBe("number");
    expect(cycle?.default).toBe("14");
    expect(cycle?.runtimeApply).toBe("live");
    // The wording matters: a tunable that looks like a throttle gets edited
    // like one.
    expect(cycle?.costWarning).toMatch(/does not raise the request rate/i);
  });

  it("adds no media-stats age boundary as a key", () => {
    // The age tiers are the engine registry's (owner decision №6), not knobs.
    const keys = new Set(CONFIG_DESCRIPTORS.map((descriptor) => descriptor.key));
    expect(keys.has("fanslyMediaStatsFreshDays")).toBe(false);
    expect(keys.has("fanslyMediaStatsMidDays")).toBe(false);
    expect(keys.has("fanslyMediaStatsFreshIntervalDays")).toBe(false);
    expect(keys.has("fanslyMediaStatsWindowDays")).toBe(false);
  });
});
