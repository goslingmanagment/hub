import { describe, expect, it } from "vitest";

import {
  FANSLY_BULK_SYNC_STREAMS,
  getSyncStreamsForPlatform,
  isSeedPausedSyncStream,
  SEED_PAUSED_SYNC_STREAMS,
  SYNC_DOMAIN_POLICY,
  SYNC_STREAM_DEPENDENCIES,
  SYNC_STREAM_POLICY,
  SYNC_STREAMS,
} from "@agency_hub_core/db";
import { PLATFORM_STREAMS } from "@agency_hub_core/platform-core";
import { CONFIG_DESCRIPTORS } from "@agency_hub_core/shared";

import { onlyfansPlatformAdapter } from "../apps/runtime/src/platforms/registry.ts";
import { FANSLY_ENGINE_SCOPE_STREAMS } from "../apps/runtime/src/services/sync-engine-levers.ts";
import { MONITORED_SYNC_STREAMS } from "../apps/runtime/src/services/sync-monitor.ts";
import {
  BULK_ENRICHMENT_SYNC_STREAMS,
  isBulkEnrichmentSyncStream,
} from "../apps/runtime/src/services/sync-ux.ts";

// WP-F1 — the §3.3 wiring checklist, as assertions.
//
// v1 of the plan listed nine sites and called them verified; five load-bearing
// ones were missing and its claim that new streams are "default-paused per page
// at seed" was false. This file is what makes the next stream's checklist
// checkable instead of remembered.

describe("stats_snapshot stream wiring", () => {
  it("is a Fansly-only stream, present in every stream vocabulary", () => {
    expect(SYNC_STREAMS).toContain("stats_snapshot");
    // The platform-core vocabulary mirrors SYNC_STREAMS EXACTLY (the
    // conformance suite pins the two equal), and adapter conformance turns a
    // declared-but-unhandled stream into a BOOT crash rather than a 500.
    expect([...PLATFORM_STREAMS]).toEqual([...SYNC_STREAMS]);
    expect(getSyncStreamsForPlatform("fansly")).toContain("stats_snapshot");
    expect(getSyncStreamsForPlatform("onlyfans")).not.toContain("stats_snapshot");
    expect(onlyfansPlatformAdapter.capabilities.streams).not.toContain("stats_snapshot");
  });

  it("carries a maintenance policy that never runs ahead of transactions or DMs", () => {
    const policy = SYNC_STREAM_POLICY.stats_snapshot;
    expect(policy.cadenceSeconds).toBe(21_600);
    expect(policy.defaultWorkClass).toBe("maintenance");
    expect(policy.freshnessSlaSeconds).toBeNull();
    expect(policy.basePriority).toBeLessThan(SYNC_STREAM_POLICY.dm_messages.basePriority);
    expect(policy.basePriority).toBeLessThan(SYNC_STREAM_POLICY.transactions.basePriority);
  });

  it("joins NO domain policy and declares no dependencies", () => {
    // A flag-gated analytics stream must not degrade a page's block-health UX
    // to "catching up" while its gate is off — which is exactly what appearing
    // in a domain's primary/supporting list would do.
    for (const domain of Object.values(SYNC_DOMAIN_POLICY)) {
      expect(domain.primaryStreams).not.toContain("stats_snapshot");
      expect(domain.supportingStreams).not.toContain("stats_snapshot");
    }
    expect(SYNC_STREAM_DEPENDENCIES.stats_snapshot).toBeUndefined();
  });

  it("is excluded from the manual `all` and `data` scopes", () => {
    // `fan_earnings` is the deliberate precedent for a stream with no scope at
    // all: a manual "sync everything" must not spend a bulk lane's daily budget.
    expect(FANSLY_ENGINE_SCOPE_STREAMS.all).not.toContain("stats_snapshot");
    expect(FANSLY_ENGINE_SCOPE_STREAMS.data).not.toContain("stats_snapshot");
    expect(FANSLY_ENGINE_SCOPE_STREAMS.messages).not.toContain("stats_snapshot");
  });

  it("seeds PAUSED, through the generalized branch rather than a name check", () => {
    // Every OTHER stream seeds pending/recovery. Without this, the deploy that
    // ships the stream would seed one pending row per page FLEET-WIDE, before
    // its flag was ever opened.
    expect(isSeedPausedSyncStream("stats_snapshot")).toBe(true);
    expect(isSeedPausedSyncStream("posts")).toBe(true);
    expect(isSeedPausedSyncStream("dm_messages")).toBe(false);
    expect([...SEED_PAUSED_SYNC_STREAMS]).toEqual([
      "posts",
      "stats_snapshot",
      "notifications",
      "catalog",
      "post_replies",
      "payouts",
      "media_stats",
    ]);
  });

  it("is exempt from the rollup vote and visible in the monitor", () => {
    expect(isBulkEnrichmentSyncStream("stats_snapshot")).toBe(true);
    expect(BULK_ENRICHMENT_SYNC_STREAMS).toContain("stats_snapshot");
    expect(MONITORED_SYNC_STREAMS).toContain("stats_snapshot");
  });

  // THE PIN THAT ALSO REPAIRS SOMETHING OLDER: `posts` had been missing from
  // the monitor since it shipped, so a wedged posts walk was unobservable in
  // exactly the way a wedged fan_earnings walk was before W8.1.
  it("keeps MONITORED_SYNC_STREAMS a superset of every Fansly stream", () => {
    const monitored = new Set<string>(MONITORED_SYNC_STREAMS);
    const missing = getSyncStreamsForPlatform("fansly").filter(
      (stream) => !monitored.has(stream),
    );
    expect(missing).toEqual([]);
  });

  it("materializes gate flips into durable pause/resume", () => {
    // #191/#194: without membership here a gate flip changes nothing until the
    // stream's next slot — six hours, or a day for the slower lanes.
    expect(FANSLY_BULK_SYNC_STREAMS).toContain("stats_snapshot");
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
    // were deleted. `syncSharedRateLimitEnabled` is a PRE-EXISTING key and is
    // deliberately not pinned away — what A28-4 removed is the day-counter key
    // and the boot/PATCH invariants that would have been added beside it.
    expect(keys.has("fanslyEgressKeyDailyRequestCap")).toBe(false);
    expect(keys.has("syncRateLimitDaysRetentionDays")).toBe(false);
  });
});

// WP-F2 — the same fourteen sites for `notifications`, as assertions.
//
// The list is checked rather than remembered on purpose: WP-F1 shipped its
// seed-pause generalization and its gate registration correctly, and the ONE
// thing nobody had a pin for — that the gate reconciler recognizes a never-ran
// seed pause — is the one thing that broke on production the day it shipped.
describe("notifications stream wiring", () => {
  it("is a Fansly-only stream, present in every stream vocabulary", () => {
    expect(SYNC_STREAMS).toContain("notifications");
    expect([...PLATFORM_STREAMS]).toEqual([...SYNC_STREAMS]);
    expect(getSyncStreamsForPlatform("fansly")).toContain("notifications");
    expect(getSyncStreamsForPlatform("onlyfans")).not.toContain("notifications");
    expect(onlyfansPlatformAdapter.capabilities.streams).not.toContain("notifications");
    // A stream in SYNC_STREAMS with no handler throws "Unsupported executor
    // stream" on every dispatch, FLEET-WIDE.
  });

  it("is LIVE class at the 1 800 s cadence, and still yields to money and DMs", () => {
    const policy = SYNC_STREAM_POLICY.notifications;
    // The cadence IS the loss bound: every unpolled interval is facts the
    // provider will not serve again.
    expect(policy.cadenceSeconds).toBe(1800);
    expect(policy.defaultWorkClass).toBe("live");
    expect(policy.freshnessSlaSeconds).toBeNull();
    expect(policy.basePriority).toBeLessThan(SYNC_STREAM_POLICY.transactions.basePriority);
    expect(policy.basePriority).toBeLessThan(SYNC_STREAM_POLICY.dm_messages.basePriority);
  });

  it("joins NO domain policy and declares no dependencies", () => {
    for (const domain of Object.values(SYNC_DOMAIN_POLICY)) {
      expect(domain.primaryStreams).not.toContain("notifications");
      expect(domain.supportingStreams).not.toContain("notifications");
    }
    expect(SYNC_STREAM_DEPENDENCIES.notifications).toBeUndefined();
  });

  it("is excluded from the manual `all` and `data` scopes", () => {
    expect(FANSLY_ENGINE_SCOPE_STREAMS.all).not.toContain("notifications");
    expect(FANSLY_ENGINE_SCOPE_STREAMS.data).not.toContain("notifications");
    expect(FANSLY_ENGINE_SCOPE_STREAMS.messages).not.toContain("notifications");
  });

  it("seeds PAUSED and is reachable by the gate reconciler", () => {
    expect(isSeedPausedSyncStream("notifications")).toBe(true);
    // BOTH halves, because F1 proved one without the other is a lane that sits
    // paused forever while its flag moves nothing (#192, reproduced 2026-08-22).
    expect(FANSLY_BULK_SYNC_STREAMS).toContain("notifications");
  });

  it("is exempt from the rollup vote and visible in the monitor", () => {
    expect(isBulkEnrichmentSyncStream("notifications")).toBe(true);
    expect(BULK_ENRICHMENT_SYNC_STREAMS).toContain("notifications");
    expect(MONITORED_SYNC_STREAMS).toContain("notifications");
  });
});

// WP-F3 — the same fourteen sites for `catalog`.

describe("catalog stream wiring", () => {
  it("is a Fansly-only stream, present in every stream vocabulary", () => {
    expect(SYNC_STREAMS).toContain("catalog");
    expect([...PLATFORM_STREAMS]).toEqual([...SYNC_STREAMS]);
    expect(getSyncStreamsForPlatform("fansly")).toContain("catalog");
    expect(getSyncStreamsForPlatform("onlyfans")).not.toContain("catalog");
    expect(onlyfansPlatformAdapter.capabilities.streams).not.toContain("catalog");
    // A stream in SYNC_STREAMS with no handler throws "Unsupported executor
    // stream" on every dispatch, FLEET-WIDE.
  });

  it("is a MAINTENANCE lane on a daily cadence that yields to money and DMs", () => {
    const policy = SYNC_STREAM_POLICY.catalog;
    // Inventory moves in days. Nothing in this lane is announced once, so
    // every step is deferrable — the opposite of the notification poll.
    expect(policy.cadenceSeconds).toBe(86_400);
    expect(policy.defaultWorkClass).toBe("maintenance");
    expect(policy.freshnessSlaSeconds).toBeNull();
    expect(policy.basePriority).toBeLessThan(SYNC_STREAM_POLICY.transactions.basePriority);
    expect(policy.basePriority).toBeLessThan(SYNC_STREAM_POLICY.dm_messages.basePriority);
    // Below the notification poll too: a daily inventory read can always wait
    // for the lane whose downtime costs facts.
    expect(policy.basePriority).toBeLessThan(SYNC_STREAM_POLICY.notifications.basePriority);
  });

  it("joins NO domain policy and declares no dependencies", () => {
    for (const domain of Object.values(SYNC_DOMAIN_POLICY)) {
      expect(domain.primaryStreams).not.toContain("catalog");
      expect(domain.supportingStreams).not.toContain("catalog");
    }
    // `media_stats -> catalog` is WP-F4's declaration to make, not this
    // package's: a dependency on a stream whose handler does not exist yet
    // would block nothing and mislead everything.
    expect(SYNC_STREAM_DEPENDENCIES.catalog).toBeUndefined();
  });

  it("is excluded from the manual `all` and `data` scopes", () => {
    expect(FANSLY_ENGINE_SCOPE_STREAMS.all).not.toContain("catalog");
    expect(FANSLY_ENGINE_SCOPE_STREAMS.data).not.toContain("catalog");
    expect(FANSLY_ENGINE_SCOPE_STREAMS.messages).not.toContain("catalog");
  });

  it("seeds PAUSED and is reachable by the gate reconciler", () => {
    expect(isSeedPausedSyncStream("catalog")).toBe(true);
    // BOTH halves: one without the other is a lane that sits paused forever
    // while its ramp flag moves nothing (#192).
    expect(FANSLY_BULK_SYNC_STREAMS).toContain("catalog");
  });

  it("is exempt from the rollup vote and visible in the monitor", () => {
    expect(isBulkEnrichmentSyncStream("catalog")).toBe(true);
    expect(BULK_ENRICHMENT_SYNC_STREAMS).toContain("catalog");
    expect(MONITORED_SYNC_STREAMS).toContain("catalog");
  });
});

// WP-F5 — the same fourteen sites for `post_replies`.

describe("post_replies stream wiring", () => {
  it("is a Fansly-only stream, present in every stream vocabulary", () => {
    expect(SYNC_STREAMS).toContain("post_replies");
    expect([...PLATFORM_STREAMS]).toEqual([...SYNC_STREAMS]);
    expect(getSyncStreamsForPlatform("fansly")).toContain("post_replies");
    expect(getSyncStreamsForPlatform("onlyfans")).not.toContain("post_replies");
    expect(onlyfansPlatformAdapter.capabilities.streams).not.toContain("post_replies");
    // A stream in SYNC_STREAMS with no handler throws "Unsupported executor
    // stream" on every dispatch, FLEET-WIDE.
  });

  it("is a maintenance lane on the history cadence that yields to money and DMs", () => {
    const policy = SYNC_STREAM_POLICY.post_replies;
    // A back-catalogue that takes ~14 days to first-pass is never "fresh" and
    // never urgent; four dispatches a day is about spreading the budget, not
    // about latency.
    expect(policy.cadenceSeconds).toBe(21_600);
    expect(policy.defaultWorkClass).toBe("maintenance");
    expect(policy.freshnessSlaSeconds).toBeNull();
    expect(policy.basePriority).toBeLessThan(SYNC_STREAM_POLICY.transactions.basePriority);
    expect(policy.basePriority).toBeLessThan(SYNC_STREAM_POLICY.dm_messages.basePriority);
    // Below the notification poll AND below the catalog sweep: of every lane in
    // this initiative, a comment archive can wait the longest.
    expect(policy.basePriority).toBeLessThan(SYNC_STREAM_POLICY.notifications.basePriority);
    expect(policy.basePriority).toBeLessThan(SYNC_STREAM_POLICY.catalog.basePriority);
  });

  it("joins NO domain policy and declares no dependencies", () => {
    for (const domain of Object.values(SYNC_DOMAIN_POLICY)) {
      expect(domain.primaryStreams).not.toContain("post_replies");
      expect(domain.supportingStreams).not.toContain("post_replies");
    }
    // The plan is explicit that comments do NOT depend on notifications: the
    // walk reads `creator_posts`, which the `posts` lane fills, and a
    // notification is only ever a dirty SIGNAL. A declared dependency would
    // block the archive on a lane it does not need.
    expect(SYNC_STREAM_DEPENDENCIES.post_replies).toBeUndefined();
  });

  it("is excluded from the manual `all` and `data` scopes", () => {
    expect(FANSLY_ENGINE_SCOPE_STREAMS.all).not.toContain("post_replies");
    expect(FANSLY_ENGINE_SCOPE_STREAMS.data).not.toContain("post_replies");
    expect(FANSLY_ENGINE_SCOPE_STREAMS.messages).not.toContain("post_replies");
  });

  it("seeds PAUSED and is reachable by the gate reconciler", () => {
    expect(isSeedPausedSyncStream("post_replies")).toBe(true);
    expect(SEED_PAUSED_SYNC_STREAMS).toContain("post_replies");
    // BOTH halves: one without the other is a lane that sits paused forever
    // while its ramp flag moves nothing (#192).
    expect(FANSLY_BULK_SYNC_STREAMS).toContain("post_replies");
  });

  it("is exempt from the rollup vote and visible in the monitor", () => {
    expect(isBulkEnrichmentSyncStream("post_replies")).toBe(true);
    expect(BULK_ENRICHMENT_SYNC_STREAMS).toContain("post_replies");
    expect(MONITORED_SYNC_STREAMS).toContain("post_replies");
  });
});

// WP-F7 — the same fourteen sites for `payouts`.

describe("payouts stream wiring", () => {
  it("is a Fansly-only stream, present in every stream vocabulary", () => {
    expect(SYNC_STREAMS).toContain("payouts");
    expect([...PLATFORM_STREAMS]).toEqual([...SYNC_STREAMS]);
    expect(getSyncStreamsForPlatform("fansly")).toContain("payouts");
    expect(getSyncStreamsForPlatform("onlyfans")).not.toContain("payouts");
    expect(onlyfansPlatformAdapter.capabilities.streams).not.toContain("payouts");
    // A stream in SYNC_STREAMS with no handler throws "Unsupported executor
    // stream" on every dispatch, FLEET-WIDE.
  });

  it("is a maintenance lane on the daily cadence that yields to money-in and DMs", () => {
    const policy = SYNC_STREAM_POLICY.payouts;
    // A payout request moves in days and the steady state is two calls; four
    // dispatches a day would buy nothing but egress.
    expect(policy.cadenceSeconds).toBe(86_400);
    expect(policy.defaultWorkClass).toBe("maintenance");
    expect(policy.freshnessSlaSeconds).toBeNull();
    expect(policy.basePriority).toBeLessThan(SYNC_STREAM_POLICY.transactions.basePriority);
    expect(policy.basePriority).toBeLessThan(SYNC_STREAM_POLICY.dm_messages.basePriority);
    // Below the comment archive, which is already the lowest lane in the tree:
    // of everything this initiative adds, a payout history nobody is waiting on
    // can wait the longest.
    expect(policy.basePriority).toBeLessThan(SYNC_STREAM_POLICY.post_replies.basePriority);
  });

  it("joins NO domain policy and declares no dependencies", () => {
    // `domain: "financials"` is where money-out belongs as a LABEL...
    expect(SYNC_STREAM_POLICY.payouts.domain).toBe("financials");
    // ...but the lane is deliberately absent from every domain's primary and
    // supporting list, so a shut gate cannot degrade a page's block-health UX
    // to "catching up".
    for (const domain of Object.values(SYNC_DOMAIN_POLICY)) {
      expect(domain.primaryStreams).not.toContain("payouts");
      expect(domain.supportingStreams).not.toContain("payouts");
    }
    // Nothing this lane reads comes from another stream: both routes are
    // account-level and take no ids from a projection.
    expect(SYNC_STREAM_DEPENDENCIES.payouts).toBeUndefined();
  });

  it("is excluded from the manual `all` and `data` scopes", () => {
    expect(FANSLY_ENGINE_SCOPE_STREAMS.all).not.toContain("payouts");
    expect(FANSLY_ENGINE_SCOPE_STREAMS.data).not.toContain("payouts");
    expect(FANSLY_ENGINE_SCOPE_STREAMS.messages).not.toContain("payouts");
  });

  it("seeds PAUSED and is reachable by the gate reconciler", () => {
    expect(isSeedPausedSyncStream("payouts")).toBe(true);
    expect(SEED_PAUSED_SYNC_STREAMS).toContain("payouts");
    // BOTH halves: one without the other is a lane that sits paused forever
    // while its ramp flag moves nothing (#192).
    expect(FANSLY_BULK_SYNC_STREAMS).toContain("payouts");
  });

  it("is exempt from the rollup vote and visible in the monitor", () => {
    expect(isBulkEnrichmentSyncStream("payouts")).toBe(true);
    expect(BULK_ENRICHMENT_SYNC_STREAMS).toContain("payouts");
    expect(MONITORED_SYNC_STREAMS).toContain("payouts");
  });
});

// WP-F4 — the same fourteen sites for `media_stats`, the one lane that can
// overload the platform.

describe("media_stats stream wiring", () => {
  it("is a Fansly-only stream, present in every stream vocabulary", () => {
    expect(SYNC_STREAMS).toContain("media_stats");
    expect([...PLATFORM_STREAMS]).toEqual([...SYNC_STREAMS]);
    expect(getSyncStreamsForPlatform("fansly")).toContain("media_stats");
    expect(getSyncStreamsForPlatform("onlyfans")).not.toContain("media_stats");
    expect(onlyfansPlatformAdapter.capabilities.streams).not.toContain("media_stats");
    // A stream in SYNC_STREAMS with no handler throws "Unsupported executor
    // stream" on every dispatch, FLEET-WIDE — and this is the lane declared for
    // every Fansly page the moment it enters SYNC_STREAMS.
  });

  it("is the LOWEST-priority lane in the tree, on the six-hourly cadence", () => {
    const policy = SYNC_STREAM_POLICY.media_stats;
    // 21 600 s so a day that deferred at its cap resumes within six hours
    // rather than at the next midnight.
    expect(policy.cadenceSeconds).toBe(21_600);
    expect(policy.defaultWorkClass).toBe("maintenance");
    expect(policy.freshnessSlaSeconds).toBeNull();
    expect(policy.basePriority).toBeLessThan(SYNC_STREAM_POLICY.transactions.basePriority);
    expect(policy.basePriority).toBeLessThan(SYNC_STREAM_POLICY.dm_messages.basePriority);
    // Below EVERY other lane this initiative adds: it is the highest-volume one
    // and it reads a back catalogue nobody is waiting on.
    expect(policy.basePriority).toBeLessThan(SYNC_STREAM_POLICY.payouts.basePriority);
    expect(policy.basePriority).toBeLessThan(SYNC_STREAM_POLICY.post_replies.basePriority);
  });

  it("joins NO domain policy but DOES declare the catalog dependency", () => {
    expect(SYNC_STREAM_POLICY.media_stats.domain).toBe("audience");
    for (const domain of Object.values(SYNC_DOMAIN_POLICY)) {
      expect(domain.primaryStreams).not.toContain("media_stats");
      expect(domain.supportingStreams).not.toContain("media_stats");
    }
    // THE ONE DEPENDENCY IN THE INITIATIVE. `catalog` is what measures M, and
    // every number this lane reports — its daily demand, its class census, its
    // cycle estimate — is computed against M. Running the per-media walk before
    // the catalogue is enumerated would size a 300-call-a-day lane against
    // whatever media the DM sidecars happened to mention.
    expect(SYNC_STREAM_DEPENDENCIES.media_stats).toEqual(["catalog"]);
  });

  it("is excluded from the manual `all` and `data` scopes", () => {
    expect(FANSLY_ENGINE_SCOPE_STREAMS.all).not.toContain("media_stats");
    expect(FANSLY_ENGINE_SCOPE_STREAMS.data).not.toContain("media_stats");
    expect(FANSLY_ENGINE_SCOPE_STREAMS.messages).not.toContain("media_stats");
  });

  it("seeds PAUSED and is reachable by the gate reconciler", () => {
    expect(isSeedPausedSyncStream("media_stats")).toBe(true);
    expect(SEED_PAUSED_SYNC_STREAMS).toContain("media_stats");
    // BOTH halves: one without the other is a lane that sits paused forever
    // while its ramp flag moves nothing (#192).
    expect(FANSLY_BULK_SYNC_STREAMS).toContain("media_stats");
  });

  it("is exempt from the rollup vote and visible in the monitor", () => {
    expect(isBulkEnrichmentSyncStream("media_stats")).toBe(true);
    expect(BULK_ENRICHMENT_SYNC_STREAMS).toContain("media_stats");
    expect(MONITORED_SYNC_STREAMS).toContain("media_stats");
  });
});

// Step 4 retired the legacy content lanes: the Fansly Sync Engine's registry
// paces these resources, so their stream flags, page allowlists, daily call
// budgets and continuation delay are read by nothing. Each stays registered,
// ignored, until the retired keys are removed together.
describe("the legacy content lanes' keys are retired", () => {
  const RETIRED = [
    "fanslyStatsSnapshotSyncEnabled", "fanslyStatsSnapshotPageAllowlist", "fanslyStatsSnapshotDailyCallBudget",
    "fanslyNotificationsSyncEnabled", "fanslyNotificationsPageAllowlist", "fanslyNotificationsDailyCallBudget",
    "fanslyCatalogSyncEnabled", "fanslyCatalogPageAllowlist", "fanslyCatalogDailyCallBudget",
    "fanslyPostRepliesSyncEnabled", "fanslyPostRepliesPageAllowlist", "fanslyRepliesDailyCallBudget",
    "fanslyPayoutsSyncEnabled", "fanslyPayoutsPageAllowlist", "fanslyPayoutsDailyCallBudget",
    "fanslyMediaStatsSyncEnabled", "fanslyMediaStatsPageAllowlist", "fanslyMediaStatsDailyCallBudget",
    "fanslyMediaStatsLongTailCycleDays",
    "fanslyPostEngagementRefreshEnabled", "fanslyPostEngagementDailyCallBudget",
    "fanslyStatsHourlyEnabled", "fanslyStatsHourlyBackfillMaxDays",
    "fanslyBackfillContinuationDelayMs",
  ];

  it("keeps each one registered, labelled retired and applied nowhere", () => {
    const byKey = new Map(CONFIG_DESCRIPTORS.map((descriptor) => [descriptor.key, descriptor]));
    for (const key of RETIRED) {
      const descriptor = byKey.get(key);
      expect(descriptor, key).toBeDefined();
      expect(descriptor?.runtimeApply, key).toBe("none");
      expect(descriptor?.label, key).toMatch(/— retired, ignored$/);
      expect(descriptor?.costWarning, key).toBeUndefined();
    }
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
