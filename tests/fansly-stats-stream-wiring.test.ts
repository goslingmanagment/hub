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

import {
  fanslyPlatformAdapter,
  onlyfansPlatformAdapter,
} from "../apps/runtime/src/platforms/registry.ts";
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
    expect(fanslyPlatformAdapter.capabilities.streams).toContain("stats_snapshot");
    expect(onlyfansPlatformAdapter.capabilities.streams).not.toContain("stats_snapshot");
    expect(fanslyPlatformAdapter.pull.stats_snapshot).toBeTypeOf("function");
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
    expect(fanslyPlatformAdapter.syncScopes.all).not.toContain("stats_snapshot");
    expect(fanslyPlatformAdapter.syncScopes.data).not.toContain("stats_snapshot");
    expect(fanslyPlatformAdapter.syncScopes.messages).not.toContain("stats_snapshot");
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

  it("registers its gate keys so opening the gate wakes the lane (#192)", () => {
    // The registration itself lives in modules/ops; what is pinned here is that
    // the KEYS exist with the shapes that registration reads.
    const byKey = new Map(CONFIG_DESCRIPTORS.map((descriptor) => [descriptor.key, descriptor]));
    const enabled = byKey.get("fanslyStatsSnapshotSyncEnabled");
    expect(enabled?.kind).toBe("boolean");
    expect(enabled?.default).toBe("false");
    expect(enabled?.runtimeApply).toBe("live");

    const allowlist = byKey.get("fanslyStatsSnapshotPageAllowlist");
    expect(allowlist?.kind).toBe("string");
    expect(allowlist?.default).toBe("");
    expect(allowlist?.runtimeApply).toBe("live");
    // FAIL-CLOSED semantics are the whole point of a per-stream key, and the
    // note is where an operator reads which rule applies.
    expect(allowlist?.note).toMatch(/FAILS CLOSED/);

    const budget = byKey.get("fanslyStatsSnapshotDailyCallBudget");
    expect(budget?.kind).toBe("number");
    expect(budget?.default).toBe("25");
    expect(budget?.min).toBe(1);
    expect(budget?.max).toBeGreaterThan(25);

    expect(byKey.get("fanslyStatsHourlyEnabled")?.default).toBe("true");
    expect(byKey.get("fanslyStatsHourlyBackfillMaxDays")?.default).toBe("30");
    expect(byKey.get("fanslyBackfillContinuationDelayMs")?.default).toBe("20000");
  });

  // A28-4's negative pins. These mechanisms were DELETED, and a key reappearing
  // is how a deleted mechanism comes back without a decision.
  it("adds no global per-page request cap and no byte ceiling", () => {
    const keys = new Set(CONFIG_DESCRIPTORS.map((descriptor) => descriptor.key));
    expect(keys.has("fanslyPageDailyRequestCap")).toBe(false);
    expect(keys.has("fanslyUntrimmedCaptureByteCeilingPerDay")).toBe(false);
    expect(keys.has("syncRateLimitDays")).toBe(false);
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
    expect(fanslyPlatformAdapter.capabilities.streams).toContain("notifications");
    expect(onlyfansPlatformAdapter.capabilities.streams).not.toContain("notifications");
    // A stream in SYNC_STREAMS with no handler throws "Unsupported executor
    // stream" on every dispatch, FLEET-WIDE.
    expect(fanslyPlatformAdapter.pull.notifications).toBeTypeOf("function");
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
    expect(fanslyPlatformAdapter.syncScopes.all).not.toContain("notifications");
    expect(fanslyPlatformAdapter.syncScopes.data).not.toContain("notifications");
    expect(fanslyPlatformAdapter.syncScopes.messages).not.toContain("notifications");
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

  it("registers its gate keys so opening the gate wakes the lane (#192)", () => {
    const byKey = new Map(CONFIG_DESCRIPTORS.map((descriptor) => [descriptor.key, descriptor]));
    const enabled = byKey.get("fanslyNotificationsSyncEnabled");
    expect(enabled?.kind).toBe("boolean");
    expect(enabled?.default).toBe("false");
    expect(enabled?.runtimeApply).toBe("live");

    const allowlist = byKey.get("fanslyNotificationsPageAllowlist");
    expect(allowlist?.kind).toBe("string");
    expect(allowlist?.default).toBe("");
    expect(allowlist?.runtimeApply).toBe("live");
    // Its OWN key, on the FAIL-CLOSED template (S4). Reading this lane through
    // the shared new-stream key would open it fleet-wide on the deploy.
    expect(allowlist?.note).toMatch(/FAILS CLOSED/);

    const budget = byKey.get("fanslyNotificationsDailyCallBudget");
    expect(budget?.kind).toBe("number");
    // 48 head polls + pagination, in HTTP ATTEMPTS.
    expect(budget?.default).toBe("96");
    expect(budget?.min).toBe(1);
    expect(budget?.costWarning).toMatch(/ATTEMPTS/);
  });
});

// WP-F3 — the same fourteen sites for `catalog`.

describe("catalog stream wiring", () => {
  it("is a Fansly-only stream, present in every stream vocabulary", () => {
    expect(SYNC_STREAMS).toContain("catalog");
    expect([...PLATFORM_STREAMS]).toEqual([...SYNC_STREAMS]);
    expect(getSyncStreamsForPlatform("fansly")).toContain("catalog");
    expect(getSyncStreamsForPlatform("onlyfans")).not.toContain("catalog");
    expect(fanslyPlatformAdapter.capabilities.streams).toContain("catalog");
    expect(onlyfansPlatformAdapter.capabilities.streams).not.toContain("catalog");
    // A stream in SYNC_STREAMS with no handler throws "Unsupported executor
    // stream" on every dispatch, FLEET-WIDE.
    expect(fanslyPlatformAdapter.pull.catalog).toBeTypeOf("function");
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
    expect(fanslyPlatformAdapter.syncScopes.all).not.toContain("catalog");
    expect(fanslyPlatformAdapter.syncScopes.data).not.toContain("catalog");
    expect(fanslyPlatformAdapter.syncScopes.messages).not.toContain("catalog");
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

  it("registers its gate keys so opening the gate wakes the lane (#192)", () => {
    const byKey = new Map(CONFIG_DESCRIPTORS.map((descriptor) => [descriptor.key, descriptor]));
    const enabled = byKey.get("fanslyCatalogSyncEnabled");
    expect(enabled?.kind).toBe("boolean");
    expect(enabled?.default).toBe("false");
    expect(enabled?.runtimeApply).toBe("live");

    const allowlist = byKey.get("fanslyCatalogPageAllowlist");
    expect(allowlist?.kind).toBe("string");
    expect(allowlist?.default).toBe("");
    expect(allowlist?.runtimeApply).toBe("live");
    // Its OWN key, on the FAIL-CLOSED template (S4).
    expect(allowlist?.note).toMatch(/FAILS CLOSED/);

    const budget = byKey.get("fanslyCatalogDailyCallBudget");
    expect(budget?.kind).toBe("number");
    // Six fixed steps plus the vault walk plus the batch hydrations, in
    // HTTP ATTEMPTS.
    expect(budget?.default).toBe("60");
    expect(budget?.min).toBe(1);
    expect(budget?.costWarning).toMatch(/ATTEMPTS/);
  });
});

// WP-F5 — the same fourteen sites for `post_replies`.

describe("post_replies stream wiring", () => {
  it("is a Fansly-only stream, present in every stream vocabulary", () => {
    expect(SYNC_STREAMS).toContain("post_replies");
    expect([...PLATFORM_STREAMS]).toEqual([...SYNC_STREAMS]);
    expect(getSyncStreamsForPlatform("fansly")).toContain("post_replies");
    expect(getSyncStreamsForPlatform("onlyfans")).not.toContain("post_replies");
    expect(fanslyPlatformAdapter.capabilities.streams).toContain("post_replies");
    expect(onlyfansPlatformAdapter.capabilities.streams).not.toContain("post_replies");
    // A stream in SYNC_STREAMS with no handler throws "Unsupported executor
    // stream" on every dispatch, FLEET-WIDE.
    expect(fanslyPlatformAdapter.pull.post_replies).toBeTypeOf("function");
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
    expect(fanslyPlatformAdapter.syncScopes.all).not.toContain("post_replies");
    expect(fanslyPlatformAdapter.syncScopes.data).not.toContain("post_replies");
    expect(fanslyPlatformAdapter.syncScopes.messages).not.toContain("post_replies");
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

  it("registers its gate keys so opening the gate wakes the lane (#192)", () => {
    const byKey = new Map(CONFIG_DESCRIPTORS.map((descriptor) => [descriptor.key, descriptor]));
    const enabled = byKey.get("fanslyPostRepliesSyncEnabled");
    expect(enabled?.kind).toBe("boolean");
    expect(enabled?.default).toBe("false");
    expect(enabled?.runtimeApply).toBe("live");

    const allowlist = byKey.get("fanslyPostRepliesPageAllowlist");
    expect(allowlist?.kind).toBe("string");
    expect(allowlist?.default).toBe("");
    expect(allowlist?.runtimeApply).toBe("live");
    // Its OWN key, on the FAIL-CLOSED template (S4).
    expect(allowlist?.note).toMatch(/FAILS CLOSED/);
  });

  it("SHIPS AT 100 CALLS A DAY with 400 as the registry ceiling", () => {
    const byKey = new Map(CONFIG_DESCRIPTORS.map((descriptor) => [descriptor.key, descriptor]));
    const budget = byKey.get("fanslyRepliesDailyCallBudget");
    expect(budget?.kind).toBe("number");
    // The raise to 300 is a SEPARATE, criteria-gated config flip with its own
    // window (A29). Shipping at 300 would spend the ritual before the criteria
    // could be measured, so 100 is pinned here rather than trusted.
    expect(budget?.default).toBe("100");
    expect(budget?.min).toBe(1);
    // 400 without a fresh owner decision — the registry is what makes that a
    // refusal rather than a note in a document.
    expect(budget?.max).toBe(400);
    expect(budget?.costWarning).toMatch(/ATTEMPTS/);

    const cycle = byKey.get("fanslyRepliesRewalkCycleDays");
    expect(cycle?.kind).toBe("number");
    expect(cycle?.default).toBe("14");
    expect(cycle?.runtimeApply).toBe("live");
    // It changes WHICH posts the budget is spent on, never HOW MANY calls are
    // made — the wording matters because a tunable that looks like a throttle
    // gets edited like one.
    expect(cycle?.costWarning).toMatch(/does not raise egress|NOT change egress/i);
  });
});
