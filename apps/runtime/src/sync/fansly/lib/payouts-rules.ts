import { PAYOUT_REQUESTS_PAGE_SIZE } from "@agency_hub_core/fansly";

import { classifyFanslyResponse } from "./lane.ts";

// The payouts rules of the Sync Engine's `payouts.*` resources
// (resources/payouts.ts): the `payouts` cursor, the request-history walk's stop
// and catch-up rules, and the reads of a served page. Pure. The legacy
// `payouts` lane (fansly-payouts.ts) imports them from here until step 4
// deletes it.

/** One kind PER ROUTE: two routes, two response shapes. */
export const FANSLY_PAYOUTS_OBSERVATION_KINDS = {
  payoutMethods: "payout_methods",
  payoutRequests: "payout_requests",
} as const;

/** The coverage plane this lane claims, one scope per capture surface — so a
 *  request walk that is still reaching backwards cannot make the method
 *  listing look degraded, or the reverse. */
export const FANSLY_PAYOUTS_COVERAGE_SCOPES = {
  methods: "payout_methods",
  requests: "payout_requests",
} as const;

/**
 * Pages the request walk may take in total before it gives up.
 *
 * `total` was 83 on the walked page. At an unknown server page size this is a
 * safety net against a cursor that advances by one row a page, not a coverage
 * limit: hitting it stops the walk with an anomaly. Catch-up pages count too.
 */
export const REQUEST_WALK_MAX_PAGES = 400;

// ── cursor state ─────────────────────────────────────────────────────────────

export interface FanslyPayoutsCursorState {
  version: 1;
  /** The UTC day `callsToday` belongs to; a different day resets the counter. */
  utcDay: string;
  /** HTTP ATTEMPTS spent by this lane on `utcDay`. Retries included. */
  callsToday: number;
  /** The UTC day whose FIXED steps are already done. */
  fixedStepsDay: string | null;
  /** Which fixed step the next dispatch resumes at (index into the two steps). */
  fixedStepIndex: number;
  /** `offset` for the next request-history page. 0 until the head read seeds it. */
  walkOffset: number;
  /** Repeat-request guard, first trigger: the `offset` the previous WALK call
   *  carried. */
  lastRequestedOffset: number | null;
  /** Repeat-request guard, second trigger: the FIRST row ref of the previous
   *  page. An offset always advances; the answer to it may not. */
  lastPageFirstRef: string | null;
  /** Pages the walk has taken across every dispatch. */
  walkPages: number;
  /** `total` as the provider last reported it. */
  walkTotal: number | null;
  /** The oldest `createdAt` the walk has reached, in Unix ms — the FLOOR. */
  floorMs: number | null;
  /** True once a page came back short or the offset reached `total`, and again
   *  once a catch-up reaches rows an earlier head read held. */
  walkDone: boolean;
  /** Why the history walk stopped; null while the first walk is still open. A
   *  catch-up that reaches the previous head keeps it; one that ends on a
   *  repeat, the page cap or a short page before `total` turns `exhausted`
   *  partial, never the reverse (`settleWalkStop`). */
  walkStop: FanslyPayoutsWalkStop | null;
  /** The row refs of the last HEAD page — what the next head read has to share
   *  a row with for the head alone to have caught every payout since. */
  headRefs: string[];
  /** An open catch-up walk, or null. */
  catchUp: FanslyPayoutsCatchUp | null;
  /** Payout status codes this page has already reported unknown, so the anomaly
   *  fires ONCE per code rather than once per sweep forever. */
  unknownStatusCodes: number[];
}

/**
 * Why the request walk stopped. Only `exhausted` reached the provider's floor;
 * every other stop leaves the history partial and names itself in coverage.
 */
export type FanslyPayoutsWalkStop =
  | "exhausted"
  | "short_before_total"
  | "repeat_request"
  | "page_cap";

const WALK_STOPS: ReadonlySet<string> = new Set<FanslyPayoutsWalkStop>([
  "exhausted",
  "short_before_total",
  "repeat_request",
  "page_cap",
]);

/** Where a catch-up walk ends: on a page holding one of `stopRefs` (the
 *  previous head's rows), or — for a cursor saved before head refs were kept —
 *  once the walk has passed `untilOffset`, the rows `total` grew by. */
export interface FanslyPayoutsCatchUp {
  stopRefs: string[] | null;
  untilOffset: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}

function asNullableInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStrings(value: unknown): string[] | null {
  return Array.isArray(value)
    ? value.filter((member): member is string => asNullableString(member) !== null)
    : null;
}

/** A catch-up with no stop condition left is no catch-up at all. */
function parseCatchUp(value: unknown): FanslyPayoutsCatchUp | null {
  const record = asRecord(value);
  const stopRefs = asStrings(record?.stopRefs) ?? [];
  const untilOffset = asNullableInt(record?.untilOffset);
  if (stopRefs.length === 0 && untilOffset === null) {
    return null;
  }
  return { stopRefs: stopRefs.length > 0 ? stopRefs : null, untilOffset };
}

export function parseFanslyPayoutsCursorState(
  value: unknown,
): FanslyPayoutsCursorState | null {
  const state = asRecord(value);
  if (!state || state.version !== 1) {
    return null;
  }
  const utcDay = asNullableString(state.utcDay);
  if (utcDay === null) {
    return null;
  }
  const walkDone = state.walkDone === true;
  return {
    version: 1,
    utcDay,
    callsToday: Math.max(0, asInt(state.callsToday, 0)),
    fixedStepsDay: asNullableString(state.fixedStepsDay),
    fixedStepIndex: Math.max(0, asInt(state.fixedStepIndex, 0)),
    walkOffset: Math.max(0, asInt(state.walkOffset, 0)),
    lastRequestedOffset: asNullableInt(state.lastRequestedOffset),
    lastPageFirstRef: asNullableString(state.lastPageFirstRef),
    walkPages: Math.max(0, asInt(state.walkPages, 0)),
    walkTotal: asNullableInt(state.walkTotal),
    floorMs: asNullableInt(state.floorMs),
    walkDone,
    // A cursor saved before the stop was kept: every such walk in production
    // ended on a short page with its count equal to `total`.
    walkStop: typeof state.walkStop === "string" && WALK_STOPS.has(state.walkStop)
      ? state.walkStop as FanslyPayoutsWalkStop
      : walkDone
      ? "exhausted"
      : null,
    headRefs: asStrings(state.headRefs) ?? [],
    catchUp: parseCatchUp(state.catchUp),
    unknownStatusCodes: Array.isArray(state.unknownStatusCodes)
      ? state.unknownStatusCodes.filter(
        (code): code is number => typeof code === "number" && Number.isSafeInteger(code),
      )
      : [],
  };
}

// ── shape helpers over the journaled bodies ──────────────────────────────────

/** The `data[]` rows of one `/payments/payout/requests` page, or `[]`. */
export function payoutRequestRows(payload: unknown): Record<string, unknown>[] {
  const record = asRecord(payload);
  if (record === null) {
    return [];
  }
  return Array.isArray(record.data)
    ? record.data.filter((row): row is Record<string, unknown> => asRecord(row) !== null)
    : [];
}

export function classifyPayoutResponse(kind: string, payload: unknown) {
  return classifyFanslyResponse(payload, {
    isValid: (value) => {
      const record = asRecord(value);
      if (kind === FANSLY_PAYOUTS_OBSERVATION_KINDS.payoutRequests) {
        return record !== null && Array.isArray(record.data);
      }
      return Array.isArray(value)
        || (record !== null && Object.values(record).some((member) => Array.isArray(member)));
    },
    isEmpty: (value) => kind === FANSLY_PAYOUTS_OBSERVATION_KINDS.payoutRequests
      ? payoutRequestRows(value).length === 0
      : Array.isArray(value)
      ? value.length === 0
      : Object.values(asRecord(value)!).every((member) => !Array.isArray(member) || member.length === 0),
  });
}

/** `total` as the page reported it, or null. It is a HINT for the walk's stop
 *  condition, never the only one: a short page ends the walk on its own. */
export function payoutRequestTotal(payload: unknown): number | null {
  const record = asRecord(payload);
  return record === null ? null : asNullableInt(record.total);
}

/** The FIRST row's `id` on a page, or null. It is the walk's proof that the
 *  server honoured `offset`: the same first row twice means it did not. */
export function firstPayoutRef(rows: readonly Record<string, unknown>[]): string | null {
  const first = rows[0];
  return first === undefined ? null : asNullableString(first.id);
}

/** The oldest `createdAt` (Unix ms) on a page — the floor this walk has reached.
 *  Null when no row carried a usable instant. */
export function oldestCreatedAtMs(rows: readonly Record<string, unknown>[]): number | null {
  let oldest: number | null = null;
  for (const row of rows) {
    const createdAt = row.createdAt;
    if (typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt <= 0) {
      continue;
    }
    oldest = oldest === null ? createdAt : Math.min(oldest, createdAt);
  }
  return oldest;
}

/** Every row `id` on a page, in page order. */
export function payoutRefs(rows: readonly Record<string, unknown>[]): string[] {
  return rows.map((row) => asNullableString(row.id)).filter((id): id is string => id !== null);
}

function sharesARef(rows: readonly Record<string, unknown>[], refs: readonly string[]): boolean {
  const known = new Set(refs);
  return payoutRefs(rows).some((id) => known.has(id));
}

/**
 * Why a walk that just ended on a SHORT page, or at `total`, stopped.
 *
 * The short page is the end either way. But a response whose own `total`
 * counts rows past the ones it served has contradicted itself, and a walk that
 * stopped there has not shown it reached the floor.
 */
export function payoutWalkStopAt(input: {
  offset: number;
  rowCount: number;
  total: number | null;
}): "exhausted" | "short_before_total" {
  return input.rowCount < PAYOUT_REQUESTS_PAGE_SIZE
      && input.total !== null
      && input.offset + input.rowCount < input.total
    ? "short_before_total"
    : "exhausted";
}

/** A walk that stops again never upgrades an earlier partial stop: a catch-up
 *  that reaches the end cleanly has read new rows, not the history the first
 *  walk left unread. It may only make an exhausted history partial. */
export function settleWalkStop(
  previous: FanslyPayoutsWalkStop | null,
  next: FanslyPayoutsWalkStop,
): FanslyPayoutsWalkStop {
  return previous === null || previous === "exhausted" ? next : previous;
}

/** The claim a DONE request walk may make. Only an exhausted walk reached the
 *  floor; every other stop is partial and names itself. */
export function settledPayoutRequestsCoverage(stop: FanslyPayoutsWalkStop | null) {
  return stop === null || stop === "exhausted"
    ? { status: "provider_exhausted", reasonCode: "walk_exhausted" } as const
    : { status: "partial_provider_surface", reasonCode: stop } as const;
}

/**
 * Did more payouts land since the previous head read than one head page holds?
 * Returns the catch-up that reaches them, or null.
 *
 * Only a FULL head can hide rows below it. With the previous head's refs in
 * hand the test is exact: a full head sharing none of them means the previous
 * head slid past offset 9. Without them (a cursor saved before they were kept,
 * or a page whose previous head was empty), `total` grown by more than a page
 * is the signal, and the catch-up walks exactly the rows it grew by.
 */
export function payoutHeadGap(input: {
  previousHeadRefs: readonly string[];
  previousTotal: number | null;
  headRows: readonly Record<string, unknown>[];
  total: number | null;
}): FanslyPayoutsCatchUp | null {
  if (input.headRows.length < PAYOUT_REQUESTS_PAGE_SIZE) {
    return null;
  }
  if (input.previousHeadRefs.length > 0) {
    return payoutRefs(input.headRows).length === 0 || sharesARef(input.headRows, input.previousHeadRefs)
      ? null
      : { stopRefs: [...input.previousHeadRefs], untilOffset: null };
  }
  if (input.previousTotal === null || input.total === null) {
    return null;
  }
  const landed = input.total - input.previousTotal;
  return landed > PAYOUT_REQUESTS_PAGE_SIZE ? { stopRefs: null, untilOffset: landed } : null;
}

/** Has a catch-up walk reached the rows the previous head already held? */
export function catchUpReached(
  catchUp: FanslyPayoutsCatchUp,
  rows: readonly Record<string, unknown>[],
  nextOffset: number,
): boolean {
  return (catchUp.stopRefs !== null && sharesARef(rows, catchUp.stopRefs))
    || (catchUp.untilOffset !== null && nextOffset >= catchUp.untilOffset);
}
