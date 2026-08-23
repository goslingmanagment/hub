import { describe, expect, it } from "vitest";

import { CANONICALIZER_FAMILIES } from "../apps/runtime/src/services/canonicalize/index.ts";
import {
  findProjection,
  isOperationalStateTable,
  OPERATIONAL_STATE_TABLES,
  PROJECTION_REGISTRY,
  projectionNames,
} from "../apps/runtime/src/services/projections/registry.ts";

// WP-F1(0) — the projection registry's own ratchet.
//
// The plan adds ~15 event types and ~10 projections to a spine that had no list
// of either: a hardcoded three-name if-chain in the CLI and six hand-written
// try/catch blocks in the worker tick were the whole registry. What this file
// pins is the properties that made those two sites dangerous — a projection
// that declares no event types is a projector nothing can reason about, and a
// projection that truncates capture-plane state on rebuild is an egress storm
// waiting for someone to type `projection:rebuild`.

describe("projection registry", () => {
  it("gives every projection a non-empty event-type list and table list", () => {
    expect(PROJECTION_REGISTRY.length).toBeGreaterThan(0);
    for (const projection of PROJECTION_REGISTRY) {
      expect(projection.name.length, `${projection.name} name`).toBeGreaterThan(0);
      expect(projection.eventTypes.length, `${projection.name} eventTypes`).toBeGreaterThan(0);
      expect(projection.tables.length, `${projection.name} tables`).toBeGreaterThan(0);
      for (const type of projection.eventTypes) {
        expect(type.length).toBeGreaterThan(0);
      }
      for (const table of projection.tables) {
        expect(table).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  it("names each projection exactly once", () => {
    expect(new Set(projectionNames()).size).toBe(PROJECTION_REGISTRY.length);
  });

  it("declares a rebuild for every projection that claims one, and none for the rest", () => {
    for (const projection of PROJECTION_REGISTRY) {
      if (projection.rebuildKind === "none") {
        expect(projection.rebuild, `${projection.name}`).toBeNull();
      } else {
        expect(projection.rebuild, `${projection.name}`).not.toBeNull();
      }
    }
  });

  // THE LOAD-BEARING ONE. §3.4's third state class exists because rebuild =
  // truncate + replay and no event carries a cursor, a floor or a blocker. A
  // rebuild that truncated `capture_coverage` would erase every retention floor
  // the backfill paid egress to discover and re-trigger the whole first-sight
  // backfill set — bounded only by the per-lane daily caps.
  it("never lets a projection's tables include capture-plane operational state", () => {
    expect(OPERATIONAL_STATE_TABLES.length).toBeGreaterThan(0);
    for (const entry of OPERATIONAL_STATE_TABLES) {
      expect(entry.stateClass).toBe("operational_state");
      expect(entry.justification.length).toBeGreaterThan(40);
      expect(entry.writer.length).toBeGreaterThan(0);
    }
    for (const projection of PROJECTION_REGISTRY) {
      for (const table of projection.tables) {
        expect(
          isOperationalStateTable(table),
          `${projection.name} declares ${table}, which is operational state`,
        ).toBe(false);
      }
    }
  });

  it("classifies capture_coverage as operational state", () => {
    expect(isOperationalStateTable("capture_coverage")).toBe(true);
    // …and the stats projector, which is the lane that WRITES coverage, does
    // not list it among the tables its rebuild truncates.
    const stats = findProjection("fansly_stats");
    expect(stats).not.toBeNull();
    expect(stats?.tables).not.toContain("capture_coverage");
  });

  it("declares WP-F1's statistics events on exactly one projection", () => {
    const owners = new Map<string, string[]>();
    for (const projection of PROJECTION_REGISTRY) {
      for (const type of projection.eventTypes) {
        owners.set(type, [...(owners.get(type) ?? []), projection.name]);
      }
    }
    for (
      const type of [
        "traffic.datapoint_observed",
        "media_traffic.datapoint_observed",
        "stats.window_top_observed",
        "tag.counters_observed",
        "earnings.breakdown_observed",
        "earnings.month_observed",
        "tracking_link.snapshot_observed",
        "broadcast.stats_observed",
        "poll.observed",
        "recap.stat_observed",
      ]
    ) {
      expect(owners.get(type), type).toEqual(["fansly_stats"]);
    }
    // The media plane stays the SINGLE writer of creator_media, so the media
    // types it consumes belong to it alone even though a second family now
    // emits them.
    expect(owners.get("media.observed")).toEqual(["media_plane"]);
    expect(owners.get("media.offer_location_observed")).toEqual(["media_plane"]);
  });

  it("keeps every canonicalizer lane unique, so health-floor gauges cannot collide", () => {
    // `healthFloorName` is `obs_backlog_<source>_<lane>_v<version>` and the
    // golden-signal threshold map is built with Object.fromEntries, where a
    // duplicate key collapses SILENTLY: two backlogs under one metric name,
    // one of them invisible.
    const names = CANONICALIZER_FAMILIES.map((family) =>
      `obs_backlog_${family.source}_${family.lane}_v${family.version}`
    );
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("obs_backlog_pull_stats_v2");
  });
});
