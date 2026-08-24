// WP-F0 / F1(0).3 — the health-floor gauge name is an OPS METRIC SERIES, and
// two families writing one name is a silent data corruption, not a test-only
// nicety: `ops_metric_samples` stores plain strings, and the golden-signals
// threshold map is built with `Object.fromEntries`, where a duplicate key
// silently collapses to whichever entry came last.
//
// The concrete collision this file exists for: `posts` is source `pull` v5 and
// `sync-pull` reached v5 with the WP-F0(b) media-plane bump. Under the old
// `obs_backlog_${source}_v${version}` shape both would have written
// `obs_backlog_pull_v5` every tick — two different backlogs under one name.

import { describe, expect, it } from "vitest";

import { CANONICALIZER_FAMILIES } from "../apps/runtime/src/services/canonicalize/index.ts";
import { FANSLY_REPLAY_FAMILY } from "../apps/runtime/src/services/canonicalize/fansly-replay.ts";
import {
  HEALTH_FLOOR_REGISTRY,
  healthFloorName,
} from "../apps/runtime/src/services/health-floors.ts";
import { GOLDEN_SIGNAL_THRESHOLDS_MS } from "../apps/runtime/src/services/golden-signals.ts";

describe("health-floor gauge names", () => {
  it("every registered canonicalizer family declares a lane", () => {
    for (const family of CANONICALIZER_FAMILIES) {
      expect(typeof family.lane, `${family.source} family lane`).toBe("string");
      expect(family.lane.length).toBeGreaterThan(0);
      // A lane must be version-INDEPENDENT: it identifies the family, and a
      // version bump must move the series, not rename the family.
      expect(family.lane).not.toMatch(/v?\d+$/);
    }
  });

  it("names are unique across the whole registry", () => {
    const names = HEALTH_FLOOR_REGISTRY.map((floor) => floor.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("sync-pull v5 and the current posts family no longer share a gauge name", () => {
    const posts = CANONICALIZER_FAMILIES.find((family) => family.lane === "posts");
    const syncPull = CANONICALIZER_FAMILIES.find((family) => family.lane === "sync");
    expect(posts).toBeDefined();
    expect(syncPull).toBeDefined();
    // The premise of the collision: same SOURCE. The two families reached v5
    // together, which is when the old `obs_backlog_${source}_v${version}` shape
    // made them write one name; WP-F6 has since moved posts to v6, so the
    // collision is asserted at the version they SHARED rather than at today's
    // numbers, which happen to differ. It is the LANE, not the version, that
    // keeps the two series apart — and a future bump that lands sync-pull on
    // the same number again must not re-open this.
    expect(syncPull!.source).toBe(posts!.source);
    expect(healthFloorName(posts!.source, posts!.lane, 5)).toBe("obs_backlog_pull_posts_v5");
    expect(healthFloorName(syncPull!.source, syncPull!.lane, 5)).toBe("obs_backlog_pull_sync_v5");
    // …and at the versions that are live today.
    expect(syncPull!.version).toBe(5);
    expect(posts!.version).toBe(7);
    const postsName = healthFloorName(posts!.source, posts!.lane, posts!.version);
    const syncName = healthFloorName(syncPull!.source, syncPull!.lane, syncPull!.version);
    expect(postsName).toBe("obs_backlog_pull_posts_v7");
    expect(syncName).toBe("obs_backlog_pull_sync_v5");
    expect(postsName).not.toBe(syncName);
  });

  it("the off-registry Fansly replay family cannot alias a registered pull family", () => {
    const replayName = healthFloorName(
      FANSLY_REPLAY_FAMILY.source,
      FANSLY_REPLAY_FAMILY.lane,
      FANSLY_REPLAY_FAMILY.version,
    );
    expect(HEALTH_FLOOR_REGISTRY.map((floor) => floor.name)).not.toContain(replayName);
    for (const family of CANONICALIZER_FAMILIES) {
      expect(family.lane).not.toBe(FANSLY_REPLAY_FAMILY.lane);
    }
  });

  it("every floor name reaches the golden-signal threshold map unshadowed", () => {
    // Object.fromEntries collapses duplicates silently — this asserts the map
    // actually carries one key per floor, which is only true while the names
    // are unique.
    for (const floor of HEALTH_FLOOR_REGISTRY) {
      expect(GOLDEN_SIGNAL_THRESHOLDS_MS[floor.name]).toBe(600_000);
    }
    const floorKeys = Object.keys(GOLDEN_SIGNAL_THRESHOLDS_MS)
      .filter((key) => key.startsWith("obs_backlog_"));
    expect(floorKeys.length).toBe(HEALTH_FLOOR_REGISTRY.length);
  });
});
