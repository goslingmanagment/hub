import type { SyncHoldRow } from "@agency_hub_core/db";
import {
  admitUnderFanslyPageHolds,
  fanslyPageHoldInForce,
  isFanslyPageHoldKind,
  readFanslyPageHolds,
  type CredentialsHold,
  type FanslyCredentialsHoldKind,
  type FanslyPageHoldOperation,
  type FanslyPageHoldRow,
  type FanslyPageHolds,
  type FanslyTimedHoldKind,
  type TimedHold,
} from "@agency_hub_core/shared";

import type { FanslyRoute } from "../fansly/routes.ts";
import { activeResourceHold, type ResourceHoldEntry } from "./errors.ts";
import { routeStateOfHolds, type RouteStateRead } from "./route-policy.ts";

// The hold evaluator of the Fansly Sync Engine (plan §9; step 4, owner
// decision №26): ONE answer to "what holds this request now?", over a page's
// hold set (`sync_holds`, handed out with the page row as
// `SyncPageRow.holds`) and its route clocks. It composes, and never
// re-states, the rules that own each scope:
//
//   page        the page-hold core (`@agency_hub_core/shared`
//               fansly-page-holds): a network hold stops everything, a
//               credentials hold everything but the identity checks it admits;
//               and rows this build cannot read, which stop everything too;
//   subject     the breaker of the work's subject (the work row's);
//   resource    the breaker of the work's resource file (`engine/errors.ts`);
//   route       the route admission (`engine/route-policy.ts`): a 429's hold
//               of a route (`route_hold`), or its budget's interval since its
//               previous send (`route_budget`).
//
// The actor's gate, its pick and its final check before an admission, the
// admission transaction itself, status and "why waiting", the alerts, the
// history requests' view and the metrics all ask here; none of them reads a
// hold row, or a hold column of the page row, itself.

/** The resource-scope kind of a hold set. */
const RESOURCE_BREAKER_KIND = "resource_breaker";

/** A row of a scope or kind this build does not know. It keeps the page
 *  closed until its end (for good when it names none): an unreadable hold
 *  never opens a page. */
export interface UnreadableHold {
  diagnostic: string;
  until: Date | null;
  /** The rows are a known route's state (`route_state_…`), not a row of a
   *  scope or kind this build does not know. */
  routeState: boolean;
}

/** A page's hold set as the engine reads it. */
export interface HoldSet {
  /** The page's own holds: a credentials hold, a network hold. */
  page: FanslyPageHolds;
  /** The resource breakers by file. */
  resources: Readonly<Record<string, ResourceHoldEntry>>;
  /** The routes' holds and slowdowns — or the diagnostic of rows of a known
   *  route this build cannot read: the page admits nothing while it stands. */
  routes: RouteStateRead;
  unreadable: readonly UnreadableHold[];
}

/** Read a page's hold set from its rows (`SyncPageRow.holds`). */
export function holdSetOf(rows: readonly SyncHoldRow[]): HoldSet {
  const pageRows: FanslyPageHoldRow[] = [];
  const resources: Record<string, ResourceHoldEntry> = {};
  const unreadable: UnreadableHold[] = [];
  for (const row of rows) {
    if (row.scope === "route") continue;
    if (row.scope === "page" && row.key === "" && isFanslyPageHoldKind(row.kind)) {
      pageRows.push({ kind: row.kind, until: row.until, since: row.since, detail: row.detail });
    } else if (row.scope === "resource" && row.kind === RESOURCE_BREAKER_KIND && row.until !== null) {
      resources[row.key] = { until: row.until, step: row.ladderStep, since: row.since };
    } else {
      unreadable.push({ diagnostic: `hold_row:${row.scope}:${row.key}:${row.kind}`, until: row.until, routeState: false });
    }
  }
  return { page: readFanslyPageHolds(pageRows), resources, routes: routeStateOfHolds(rows), unreadable };
}

/** A page that holds nothing. */
export const EMPTY_HOLD_SET: HoldSet = holdSetOf([]);

/** A key's routes, or one route, closed at an instant: when they next admit a
 *  send, the routes still closed and those of them a hold keeps closed. */
export interface RouteClosure {
  at: Date;
  routes: FanslyRoute[];
  held: FanslyRoute[];
}

/** The route admission of a page at one instant (`routeAdmissionView` over
 *  its route clocks). */
export interface RouteAdmissionView {
  /** The key's declared routes; null: one admits a send now, or the key
   *  declares none (only its planned request is checked). */
  keyOpensAt(resource: string): RouteClosure | null;
  /** One route (a planned request's); null: it admits a send now. */
  routeOpensAt(route: FanslyRoute): RouteClosure | null;
  /** The key's declared routes a hold keeps closed now (some may be open). */
  keyHeldRoutes(resource: string): FanslyRoute[];
}

/** What holds a request, by the scope that holds it. */
export type Held =
  /** Rows of the hold set this build cannot read: nothing is admitted.
   *  `until` null: no instant ends it (the operator repairs the rows). */
  | { scope: "page"; kind: "unreadable"; until: Date | null; diagnostic: string; routeState: boolean }
  /** The page's network hold: nothing is admitted before its end. */
  | { scope: "page"; kind: FanslyTimedHoldKind; until: Date; hold: TimedHold }
  /** The page's credentials hold (indefinite: an identity proof sent after
   *  its latest refusal clears it). */
  | { scope: "credentials"; kind: FanslyCredentialsHoldKind; until: Date; hold: CredentialsHold }
  | { scope: "subject"; kind: "blocked_by_vendor" | "subject_breaker"; until: Date | null }
  | { scope: "resource"; kind: "resource_breaker"; until: Date; file: string; step: number }
  /** `route_hold`: a 429's hold (or a 5xx's `Retry-After`) keeps one of the
   *  routes closed; `route_budget`: only their budgets' intervals do. */
  | { scope: "route_hold" | "route_budget"; kind: "route"; until: Date; routes: FanslyRoute[]; held: FanslyRoute[] };

export type HeldScope = Held["scope"];

/** What is asked: a request of the page, and — when it is a piece of work —
 *  its key, its subject's breaker and the route it planned. */
export interface HeldQuery {
  /** What the request is to the page holds (default: an ordinary request). */
  operation?: FanslyPageHoldOperation;
  /** The work the request serves. Absent: the page as a whole (the gate). */
  work?: {
    /** The registry key `<file>.<variant>`. */
    resource: string;
    breakerUntil?: Date | null;
    blockedByVendorAt?: Date | null;
    /** Its planned request was put off for its route until this instant (the
     *  row's own record: `waiting_reason = 'pacer'`, due then). */
    putOffUntil?: Date | null;
  };
  /** The route of the planned request (the final check before an admission;
   *  a caller that knows the one route its reads take). Absent: the declared
   *  routes of the work's key (the pick). */
  plannedRoute?: FanslyRoute;
}

/** The answer scope by scope; `whyHeld` is its first. */
export interface HeldByScope {
  page: Extract<Held, { scope: "page" | "credentials" }> | null;
  subject: Extract<Held, { scope: "subject" }> | null;
  resource: Extract<Held, { scope: "resource" }> | null;
  route: Extract<Held, { scope: "route_hold" | "route_budget" }> | null;
}

function unreadableInForce(holds: HoldSet, now: Date): UnreadableHold | null {
  if (!holds.routes.ok) return { diagnostic: holds.routes.diagnostic, until: null, routeState: true };
  let latest: UnreadableHold | null = null;
  for (const row of holds.unreadable) {
    if (row.until !== null && row.until.getTime() <= now.getTime()) continue;
    if (row.until === null) return row;
    if (latest === null || row.until.getTime() > latest.until!.getTime()) latest = row;
  }
  return latest;
}

function pageHeld(holds: HoldSet, operation: FanslyPageHoldOperation, now: Date): HeldByScope["page"] {
  const unreadable = unreadableInForce(holds, now);
  if (unreadable !== null) return { scope: "page", kind: "unreadable", ...unreadable };
  const admission = admitUnderFanslyPageHolds(holds.page, operation, now);
  if (admission.admitted) return null;
  if (admission.scope === "timed") {
    const hold = holds.page.timed!;
    return { scope: "page", kind: hold.kind, until: admission.until, hold };
  }
  const hold = holds.page.credentials!;
  return { scope: "credentials", kind: hold.kind, until: admission.until, hold };
}

function subjectHeld(work: NonNullable<HeldQuery["work"]>, now: Date): HeldByScope["subject"] {
  const breakerUntil = work.breakerUntil ?? null;
  if ((work.blockedByVendorAt ?? null) !== null) return { scope: "subject", kind: "blocked_by_vendor", until: breakerUntil };
  if (breakerUntil !== null && breakerUntil.getTime() > now.getTime()) {
    return { scope: "subject", kind: "subject_breaker", until: breakerUntil };
  }
  return null;
}

function routeHeld(
  routes: RouteAdmissionView | null,
  work: HeldQuery["work"],
  plannedRoute: FanslyRoute | undefined,
  now: Date,
): HeldByScope["route"] {
  const closed = (closure: RouteClosure, until: Date = closure.at): HeldByScope["route"] => ({
    scope: closure.held.length > 0 ? "route_hold" : "route_budget",
    kind: "route",
    until,
    routes: closure.routes,
    held: closure.held,
  });
  if (plannedRoute !== undefined) {
    const closure = routes?.routeOpensAt(plannedRoute) ?? null;
    return closure === null ? null : closed(closure);
  }
  if (work === undefined) return null;
  const closure = routes?.keyOpensAt(work.resource) ?? null;
  const putOffUntil = work.putOffUntil ?? null;
  if (putOffUntil !== null && putOffUntil.getTime() > now.getTime()) {
    // The route its request planned kept it closed (the row says until
    // when): a hold, when one holds a route of its key now; else that
    // route's pace.
    return closed(closure ?? { at: putOffUntil, routes: [], held: routes?.keyHeldRoutes(work.resource) ?? [] }, putOffUntil);
  }
  return closure === null ? null : closed(closure);
}

/**
 * What holds the request at `now`, scope by scope (pure). `routes` is the
 * page's route admission at `now`; null: not asked (the gate, a key that
 * sends nothing, a caller that did not read the clocks) — a row its route
 * put off is then held by its route's pace, as far as anyone knows.
 */
export function heldByScope(holds: HoldSet, routes: RouteAdmissionView | null, query: HeldQuery, now: Date): HeldByScope {
  const { work } = query;
  const resourceHold = work === undefined ? null : activeResourceHold(holds.resources, work.resource, now);
  return {
    page: pageHeld(holds, query.operation ?? { kind: "request" }, now),
    subject: work === undefined ? null : subjectHeld(work, now),
    resource: resourceHold === null
      ? null
      : { scope: "resource", kind: "resource_breaker", until: resourceHold.until, file: resourceHold.file, step: resourceHold.step },
    route: routeHeld(routes, work, query.plannedRoute, now),
  };
}

/**
 * What holds the request at `now` — the first of: the page (rows this build
 * cannot read, the network hold, the credentials hold), the subject's
 * breaker, the resource file's breaker, the route. Null: nothing holds it.
 */
export function whyHeld(holds: HoldSet, routes: RouteAdmissionView | null, query: HeldQuery, now: Date): Held | null {
  const held = heldByScope(holds, routes, query, now);
  return held.page ?? held.subject ?? held.resource ?? held.route;
}

/** Everything that holds the page itself at `now`, each named (the alerts and
 *  the metrics tell them apart; an admission is refused by the first). */
export interface PageHoldsInForce {
  unreadable: UnreadableHold | null;
  credentials: CredentialsHold | null;
  timed: TimedHold | null;
}

/** The page's own holds in force at `now`; null: none. */
export function pageHoldsInForce(holds: HoldSet, now: Date): PageHoldsInForce | null {
  const unreadable = unreadableInForce(holds, now);
  const held = fanslyPageHoldInForce(holds.page, now);
  if (unreadable === null && held === null) return null;
  return { unreadable, credentials: held?.credentials ?? null, timed: held?.timed ?? null };
}

/** The resource files whose breaker is in force at `now`, sorted. */
export function resourceFilesHeld(holds: HoldSet, now: Date): string[] {
  return Object.entries(holds.resources)
    .filter(([, entry]) => entry.until.getTime() > now.getTime())
    .map(([file]) => file)
    .sort();
}
