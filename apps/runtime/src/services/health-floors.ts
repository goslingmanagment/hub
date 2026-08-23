// Shared health-floor registry (fast-reply freshness PR3; spec v7 amendment
// 5, v8 C4/C5). One descriptor per replayable consumer of the observations
// journal: today the canonicalizer families; PR4 adds the readthrough
// projector's descriptor HERE, and the runner imports its version floor from
// this registry — the sampler and the consumer share one constant, so floors
// cannot drift. The golden-signal SAMPLER (a separate job from the sweeps —
// a wedged sweep is measured, not self-reported) iterates this registry and
// emits one backlog-age gauge per family: now() - MIN(received_at) over the
// rows still below the family's version floor, zero when caught up. The
// family version is embedded in the metric name so a version bump starts a
// new series instead of silently redefining an old one.

import { sql } from "drizzle-orm";

import type { Database } from "@agency_hub_core/db";

import { CANONICALIZER_FAMILIES } from "./canonicalize/index.ts";

export interface HealthFloorDescriptor {
  /** Metric/series name; embeds lane AND version (obs_backlog_webhook_ofapi_v2). */
  name: string;
  source: string;
  /** Stable family lane id — unique across the registry (see healthFloorName). */
  lane: string;
  /** null = every kind of the source (measured via the parse-version index). */
  kinds: readonly string[] | null;
  version: number;
}

/** M4: one threshold for every family — 10 minutes of unconsumed backlog. */
export const HEALTH_FLOOR_THRESHOLD_MS = 600_000;

/**
 * Gauge/series name for one replayable consumer. The LANE is what keeps two
 * families that share a `source` apart: `posts` and `sync-pull` are both
 * source `pull`, and the moment sync-pull reached v5 (WP-F0(b)) the old
 * `obs_backlog_${source}_v${version}` name made both write one metric every
 * tick — two different backlogs under one name, and one silently wins in the
 * golden-signal threshold map (built with Object.fromEntries). The five
 * Fansly families the endpoints-cover initiative adds are all source `pull`
 * v1 and would have collided the same way.
 *
 * Consequence, stated rather than discovered: every existing series ends at
 * the rename and a new one starts. Ops metric samples are plain strings —
 * nothing migrates, nothing breaks, and dashboards read the new names.
 */
export function healthFloorName(source: string, lane: string, version: number): string {
  return `obs_backlog_${source}_${lane}_v${version}`;
}

/** PR4: the readthrough reconcile projector's observation kind + floor. The
 *  kind constant lives HERE so the capture tee, the runner, and the sampler
 *  all import one definition; the runner's version floor IS this descriptor's
 *  version — the sampler and the consumer cannot drift (v7 amendment 5).
 *  Wave 2 bumps the version to 2 at reducer cutover, in the same commit as
 *  the reducer, so v1-stamped observations replay through the real reducer. */
export const OFAPI_READTHROUGH_OBSERVATION_KIND = "ofapi_gateway_chat_messages_v2";

export const OFAPI_READTHROUGH_HEALTH_FLOOR: HealthFloorDescriptor = {
  name: healthFloorName("readthrough", "ofapi_dm", 2),
  source: "readthrough",
  lane: "ofapi_dm",
  kinds: [OFAPI_READTHROUGH_OBSERVATION_KIND],
  // v2 = the Wave-2 candidate-reducer cutover (v7 amendment 8): v1-stamped
  // observations fall below the floor and replay through the real reducer
  // (material no-ops for already-merged rows). Bumped in the SAME commit as
  // the reducer, so the sampler and the runner cannot drift.
  version: 2,
};

/** Registry-driven by construction: a version-0 family (nothing consumes its
 *  kinds yet) measures parse_version < 0 — an empty set, so its gauge is a
 *  constant zero rather than a false backlog. */
export const HEALTH_FLOOR_REGISTRY: readonly HealthFloorDescriptor[] = [
  ...CANONICALIZER_FAMILIES.map((family) => ({
    name: healthFloorName(family.source, family.lane, family.version),
    source: family.source,
    lane: family.lane,
    kinds: family.kinds,
    version: family.version,
  })),
  OFAPI_READTHROUGH_HEALTH_FLOOR,
];

/**
 * Backlog age (ms) for one family: the age of the OLDEST observation still
 * below the family's parse-version floor, 0 when fully caught up. Semantics are
 * unchanged from the first PR3 implementation — what changed is the access path.
 *
 * The probe used to be `min(received_at) where kind = $k and source = $s and
 * parse_version < $v` against `(kind, received_at)`. `source` and
 * `parse_version` were HEAP filters, so a CAUGHT-UP kind walked every row it
 * has, in every partition, to prove there was nothing there: 4.8 s and ~200 000
 * blocks for the webhook family alone on prod (2026-08-23), once a minute, per
 * family — the golden-signal sampler was one of the two jobs burning 81-89 % of
 * all block reads on the box.
 *
 * Two changes make it a bounded probe, both leaning on migration 0144's
 * `(source, kind, parse_version, received_at)`:
 *
 *  1. All three predicate columns are now INDEX conditions, so a caught-up pair
 *     is an empty index range rather than a table walk.
 *  2. `parse_version < $v` is expanded into one probe per version BELOW the
 *     floor. A range over the third column cannot use the fourth for ordering,
 *     so `min()` would still scan every pending row of that kind — and prod has
 *     ~850 k of them. With the version pinned by equality the index is already
 *     in `received_at` order, so `order by received_at limit 1` reads ONE tuple.
 *     `min over parse_version < v` is exactly `min over the per-version minima`,
 *     which is what the outer `max(age)` reassembles.
 *
 * A version-0 family (nothing consumes its kinds yet) generates an empty
 * version series and reports a constant zero — the same "measures an empty set"
 * behaviour `parse_version < 0` gave, kept deliberately.
 */
export async function computeHealthFloorBacklogMs(
  db: Database,
  floor: HealthFloorDescriptor,
): Promise<number> {
  if (floor.kinds === null) {
    // A kinds:null family is a total over its source, so `kind` cannot be
    // pinned and the per-version expansion buys nothing: the probe scans this
    // source's slice of the index (command_result, the only such family, is
    // ~5.6 k rows on prod). Still index-only — `source` is the leading column.
    const result = await db.execute<{ backlog_ms: string | null }>(sql`
      select coalesce(extract(epoch from (now() - min(o.received_at))) * 1000, 0)::float8 as backlog_ms
      from observations o
      where o.source = ${floor.source} and o.parse_version < ${floor.version}
    `);
    return Number(result.rows[0]?.backlog_ms ?? 0);
  }
  if (floor.kinds.length === 0) {
    return 0;
  }
  const result = await db.execute<{ backlog_ms: string | null }>(sql`
    select coalesce(max(extract(epoch from (now() - pending.received_at)) * 1000), 0)::float8 as backlog_ms
    from unnest(${sql.raw(`array[${floor.kinds.map((kind) => `'${kind.replaceAll("'", "''")}'`).join(",")}]::text[]`)}) as kind_list(kind)
    cross join generate_series(0, ${floor.version - 1}) as below_floor(parse_version)
    cross join lateral (
      select o.received_at
      from observations o
      where o.source = ${floor.source}
        and o.kind = kind_list.kind
        and o.parse_version = below_floor.parse_version
      order by o.received_at asc
      limit 1
    ) pending
  `);
  return Number(result.rows[0]?.backlog_ms ?? 0);
}
