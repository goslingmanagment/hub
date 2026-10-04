import { getSyncPage, type Database, type SyncHoldRow } from "@agency_hub_core/db";
import { INDEFINITE_UNTIL } from "@agency_hub_core/shared";

// The previous image's half of a hold write, frozen (step 4, S4-32).
//
// The release before this one (S4-31) — and the hold-set release before it
// (S4-30) — ended every hold write by rewriting the old hold columns of the
// page row from the page's rows of `sync_holds`, in the write's transaction:
// `mirrorSyncHoldsToLegacyColumns` over `legacyHoldColumnsOf`, in
// `packages/db/src/repositories/sync/holds-legacy.ts`. This release deleted
// that file and names the columns nowhere; the two functions below are that
// code as it was (25a07294), kept by the tests alone so that they can run what
// a rollback's image runs over a database this release has left: its mirror
// (`mirrorHoldsAsPreviousImage`), and the comparison the hold-set release
// makes when it acquires a page (`previousImageHoldColumnsOf` against the
// stored columns). They go with the columns.

/** The old hold columns of a `sync_pages` row, as stored. */
export interface PreviousImageHoldColumns {
  holdKind: string | null;
  holdUntil: Date | null;
  holdSince: Date | null;
  holdDetail: Record<string, unknown>;
  /** `resource_holds`, the route-state namespace included. */
  resourceHolds: Record<string, unknown>;
}

/** Where the old slot carries a network hold beside a credentials hold. */
const CARRIED_HOLD_FIELD = "timedHold";
/** The route-state namespace inside `sync_pages.resource_holds`, and the one
 *  version of it there ever was. */
const ROUTE_STATE_KEY = "route:state";
const ROUTE_NAMESPACE_VERSION = 1;

function isCredentialsKind(kind: string): boolean {
  return kind === "auth" || kind === "identity_mismatch";
}

function without(detail: Readonly<Record<string, unknown>>, field: string): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...detail };
  delete rest[field];
  return rest;
}

/**
 * The old columns of a page whose hold set is `rows`, as the previous image
 * writes them:
 *
 * - the hold slot: the credentials hold, with the network hold carried in its
 *   detail when both stand; else the network hold; else empty;
 * - `resource_holds[file]`: each resource breaker `{until, step, since}`;
 * - `resource_holds['route:state']`: every route's entry (version 1), the
 *   hold's end and the slowdown state in one object.
 */
export function previousImageHoldColumnsOf(rows: readonly SyncHoldRow[]): PreviousImageHoldColumns {
  const page = rows.filter((row) => row.scope === "page");
  const credentials = page.find((row) => isCredentialsKind(row.kind)) ?? null;
  const network = page.find((row) => row.kind === "network" && row.until !== null) ?? null;
  const columns: PreviousImageHoldColumns = { holdKind: null, holdUntil: null, holdSince: null, holdDetail: {}, resourceHolds: {} };
  if (credentials !== null) {
    columns.holdKind = credentials.kind;
    columns.holdUntil = credentials.until ?? INDEFINITE_UNTIL;
    columns.holdSince = credentials.since;
    columns.holdDetail = {
      ...without(credentials.detail, CARRIED_HOLD_FIELD),
      ...(network === null
        ? {}
        : { [CARRIED_HOLD_FIELD]: { kind: "network", until: network.until!.toISOString(), detail: network.detail } }),
    };
  } else if (network !== null) {
    columns.holdKind = "network";
    columns.holdUntil = network.until;
    columns.holdSince = network.since;
    columns.holdDetail = { ...network.detail };
  }
  for (const row of rows) {
    if (row.scope !== "resource" || row.kind !== "resource_breaker" || row.until === null) continue;
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
    columns.resourceHolds[ROUTE_STATE_KEY] = { version: ROUTE_NAMESPACE_VERSION, routes };
  }
  return columns;
}

/** A test database: its pool and its drizzle handle (`StartedTestDatabase`). */
interface TestDatabase {
  pool: { query(text: string, values?: unknown[]): Promise<unknown> };
  db: unknown;
}

function timestamp(value: Date | null): string | null {
  if (value === null) return null;
  return value.getTime() >= INDEFINITE_UNTIL.getTime() ? "infinity" : value.toISOString();
}

/**
 * The statement the previous image ends every hold write with: the page's old
 * hold columns rewritten from its rows (its `update`, column for column).
 */
export async function mirrorHoldsAsPreviousImage(target: TestDatabase, pageId: number): Promise<void> {
  const page = await getSyncPage(target.db as Database, pageId);
  if (page === null) throw new Error(`Fansly sync page ${pageId} has no sync_pages row`);
  const columns = previousImageHoldColumnsOf(page.holds);
  await target.pool.query(
    `update sync_pages
        set hold_kind = $2::text,
            hold_until = $3::timestamptz,
            hold_since = $4::timestamptz,
            hold_detail = $5::jsonb,
            resource_holds = $6::jsonb,
            updated_at = clock_timestamp()
      where page_id = $1`,
    [
      pageId, columns.holdKind, timestamp(columns.holdUntil), timestamp(columns.holdSince),
      JSON.stringify(columns.holdDetail), JSON.stringify(columns.resourceHolds),
    ],
  );
}
