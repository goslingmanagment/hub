import { routeBudget, routePolicyVersion, type FanslyRoute } from "../fansly/routes.ts";
import type { RouteState, RouteStateEntry } from "./route-policy.ts";

// Route holds and slowdowns (step 3b ruling 2 as amended by A2; owner
// decisions №22, D3; plan PR 1-2). A 429 holds ONLY the route that answered it
// — never the page, never the route's family:
//
//   - the route admits nothing until its hold ends: a valid `Retry-After`
//     (delta-seconds or an HTTP-date) to the letter, never shortened; without
//     one the ladder of owner decision №14, 5 → 10 → 20 → 40 → 80 → 160 →
//     300 s, plus 0–20 % jitter. A later answer never shortens a hold;
//   - each 429 halves the page+route's effective rate (never below ⅛ of the
//     route's ceiling), durably: a restart, new demand or new credentials
//     never lift it, nor does a success. Only a deliberate raise does — one
//     step of at most +1/min, never above the route's `current`, by the
//     owner's audited `sync route raise` (a compare-and-set on the entry's
//     revision, so a 429 after the evidence rejects the stale step) or by a
//     calibration PR that moves `current` for every page (`fansly/routes.ts`;
//     the lower of the two always counts);
//   - the ladder climbs by the 429s of one slowdown: while the route runs
//     slowed, the next 429 takes the next step; once raised back to `current`
//     the next 429 starts the ladder over.
//
// A 5xx naming its `Retry-After` (the provider's own pause) holds the route
// that answered it the same way, to the letter, without a slowdown or a
// ladder step (it is no quota answer).
//
// The state lives in the page's route-state namespace (`route-policy.ts`,
// written by `writeSyncRouteState` only); this file is pure.

/** A route 429 without `Retry-After` (owner decision №14): by the ladder step
 *  of the route's slowdown. */
export const ROUTE_HOLD_LADDER_MS: readonly number[] = [5, 10, 20, 40, 80, 160, 300].map((seconds) => seconds * 1_000);
/** A ladder step is stretched by up to this share (never a `Retry-After`). */
export const ROUTE_HOLD_JITTER_MAX = 0.2;
/** A slowdown never takes a route below this share of its ceiling. */
export const ROUTE_SLOWDOWN_FLOOR_SHARE = 1 / 8;
/** One raise adds at most this many requests a minute (A2). */
export const ROUTE_RAISE_STEP_PER_MIN = 1;

/** Whether the route runs slower than the table's `current` on this page. */
export function routeSlowed(route: FanslyRoute, entry: RouteStateEntry | null): boolean {
  return entry !== null && entry.effectivePerMin !== null && entry.effectivePerMin < routeBudget(route).currentPerMin;
}

/** The route's hold in force at `now`, or null. */
export function routeHoldUntil(state: RouteState, route: FanslyRoute, now: Date): Date | null {
  const until = state.routes[route]?.holdUntil ?? null;
  if (until === null) return null;
  const at = new Date(until);
  return at.getTime() > now.getTime() ? at : null;
}

export interface RouteHoldInput {
  route: FanslyRoute;
  /** The route's stored entry (null: none yet). */
  entry: RouteStateEntry | null;
  now: Date;
  /** 429, or a 5xx that named its `Retry-After`. */
  httpStatus: number;
  /** `Retry-After` in ms from `now` as the provider stated it (never clamped). */
  retryAfterMs: number | null;
  /** The attempt that got the answer. */
  attemptId: number;
  /** A unit draw in [0, 1): the ladder step's jitter (called only for a 429
   *  without `Retry-After`). */
  jitter: () => number;
}

export interface RouteHold {
  route: FanslyRoute;
  /** The revision the write compares against (0: no entry yet). */
  expectRevision: number;
  /** The entry to store (its revision is `expectRevision + 1`). */
  entry: RouteStateEntry;
  /** The route admits nothing before this. */
  holdUntil: Date;
  /** The answer was a 429 (a quota answer: slowed, ladder stepped). */
  rateLimited: boolean;
}

function later(a: number | null, b: number): number {
  return a === null || b > a ? b : a;
}

/**
 * The route's state after one 429 or 5xx-with-`Retry-After` (pure). Null: the
 * entry already records this attempt's 429 (the outcome is written once).
 */
export function routeHoldAfter(input: RouteHoldInput): RouteHold | null {
  const { route, entry, now } = input;
  if (entry !== null && entry.last429AttemptId === input.attemptId) return null;
  const rateLimited = input.httpStatus === 429;
  if (!rateLimited && input.retryAfterMs === null) {
    throw new Error(`A route hold needs a 429 or a Retry-After (got ${input.httpStatus} without one)`);
  }
  const slowed = routeSlowed(route, entry);
  const step = slowed ? Math.min(entry!.ladderStep, ROUTE_HOLD_LADDER_MS.length - 1) : 0;
  const holdMs = input.retryAfterMs !== null
    ? Math.max(0, input.retryAfterMs)
    : Math.ceil(ROUTE_HOLD_LADDER_MS[step]! * (1 + ROUTE_HOLD_JITTER_MAX * Math.min(Math.max(input.jitter(), 0), 1)));
  const storedUntil = entry === null || entry.holdUntil === null ? null : Date.parse(entry.holdUntil);
  const holdUntil = new Date(later(storedUntil, now.getTime() + holdMs));
  const revision = entry?.revision ?? 0;
  if (!rateLimited) {
    const base: RouteStateEntry = entry ?? {
      holdUntil: null,
      ladderStep: 0,
      effectivePerMin: null,
      policyVersion: null,
      last429AttemptId: null,
      last429At: null,
      revision: 0,
    };
    return {
      route,
      expectRevision: revision,
      entry: { ...base, holdUntil: holdUntil.toISOString(), revision: revision + 1 },
      holdUntil,
      rateLimited,
    };
  }
  const budget = routeBudget(route);
  const stored = entry === null ? null : entry.effectivePerMin;
  const effective = stored === null ? budget.currentPerMin : Math.min(budget.currentPerMin, stored);
  return {
    route,
    expectRevision: revision,
    entry: {
      holdUntil: holdUntil.toISOString(),
      ladderStep: Math.min(step + 1, ROUTE_HOLD_LADDER_MS.length - 1),
      effectivePerMin: Math.max(budget.ceilingPerMin * ROUTE_SLOWDOWN_FLOOR_SHARE, effective / 2),
      policyVersion: routePolicyVersion(route),
      last429AttemptId: input.attemptId,
      last429At: now.toISOString(),
      revision: revision + 1,
    },
    holdUntil,
    rateLimited,
  };
}

export type RouteRaise =
  | { ok: true; route: FanslyRoute; expectRevision: number; entry: RouteStateEntry; fromPerMin: number; toPerMin: number }
  | { ok: false; reason: "not_slowed" | "stale_revision" | "not_a_raise" | "step_too_large" | "above_current"; detail: string };

/**
 * `sync route raise` (A2): one step up of a page+route's slowdown — at most
 * +1/min, never above the route's `current`, a compare-and-set on the revision
 * the evidence was read at. The hold in force (a cooldown, a `Retry-After`)
 * and the ladder stay; reaching `current` ends the slowdown.
 */
export function routeRaise(
  route: FanslyRoute,
  entry: RouteStateEntry | null,
  input: { toPerMin: number; expectRevision: number },
): RouteRaise {
  const current = routeBudget(route).currentPerMin;
  if (entry === null || !routeSlowed(route, entry)) {
    return { ok: false, reason: "not_slowed", detail: `${route} runs at its current ${current}/min: nothing to raise (a calibration PR moves current)` };
  }
  if (entry.revision !== input.expectRevision) {
    return {
      ok: false,
      reason: "stale_revision",
      detail: `${route} is at revision ${entry.revision}, the evidence at ${input.expectRevision}: a newer 429 or raise came after it`,
    };
  }
  const from = entry.effectivePerMin!;
  const to = input.toPerMin;
  if (!(Number.isFinite(to) && to > from)) {
    return { ok: false, reason: "not_a_raise", detail: `${route} runs at ${from}/min: ${to}/min is no raise` };
  }
  if (to > current) {
    return { ok: false, reason: "above_current", detail: `${route}: ${to}/min is above its current ${current}/min` };
  }
  if (to - from > ROUTE_RAISE_STEP_PER_MIN + 1e-9) {
    return {
      ok: false,
      reason: "step_too_large",
      detail: `${route}: ${from}/min → ${to}/min is more than one step of +${ROUTE_RAISE_STEP_PER_MIN}/min`,
    };
  }
  const lifted = to >= current;
  return {
    ok: true,
    route,
    expectRevision: entry.revision,
    entry: {
      ...entry,
      effectivePerMin: lifted ? null : to,
      policyVersion: lifted ? null : entry.policyVersion,
      revision: entry.revision + 1,
    },
    fromPerMin: from,
    toPerMin: to,
  };
}
