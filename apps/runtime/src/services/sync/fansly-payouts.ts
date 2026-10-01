// WP-F7 — the `payouts` capture handler.
//
// Money OUT, and it is the smallest lane in this initiative: TWO routes, TWO
// calls a day once the history has been reached.
//
//   payout_methods    /payments/payoutmethods                 (full listing)
//   payout_requests   /payments/payout/requests?before=&after=&limit=10&offset=
//
// ── WHAT IS **NOT** HERE, AND WHY THAT IS THE MOST IMPORTANT PART ───────────
//
// `/account/wallets/earnings` is already `getEarningsOverview` in the adapter,
// so this package adds no wallet-balance route and no `page_wallet_snapshots`
// table (A28-8). And the wallet earnings LEDGER —
// `/account/wallets/earnings/transactions` — is the EXISTING `transactions`
// stream, which has called it with `limit=100` since 2024 and runs a
// full-history backfill on page connect. That was settled by matching seven
// transaction ids out of this lane's own capture HAR against rows the kernel
// already held, including the oldest row on page 242 of 242 (A28-1). A second
// lane reading the same route would have been a duplicate ledger with its own
// parser and its own bugs.
//
// ── THE SWEEP, once a UTC day ───────────────────────────────────────────────
//
// TWO FIXED STEPS, one journaled call each:
//
//   1. the payout-method listing — a FULL array, so it also carries the roster
//      that lets a removed method be marked `missing_since` rather than deleted;
//   2. the HEAD page of the payout-request history, `offset=0`.
//
// ── THE FIRST-ENABLE WALK ───────────────────────────────────────────────────
//
// `/payments/payout/requests` is OFFSET-paged at 10 rows a page: the walked
// page carried `total = 83` back to 2025-06-23, which is nine calls. The head
// page IS page one of that walk — on the day the lane is enabled the head read
// seeds the cursor at offset 10 and the walk continues 20, 30, … until a page
// comes back short or the offset reaches `total`. After that the walk is done
// and the daily cost is exactly two calls.
//
// WHY the walk stopped is kept (`walkStop`), because only one stop may claim
// the floor. A short page always ends the walk — but when that response's own
// `total` says rows remain past it, the provider contradicted itself, and the
// claim is `short_before_total`: partial, with ONE anomaly, never
// `provider_exhausted`. Every later head read restates the stop it has, and
// nothing upgrades it.
//
// ── THE CATCH-UP ────────────────────────────────────────────────────────────
//
// New payouts land at the HEAD, and the head holds ten. When more than ten
// land between two head reads — a lane down for weeks on a busy page — the rest
// slide below offset 0, where no daily read reaches. So the head read keeps the
// refs it saw, and a FULL head that shares none of them with the previous one
// re-opens the walk at offset 10 as a CATCH-UP, which stops on the first page
// that reaches a row the previous head held. A cursor saved before the refs
// were kept falls back on `total`: grown by more than a page, the catch-up
// walks exactly the rows it grew by. A catch-up that reaches the previous
// head's rows read new rows, not the floor, so it keeps the stop as it was; one
// that ends on a repeat, the page cap or a short page before `total` turns an
// exhausted history partial — and never the reverse.
//
// Whether `limit > 10` is honoured on THIS route has never been measured. So
// the walk assumes 10 and carries a REPEAT-REQUEST GUARD instead of a belief.
// It has TWO triggers and they answer the same question — "did this request
// already happen?" — from the two ends it can be asked from:
//
//   THE OFFSET. The same offset asked twice in one walk is a loop's first
//   visible step (WP-F1 spent a whole day's cap on that shape in production).
//   It is spent before any egress, and on an offset walk it can only fire from
//   corrupted cursor state — which is exactly what a crash mid-save produces.
//
//   THE ANSWER. An offset ALWAYS advances by construction, so the check above
//   cannot catch the failure this route can actually have: a server that
//   IGNORES `offset` and serves page one forever. A page whose first row is the
//   first row of the page before it is that server, and the walk stops on it.
//
// Either trigger stops the walk with ONE anomaly and never loops.
//
// Everything rides ONE cap of 20 attempts/page/UTC-day (§6.1's corrected
// number; the pre-A28 8 was sized before the ledger was believed to ride this
// lane, and then the ledger turned out to be a duplicate). Crossing it DEFERS
// to the next UTC day and never drops a response already fetched.
//
// ── THE STATUS MAP IS ONE CODE DEEP ────────────────────────────────────────
//
// All 83 observed requests carried `status = 8`, whose UI label is `Processed`.
// Every other payout status is unknown, so this lane never treats 8 as "the
// success code" in a conditional — it raises ONE anomaly per unseen code, per
// page, durably, and the canonicalizer projects `unmapped:<code>` beside the
// integer. A parser that invented names would report a failed payout as a
// completed one.
//
// ── WHAT NEVER LEAVES THE JOURNAL ──────────────────────────────────────────
//
// `/payments/payoutmethods` returns the creator's payout CREDENTIALS: provider
// 2 (Paxum, per A22-4 — the API spec says PayPal and is wrong) hands back the
// FULL email address in plaintext. The body is journaled verbatim (DP 7) and
// the ONLY thing derived from it downstream is a mask. Neither of this lane's
// observation kinds is on `AGENT_OBSERVATION_PAYLOAD_ALLOWLIST`
// (`modules/agent-read/observation-scrub.ts`), which is an ALLOWLIST and
// fail-closed, so the agent read plane can never serve either body.

import {
  assertOwnedPageSyncLease,
  countPagePayouts,
  getCheckpoint,
} from "@agency_hub_core/db";
import { PAYOUT_REQUESTS_PAGE_SIZE, PAYOUT_REQUESTS_UNBOUNDED } from "@agency_hub_core/fansly";
import { CAPTURE_COVERAGE_PLANES } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { isMappedPayoutStatus } from "../canonicalize/fansly-payouts.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { composeRequestObservers } from "./chunk-budget.ts";
import type { ExecutorRequestContext, StreamChunkResult } from "./executor-handlers.ts";
import {
  advanceOffsetPage,
  classifyFanslyResponse,
  createFanslyLaneCoverageWriter,
  createFanslyLaneJournal,
  createFanslyLaneRuntime,
  fanslyUtcDayKey,
  FanslyLaneInvalidResponseError,
  isRepeatedRequest,
  nextFanslyUtcDayStart,
  rollFanslyUtcDay,
  spreadFanslyContinuation,
} from "./fansly-lane.ts";
import { evaluateFanslyStreamGate } from "./fansly-stream-gate.ts";
import { summarizeCheckpoint } from "./observability.ts";
import { createSyncRateLimitWaiter } from "./rate-limiter.ts";
import {
  FANSLY_PAYOUTS_CAPTURE_MAPPER_VERSION,
  retentionDate,
} from "./shared.ts";
import { fanslyPageSendGuard } from "../fansly-send-guard/index.ts";

const STREAM = "payouts" as const;

/** One kind PER ROUTE: two routes, two response shapes. */
const OBSERVATION_KINDS = {
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
 * Request-history pages one dispatch may walk before a jittered continuation.
 *
 * The chunk budget bites long before this on a healthy lane; this keeps a
 * first-enable walk from running as one contiguous burst, which is the real
 * ban-risk surface. Nine pages is the whole walked history, so the default
 * spreads it over two dispatches.
 */
const REQUEST_WALK_PAGES_PER_CHUNK = 5;

/**
 * Pages the request walk may take in total before it gives up.
 *
 * `total` was 83 on the walked page. At an unknown server page size this is a
 * safety net against a cursor that advances by one row a page, not a coverage
 * limit: hitting it stops the walk with an anomaly. Catch-up pages count too.
 */
const REQUEST_WALK_MAX_PAGES = 400;


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

export function emptyFanslyPayoutsCursorState(now: Date): FanslyPayoutsCursorState {
  return {
    version: 1,
    utcDay: utcDayKey(now),
    callsToday: 0,
    fixedStepsDay: null,
    fixedStepIndex: 0,
    walkOffset: 0,
    lastRequestedOffset: null,
    lastPageFirstRef: null,
    walkPages: 0,
    walkTotal: null,
    floorMs: null,
    walkDone: false,
    walkStop: null,
    headRefs: [],
    catchUp: null,
    unknownStatusCodes: [],
  };
}

export const utcDayKey = fanslyUtcDayKey;

/** A new UTC day resets the attempt counter and re-arms the fixed steps.
 *  Nothing else changes: a request walk that deferred mid-history resumes at
 *  exactly the offset it stopped on. */
export const rollUtcDay = rollFanslyUtcDay;

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

function classifyPayoutResponse(kind: string, payload: unknown) {
  return classifyFanslyResponse(payload, {
    isValid: (value) => {
      const record = asRecord(value);
      if (kind === OBSERVATION_KINDS.payoutRequests) {
        return record !== null && Array.isArray(record.data);
      }
      return Array.isArray(value)
        || (record !== null && Object.values(record).some((member) => Array.isArray(member)));
    },
    isEmpty: (value) => kind === OBSERVATION_KINDS.payoutRequests
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
function payoutRefs(rows: readonly Record<string, unknown>[]): string[] {
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
function settledPayoutRequestsCoverage(stop: FanslyPayoutsWalkStop | null) {
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
function catchUpReached(
  catchUp: FanslyPayoutsCatchUp,
  rows: readonly Record<string, unknown>[],
  nextOffset: number,
): boolean {
  return (catchUp.stopRefs !== null && sharesARef(rows, catchUp.stopRefs))
    || (catchUp.untilOffset !== null && nextOffset >= catchUp.untilOffset);
}

/** Backfill continuation spacing: the configured delay ± 30 % jitter, so a deep
 *  walk cannot run contiguously. Burst shape, not daily volume, is the real
 *  ban-risk surface. */
export function walkContinuationAt(
  now: Date,
  delayMs: number,
  random: () => number = Math.random,
): Date {
  return spreadFanslyContinuation(now, delayMs, random);
}

// ── the handler ──────────────────────────────────────────────────────────────

function skip(reason: string): StreamChunkResult {
  return { satisfied: true, yieldReason: null, stats: { skipped: reason }, gatedSkip: reason };
}

export async function fanslyPayoutsChunk(
  app: AppContext,
  input: ExecutorRequestContext & { syncRunId: number; now?: Date },
): Promise<StreamChunkResult> {
  if (input.pageContext.platform !== "fansly") {
    return skip("not_fansly");
  }
  await input.telemetry.recordPhaseStarted(STREAM);

  const effective = await loadEffectiveConfig(app.db, app.config);
  const gate = evaluateFanslyStreamGate(effective, STREAM, input.pageContext.page.label);
  if (gate.state !== "ramped") {
    return skip(gate.state);
  }

  const now = input.now ?? new Date();
  const pageId = input.pageContext.page.id;
  const dailyCap = Math.max(1, effective.fanslyPayoutsDailyCallBudget ?? 20);
  const continuationDelayMs = Math.max(0, effective.fanslyBackfillContinuationDelayMs ?? 20_000);

  const checkpoint = await getCheckpoint(app.db, pageId, STREAM);
  await input.telemetry.recordCheckpointLoaded(STREAM, summarizeCheckpoint(checkpoint));
  let state = rollUtcDay(
    parseFanslyPayoutsCursorState(checkpoint?.state) ?? emptyFanslyPayoutsCursorState(now),
    now,
  );

  const lane = createFanslyLaneRuntime({
    db: app.db,
    pageId,
    stream: STREAM,
    cursorText: () => state.fixedStepsDay,
    dailyCap,
    telemetry: input.telemetry,
    downstreamObserver: composeRequestObservers(
      input.telemetry.getRequestObserver(),
      input.budget,
    ),
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    egressKey: input.pageContext.egressKey,
    rateLimitWaiter: createSyncRateLimitWaiter(app, input.pageContext),
    sendGuard: fanslyPageSendGuard(app, input.pageContext.page.id, "sync_stream"),
  });
  const { attemptBudget, complete: completeLane, requestContext, saveProgress } = lane;

  let journaled = 0;
  let deferred: string | null = null;

  /**
   * Journal FIRST, always, and VERBATIM.
   *
   * No trim runs on this lane. [A20] narrowed exactly one array — an
   * `accounts[]` sidecar whose `lastSeenAt` moves every minute — and neither
   * payout body carries one: `/payments/payoutmethods` is a bare array of the
   * page's OWN methods and `/payments/payout/requests` is `{total, data[]}` of
   * the page's own payouts. Both are small, both are stable between sweeps, and
   * both content-address to the same object until something actually changes.
   */
  const journal = createFanslyLaneJournal({
    db: app.db,
    pageId,
    syncRunId: input.syncRunId,
    mapperVersion: FANSLY_PAYOUTS_CAPTURE_MAPPER_VERSION,
    payloadKind: "mapping_critical",
    retainUntil: retentionDate(),
    onJournal: () => { journaled += 1; },
  });
  const persist = async (
    kind: string,
    requestParams: Record<string, unknown>,
    payload: unknown,
  ) => {
    const result = await journal(kind, requestParams, payload);
    if (classifyPayoutResponse(kind, payload) === "invalid") {
      throw new FanslyLaneInvalidResponseError(kind);
    }
    return result;
  };

  /** Room for one more call today? Crossing this defers; it never drops. */
  const hasDayCapacity = attemptBudget.hasCapacity;


  const coverage = createFanslyLaneCoverageWriter({
    db: app.db,
    pageId,
    plane: CAPTURE_COVERAGE_PLANES.payouts,
    acquisitionMode: "retroactive",
    newestCapturedAt: now,
  });

  /**
   * ONE anomaly per unseen payout status code, per page, DURABLY.
   *
   * The map is one code deep (8 = `Processed`) and every other value is
   * unknown. Raising this once per code rather than once per sweep is what
   * keeps it a signal: a page whose history is all code 8 says nothing, and the
   * day a refusal or a reversal appears, it says so exactly once.
   */
  const reportUnknownStatuses = async (rows: readonly Record<string, unknown>[]) => {
    const seen = new Set(state.unknownStatusCodes);
    const fresh: number[] = [];
    for (const row of rows) {
      const code = asNullableInt(row.status);
      if (code === null || isMappedPayoutStatus(code) || seen.has(code)) {
        continue;
      }
      seen.add(code);
      fresh.push(code);
    }
    for (const code of fresh) {
      await input.telemetry.addAnomaly({
        code: "fansly_payout_status_unknown",
        severity: "warn",
        message:
          "Fansly served a payout status code with no observed label; "
          + "the row is projected as `unmapped` rather than guessed at",
        details: { statusCode: code },
      });
    }
    if (fresh.length > 0) {
      state = { ...state, unknownStatusCodes: [...seen].sort((a, b) => a - b) };
    }
  };

  /**
   * One page of the request history, journaled and folded into the walk.
   *
   * The HEAD read and the walk share this on purpose: on the day the lane is
   * enabled the head page IS page one of the walk, so the whole 83-row history
   * costs nine calls rather than ten.
   */
  const readRequestPage = async (offset: number) => {
    await assertOwnedPageSyncLease(app.db);
    const response = await app.adapter.getPayoutRequestsPage(requestContext, {
      before: PAYOUT_REQUESTS_UNBOUNDED,
      after: PAYOUT_REQUESTS_UNBOUNDED,
      limit: PAYOUT_REQUESTS_PAGE_SIZE,
      offset,
    });
    const persisted = await persist(OBSERVATION_KINDS.payoutRequests, {
      before: PAYOUT_REQUESTS_UNBOUNDED,
      after: PAYOUT_REQUESTS_UNBOUNDED,
      limit: PAYOUT_REQUESTS_PAGE_SIZE,
      offset,
    }, response.raw);
    const rows = payoutRequestRows(response.raw);
    const total = payoutRequestTotal(response.raw);
    const pageFloor = oldestCreatedAtMs(rows);
    state = {
      ...state,
      walkTotal: total ?? state.walkTotal,
      floorMs: pageFloor === null
        ? state.floorMs
        : state.floorMs === null
        ? pageFloor
        : Math.min(state.floorMs, pageFloor),
    };
    await reportUnknownStatuses(rows);
    return { persisted, rows, total };
  };

  /** ONE anomaly when a page ends the walk short of its own `total`, as every
   *  other stop that leaves the history partial raises one. */
  const reportShortBeforeTotal = async (offset: number, rowCount: number, total: number | null) => {
    await input.telemetry.addAnomaly({
      code: "fansly_payouts_short_before_total",
      severity: "warn",
      message:
        "A Fansly payout-request page came back short while its own `total` counts "
        + "more rows; the walk stopped and claims a partial history",
      details: { offset, rows: rowCount, total, pages: state.walkPages },
    });
  };

  /**
   * The request-history claim of a DONE walk, read off why it stopped.
   *
   * `proof` is the page this dispatch just read, if any. It proves an exhausted
   * walk, and a partial one only when that page is what stopped it; a partial
   * stop restated from anywhere else names no observation, so the upsert keeps
   * the one that proved it.
   */
  const writeSettledCoverage = async (
    proof: { observationId: number | null; stoppedHere: boolean } | null,
  ) => {
    const settled = settledPayoutRequestsCoverage(state.walkStop);
    const proved = proof !== null
      && (settled.status === "provider_exhausted" || proof.stoppedHere);
    await coverage(
      FANSLY_PAYOUTS_COVERAGE_SCOPES.requests,
      settled.status,
      proved ? "terminal_response" : "none",
      {
        proofObservationId: proved ? proof.observationId : null,
        reasonCode: settled.reasonCode,
        expectedCount: state.walkTotal,
        // THE FLOOR: the oldest payout this page has ever reached.
        oldestCapturedAt: state.floorMs === null ? null : new Date(state.floorMs),
        cursor: { offset: state.walkOffset, pages: state.walkPages },
      },
    );
  };

  // ── THE TWO FIXED STEPS ────────────────────────────────────────────────────
  //
  // They run in order and the index is durable, so a chunk that defers between
  // them resumes at the one it did not reach rather than re-issuing the one it
  // did.
  const fixedStepsDueToday = state.fixedStepsDay !== utcDayKey(now);

  if (fixedStepsDueToday) {
    while (state.fixedStepIndex < 2) {
      if (!input.budget.hasRequestCapacity(1) || !input.budget.hasWallClockCapacity()) {
        break;
      }
      if (!hasDayCapacity()) {
        deferred = "daily_call_budget";
        break;
      }

      if (state.fixedStepIndex === 0) {
        // STEP 1 — the payout-method listing. A FULL array, which is what lets
        // the canonicalizer emit a roster and a removed method be MARKED rather
        // than silently kept alive forever.
        await assertOwnedPageSyncLease(app.db);
        const response = await app.adapter.getPayoutMethods(requestContext);
        const persisted = await persist(OBSERVATION_KINDS.payoutMethods, {}, response.raw);
        state = { ...state, fixedStepIndex: 1 };
        await coverage(
          FANSLY_PAYOUTS_COVERAGE_SCOPES.methods,
          // A full listing served in one call IS the provider's whole surface
          // for that kind — there is no deeper page to reach.
          "provider_exhausted",
          "terminal_response",
          {
            proofObservationId: persisted.observationId ?? null,
            reasonCode: "full_listing",
          },
        );
        await saveProgress();
        continue;
      }

      // STEP 2 — the HEAD page of the request history, `offset=0`.
      const previousTotal = state.walkTotal;
      const previousHeadRefs = state.headRefs;
      const head = await readRequestPage(0);
      const seedsWalk = !state.walkDone && state.walkOffset === 0;
      let stoppedHere = false;
      if (seedsWalk) {
        // FIRST ENABLE. This page is also page one of the walk: record it as
        // taken, so the 83-row history costs nine calls, not ten.
        const short = head.rows.length < PAYOUT_REQUESTS_PAGE_SIZE;
        const reachedTotal = head.total !== null
          && PAYOUT_REQUESTS_PAGE_SIZE >= head.total;
        const walkDone = short || reachedTotal;
        const walkStop = walkDone
          ? payoutWalkStopAt({ offset: 0, rowCount: head.rows.length, total: head.total })
          : null;
        state = {
          ...state,
          lastRequestedOffset: 0,
          // The head page is page one of the walk, so it is also what page two
          // is compared against.
          lastPageFirstRef: firstPayoutRef(head.rows),
          walkPages: state.walkPages + 1,
          walkOffset: PAYOUT_REQUESTS_PAGE_SIZE,
          walkDone,
          walkStop,
        };
        stoppedHere = walkDone;
        if (walkStop === "short_before_total") {
          await reportShortBeforeTotal(0, head.rows.length, head.total);
        }
      } else if (state.walkDone) {
        // THE CATCH-UP. A full head that shares no row with the previous one
        // has pushed payouts below offset 9 that no daily read would reach.
        const catchUp = payoutHeadGap({
          previousHeadRefs,
          previousTotal,
          headRows: head.rows,
          total: head.total,
        });
        if (catchUp !== null) {
          await input.telemetry.addAnomaly({
            code: "fansly_payouts_head_gap",
            severity: "info",
            message:
              "More Fansly payouts landed since the last head read than one page holds; "
              + "the walk re-opened at offset 10 to catch up",
            details: { previousTotal, total: head.total, byRefs: catchUp.stopRefs !== null },
          });
          state = {
            ...state,
            walkDone: false,
            walkOffset: PAYOUT_REQUESTS_PAGE_SIZE,
            lastRequestedOffset: 0,
            lastPageFirstRef: firstPayoutRef(head.rows),
            catchUp,
          };
        }
      }
      state = { ...state, headRefs: payoutRefs(head.rows), fixedStepIndex: 2 };
      if (state.walkDone) {
        await writeSettledCoverage({
          observationId: head.persisted.observationId ?? null,
          stoppedHere,
        });
      } else {
        await coverage(
          FANSLY_PAYOUTS_COVERAGE_SCOPES.requests,
          "in_progress",
          "terminal_response",
          {
            proofObservationId: head.persisted.observationId ?? null,
            reasonCode: state.catchUp === null ? "head_captured" : "catching_up",
            expectedCount: state.walkTotal,
            oldestCapturedAt: state.floorMs === null ? null : new Date(state.floorMs),
            cursor: { offset: state.walkOffset, pages: state.walkPages },
          },
        );
      }
      await saveProgress();
    }

    if (state.fixedStepIndex >= 2) {
      state = { ...state, fixedStepsDay: utcDayKey(now), fixedStepIndex: 0 };
      await saveProgress();
    } else {
      // Out of budget mid-sweep. Whatever was fetched is journaled; the rest
      // resumes at the index above.
      return await finish({ phase: "fixed_steps" });
    }
  }

  // ── THE REQUEST-HISTORY WALK ───────────────────────────────────────────────
  //
  // Offset 10, 20, 30 … until a page comes back short or the offset reaches
  // `total`. It runs on the first enable, and as a CATCH-UP after a head read
  // that found more new payouts than the head holds — until it reaches a row
  // the previous head held.
  let walkPagesThisChunk = 0;

  while (!state.walkDone) {
    if (!input.budget.hasRequestCapacity(1) || !input.budget.hasWallClockCapacity()) {
      break;
    }
    if (walkPagesThisChunk >= REQUEST_WALK_PAGES_PER_CHUNK) {
      break;
    }
    if (!hasDayCapacity()) {
      deferred = "daily_call_budget";
      break;
    }

    // REPEAT-REQUEST GUARD, spent before any egress. The identical offset twice
    // in one walk is a loop, and issuing it teaches nothing.
    if (isRepeatedRequest(state.lastRequestedOffset, state.walkOffset)) {
      await input.telemetry.addAnomaly({
        code: "fansly_payouts_offset_repeat",
        severity: "warn",
        message: "Fansly payout-request pagination did not advance; the walk stopped",
        details: { offset: state.walkOffset, pages: state.walkPages },
      });
      state = {
        ...state,
        walkDone: true,
        walkStop: settleWalkStop(state.walkStop, "repeat_request"),
        catchUp: null,
      };
      await writeSettledCoverage(null);
      await saveProgress();
      break;
    }

    if (state.walkPages >= REQUEST_WALK_MAX_PAGES) {
      await input.telemetry.addAnomaly({
        code: "fansly_payouts_walk_capped",
        severity: "warn",
        message: "Fansly payout-request walk hit its page cap before reaching the floor",
        details: { pages: state.walkPages, total: state.walkTotal },
      });
      state = {
        ...state,
        walkDone: true,
        walkStop: settleWalkStop(state.walkStop, "page_cap"),
        catchUp: null,
      };
      await writeSettledCoverage(null);
      await saveProgress();
      break;
    }

    const requestedOffset = state.walkOffset;
    const page = await readRequestPage(requestedOffset);
    walkPagesThisChunk += 1;

    // THE SECOND TRIGGER, spent on the ANSWER. The page is already journaled —
    // it is evidence about the provider either way — but a page that begins
    // where the last one began is a server ignoring `offset`, and walking it
    // further would spend the day's cap re-reading page one.
    const pageFirstRef = firstPayoutRef(page.rows);
    if (pageFirstRef !== null && pageFirstRef === state.lastPageFirstRef) {
      await input.telemetry.addAnomaly({
        code: "fansly_payouts_offset_repeat",
        severity: "warn",
        message:
          "Fansly served the same payout-request page for a different offset; "
          + "the walk stopped rather than re-reading page one",
        details: { offset: requestedOffset, pages: state.walkPages, firstRef: pageFirstRef },
      });
      state = {
        ...state,
        lastRequestedOffset: requestedOffset,
        walkDone: true,
        walkStop: settleWalkStop(state.walkStop, "repeat_request"),
        catchUp: null,
      };
      await writeSettledCoverage({
        observationId: page.persisted.observationId ?? null,
        stoppedHere: state.walkStop === "repeat_request",
      });
      await saveProgress();
      break;
    }

    const offsetPage = advanceOffsetPage({
      offset: requestedOffset,
      pageSize: PAYOUT_REQUESTS_PAGE_SIZE,
      rowCount: page.rows.length,
    });
    const nextOffset = offsetPage.nextOffset;
    // TWO stop conditions, and the short page is the one that is always true:
    // `total` is a hint the provider may or may not keep honest, while a page
    // that returned fewer rows than it was asked for IS the end.
    const short = offsetPage.done;
    const reachedTotal = page.total !== null && nextOffset >= page.total;
    const reachedEnd = short || reachedTotal;
    const endStop = reachedEnd
      ? payoutWalkStopAt({ offset: requestedOffset, rowCount: page.rows.length, total: page.total })
      : null;
    // A catch-up also ends where it reaches rows the previous head held, and
    // that stop says nothing about the floor: the walk's stop stays as it was.
    const caughtUp = state.catchUp !== null
      && catchUpReached(state.catchUp, page.rows, nextOffset);
    state = {
      ...state,
      lastRequestedOffset: requestedOffset,
      lastPageFirstRef: pageFirstRef,
      walkPages: state.walkPages + 1,
      walkOffset: nextOffset,
      walkDone: reachedEnd || caughtUp,
      walkStop: endStop === null ? state.walkStop : settleWalkStop(state.walkStop, endStop),
      catchUp: reachedEnd || caughtUp ? null : state.catchUp,
    };
    if (endStop === "short_before_total") {
      await reportShortBeforeTotal(requestedOffset, page.rows.length, page.total);
    }

    if (state.walkDone) {
      await writeSettledCoverage({
        observationId: page.persisted.observationId ?? null,
        stoppedHere: endStop !== null && state.walkStop === endStop,
      });
    } else {
      await coverage(
        FANSLY_PAYOUTS_COVERAGE_SCOPES.requests,
        "in_progress",
        "terminal_response",
        {
          proofObservationId: page.persisted.observationId ?? null,
          reasonCode: state.catchUp === null ? "walking" : "catching_up",
          expectedCount: state.walkTotal,
          oldestCapturedAt: state.floorMs === null ? null : new Date(state.floorMs),
          cursor: { offset: state.walkOffset, pages: state.walkPages },
        },
      );
    }
    await saveProgress();
  }

  return await finish({ phase: state.walkDone ? "steady" : "walk" });

  /**
   * The one exit. Every return path reads the projection's counts, because a
   * dispatch that captured nothing new still has to report where the lane
   * stands — a progress block that goes blank when a sweep is deferred reads
   * like the history vanished.
   */
  async function finish(extra: { phase: string }): Promise<StreamChunkResult> {
    const counts = await countPagePayouts(app.db, pageId);

    const stats: Record<string, unknown> = {
      phase: extra.phase,
      journaled,
      callsToday: state.callsToday,
      dailyCap,
      methodCount: counts.methods,
      methodsMissing: counts.methodsMissing,
      payoutCount: counts.requests,
      // The floor, read back from the PROJECTION rather than trusted from the
      // cursor — a walk that journaled a page whose parse has not run yet must
      // not claim the history it has not stored.
      oldestPayoutAt: counts.oldestRequestedAt?.toISOString() ?? null,
      walkOffset: state.walkOffset,
      walkPages: state.walkPages,
      walkTotal: state.walkTotal,
      walkDone: state.walkDone,
      walkStop: state.walkStop,
      ...(deferred === null ? {} : { deferred }),
    };

    if (deferred !== null) {
      await saveProgress();
      return {
        satisfied: false,
        yieldReason: null,
        // Deferred at the cap: come back after the UTC roll.
        continuationRetryAt: nextFanslyUtcDayStart(now),
        stats,
      };
    }
    if (!input.budget.hasRequestCapacity(1) || !input.budget.hasWallClockCapacity()) {
      await saveProgress();
      return {
        satisfied: false,
        yieldReason: input.budget.resolveYieldReason(1),
        // A jittered continuation, because burst shape is the ban-risk surface.
        continuationRetryAt: walkContinuationAt(now, continuationDelayMs),
        stats,
      };
    }
    if (!state.walkDone) {
      // More history is owed and there is budget for it; hand the rest of the
      // day to the walk, spaced.
      await saveProgress();
      return {
        satisfied: false,
        yieldReason: null,
        continuationRetryAt: walkContinuationAt(now, continuationDelayMs),
        stats,
      };
    }
  await completeLane(input.syncRunId);
    return { satisfied: true, yieldReason: null, stats };
  }
}
