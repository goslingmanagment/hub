import { sql } from "drizzle-orm";

import type { Database } from "../../client.ts";
import {
  listSyncHolds,
  SYNC_PAGE_HOLD_KEY,
  SYNC_RESOURCE_HOLD_KIND,
  type SyncHoldRow,
} from "./holds.ts";
import { jsonParam, SYNC_INDEFINITE_UNTIL_MS, timestampParam, toDate, untilParam } from "./values.ts";

// The hold set beside the columns it replaces (step 4, S4-30), until S4-31
// takes the columns and this file away — in the three releases at the end of
// this comment.
//
// The previous image reads a page's holds only from `sync_pages`: the hold
// slot (`hold_kind`, `hold_until`, `hold_since`, `hold_detail`, with a network
// hold carried in `hold_detail.timedHold` beside a credentials hold) and
// `resource_holds` (the resource breakers by file, and the route state under
// `route:state`). A rollback to it must not fail open, and what it wrote must
// not be lost when this image comes back. So:
//
//   - every write of the hold set rewrites those columns from the page's rows
//     in the same transaction (`mirrorSyncHoldsToLegacyColumns`): they are
//     always exactly what `legacyHoldColumnsOf` makes of the rows;
//   - whenever a page's ownership is acquired — and before a hold write under
//     no generation, which can come before that acquisition — the columns
//     are compared with what the rows make them; if they differ, someone who
//     knows only the columns wrote them — the previous image, or a hand — and
//     the columns win: the page's rows are replaced by what they say
//     (`holdRowsOfLegacyColumns`, `reconcileSyncHoldsWithLegacyColumns`).
//     That is also how a page's state first reaches the table.
//
// Nothing else reads the columns. A hold changed by hand is changed on both
// sides — or, with `sync` stopped, in the columns alone: rows changed alone
// are replaced from the columns at the page's next acquisition, and columns
// changed alone under a running owner are rewritten from the rows by its next
// hold write.
//
// "The columns win" is right only against a writer that knows nothing but the
// columns. A build that wrote the rows and left the columns behind would, on
// a rollback to this one, lose every hold it took and get back every hold it
// lifted. So the way out is three releases, each a safe rollback target of
// the next:
//
//   1. the two `reconcileSyncHoldsWithLegacyColumns` calls go, the mirror
//      stays: a rollback to this build finds the columns equal to the rows;
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

/** A row to write: `since` null takes the database clock. */
export interface SyncHoldWrite extends Omit<SyncHoldRow, "since"> {
  since: Date | null;
}

/** The old columns hold a route state no build ever wrote (another version, a
 *  shape that is not an entry): nothing is imported and the page's ownership
 *  is not taken until it is repaired — an unreadable hold never opens a page. */
export class SyncLegacyHoldsUnreadableError extends Error {
  readonly pageId: number;
  readonly diagnostic: string;

  constructor(pageId: number, diagnostic: string) {
    super(`Fansly sync page ${pageId}: the old hold columns are not readable (${diagnostic}); the hold set was not imported`);
    this.name = "SyncLegacyHoldsUnreadableError";
    this.pageId = pageId;
    this.diagnostic = diagnostic;
  }
}

class UnreadableLegacyState extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function instantOf(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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

// ── the old columns → rows ──────────────────────────────────────────────────

function pageRowsOf(columns: SyncLegacyHoldColumns): SyncHoldWrite[] {
  const { holdKind, holdDetail } = columns;
  if (holdKind === null || columns.holdUntil === null) return [];
  const page = { scope: "page", key: SYNC_PAGE_HOLD_KEY, ladderStep: 0, revision: 1 };
  // An end that is not an instant holds indefinitely: never a way out.
  const until = Number.isNaN(columns.holdUntil.getTime()) ? new Date(SYNC_INDEFINITE_UNTIL_MS) : columns.holdUntil;
  if (!isCredentialsKind(holdKind)) {
    // The network back-off — or a kind no build takes any more (the page-wide
    // 429 hold an older build wrote): it holds the page until its end all the
    // same, as the timed hold it is, and names what it was.
    const detail = holdKind === "network" ? { ...holdDetail } : { ...holdDetail, legacyKind: holdKind };
    return [{ ...page, kind: "network", until, since: columns.holdSince, detail }];
  }
  const rows: SyncHoldWrite[] = [{
    ...page,
    kind: holdKind,
    until,
    since: columns.holdSince,
    detail: without(holdDetail, LEGACY_CARRIED_HOLD_FIELD),
  }];
  const carried = holdDetail[LEGACY_CARRIED_HOLD_FIELD];
  if (!isRecord(carried)) return rows;
  const carriedUntil = instantOf(carried.until);
  if ((carried.kind !== "network" && carried.kind !== "rate_limit") || carriedUntil === null) return rows;
  const carriedDetail = isRecord(carried.detail) ? { ...carried.detail } : {};
  rows.push({
    ...page,
    kind: "network",
    until: carriedUntil,
    since: instantOf(carried.kind === "network" ? carriedDetail.networkSince : carriedDetail.lastRateLimitAt),
    detail: carried.kind === "network" ? carriedDetail : { ...carriedDetail, legacyKind: carried.kind },
  });
  return rows;
}

function resourceRowsOf(columns: SyncLegacyHoldColumns): SyncHoldWrite[] {
  const rows: SyncHoldWrite[] = [];
  for (const [file, value] of Object.entries(columns.resourceHolds)) {
    // The route state is read apart; an entry with a `kind` is an older
    // build's endpoint-group hold, which no build reads any more; an entry
    // without an end never held anything.
    if (file === LEGACY_ROUTE_STATE_KEY || file.length === 0 || !isRecord(value) || "kind" in value) continue;
    const until = instantOf(value.until);
    if (until === null) continue;
    rows.push({
      scope: "resource",
      key: file,
      kind: SYNC_RESOURCE_HOLD_KIND,
      until,
      since: instantOf(value.since),
      ladderStep: isCount(value.step) ? value.step : 0,
      detail: {},
      revision: 1,
    });
  }
  return rows;
}

function routeRowsOf(columns: SyncLegacyHoldColumns): SyncHoldWrite[] {
  const raw = columns.resourceHolds[LEGACY_ROUTE_STATE_KEY];
  if (raw === undefined || raw === null) return [];
  if (!isRecord(raw)) throw new UnreadableLegacyState("route_state_not_an_object");
  if (raw.version !== LEGACY_ROUTE_NAMESPACE_VERSION) throw new UnreadableLegacyState(`route_state_version:${String(raw.version)}`);
  if (!isRecord(raw.routes)) throw new UnreadableLegacyState("route_state_routes");
  const rows: SyncHoldWrite[] = [];
  for (const [route, entry] of Object.entries(raw.routes)) {
    const unreadable = new UnreadableLegacyState(`route_state_entry:${route}`);
    if (route.length === 0 || !isRecord(entry)) throw unreadable;
    const { holdUntil, ladderStep, effectivePerMin, policyVersion, last429AttemptId, last429At, revision } = entry;
    if (holdUntil !== null && instantOf(holdUntil) === null) throw unreadable;
    if (last429At !== null && instantOf(last429At) === null) throw unreadable;
    if (!isCount(ladderStep) || !isCount(revision) || revision === 0) throw unreadable;
    if (effectivePerMin !== null && !(typeof effectivePerMin === "number" && Number.isFinite(effectivePerMin) && effectivePerMin > 0)) throw unreadable;
    if (policyVersion !== null && typeof policyVersion !== "string") throw unreadable;
    if (last429AttemptId !== null && !(isCount(last429AttemptId) && last429AttemptId > 0)) throw unreadable;
    const base = { scope: "route", key: route, since: null };
    rows.push({
      ...base,
      kind: "route_budget",
      until: null,
      ladderStep,
      detail: { effectivePerMin, policyVersion, last429AttemptId, last429At },
      revision,
    });
    if (holdUntil !== null) {
      rows.push({ ...base, kind: "route_hold", until: instantOf(holdUntil), ladderStep: 0, detail: {}, revision: 1 });
    }
  }
  return rows;
}

/**
 * The hold set the old columns say (pure): the rows `legacyHoldColumnsOf`
 * turns back into those columns. Throws `SyncLegacyHoldsUnreadableError` for
 * a route state no build wrote.
 */
export function holdRowsOfLegacyColumns(pageId: number, columns: SyncLegacyHoldColumns): SyncHoldWrite[] {
  try {
    return [...pageRowsOf(columns), ...resourceRowsOf(columns), ...routeRowsOf(columns)];
  } catch (error) {
    if (error instanceof UnreadableLegacyState) throw new SyncLegacyHoldsUnreadableError(pageId, error.message);
    throw error;
  }
}

// ── comparison ──────────────────────────────────────────────────────────────

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function instantMs(value: Date | null): number | null {
  if (value === null) return null;
  return Number.isNaN(value.getTime()) || value.getTime() >= SYNC_INDEFINITE_UNTIL_MS ? SYNC_INDEFINITE_UNTIL_MS : value.getTime();
}

/** Whether two sets of old columns say the same: the slot's kind and
 *  instants, and its detail and `resource_holds` as JSON values. */
export function sameLegacyHoldColumns(left: SyncLegacyHoldColumns, right: SyncLegacyHoldColumns): boolean {
  return left.holdKind === right.holdKind
    && instantMs(left.holdUntil) === instantMs(right.holdUntil)
    && instantMs(left.holdSince) === instantMs(right.holdSince)
    && JSON.stringify(canonical(left.holdDetail)) === JSON.stringify(canonical(right.holdDetail))
    && JSON.stringify(canonical(left.resourceHolds)) === JSON.stringify(canonical(right.resourceHolds));
}

// ── the database ────────────────────────────────────────────────────────────

/**
 * Rewrite a page's old hold columns from its rows — the second half of every
 * hold write, in the writer's transaction. `hold_step` is
 * left alone (nothing has stepped it since a 429 holds its route), as is
 * `network_failure_streak`, which is a counter and no hold.
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

async function readLegacyHoldColumns(db: Database, pageId: number): Promise<SyncLegacyHoldColumns | null> {
  const result = await db.execute<{
    holdKind: string | null;
    holdUntil: Date | string | number | null;
    holdSince: Date | string | number | null;
    holdDetail: Record<string, unknown> | null;
    resourceHolds: Record<string, unknown> | null;
  }>(sql`
    select hold_kind as "holdKind", hold_until as "holdUntil", hold_since as "holdSince",
           hold_detail as "holdDetail", resource_holds as "resourceHolds"
      from sync_pages
     where page_id = ${pageId}
  `);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    holdKind: row.holdKind,
    holdUntil: toDate(row.holdUntil),
    holdSince: toDate(row.holdSince),
    holdDetail: row.holdDetail ?? {},
    resourceHolds: row.resourceHolds ?? {},
  };
}

/** What `reconcileSyncHoldsWithLegacyColumns` found. */
export interface SyncHoldsReconciliation {
  /** The columns said something else than the rows: the rows were replaced. */
  imported: boolean;
  /** The page's hold set after it. */
  holds: number;
}

/**
 * Bring a page's hold set in line with its old columns when they are not what
 * its rows make them (`legacyHoldColumnsOf`): someone who knows only the
 * columns wrote them, so they win — the rows are replaced by what they say,
 * and the columns then rewritten from the rows. The caller holds the page row
 * FOR NO KEY UPDATE — about to own the page (`acquireSyncPageOwnership`), or
 * about to write its hold set under no generation (`writeHoldSet`): nobody
 * else writes either side meanwhile.
 * Idempotent — a page whose two sides agree is not written. Throws
 * `SyncLegacyHoldsUnreadableError` and writes nothing when columns that
 * disagree hold a route state that cannot be read.
 */
export async function reconcileSyncHoldsWithLegacyColumns(db: Database, pageId: number): Promise<SyncHoldsReconciliation> {
  const columns = await readLegacyHoldColumns(db, pageId);
  const rows = await listSyncHolds(db, pageId);
  if (columns === null || sameLegacyHoldColumns(columns, legacyHoldColumnsOf(rows))) return { imported: false, holds: rows.length };
  const said = holdRowsOfLegacyColumns(pageId, columns);
  await db.execute(sql`delete from sync_holds where page_id = ${pageId}`);
  for (const row of said) {
    await db.execute(sql`
      insert into sync_holds (page_id, scope, key, kind, until, since, ladder_step, detail, revision)
      values (${pageId}, ${row.scope}, ${row.key}, ${row.kind}, ${untilParam(row.until)},
              coalesce(${timestampParam(row.since)}, clock_timestamp()), ${row.ladderStep}, ${jsonParam(row.detail)},
              ${row.revision})
    `);
  }
  await mirrorSyncHoldsToLegacyColumns(db, pageId);
  return { imported: true, holds: said.length };
}
