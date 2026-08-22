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
// Whether `limit > 10` is honoured on THIS route has never been measured. So
// the walk assumes 10 and carries a REPEAT-REQUEST GUARD instead of a belief:
// the same offset asked twice in one walk is a loop's first visible step (WP-F1
// spent a whole day's cap on that shape in production), and there is nothing to
// learn from issuing it. It stops the walk with one anomaly and never loops.
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
  upsertCaptureCoverage,
  upsertCheckpoint,
  upsertCheckpointProgress,
  type CaptureCoverageProof,
  type CaptureCoverageStatus,
} from "@agency_hub_core/db";
import { PAYOUT_REQUESTS_PAGE_SIZE, PAYOUT_REQUESTS_UNBOUNDED } from "@agency_hub_core/fansly";
import type { HttpRequestEvent, HttpRequestObserver } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { isMappedPayoutStatus } from "../canonicalize/fansly-payouts.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { isPageAllowlisted } from "../voice-notes.ts";
import { composeRequestObservers } from "./chunk-budget.ts";
import type { ExecutorRequestContext, StreamChunkResult } from "./executor-handlers.ts";
import { summarizeCheckpoint } from "./observability.ts";
import { createSyncRateLimitWaiter } from "./rate-limiter.ts";
import {
  FANSLY_PAYOUTS_CAPTURE_MAPPER_VERSION,
  persistRawPayload,
  retentionDate,
} from "./shared.ts";

const STREAM = "payouts" as const;

/** One kind PER ROUTE: two routes, two response shapes. */
const OBSERVATION_KINDS = {
  payoutMethods: "payout_methods",
  payoutRequests: "payout_requests",
} as const;

/** The coverage plane this lane claims, one scope per capture surface — so a
 *  request walk that is still reaching backwards cannot make the method
 *  listing look degraded, or the reverse. */
export const FANSLY_PAYOUTS_COVERAGE_PLANE = "payouts";
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
 * limit: hitting it stops the walk with an anomaly.
 */
const REQUEST_WALK_MAX_PAGES = 400;

const BACKFILL_JITTER_FRACTION = 0.3;

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
  /** Repeat-request guard: the `offset` the previous WALK call carried. */
  lastRequestedOffset: number | null;
  /** Pages the walk has taken across every dispatch. */
  walkPages: number;
  /** `total` as the provider last reported it. */
  walkTotal: number | null;
  /** The oldest `createdAt` the walk has reached, in Unix ms — the FLOOR. */
  floorMs: number | null;
  /** True once a page came back short or the offset reached `total`. */
  walkDone: boolean;
  /** Payout status codes this page has already reported unknown, so the anomaly
   *  fires ONCE per code rather than once per sweep forever. */
  unknownStatusCodes: number[];
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
  return {
    version: 1,
    utcDay,
    callsToday: Math.max(0, asInt(state.callsToday, 0)),
    fixedStepsDay: asNullableString(state.fixedStepsDay),
    fixedStepIndex: Math.max(0, asInt(state.fixedStepIndex, 0)),
    walkOffset: Math.max(0, asInt(state.walkOffset, 0)),
    lastRequestedOffset: asNullableInt(state.lastRequestedOffset),
    walkPages: Math.max(0, asInt(state.walkPages, 0)),
    walkTotal: asNullableInt(state.walkTotal),
    floorMs: asNullableInt(state.floorMs),
    walkDone: state.walkDone === true,
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
    walkPages: 0,
    walkTotal: null,
    floorMs: null,
    walkDone: false,
    unknownStatusCodes: [],
  };
}

export function utcDayKey(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** A new UTC day resets the attempt counter and re-arms the fixed steps.
 *  Nothing else changes: a request walk that deferred mid-history resumes at
 *  exactly the offset it stopped on. */
export function rollUtcDay(
  state: FanslyPayoutsCursorState,
  now: Date,
): FanslyPayoutsCursorState {
  const today = utcDayKey(now);
  return state.utcDay === today ? state : { ...state, utcDay: today, callsToday: 0 };
}

// ── attempt counting ─────────────────────────────────────────────────────────

/** Counts HTTP ATTEMPTS, retries included — the unit the cap is enforced in.
 *  `SyncChunkBudget` counts the same events but is scoped to one chunk; the day
 *  counter has to survive chunks, leases and restarts. */
class AttemptCounter implements HttpRequestObserver {
  private attempts = 0;

  async onRequestEvent(event: HttpRequestEvent) {
    if (event.state === "started") {
      this.attempts += 1;
    }
  }

  take(): number {
    const attempts = this.attempts;
    this.attempts = 0;
    return attempts;
  }
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

/** `total` as the page reported it, or null. It is a HINT for the walk's stop
 *  condition, never the only one: a short page ends the walk on its own. */
export function payoutRequestTotal(payload: unknown): number | null {
  const record = asRecord(payload);
  return record === null ? null : asNullableInt(record.total);
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

/** Backfill continuation spacing: the configured delay ± 30 % jitter, so a deep
 *  walk cannot run contiguously. Burst shape, not daily volume, is the real
 *  ban-risk surface. */
export function walkContinuationAt(
  now: Date,
  delayMs: number,
  random: () => number = Math.random,
): Date {
  const jitter = 1 + (random() * 2 - 1) * BACKFILL_JITTER_FRACTION;
  return new Date(now.getTime() + Math.max(0, Math.round(delayMs * jitter)));
}

function nextUtcDayStart(now: Date): Date {
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    5,
    0,
  ));
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
  if (effective.fanslyPayoutsSyncEnabled !== true) {
    return skip("flag_off");
  }
  // FAIL-CLOSED (S4): empty = NO pages. Deliberately NOT `fanslyNewStreamAllowed`,
  // whose empty CSV means every page — using it here would open a lane that
  // reads payout credentials fleet-wide on the deploy that ships it.
  if (!isPageAllowlisted(effective.fanslyPayoutsPageAllowlist, input.pageContext.page.label)) {
    return skip("not_allowlisted");
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

  const attempts = new AttemptCounter();
  const requestContext = {
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    egressKey: input.pageContext.egressKey,
    requestObserver: composeRequestObservers(
      input.telemetry.getRequestObserver(),
      input.budget,
      attempts,
    ),
    rateLimitWaiter: createSyncRateLimitWaiter(app, input.pageContext),
  };

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
  const persist = async (
    kind: string,
    requestParams: Record<string, unknown>,
    payload: unknown,
  ) => {
    const result = await persistRawPayload(app.db, {
      platformAccountId: pageId,
      syncRunId: input.syncRunId,
      endpoint: kind,
      requestParams,
      responsePayload: payload,
      mapperVersion: FANSLY_PAYOUTS_CAPTURE_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: `inserting Fansly ${kind} raw payload`,
      platform: "fansly",
    });
    journaled += 1;
    // The cap is counted in ATTEMPTS, folded in AFTER the response is safe.
    state = { ...state, callsToday: state.callsToday + attempts.take() };
    return result;
  };

  /** Room for one more call today? Crossing this defers; it never drops. */
  const hasDayCapacity = () => state.callsToday < dailyCap;

  const saveProgress = async () => {
    const advanced = await upsertCheckpointProgress(app.db, {
      platformAccountId: pageId,
      stream: STREAM,
      cursorText: state.fixedStepsDay,
      state: { ...state } as unknown as Record<string, unknown>,
    });
    await input.telemetry.recordCheckpointAdvanced(STREAM, summarizeCheckpoint(advanced));
  };

  const completeSlot = async () => {
    const completed = await upsertCheckpoint(app.db, {
      platformAccountId: pageId,
      stream: STREAM,
      cursorText: state.fixedStepsDay,
      state: { ...state } as unknown as Record<string, unknown>,
      lastSuccessfulRunId: input.syncRunId,
    });
    await input.telemetry.recordCheckpointAdvanced(STREAM, summarizeCheckpoint(completed));
  };

  const coverage = async (
    scopeRef: string,
    status: CaptureCoverageStatus,
    proof: CaptureCoverageProof,
    extra: {
      proofObservationId?: number | null;
      reasonCode?: string | null;
      observedUniqueCount?: number | null;
      expectedCount?: number | null;
      oldestCapturedAt?: Date | null;
      cursor?: Record<string, unknown>;
    } = {},
  ) => {
    await upsertCaptureCoverage(app.db, {
      pageId,
      platform: "fansly",
      plane: FANSLY_PAYOUTS_COVERAGE_PLANE,
      scopeRef,
      status,
      // Both surfaces are re-readable: the method listing is served whole every
      // time, and the request history is offset-paged with no cursor that
      // expires. Nothing here is forward-only.
      acquisitionMode: "retroactive",
      proof,
      newestCapturedAt: now,
      ...extra,
    });
  };

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
      const head = await readRequestPage(0);
      const seedsWalk = !state.walkDone && state.walkOffset === 0;
      if (seedsWalk) {
        // FIRST ENABLE. This page is also page one of the walk: record it as
        // taken, so the 83-row history costs nine calls, not ten.
        const short = head.rows.length < PAYOUT_REQUESTS_PAGE_SIZE;
        const reachedTotal = head.total !== null
          && PAYOUT_REQUESTS_PAGE_SIZE >= head.total;
        state = {
          ...state,
          lastRequestedOffset: 0,
          walkPages: state.walkPages + 1,
          walkOffset: PAYOUT_REQUESTS_PAGE_SIZE,
          walkDone: short || reachedTotal,
        };
      }
      state = { ...state, fixedStepIndex: 2 };
      await coverage(
        FANSLY_PAYOUTS_COVERAGE_SCOPES.requests,
        state.walkDone ? "provider_exhausted" : "in_progress",
        "terminal_response",
        {
          proofObservationId: head.persisted.observationId ?? null,
          reasonCode: state.walkDone ? "walk_exhausted" : "head_captured",
          expectedCount: state.walkTotal,
          oldestCapturedAt: state.floorMs === null ? null : new Date(state.floorMs),
          cursor: { offset: state.walkOffset, pages: state.walkPages },
        },
      );
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
  // `total`. It only runs on the first enable (and after a `total` that grows
  // past what the walk reached, which cannot happen backwards — new payouts
  // land at the HEAD, which the daily sweep already reads).
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
    if (state.lastRequestedOffset === state.walkOffset) {
      await input.telemetry.addAnomaly({
        code: "fansly_payouts_offset_repeat",
        severity: "warn",
        message: "Fansly payout-request pagination did not advance; the walk stopped",
        details: { offset: state.walkOffset, pages: state.walkPages },
      });
      state = { ...state, walkDone: true };
      await coverage(
        FANSLY_PAYOUTS_COVERAGE_SCOPES.requests,
        "partial_provider_surface",
        "none",
        {
          reasonCode: "repeat_request",
          expectedCount: state.walkTotal,
          oldestCapturedAt: state.floorMs === null ? null : new Date(state.floorMs),
          cursor: { offset: state.walkOffset, pages: state.walkPages },
        },
      );
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
      state = { ...state, walkDone: true };
      await coverage(
        FANSLY_PAYOUTS_COVERAGE_SCOPES.requests,
        "partial_provider_surface",
        "none",
        {
          reasonCode: "page_cap",
          expectedCount: state.walkTotal,
          oldestCapturedAt: state.floorMs === null ? null : new Date(state.floorMs),
          cursor: { offset: state.walkOffset, pages: state.walkPages },
        },
      );
      await saveProgress();
      break;
    }

    const requestedOffset = state.walkOffset;
    const page = await readRequestPage(requestedOffset);
    walkPagesThisChunk += 1;
    const nextOffset = requestedOffset + PAYOUT_REQUESTS_PAGE_SIZE;
    // TWO stop conditions, and the short page is the one that is always true:
    // `total` is a hint the provider may or may not keep honest, while a page
    // that returned fewer rows than it was asked for IS the end.
    const short = page.rows.length < PAYOUT_REQUESTS_PAGE_SIZE;
    const reachedTotal = page.total !== null && nextOffset >= page.total;
    state = {
      ...state,
      lastRequestedOffset: requestedOffset,
      walkPages: state.walkPages + 1,
      walkOffset: nextOffset,
      walkDone: short || reachedTotal,
    };

    await coverage(
      FANSLY_PAYOUTS_COVERAGE_SCOPES.requests,
      state.walkDone ? "provider_exhausted" : "in_progress",
      "terminal_response",
      {
        proofObservationId: page.persisted.observationId ?? null,
        reasonCode: state.walkDone ? "walk_exhausted" : "walking",
        expectedCount: state.walkTotal,
        observedUniqueCount: state.walkDone ? state.walkPages : null,
        // THE FLOOR: the oldest payout this page has ever reached, proved by
        // the response journaled above.
        oldestCapturedAt: state.floorMs === null ? null : new Date(state.floorMs),
        cursor: { offset: state.walkOffset, pages: state.walkPages },
      },
    );
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
      ...(deferred === null ? {} : { deferred }),
    };

    if (deferred !== null) {
      await saveProgress();
      return {
        satisfied: false,
        yieldReason: null,
        // Deferred at the cap: come back after the UTC roll.
        continuationRetryAt: nextUtcDayStart(now),
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
    await completeSlot();
    return { satisfied: true, yieldReason: null, stats };
  }
}
