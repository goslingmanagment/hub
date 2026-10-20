import { describe, expect, it } from "vitest";

import {
  FANSLY_ENGAGEMENT_PROJECTION,
  FANSLY_ENGAGEMENT_PROJECTION_TABLES,
} from "../apps/runtime/src/services/projections/fansly-engagement.ts";
import {
  findProjection,
  isOperationalStateTable,
  OPERATIONAL_STATE_TABLES,
  PROJECTION_REGISTRY,
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
  // THE LOAD-BEARING ONE. §3.4's third state class exists because rebuild =
  // truncate + replay and no event carries a cursor, a floor or a blocker. A
  // rebuild that truncated `capture_coverage` would erase every retention floor
  // the backfill paid egress to discover and re-trigger the whole first-sight
  // backfill set — bounded only by the per-lane daily caps.
  it("never lets a rebuild truncate capture-plane operational state", () => {
    expect(OPERATIONAL_STATE_TABLES.length).toBeGreaterThan(0);
    for (const entry of OPERATIONAL_STATE_TABLES) {
      expect(entry.stateClass).toBe("operational_state");
      expect(entry.justification.length).toBeGreaterThan(40);
      expect(entry.writer.length).toBeGreaterThan(0);
    }
    for (const projection of PROJECTION_REGISTRY) {
      for (const table of projection.tables) {
        if (projection.stateClass === "operational_state") {
          expect(projection.rebuildKind).toBe("none");
          expect(projection.rebuild).toBeNull();
          expect(isOperationalStateTable(table)).toBe(true);
          continue;
        }
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
});

// Per-projection declarations: each family's own pins on its registry entry
// (exact tables and event types, rebuild kind, state class). They read only the
// registry, so they live here rather than in the family's database suite.
describe("projection registry — per-projection declarations", () => {
  it("declares subject_refresh_state as operational state, and no projection truncates it", () => {
    // BY CLASSIFICATION (§3.4), never by a quiet exemption in this file.
    const declared = new Set(OPERATIONAL_STATE_TABLES.map((entry) => entry.table));
    expect(declared.has("subject_refresh_state")).toBe(true);
    const projected = new Set(PROJECTION_REGISTRY
      .filter((projection) => projection.rebuildKind !== "none")
      .flatMap((projection) => projection.tables));
    expect(projected.has("subject_refresh_state")).toBe(false);

    const engagement = findProjection(FANSLY_ENGAGEMENT_PROJECTION);
    expect([...(engagement?.tables ?? [])]).toEqual([...FANSLY_ENGAGEMENT_PROJECTION_TABLES]);
    expect(engagement?.rebuildKind).toBe("truncate_replay");
    // `post_likes` IS truncated on rebuild: it is a fact projection whose
    // Fansly half happens to be empty, and "empty because nothing wrote it" has
    // to stay distinguishable from "empty because it was truncated".
    expect([...FANSLY_ENGAGEMENT_PROJECTION_TABLES]).toContain("post_likes");
  });
});
