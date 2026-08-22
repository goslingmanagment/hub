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
    expect([...SEED_PAUSED_SYNC_STREAMS]).toEqual(["posts", "stats_snapshot"]);
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
