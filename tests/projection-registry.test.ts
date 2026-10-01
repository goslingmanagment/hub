import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FANSLY_CATALOG_PROJECTION } from "../apps/runtime/src/services/projections/fansly-catalog.ts";
import { FANSLY_COMMENTS_PROJECTION } from "../apps/runtime/src/services/projections/fansly-comments.ts";
import {
  FANSLY_ENGAGEMENT_PROJECTION,
  FANSLY_ENGAGEMENT_PROJECTION_TABLES,
} from "../apps/runtime/src/services/projections/fansly-engagement.ts";
import { FANSLY_PAYOUTS_PROJECTION } from "../apps/runtime/src/services/projections/fansly-payouts.ts";
import { MEDIA_PLANE_PROJECTION } from "../apps/runtime/src/services/projections/media-plane.ts";
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

  it("is registered with a rebuild, and declares creator_media on nobody but the media plane", () => {
    const projection = findProjection(FANSLY_CATALOG_PROJECTION);
    expect(projection).not.toBeNull();
    expect(projection?.rebuildKind).toBe("truncate_replay");
    expect(projection?.rebuild).not.toBeNull();
    expect(projection?.tables).not.toContain("creator_media");
    expect(projection?.tables).not.toContain("creator_media_bundles");
    // The single-writer rule, stated as an ownership claim rather than a hope.
    expect(projection?.eventTypes).not.toContain("media.observed");
  });

  it("declares itself in the registry with a real rebuild and a partition preflight", () => {
    const definition = findProjection(FANSLY_COMMENTS_PROJECTION);
    expect(definition?.stateClass).toBe("fact_projection");
    expect(definition?.rebuildKind).toBe("truncate_replay");
    expect(definition?.rebuild).toBeTypeOf("function");
    expect(definition?.eventTypes).toEqual([
      "post.comment_observed",
      "post.comment_list_observed",
    ]);
    expect(definition?.tables).toEqual(["post_comments"]);
  });

  it("is registered with its tables, its types and a truncate-replay rebuild", () => {
    const definition = findProjection(FANSLY_PAYOUTS_PROJECTION);
    expect(definition).toBeDefined();
    expect(definition?.stateClass).toBe("fact_projection");
    expect(definition?.rebuildKind).toBe("truncate_replay");
    expect([...(definition?.tables ?? [])].sort()).toEqual([
      "page_payout_methods",
      "page_payout_requests",
    ]);
    expect([...(definition?.eventTypes ?? [])].sort()).toEqual([
      "payout.method_list_observed",
      "payout.method_observed",
      "payout.observed",
    ]);
  });
});

describe("media plane — registration", () => {
  // Source-level, and deliberately so: a projector that runs but that nobody
  // can REBUILD is a projection you cannot repair, and a projector registered
  // nowhere is a table that silently stops filling. Both are the kind of
  // omission a passing end-to-end test does not notice.
  //
  // WP-F1(0) moved the two registration sites INTO the projection registry, so
  // the property is now checked against the registry itself rather than against
  // the shape of two hand-written blocks. That is strictly stronger: the old
  // assertions could only see whether one specific literal was present, and the
  // registry is what the tick and the CLI now both read.
  it("is declared in the projection registry, with its rebuild and its tables", () => {
    const definition = findProjection(MEDIA_PLANE_PROJECTION);
    expect(definition).not.toBeNull();
    expect(definition?.rebuildKind).toBe("truncate_replay");
    expect(definition?.rebuild).not.toBeNull();
    expect(definition?.stateClass).toBe("fact_projection");
    expect([...(definition?.eventTypes ?? [])]).toEqual([
      "media.observed",
      "media.file_observed",
      "media.order_observed",
      "media.offer_location_observed",
      "message.attachments_observed",
    ]);
    expect([...(definition?.tables ?? [])]).toEqual([
      "creator_media",
      "creator_raw_media",
      "creator_media_bundles",
      "media_orders",
      "message_media_offers",
      "media_offer_locations",
    ]);
  });

  it("rides the registry-driven worker tick and the registry-driven CLI", () => {
    const worker = readFileSync(
      path.resolve("apps/runtime/src/worker-services.ts"),
      "utf8",
    );
    // The tick iterates the registry; nothing about media_plane is named here
    // any more, which is the point — one call site now covers every projection.
    expect(worker).toContain("runProjectionTick");

    const cli = readFileSync(path.resolve("apps/runtime/src/cli.ts"), "utf8");
    expect(cli).toContain("rebuildRegisteredProjection");
    // The argument help is DERIVED from the registry, so an accepted value
    // nobody is told about is impossible rather than merely caught.
    expect(cli).toContain("projectionNames().join(\" | \")");
    expect(projectionNames()).toContain(MEDIA_PLANE_PROJECTION);
  });
});
