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
 * Backlog age (ms) for one family: per-KIND MIN(received_at) over the
 * (kind, received_at) index — one lateral probe per kind, each an index
 * min-scan — MAX-aggregated into the single family gauge. A kinds:null
 * family (total over its source) uses the observations_parse_idx access
 * path instead. Returns 0 when fully caught up.
 */
export async function computeHealthFloorBacklogMs(
  db: Database,
  floor: HealthFloorDescriptor,
): Promise<number> {
  if (floor.kinds === null) {
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
    select coalesce(max(extract(epoch from (now() - per_kind.min_received)) * 1000), 0)::float8 as backlog_ms
    from unnest(${sql.raw(`array[${floor.kinds.map((kind) => `'${kind.replaceAll("'", "''")}'`).join(",")}]::text[]`)}) as kind_list(kind)
    cross join lateral (
      select min(o.received_at) as min_received
      from observations o
      where o.kind = kind_list.kind
        and o.source = ${floor.source}
        and o.parse_version < ${floor.version}
    ) per_kind
  `);
  return Number(result.rows[0]?.backlog_ms ?? 0);
}
