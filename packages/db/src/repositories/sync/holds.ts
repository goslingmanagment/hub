import { sql } from "drizzle-orm";

import type { Database } from "../../client.ts";
import { toDate, toRequiredDate } from "./values.ts";

// Fansly Sync Engine, the hold set (0240; plan §9, §11, owner decision №26):
// `sync_holds`, one row per hold of a page, a route or a resource file. The
// page row hands a page's rows out with every read (`SyncPageRow.holds`); the
// engine's one hold evaluator (`apps/runtime/src/sync/engine/admission.ts`)
// reads nothing else. The rows are written by the hold writers of
// `repositories/sync/pages.ts` only (`setPageHold`, `clearPageHold`,
// `setResourceHold`, `writeSyncRouteState`), under the page row's lock.

export const SYNC_HOLD_SCOPES = ["page", "route", "resource"] as const;
export type SyncHoldScope = (typeof SYNC_HOLD_SCOPES)[number];

/** What stops every request of a page: its credentials hold (`auth`,
 *  `identity_mismatch`: at most one) and its network back-off. */
export const SYNC_PAGE_HOLD_KINDS = ["auth", "identity_mismatch", "network"] as const;
export type SyncPageHoldKind = (typeof SYNC_PAGE_HOLD_KINDS)[number];

/** A route of a page after a 429: its hold, and its durable slowdown state. */
export const SYNC_ROUTE_HOLD_KINDS = ["route_hold", "route_budget"] as const;
export type SyncRouteHoldKind = (typeof SYNC_ROUTE_HOLD_KINDS)[number];

/** A resource file's breaker. */
export const SYNC_RESOURCE_HOLD_KIND = "resource_breaker";

export const SYNC_HOLD_KINDS = [...SYNC_PAGE_HOLD_KINDS, ...SYNC_ROUTE_HOLD_KINDS, SYNC_RESOURCE_HOLD_KIND] as const;
export type SyncHoldKind = (typeof SYNC_HOLD_KINDS)[number];

/** The kinds each scope admits (the table's `sync_holds_scope_kind_check`). */
export const SYNC_HOLD_KINDS_BY_SCOPE: Readonly<Record<SyncHoldScope, readonly SyncHoldKind[]>> = {
  page: SYNC_PAGE_HOLD_KINDS,
  route: SYNC_ROUTE_HOLD_KINDS,
  resource: [SYNC_RESOURCE_HOLD_KIND],
};

/** `sync_holds.key` of a page-scope row. */
export const SYNC_PAGE_HOLD_KEY = "";

/**
 * One row of a page's hold set. `scope` and `kind` are handed out as stored:
 * a value a later build added is this build's to refuse (the evaluator keeps
 * the page closed on a row it cannot read), never to guess.
 */
export interface SyncHoldRow {
  scope: string;
  /** The route id, the resource file, or `""` for the page. */
  key: string;
  kind: string;
  /** The hold's end; the JS stand-in of `'infinity'` for a credentials hold;
   *  null for a row without one (`route_budget`). */
  until: Date | null;
  /** The start of the episode. */
  since: Date;
  ladderStep: number;
  detail: Record<string, unknown>;
  /** Bumped by every write of the row. */
  revision: number;
}

type HoldSqlRow = {
  scope: string;
  key: string;
  kind: string;
  until: Date | string | number | null;
  since: Date | string | number;
  ladderStep: number | string;
  detail: Record<string, unknown> | null;
  revision: number | string;
};

/** A page's rows as one JSON array, for the page row's select (`sp` is its
 *  `sync_pages` alias): scope, key and kind order them. */
export const syncHoldsOfPageSql = sql`
  (select coalesce(jsonb_agg(jsonb_build_object(
            'scope', h.scope,
            'key', h.key,
            'kind', h.kind,
            'until', h.until,
            'since', h.since,
            'ladderStep', h.ladder_step,
            'detail', h.detail,
            'revision', h.revision) order by h.scope, h.key, h.kind), '[]'::jsonb)
     from sync_holds h
    where h.page_id = sp.page_id)`;

/** Rows as the driver hands them out (a JSON aggregate, or columns) → rows. */
export function normalizeSyncHoldRows(rows: readonly HoldSqlRow[] | null | undefined): SyncHoldRow[] {
  return (rows ?? []).map((row) => ({
    scope: row.scope,
    key: row.key,
    kind: row.kind,
    until: toDate(row.until),
    since: toRequiredDate(row.since),
    ladderStep: Number(row.ladderStep),
    detail: row.detail ?? {},
    revision: Number(row.revision),
  }));
}

/** A page's hold set, ordered by scope, key and kind. */
export async function listSyncHolds(db: Database, pageId: number): Promise<SyncHoldRow[]> {
  const result = await db.execute<HoldSqlRow>(sql`
    select h.scope, h.key, h.kind, h.until, h.since, h.ladder_step as "ladderStep", h.detail, h.revision::text as revision
      from sync_holds h
     where h.page_id = ${pageId}
     order by h.scope, h.key, h.kind
  `);
  return normalizeSyncHoldRows(result.rows);
}
