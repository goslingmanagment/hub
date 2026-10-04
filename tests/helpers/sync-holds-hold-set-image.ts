import type { Pool, PoolClient } from "pg";

import { normalizeSyncHoldRows, type FanslySendHolderIdentity, type SyncHoldRow } from "@agency_hub_core/db";
import { INDEFINITE_UNTIL } from "@agency_hub_core/shared";

import { previousImageHoldColumnsOf, type PreviousImageHoldColumns } from "./sync-holds-previous-image.ts";

// The hold-set release's read of the old hold columns, frozen (step 4, S4-32).
//
// The hold-set release (S4-30, 278a4e05) keeps a page's holds in `sync_holds`
// and in the old hold columns of the page row at once, and lets the COLUMNS
// win: whenever it acquires a page, and before a hold write under no
// generation, it compares the columns with what the rows make them and, where
// they differ, replaces the rows by what the columns say
// (`reconcileSyncHoldsWithLegacyColumns` of its
// `packages/db/src/repositories/sync/holds-legacy.ts`, called from
// `acquireSyncPageOwnership` and `writeHoldSet` of its `pages.ts`). Columns it
// cannot read refuse the page instead (`SyncLegacyHoldsUnreadableError`).
//
// This release leaves the columns stale and marks them so at every
// acquisition; that image must then refuse the page rather than read them.
// The tests prove it with that image's own code, kept here as it was:
//
//   - the columns → rows half and the comparison are its functions, body for
//     body (`holdRowsOfLegacyColumns` with `pageRowsOf`, `resourceRowsOf`,
//     `routeRowsOf`; `sameLegacyHoldColumns`);
//   - the rows → columns half is `previousImageHoldColumnsOf` — its
//     `legacyHoldColumnsOf`, which the release after it kept unchanged;
//   - the database half (`readLegacyHoldColumns`, `listSyncHolds`,
//     `reconcileSyncHoldsWithLegacyColumns`, `mirrorSyncHoldsToLegacyColumns`)
//     and the acquisition are its statements, in its order, sent through one
//     pool client inside one transaction where it sent them through drizzle.
//     The acquisition judges the previous owner by the database's own
//     evidence — never owned, a safe release, a confirmed stop; its OS-level
//     proof is the host's and no part of this.
//
// The release between that one and this (S4-31, 25a07294) acquires a page by
// the same statements without the read of the old columns
// (`acquireAsPreviousImage`): it names no old column there, and writes them
// only at the end of a hold write (tests/helpers/sync-holds-previous-image.ts).
//
// It goes with the columns.

const INDEFINITE_UNTIL_MS = INDEFINITE_UNTIL.getTime();

/** Where the old slot carries a network hold beside a credentials hold. */
const LEGACY_CARRIED_HOLD_FIELD = "timedHold";
/** The route-state namespace inside `sync_pages.resource_holds`, and the one
 *  version of it there ever was. */
const LEGACY_ROUTE_STATE_KEY = "route:state";
const LEGACY_ROUTE_NAMESPACE_VERSION = 1;

/** A row to write: `since` null takes the database clock. */
interface SyncHoldWrite extends Omit<SyncHoldRow, "since"> {
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

// ── the old columns → rows ──────────────────────────────────────────────────

function pageRowsOf(columns: PreviousImageHoldColumns): SyncHoldWrite[] {
  const { holdKind, holdDetail } = columns;
  if (holdKind === null || columns.holdUntil === null) return [];
  const page = { scope: "page", key: "", ladderStep: 0, revision: 1 };
  // An end that is not an instant holds indefinitely: never a way out.
  const until = Number.isNaN(columns.holdUntil.getTime()) ? new Date(INDEFINITE_UNTIL_MS) : columns.holdUntil;
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

function resourceRowsOf(columns: PreviousImageHoldColumns): SyncHoldWrite[] {
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
      kind: "resource_breaker",
      until,
      since: instantOf(value.since),
      ladderStep: isCount(value.step) ? value.step : 0,
      detail: {},
      revision: 1,
    });
  }
  return rows;
}

function routeRowsOf(columns: PreviousImageHoldColumns): SyncHoldWrite[] {
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
export function holdRowsOfLegacyColumns(pageId: number, columns: PreviousImageHoldColumns): SyncHoldWrite[] {
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
  return Number.isNaN(value.getTime()) || value.getTime() >= INDEFINITE_UNTIL_MS ? INDEFINITE_UNTIL_MS : value.getTime();
}

/** Whether two sets of old columns say the same: the slot's kind and
 *  instants, and its detail and `resource_holds` as JSON values. */
export function sameLegacyHoldColumns(left: PreviousImageHoldColumns, right: PreviousImageHoldColumns): boolean {
  return left.holdKind === right.holdKind
    && instantMs(left.holdUntil) === instantMs(right.holdUntil)
    && instantMs(left.holdSince) === instantMs(right.holdSince)
    && JSON.stringify(canonical(left.holdDetail)) === JSON.stringify(canonical(right.holdDetail))
    && JSON.stringify(canonical(left.resourceHolds)) === JSON.stringify(canonical(right.resourceHolds));
}

// ── the database ────────────────────────────────────────────────────────────

/** node-postgres parses a timestamptz `'infinity'` as the NUMBER Infinity. */
function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (value === Number.POSITIVE_INFINITY || value === "infinity") return new Date(INDEFINITE_UNTIL_MS);
  if (value === Number.NEGATIVE_INFINITY || value === "-infinity") return new Date(-INDEFINITE_UNTIL_MS);
  return new Date(value);
}

/** A hold's end as a timestamptz parameter (that image's `untilParam`). */
function untilParam(value: Date | null): string | null {
  if (value === null) return null;
  return value.getTime() >= INDEFINITE_UNTIL_MS ? "infinity" : value.toISOString();
}

/** A page's hold set, ordered by scope, key and kind. */
async function listSyncHolds(tx: PoolClient, pageId: number): Promise<SyncHoldRow[]> {
  const result = await tx.query(
    `select h.scope, h.key, h.kind, h.until, h.since, h.ladder_step as "ladderStep", h.detail, h.revision::text as revision
       from sync_holds h
      where h.page_id = $1
      order by h.scope, h.key, h.kind`,
    [pageId],
  );
  return normalizeSyncHoldRows(result.rows);
}

async function mirrorSyncHoldsToLegacyColumns(tx: PoolClient, pageId: number): Promise<void> {
  const columns = previousImageHoldColumnsOf(await listSyncHolds(tx, pageId));
  await tx.query(
    `update sync_pages
        set hold_kind = $2::text,
            hold_until = $3::timestamptz,
            hold_since = $4::timestamptz,
            hold_detail = $5::jsonb,
            resource_holds = $6::jsonb,
            updated_at = clock_timestamp()
      where page_id = $1`,
    [
      pageId, columns.holdKind, untilParam(columns.holdUntil), columns.holdSince?.toISOString() ?? null,
      JSON.stringify(columns.holdDetail), JSON.stringify(columns.resourceHolds),
    ],
  );
}

async function readLegacyHoldColumns(tx: PoolClient, pageId: number): Promise<PreviousImageHoldColumns | null> {
  const result = await tx.query<{
    holdKind: string | null;
    holdUntil: Date | string | number | null;
    holdSince: Date | string | number | null;
    holdDetail: Record<string, unknown> | null;
    resourceHolds: Record<string, unknown> | null;
  }>(
    `select hold_kind as "holdKind", hold_until as "holdUntil", hold_since as "holdSince",
            hold_detail as "holdDetail", resource_holds as "resourceHolds"
       from sync_pages
      where page_id = $1`,
    [pageId],
  );
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
interface SyncHoldsReconciliation {
  /** The columns said something else than the rows: the rows were replaced. */
  imported: boolean;
  /** The page's hold set after it. */
  holds: number;
}

/**
 * Bring a page's hold set in line with its old columns when they are not what
 * its rows make them: someone who knows only the columns wrote them, so they
 * win — the rows are replaced by what they say, and the columns then rewritten
 * from the rows. The caller holds the page row FOR NO KEY UPDATE. Idempotent —
 * a page whose two sides agree is not written. Throws
 * `SyncLegacyHoldsUnreadableError` and writes nothing when columns that
 * disagree hold a route state that cannot be read.
 */
async function reconcileSyncHoldsWithLegacyColumns(tx: PoolClient, pageId: number): Promise<SyncHoldsReconciliation> {
  const columns = await readLegacyHoldColumns(tx, pageId);
  const rows = await listSyncHolds(tx, pageId);
  if (columns === null || sameLegacyHoldColumns(columns, previousImageHoldColumnsOf(rows))) return { imported: false, holds: rows.length };
  const said = holdRowsOfLegacyColumns(pageId, columns);
  await tx.query("delete from sync_holds where page_id = $1", [pageId]);
  for (const row of said) {
    await tx.query(
      `insert into sync_holds (page_id, scope, key, kind, until, since, ladder_step, detail, revision)
       values ($1, $2, $3, $4, $5::timestamptz,
               coalesce($6::timestamptz, clock_timestamp()), $7, $8::jsonb,
               $9)`,
      [
        pageId, row.scope, row.key, row.kind, untilParam(row.until),
        row.since?.toISOString() ?? null, row.ladderStep, JSON.stringify(row.detail),
        row.revision,
      ],
    );
  }
  await mirrorSyncHoldsToLegacyColumns(tx, pageId);
  return { imported: true, holds: said.length };
}

/** A test database: its pool (`StartedTestDatabase`). */
interface TestDatabase {
  pool: Pool;
}

async function inTransaction<T>(target: TestDatabase, run: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await target.pool.connect();
  try {
    await tx.query("begin");
    const result = await run(tx);
    await tx.query("commit");
    return result;
  } catch (error) {
    await tx.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    tx.release();
  }
}

export type OlderImageAcquisition =
  | { kind: "acquired"; generation: bigint; holdsImported: boolean }
  | { kind: "unconfirmed" }
  | { kind: "no_page" };

interface AcquireInput {
  pageId: number;
  owner: FanslySendHolderIdentity;
}

async function acquire(target: TestDatabase, input: AcquireInput, image: "hold-set" | "previous"): Promise<OlderImageAcquisition> {
  return inTransaction(target, async (tx): Promise<OlderImageAcquisition> => {
    const locked = await tx.query<{
      ownerGeneration: string;
      ownerReleasedAt: Date | null;
      ownerReleaseGeneration: string | null;
      stopConfirmedAfterAcquire: boolean;
    }>(
      `select sp.owner_generation::text as "ownerGeneration",
              sp.owner_released_at as "ownerReleasedAt",
              sp.owner_release_generation::text as "ownerReleaseGeneration",
              coalesce(sp.owner_stop_confirmed_at > sp.owner_acquired_at,
                       sp.owner_stop_confirmed_at is not null) as "stopConfirmedAfterAcquire"
         from sync_pages sp
         left join pages p on p.id = sp.page_id
        where sp.page_id = $1
          for no key update of sp`,
      [input.pageId],
    );
    const row = locked.rows[0];
    if (!row) return { kind: "no_page" };

    const confirmed = BigInt(row.ownerGeneration) === 0n
      || (row.ownerReleasedAt !== null && row.ownerReleaseGeneration === row.ownerGeneration)
      || row.stopConfirmedAfterAcquire === true;
    if (!confirmed) return { kind: "unconfirmed" };

    // The hold set against the old hold columns (the hold-set release alone):
    // what the previous image left in them is the page's state, and the new
    // owner admits by the rows.
    const holds = image === "hold-set"
      ? await reconcileSyncHoldsWithLegacyColumns(tx, input.pageId)
      : { imported: false };

    const owner = input.owner;
    const updated = await tx.query<{ generation: string }>(
      `update sync_pages
          set owner_generation = owner_generation + 1,
              owner_instance = $2::uuid,
              owner_host = $3,
              owner_pid = $4,
              owner_pid_start = $5,
              owner_pid_ns = $6,
              owner_boot_id = $7,
              owner_acquired_at = clock_timestamp(),
              owner_heartbeat_at = clock_timestamp(),
              owner_released_at = null,
              owner_release_generation = null,
              updated_at = clock_timestamp()
        where page_id = $1
        returning owner_generation::text as generation`,
      [input.pageId, owner.instance, owner.host, owner.pid, owner.pidStart, owner.pidNs, owner.bootId],
    );
    return { kind: "acquired", generation: BigInt(updated.rows[0]!.generation), holdsImported: holds.imported };
  });
}

/**
 * The hold-set release's acquisition of a page (`acquireSyncPageOwnership` of
 * its `pages.ts`), one transaction: the page row FOR NO KEY UPDATE, the
 * previous owner confirmed stopped, the hold set brought in line with the old
 * columns — which throws `SyncLegacyHoldsUnreadableError` for columns it
 * cannot read, nothing written — and then the next owner generation.
 */
export async function acquireAsHoldSetImage(target: TestDatabase, input: AcquireInput): Promise<OlderImageAcquisition> {
  return acquire(target, input, "hold-set");
}

/**
 * The acquisition of the release before this one (S4-31): the same lock,
 * evidence and next owner generation, and no old column read or written.
 */
export async function acquireAsPreviousImage(target: TestDatabase, input: AcquireInput): Promise<OlderImageAcquisition> {
  return acquire(target, input, "previous");
}

/**
 * What the hold-set release does before a hold write under no generation
 * (`writeHoldSet` of its `pages.ts`, the owner's `sync route raise`): the page
 * row FOR NO KEY UPDATE, then the same read of the old columns. Throws
 * `SyncLegacyHoldsUnreadableError` where the write is refused.
 */
export async function reconcileAsHoldSetImage(target: TestDatabase, pageId: number): Promise<SyncHoldsReconciliation> {
  return inTransaction(target, async (tx) => {
    await tx.query("select owner_generation::text as generation from sync_pages where page_id = $1 for no key update", [pageId]);
    return reconcileSyncHoldsWithLegacyColumns(tx, pageId);
  });
}
