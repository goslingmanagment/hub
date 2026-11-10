import type { SyncHoldRow, SyncPageRow } from "@agency_hub_core/db";
import { INDEFINITE_UNTIL, type FanslyPageHoldKind, type FanslyPageHolds } from "@agency_hub_core/shared";

import { holdSetOf } from "../../apps/runtime/src/sync/engine/admission.ts";
import type { RouteStateEntry } from "../../apps/runtime/src/sync/engine/route-policy.ts";
import type { FanslyRoute } from "../../apps/runtime/src/sync/fansly/routes.ts";

// A page's hold set (`sync_holds`, `SyncPageRow.holds`) for tests: rows built
// without a database, rows written straight into one, and what a page row's
// rows say.

const EPOCH = new Date("2026-01-01T00:00:00.000Z");

interface HoldOptions {
  since?: Date;
  detail?: Record<string, unknown>;
  revision?: number;
}

/** A page-scope row: a credentials hold (`until` defaults to indefinite) or
 *  the network hold. */
export function pageHoldRow(kind: string, until: Date | null = INDEFINITE_UNTIL, options: HoldOptions = {}): SyncHoldRow {
  return {
    scope: "page",
    key: "",
    kind,
    until,
    since: options.since ?? EPOCH,
    ladderStep: 0,
    detail: options.detail ?? {},
    revision: options.revision ?? 1,
  };
}

/** A resource file's breaker. */
export function resourceBreakerRow(file: string, until: Date, options: { step?: number; since?: Date } = {}): SyncHoldRow {
  return {
    scope: "resource",
    key: file,
    kind: "resource_breaker",
    until,
    since: options.since ?? EPOCH,
    ladderStep: options.step ?? 1,
    detail: {},
    revision: 1,
  };
}

/** The rows of one route: its `route_budget` state and, when the entry names
 *  a hold's end, its `route_hold`. */
export function routeHoldRows(route: string, entry: Partial<RouteStateEntry> = {}): SyncHoldRow[] {
  const rows: SyncHoldRow[] = [{
    scope: "route",
    key: route,
    kind: "route_budget",
    until: null,
    since: EPOCH,
    ladderStep: entry.ladderStep ?? 0,
    detail: {
      effectivePerMin: entry.effectivePerMin ?? null,
      policyVersion: entry.policyVersion ?? null,
      last429AttemptId: entry.last429AttemptId ?? null,
      last429At: entry.last429At ?? null,
    },
    revision: entry.revision ?? 1,
  }];
  const holdUntil = entry.holdUntil ?? null;
  if (holdUntil !== null) {
    rows.push({ scope: "route", key: route, kind: "route_hold", until: new Date(holdUntil), since: EPOCH, ladderStep: 0, detail: {}, revision: 1 });
  }
  return rows;
}

/** The rows of several routes, by route. */
export function routeStateRows(routes: Readonly<Record<string, Partial<RouteStateEntry>>>): SyncHoldRow[] {
  return Object.entries(routes).flatMap(([route, entry]) => routeHoldRows(route, entry));
}

// ── a database's hold set, written directly (a test's stand-in for an
// outcome), by the database clock ──────────────────────────────────────────

/** A test database: its pool (`StartedTestDatabase`). */
interface TestDatabase {
  pool: { query(text: string, values?: unknown[]): Promise<unknown> };
}

/** The page's own hold of `kind`, until `untilSeconds` from now (`"infinity"`:
 *  a credentials hold); replaces the row of that kind. */
export async function seedPageHold(
  target: TestDatabase,
  input: { pageId: number; kind: string; untilSeconds: number | "infinity"; detail?: Record<string, unknown> },
): Promise<void> {
  await target.pool.query(
    `insert into sync_holds (page_id, scope, key, kind, until, detail)
     values ($1, 'page', '', $2,
             case when $3::float8 is null then 'infinity'::timestamptz else clock_timestamp() + make_interval(secs => $3::float8) end,
             $4::jsonb)
     on conflict (page_id, scope, key, kind) do update set until = excluded.until, detail = excluded.detail, revision = sync_holds.revision + 1`,
    [input.pageId, input.kind, input.untilSeconds === "infinity" ? null : input.untilSeconds, JSON.stringify(input.detail ?? {})],
  );
}

/** Lift the page's own holds (every kind, or `kinds`). */
export async function clearPageHolds(target: TestDatabase, pageId: number, kinds?: readonly string[]): Promise<void> {
  await target.pool.query(
    "delete from sync_holds where page_id = $1 and scope = 'page' and ($2::text[] is null or kind = any($2::text[]))",
    [pageId, kinds ?? null],
  );
}

// ── a page row's hold set, as a test asks about it ─────────────────────────

/** The page's own holds as the engine reads them. */
export function pageHoldsOf(page: Pick<SyncPageRow, "holds">): FanslyPageHolds {
  return holdSetOf(page.holds).page;
}

/** The kind of the page's credentials hold, else of its network hold, else
 *  null — recorded, in force or not. */
export function pageHoldKindOf(page: Pick<SyncPageRow, "holds">): FanslyPageHoldKind | null {
  const holds = pageHoldsOf(page);
  return holds.credentials?.kind ?? holds.timed?.kind ?? null;
}

/** A route's entry of the page's route state (null: none, or unreadable). */
export function routeEntryOf(page: Pick<SyncPageRow, "holds">, route: FanslyRoute): RouteStateEntry | null {
  const read = holdSetOf(page.holds).routes;
  return read.ok ? read.state.routes[route] ?? null : null;
}
