import type { SyncHoldRow, SyncRouteSend } from "@agency_hub_core/db";
import type { FanslyWireId } from "@agency_hub_core/fansly";

import {
  FAMILY_BUDGETS,
  FANSLY_ROUTE_FAMILIES,
  FANSLY_ROUTE_FAMILY_IDS,
  FANSLY_ROUTES,
  familyOfRoute,
  intervalMsOf,
  isFanslyRoute,
  routeBudget,
  routeOfEngineOperation,
  routeOfLegacyOperation,
  routeOfWireId,
  ROUTE_POLICY_HASH,
  type FanslyRoute,
  type FanslyRouteFamily,
} from "../fansly/routes.ts";
import type { RouteAdmissionView } from "./admission.ts";
import type { RouteBudgetStatusView, RouteStatusView } from "./status.ts";

// The route admission of a page (step 3b rulings 1, 3, 4; plan PR 1-1): on
// top of the pause S between any two sends of a page, every route and every
// family of `fansly/routes.ts` admits its next send no sooner than one
// interval of its effective rate after its previous ACTUAL send — strict:
// no borrowing, no burst, an idle hour earns nothing. The clocks are read
// from the attempt journal on every slot (`readRouteJournal`), never kept in
// memory: a restart, a takeover, a demand bump or a restarted walk can never
// shorten an interval. The step-1 send log counts too (what the legacy
// engine sent before the switch); a send whose instant is unknown counts at
// its upper bound.
//
// The rule is applied twice per slot, one pure function each:
//   - at the pick: a key all of whose routes are closed is left out of the
//     pick (`routeExclusions`), so a held or spent route never takes a slot
//     and never makes the actor spin; a class whose best candidate opens
//     within one longest pause (1.2 × S) holds the slot for it
//     (`lookaheadInstants`, the scheduler's short look-ahead);
//   - after the plan: the planned request's route itself (`notBefore`), for
//     every key — a multi-route walk, a probe, the CDN, the socket's Upgrade.
//
// A page's route state — holds and slowdowns after a 429 — lives in the
// route-scope rows of its hold set (`sync_holds`): `route_hold`, the end of a
// route's hold, and `route_budget`, its durable slowdown state. It may only
// make a route slower: the effective rate is the lower of the table's
// `current` and the stored one. Rows this build cannot read close the page's
// admission with a diagnostic (status, alert 1) rather than guess.

/** One route of a page, as its 429s left it (written by `route-holds.ts`
 *  through `writeSyncRouteState` only: `holdUntil` is its `route_hold` row,
 *  the rest its `route_budget` row). */
export interface RouteStateEntry {
  /** No send on the route before this instant (ISO): a 429's hold, a
   *  `Retry-After` honoured to the letter. Null: none. */
  holdUntil: string | null;
  /** The ladder step the route's next 429 without `Retry-After` takes
   *  (owner decision №14: 5 → 10 → … → 300 s). */
  ladderStep: number;
  /** The page+route's effective rate after its slowdowns, requests a minute
   *  (null: the table's `current`). Only ever lower than `current` counts. */
  effectivePerMin: number | null;
  /** `routePolicyVersion(route)` when the slowdown was taken. */
  policyVersion: string | null;
  /** The newest 429 of the page+route. */
  last429AttemptId: number | null;
  last429At: string | null;
  /** Bumped by every write of the entry: a raise is a compare-and-set on it. */
  revision: number;
}

export interface RouteState {
  routes: Partial<Record<FanslyRoute, RouteStateEntry>>;
}

export const EMPTY_ROUTE_STATE: RouteState = { routes: {} };

export type RouteStateRead =
  | { ok: true; state: RouteState }
  /** Admission of the page stays closed while this holds. */
  | { ok: false; diagnostic: string };

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A route's `route_budget` row (and the end of its `route_hold` row) as its
 *  entry; null: not a shape this build reads. */
function entryOfRows(budget: SyncHoldRow | null, hold: SyncHoldRow | null): RouteStateEntry | null {
  const detail: Readonly<Record<string, unknown>> = budget?.detail ?? {};
  const effectivePerMin = detail.effectivePerMin ?? null;
  const policyVersion = detail.policyVersion ?? null;
  const last429AttemptId = detail.last429AttemptId ?? null;
  const last429At = detail.last429At ?? null;
  if (effectivePerMin !== null && !(typeof effectivePerMin === "number" && Number.isFinite(effectivePerMin) && effectivePerMin > 0)) {
    return null;
  }
  if (policyVersion !== null && typeof policyVersion !== "string") return null;
  if (last429AttemptId !== null && !(isCount(last429AttemptId) && last429AttemptId > 0)) return null;
  if (last429At !== null && (typeof last429At !== "string" || Number.isNaN(Date.parse(last429At)))) return null;
  // A hold without the route's state row is a hold all the same: an entry at
  // revision 0, which the first write of the state takes over.
  const ladderStep = budget?.ladderStep ?? 0;
  const revision = budget?.revision ?? 0;
  if (!isCount(ladderStep) || !isCount(revision)) return null;
  if (hold !== null && (hold.until === null || Number.isNaN(hold.until.getTime()))) return null;
  return {
    holdUntil: hold === null ? null : hold.until!.toISOString(),
    ladderStep,
    effectivePerMin,
    policyVersion,
    last429AttemptId,
    last429At,
    revision,
  };
}

/**
 * Read a page's route state from the route-scope rows of its hold set. None
 * stored is the empty state. Rows of a known route that are not a shape this
 * build reads — a kind it does not know, a state it cannot parse — are a
 * diagnostic: the caller keeps the page's admission closed. The rows of a
 * route this build does not know are left alone — this build never sends on
 * it.
 */
export function routeStateOfHolds(rows: readonly SyncHoldRow[]): RouteStateRead {
  const routes: Partial<Record<FanslyRoute, RouteStateEntry>> = {};
  const byRoute = new Map<FanslyRoute, { budget: SyncHoldRow | null; hold: SyncHoldRow | null }>();
  for (const row of rows) {
    if (row.scope !== "route" || !isFanslyRoute(row.key)) continue;
    const found = byRoute.get(row.key) ?? { budget: null, hold: null };
    if (row.kind === "route_budget") found.budget = row;
    else if (row.kind === "route_hold") found.hold = row;
    else return { ok: false, diagnostic: `route_state_kind:${row.key}:${row.kind}` };
    byRoute.set(row.key, found);
  }
  for (const [route, found] of byRoute) {
    const entry = entryOfRows(found.budget, found.hold);
    if (entry === null) return { ok: false, diagnostic: `route_state_entry:${route}` };
    routes[route] = entry;
  }
  return { ok: true, state: { routes } };
}

export interface RoutePolicyOptions {
  /** TESTS ONLY (default 1): every budget interval is multiplied by this — a
   *  test that paces at 30 ms keeps the production ratios at 30 / 2 500, 0
   *  lifts the budgets (a route hold still holds). The host and `main.ts`
   *  never pass it (pinned by tests/sync-live-gate.integration.test.ts). */
  timeScale?: number;
}

function scaleOf(options: RoutePolicyOptions): number {
  const scale = options.timeScale ?? 1;
  if (!(Number.isFinite(scale) && scale >= 0)) throw new RangeError(`Route policy time scale must be ≥ 0 (got ${scale})`);
  return scale;
}

function scaledInterval(perMin: number, scale: number): number {
  return scale === 1 ? intervalMsOf(perMin) : Math.ceil(intervalMsOf(perMin) * scale);
}

/** A route's effective rate on a page: the table's `current`, or the stored
 *  slowdown when that is lower. */
export function effectiveRatePerMin(route: FanslyRoute, state: RouteState): number {
  const current = routeBudget(route).currentPerMin;
  const stored = state.routes[route]?.effectivePerMin ?? null;
  return stored === null ? current : Math.min(current, stored);
}

/** How far back the journal must be read for `state`: the longest interval
 *  any route or family of the page can have now. */
export function routeJournalLookbackMs(state: RouteState, options: RoutePolicyOptions = {}): number {
  const scale = scaleOf(options);
  let longest = 0;
  for (const route of FANSLY_ROUTES.keys()) {
    longest = Math.max(longest, scaledInterval(effectiveRatePerMin(route, state), scale));
  }
  for (const family of FANSLY_ROUTE_FAMILY_IDS) {
    longest = Math.max(longest, scaledInterval(FAMILY_BUDGETS[family].currentPerMin, scale));
  }
  return longest;
}

/** What the status shows of one route or family of a page. */
export interface RouteClockView {
  route: FanslyRoute;
  family: FanslyRouteFamily | null;
  ceilingPerMin: number;
  currentPerMin: number;
  effectivePerMin: number;
  intervalMs: number;
  lastSendAt: Date | null;
  holdUntil: Date | null;
  /** No send on the route before this (its own interval, its family's, its
   *  hold); null: nothing constrains it. May lie in the past. */
  notBefore: Date | null;
}

/** The intervals an admission on a route is held to: its route's at the
 *  effective rate, and its family's (null: the route has none). The
 *  admission records them on its attempt (`sync_attempts.route_interval_ms`,
 *  `family_interval_ms`), and the send audit judges its gaps by them. */
export interface RouteAdmissionIntervals {
  routeIntervalMs: number;
  familyIntervalMs: number | null;
}

export interface FamilyClockView {
  family: FanslyRouteFamily;
  ceilingPerMin: number;
  currentPerMin: number;
  intervalMs: number;
  lastSendAt: Date | null;
  notBefore: Date | null;
}

function maxMs(...values: Array<number | null>): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (value !== null && (best === null || value > best)) best = value;
  }
  return best;
}

function dateOrNull(ms: number | null): Date | null {
  return ms === null ? null : new Date(ms);
}

/**
 * The route clocks of one page at one instant: the newest send per route and
 * family from the journal read (`readRouteJournal`), the page's route state
 * and the budget table. Pure; built once per slot.
 */
export class RouteClocks {
  readonly #state: RouteState;
  readonly #scale: number;
  readonly #lastMs = new Map<FanslyRoute, number>();
  /** A send of an operation this build cannot place: it counts on every
   *  route (an unknown outcome consumes budget). */
  readonly #anyMs: number | null;
  readonly #familyLastMs = new Map<FanslyRouteFamily, number>();

  constructor(input: { sends: readonly SyncRouteSend[]; state: RouteState } & RoutePolicyOptions) {
    this.#state = input.state;
    this.#scale = scaleOf(input);
    let anyMs: number | null = null;
    for (const send of input.sends) {
      const at = send.lastAt.getTime();
      const route = send.journal === "engine" ? routeOfEngineOperation(send.operation) : routeOfLegacyOperation(send.operation);
      if (route === null) {
        anyMs = maxMs(anyMs, at);
        continue;
      }
      this.#lastMs.set(route, maxMs(this.#lastMs.get(route) ?? null, at)!);
    }
    this.#anyMs = anyMs;
    for (const family of FANSLY_ROUTE_FAMILY_IDS) {
      const last = maxMs(anyMs, ...FANSLY_ROUTE_FAMILIES[family].map((route) => this.#lastMs.get(route) ?? null));
      if (last !== null) this.#familyLastMs.set(family, last);
    }
  }

  get state(): RouteState {
    return this.#state;
  }

  #routeLastMs(route: FanslyRoute): number | null {
    return maxMs(this.#lastMs.get(route) ?? null, this.#anyMs);
  }

  /** A send's clock: one interval after it — none for a lifted (zero) one. */
  #after(last: number | null, intervalMs: number): number | null {
    return last === null || intervalMs === 0 ? null : last + intervalMs;
  }

  #familyIntervalMs(family: FanslyRouteFamily): number {
    return scaledInterval(FAMILY_BUDGETS[family].currentPerMin, this.#scale);
  }

  #familyNotBeforeMs(family: FanslyRouteFamily): number | null {
    return this.#after(this.#familyLastMs.get(family) ?? null, this.#familyIntervalMs(family));
  }

  /** The intervals a send on `route` is admitted under now (what its
   *  attempt records). */
  intervals(route: FanslyRoute): RouteAdmissionIntervals {
    const family = familyOfRoute(route);
    return {
      routeIntervalMs: scaledInterval(effectiveRatePerMin(route, this.#state), this.#scale),
      familyIntervalMs: family === null ? null : this.#familyIntervalMs(family),
    };
  }

  #notBeforeMs(route: FanslyRoute): number | null {
    const own = this.#after(this.#routeLastMs(route), this.intervals(route).routeIntervalMs);
    const family = familyOfRoute(route);
    const holdUntil = this.#state.routes[route]?.holdUntil ?? null;
    return maxMs(own, family === null ? null : this.#familyNotBeforeMs(family), holdUntil === null ? null : Date.parse(holdUntil));
  }

  /** No send on `route` before this instant; null: nothing constrains it. */
  notBefore(route: FanslyRoute): Date | null {
    return dateOrNull(this.#notBeforeMs(route));
  }

  /** Whether `route` may send at `at`. */
  admits(route: FanslyRoute, at: Date): boolean {
    const notBefore = this.#notBeforeMs(route);
    return notBefore === null || notBefore <= at.getTime();
  }

  /** The first instant a key with these wire routes may send on one of them;
   *  null when one is unconstrained — or the key declares no route (a probe,
   *  a write without a request): only its planned request is checked. */
  keyNotBefore(operations: readonly FanslyWireId[] | undefined): Date | null {
    if (operations === undefined || operations.length === 0) return null;
    let earliest = Number.POSITIVE_INFINITY;
    for (const operation of operations) {
      const notBefore = this.#notBeforeMs(routeOfWireId(operation));
      if (notBefore === null) return null;
      earliest = Math.min(earliest, notBefore);
    }
    return new Date(earliest);
  }

  view(route: FanslyRoute): RouteClockView {
    const budget = routeBudget(route);
    const effective = effectiveRatePerMin(route, this.#state);
    const holdUntil = this.#state.routes[route]?.holdUntil ?? null;
    return {
      route,
      family: familyOfRoute(route),
      ceilingPerMin: budget.ceilingPerMin,
      currentPerMin: budget.currentPerMin,
      effectivePerMin: effective,
      intervalMs: scaledInterval(effective, this.#scale),
      lastSendAt: dateOrNull(this.#routeLastMs(route)),
      holdUntil: holdUntil === null ? null : new Date(holdUntil),
      notBefore: this.notBefore(route),
    };
  }

  familyView(family: FanslyRouteFamily): FamilyClockView {
    const budget = FAMILY_BUDGETS[family];
    return {
      family,
      ceilingPerMin: budget.ceilingPerMin,
      currentPerMin: budget.currentPerMin,
      intervalMs: scaledInterval(budget.currentPerMin, this.#scale),
      lastSendAt: dateOrNull(this.#familyLastMs.get(family) ?? null),
      notBefore: dateOrNull(this.#familyNotBeforeMs(family)),
    };
  }

  /** The routes the page sent on within the read, or holds state for. */
  activeRoutes(): FanslyRoute[] {
    const routes = new Set<FanslyRoute>(this.#lastMs.keys());
    for (const route of Object.keys(this.#state.routes) as FanslyRoute[]) routes.add(route);
    if (this.#anyMs !== null) for (const route of FANSLY_ROUTES.keys()) routes.add(route);
    return [...routes].sort();
  }
}

/** What the route admission needs of a registry entry. */
export interface RouteKeySpec {
  key: string;
  operations?: readonly FanslyWireId[];
}

/** The keys none of whose routes may send at `at`: left out of the pick (a
 *  key without declared routes never is — its planned request is checked). */
export function routeExclusions(specs: readonly RouteKeySpec[], clocks: RouteClocks, at: Date): string[] {
  const excluded: string[] = [];
  for (const spec of specs) {
    const notBefore = clocks.keyNotBefore(spec.operations);
    if (notBefore !== null && notBefore.getTime() > at.getTime()) excluded.push(spec.key);
  }
  return excluded.sort();
}

/** The instants in (now, until) at which a key closed now opens, ascending:
 *  the scheduler's short look-ahead asks a class again at each. */
export function lookaheadInstants(specs: readonly RouteKeySpec[], clocks: RouteClocks, now: Date, until: Date): Date[] {
  const instants = new Set<number>();
  for (const spec of specs) {
    const notBefore = clocks.keyNotBefore(spec.operations);
    if (notBefore === null) continue;
    const at = notBefore.getTime();
    if (at > now.getTime() && at < until.getTime()) instants.add(at);
  }
  return [...instants].sort((a, b) => a - b).map((at) => new Date(at));
}

/** The route admission of a page at `now`, as the hold evaluator asks it
 *  (`engine/admission.ts`): when a key's declared routes, or one route, next
 *  admit a send, with the routes still closed and those of them a 429's (or a
 *  5xx's `Retry-After`) hold keeps closed. */
export function routeAdmissionView(clocks: RouteClocks, specs: readonly RouteKeySpec[], now: Date): RouteAdmissionView {
  const byKey = new Map(specs.map((spec) => [spec.key, spec.operations]));
  const heldOf = (routes: readonly FanslyRoute[]): FanslyRoute[] =>
    routes.filter((route) => {
      const holdUntil = clocks.state.routes[route]?.holdUntil ?? null;
      return holdUntil !== null && Date.parse(holdUntil) > now.getTime();
    });
  return {
    keyOpensAt(resource) {
      const operations = byKey.get(resource);
      const at = clocks.keyNotBefore(operations);
      if (at === null || at.getTime() <= now.getTime()) return null;
      const closed = [...new Set((operations ?? []).map(routeOfWireId).filter((route) => !clocks.admits(route, now)))].sort();
      return { at, routes: closed, held: heldOf(closed) };
    },
    routeOpensAt(route) {
      const at = clocks.notBefore(route);
      if (at === null || at.getTime() <= now.getTime()) return null;
      return { at, routes: [route], held: heldOf([route]) };
    },
    keyHeldRoutes(resource) {
      return heldOf([...new Set((byKey.get(resource) ?? []).map(routeOfWireId))].sort());
    },
  };
}

/** The route budgets of a page as its status shows them: the routes it sent
 *  on within the read or holds state for, and the families. */
export function routeStatusView(clocks: RouteClocks | null, stateError: string | null, now: Date): RouteStatusView {
  const opensAt = (at: Date | null): string | null => (at === null || at.getTime() <= now.getTime() ? null : at.toISOString());
  const routes: RouteBudgetStatusView[] = [];
  if (clocks !== null) {
    for (const route of clocks.activeRoutes()) {
      const view = clocks.view(route);
      const entry = clocks.state.routes[route] ?? null;
      routes.push({
        name: route,
        family: view.family,
        ceilingPerMin: view.ceilingPerMin,
        currentPerMin: view.currentPerMin,
        effectivePerMin: view.effectivePerMin,
        intervalMs: view.intervalMs,
        lastSendAt: view.lastSendAt?.toISOString() ?? null,
        holdUntil: view.holdUntil?.toISOString() ?? null,
        ladderStep: entry?.ladderStep ?? null,
        last429At: entry?.last429At ?? null,
        revision: entry?.revision ?? null,
        opensAt: opensAt(view.notBefore),
      });
    }
    for (const family of FANSLY_ROUTE_FAMILY_IDS) {
      const view = clocks.familyView(family);
      routes.push({
        name: `family:${family}`,
        family,
        ceilingPerMin: view.ceilingPerMin,
        currentPerMin: view.currentPerMin,
        effectivePerMin: view.currentPerMin,
        intervalMs: view.intervalMs,
        lastSendAt: view.lastSendAt?.toISOString() ?? null,
        holdUntil: null,
        ladderStep: null,
        last429At: null,
        revision: null,
        opensAt: opensAt(view.notBefore),
      });
    }
  }
  return { policyHash: ROUTE_POLICY_HASH, stateError, routes };
}
