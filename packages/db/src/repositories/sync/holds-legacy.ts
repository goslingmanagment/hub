import { sql } from "drizzle-orm";

import type { Database } from "../../client.ts";
import { listSyncHolds, SYNC_RESOURCE_HOLD_KIND, type SyncHoldRow } from "./holds.ts";
import { jsonParam, SYNC_INDEFINITE_UNTIL_MS, timestampParam, untilParam } from "./values.ts";

// The old hold columns of `sync_pages`: still written, no longer read (step 4,
// S4-31 — the first of the three releases that take them away; owner decision
// №26).
//
// A page's holds are its rows of `sync_holds`, and this build reads nothing
// else. The image before it (the hold-set release) reads them there too —
// but whenever it acquires a page's ownership, and before a hold write under
// no generation, it compares the page's old columns with what the rows make
// them: the hold slot (`hold_kind`, `hold_until`, `hold_since`, `hold_detail`,
// with a network hold carried in `hold_detail.timedHold` beside a credentials
// hold) and `resource_holds` (the resource breakers by file, and the route
// state under `route:state`). Where they differ the columns win: it replaces
// the rows by what they say. That is right against a writer that knows
// nothing but the columns; after a rollback from a build that wrote the rows
// and left the columns behind, it would lose every hold that build took and
// bring back every hold it lifted.
//
// So every write of the hold set still rewrites those columns from the page's
// rows in the same transaction (`mirrorSyncHoldsToLegacyColumns`): they are
// always exactly what `legacyHoldColumnsOf` makes of the rows, and a rollback
// to that image finds nothing to read back.
//
// A hold changed by hand is changed in the rows — and in the columns too
// while that image is a rollback target: rows changed alone stand here (the
// columns follow at the page's next hold write) and would be replaced from
// the columns by a rollback before it.
//
// The way out is three releases, each a safe rollback target of the next:
//
//   1. this build: nothing reads the columns back, the mirror stays. Before
//      it ships every page's rows are what its columns say — the hold-set
//      release has acquired the page. `hold_step`, which that release neither
//      reads nor writes, is dropped (0243);
//   2. the mirror and this file go: a rollback to (1) reads no column;
//   3. the columns are dropped: a rollback to (2) neither reads nor writes
//      them.

/** Where the old slot carries a network hold beside a credentials hold. */
const LEGACY_CARRIED_HOLD_FIELD = "timedHold";
/** The route-state namespace inside `sync_pages.resource_holds`, and the one
 *  version of it there ever was. */
const LEGACY_ROUTE_STATE_KEY = "route:state";
const LEGACY_ROUTE_NAMESPACE_VERSION = 1;

/** The old hold columns of a `sync_pages` row, as stored. */
export interface SyncLegacyHoldColumns {
  holdKind: string | null;
  holdUntil: Date | null;
  holdSince: Date | null;
  holdDetail: Record<string, unknown>;
  /** `resource_holds`, the route-state namespace included. */
  resourceHolds: Record<string, unknown>;
}

function isCredentialsKind(kind: string): boolean {
  return kind === "auth" || kind === "identity_mismatch";
}

function without(detail: Readonly<Record<string, unknown>>, field: string): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...detail };
  delete rest[field];
  return rest;
}

// ── rows → the old columns ──────────────────────────────────────────────────

/**
 * The old columns of a page whose hold set is `rows` (pure): what the
 * previous image must read to hold what the rows hold.
 *
 * - the hold slot: the credentials hold, with the network hold carried in its
 *   detail when both stand; else the network hold; else empty;
 * - `resource_holds[file]`: each resource breaker `{until, step, since}`;
 * - `resource_holds['route:state']`: every route's entry (version 1), the
 *   hold's end and the slowdown state in one object as that image reads it.
 */
export function legacyHoldColumnsOf(rows: readonly SyncHoldRow[]): SyncLegacyHoldColumns {
  const page = rows.filter((row) => row.scope === "page");
  const credentials = page.find((row) => isCredentialsKind(row.kind)) ?? null;
  const network = page.find((row) => row.kind === "network" && row.until !== null) ?? null;
  const columns: SyncLegacyHoldColumns = { holdKind: null, holdUntil: null, holdSince: null, holdDetail: {}, resourceHolds: {} };
  if (credentials !== null) {
    columns.holdKind = credentials.kind;
    columns.holdUntil = credentials.until ?? new Date(SYNC_INDEFINITE_UNTIL_MS);
    columns.holdSince = credentials.since;
    columns.holdDetail = {
      ...without(credentials.detail, LEGACY_CARRIED_HOLD_FIELD),
      ...(network === null
        ? {}
        : { [LEGACY_CARRIED_HOLD_FIELD]: { kind: "network", until: network.until!.toISOString(), detail: network.detail } }),
    };
  } else if (network !== null) {
    columns.holdKind = "network";
    columns.holdUntil = network.until;
    columns.holdSince = network.since;
    columns.holdDetail = { ...network.detail };
  }
  for (const row of rows) {
    if (row.scope !== "resource" || row.kind !== SYNC_RESOURCE_HOLD_KIND || row.until === null) continue;
    columns.resourceHolds[row.key] = { until: row.until.toISOString(), step: row.ladderStep, since: row.since.toISOString() };
  }
  const routes: Record<string, unknown> = {};
  for (const route of [...new Set(rows.filter((row) => row.scope === "route").map((row) => row.key))].sort()) {
    const budget = rows.find((row) => row.scope === "route" && row.key === route && row.kind === "route_budget") ?? null;
    const hold = rows.find((row) => row.scope === "route" && row.key === route && row.kind === "route_hold") ?? null;
    if (budget === null && hold === null) continue;
    const detail = budget?.detail ?? {};
    routes[route] = {
      holdUntil: hold?.until?.toISOString() ?? null,
      ladderStep: budget?.ladderStep ?? 0,
      effectivePerMin: detail.effectivePerMin ?? null,
      policyVersion: detail.policyVersion ?? null,
      last429AttemptId: detail.last429AttemptId ?? null,
      last429At: detail.last429At ?? null,
      revision: budget?.revision ?? hold!.revision,
    };
  }
  if (Object.keys(routes).length > 0) {
    columns.resourceHolds[LEGACY_ROUTE_STATE_KEY] = { version: LEGACY_ROUTE_NAMESPACE_VERSION, routes };
  }
  return columns;
}

// ── the database ────────────────────────────────────────────────────────────

/**
 * Rewrite a page's old hold columns from its rows — the second half of every
 * hold write, in the writer's transaction. `network_failure_streak` is left
 * alone: a counter and no hold.
 */
export async function mirrorSyncHoldsToLegacyColumns(db: Database, pageId: number): Promise<void> {
  const columns = legacyHoldColumnsOf(await listSyncHolds(db, pageId));
  await db.execute(sql`
    update sync_pages
       set hold_kind = ${columns.holdKind}::text,
           hold_until = ${untilParam(columns.holdUntil)},
           hold_since = ${timestampParam(columns.holdSince)},
           hold_detail = ${jsonParam(columns.holdDetail)},
           resource_holds = ${jsonParam(columns.resourceHolds)},
           updated_at = clock_timestamp()
     where page_id = ${pageId}
  `);
}
