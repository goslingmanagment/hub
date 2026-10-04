import { getSyncPage, insertAuditEvent, writeSyncRouteState, type Database } from "@agency_hub_core/db";

import { routeRaise } from "./engine/route-holds.ts";
import { routeStateOfHolds } from "./engine/route-policy.ts";
import { isFanslyRoute, routeBudget } from "./fansly/routes.ts";
import { findSyncPageByLabel, SyncOwnerLeverError } from "./inspect.ts";

// `pnpm cli sync route raise` (step 3b A2, owner decision D3 / №22): the only
// owner lever on a route's slowdown. After a 429 a page+route runs at half its
// rate (≥ ⅛ of its ceiling) until it is raised deliberately — one step of at
// most +1/min, never above the route's `current` (`fansly/routes.ts`), backed
// by an evidence report (`budgets-calibration.sql`) that names the route
// state's revision it was read at: a 429 (or another raise) after that
// evidence moves the revision, and the stale step is refused. The hold in
// force (a cooldown, a `Retry-After`) and the ladder stay. The raise and its
// audit row (`admin.sync_route_raise`) commit together.

export const SYNC_ROUTE_RAISE_AUDIT_EVENT = "admin.sync_route_raise";

export interface SyncRouteRaiseResult {
  page: string;
  route: string;
  fromPerMin: number;
  toPerMin: number;
  currentPerMin: number;
  ceilingPerMin: number;
  /** The entry's revision after the raise (the next raise's `--revision`). */
  revision: number;
  /** The raise reached `current`: the slowdown is over. */
  slowdownEnded: boolean;
  /** The hold in force, untouched by the raise. */
  holdUntil: string | null;
}

export async function raiseSyncRoute(
  db: Database,
  input: { pageLabel: string; route: string; toPerMin: number; revision: number; evidence: string; actor: string },
): Promise<SyncRouteRaiseResult> {
  const { route } = input;
  if (!isFanslyRoute(route)) throw new SyncOwnerLeverError(`No Fansly route ${route} (the catalogue of fansly/routes.ts)`);
  if (input.evidence.trim().length === 0) {
    throw new SyncOwnerLeverError("a raise needs its evidence (--evidence: the budgets-calibration report it rests on)");
  }
  const page = await findSyncPageByLabel(db, input.pageLabel);
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    const current = await getSyncPage(tx, page.pageId);
    if (current === null) throw new SyncOwnerLeverError(`${input.pageLabel}: the page row is gone`);
    const read = routeStateOfHolds(current.holds);
    if (!read.ok) {
      throw new SyncOwnerLeverError(`${input.pageLabel}: the route state is not one this build reads (${read.diagnostic}); nothing raised`);
    }
    const raise = routeRaise(route, read.state.routes[route] ?? null, { toPerMin: input.toPerMin, expectRevision: input.revision });
    if (!raise.ok) throw new SyncOwnerLeverError(`${input.pageLabel}: sync route raise refused (${raise.reason}): ${raise.detail}`);
    const { entry } = raise;
    const written = await writeSyncRouteState(tx, {
      pageId: page.pageId,
      route,
      expectRevision: raise.expectRevision,
      entry: {
        holdUntil: entry.holdUntil === null ? null : new Date(entry.holdUntil),
        ladderStep: entry.ladderStep,
        effectivePerMin: entry.effectivePerMin,
        policyVersion: entry.policyVersion,
        last429AttemptId: entry.last429AttemptId,
        last429At: entry.last429At === null ? null : new Date(entry.last429At),
      },
    });
    if (written.kind === "stale") {
      // A 429 between the read and the write — or the write found the route
      // as the previous image left it in the old hold columns (after a
      // rollback, before this build's `sync` has taken the page): the page's
      // hold set, and so the evidence, shows that state once it has.
      throw new SyncOwnerLeverError(
        `${input.pageLabel}: ${route} is no longer at revision ${raise.expectRevision} (a new 429 — after a rollback, one the previous `
        + "image recorded, shown once `sync` has taken the page): read the evidence again; nothing raised",
      );
    }
    const budget = routeBudget(route);
    const result: SyncRouteRaiseResult = {
      page: input.pageLabel,
      route,
      fromPerMin: raise.fromPerMin,
      toPerMin: raise.toPerMin,
      currentPerMin: budget.currentPerMin,
      ceilingPerMin: budget.ceilingPerMin,
      revision: written.revision,
      slowdownEnded: entry.effectivePerMin === null,
      holdUntil: entry.holdUntil,
    };
    await insertAuditEvent(tx, {
      platformAccountId: page.pageId,
      source: "cli",
      eventType: SYNC_ROUTE_RAISE_AUDIT_EVENT,
      metadata: {
        actor: input.actor,
        pageLabel: input.pageLabel,
        route,
        fromPerMin: raise.fromPerMin,
        toPerMin: raise.toPerMin,
        fromRevision: raise.expectRevision,
        revision: written.revision,
        slowdownEnded: result.slowdownEnded,
        evidence: input.evidence,
      },
    });
    return result;
  });
}
