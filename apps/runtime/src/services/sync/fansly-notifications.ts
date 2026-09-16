// WP-F2 — the `notifications` capture handler.
//
// THE ONLY PERMANENTLY-LOSSY LANE IN THE SYSTEM, and every decision below is
// downstream of that. Fansly announces a liker, a reply, a quote or a purchase
// ONCE, in this stream, and never serves it again from any other route. A
// statistics window we miss today can be re-asked for tomorrow; a notification
// we miss is gone. So this lane is `live` class at 1 800 s (48 polls/day), it
// polls the HEAD before it does anything else, and it never trades a head poll
// for backfill progress.
//
// TWO PHASES, one cursor:
//
//   FORWARD POLL — page from the head (`before=0`) down until the page overlaps
//   the last id we saw. Usually ONE call: the observed rate is ~15
//   notifications/day against 50 rows a page.
//
//   DEEP BACKFILL (one-off, first enable) — page backwards from the head to the
//   retention floor, journaling every page INCLUDING the empty one, because an
//   empty page IS the floor evidence. The 2026-08-19 capture reached 13.65 days
//   in four pages and stopped there because the WALK stopped, not because the
//   platform did — the real depth is what this measures.
//
// THE CURSOR IS A NOTIFICATION ID, NOT A TIMESTAMP. `before=945239851786067977`
// is "the page older than that row". Reading it as an epoch would ask for
// notifications from 1970, get an empty page, and record a retention floor that
// does not exist.
//
// THE TYPE-FILTER FORK (A1 + A22). The first call of every poll goes with NO
// `type` param, because a filtered call can only return codes we already knew
// to ask for and the UNKNOWN codes are half the reason this lane exists. If the
// unfiltered form is refused (4xx) or is visibly filtering (empty where the CSV
// form returns rows), the lane falls back to the client's FULL declared CSV —
// eighteen codes — and then, if even that is refused, to one filter group per
// call. It never falls back to the eight-code CSV the walked UI happened to
// send: that list silently excludes 32007 (Locked Text Purchases) and 45012
// (Stream Ticket Purchases), BOTH of which are money, on exactly the degraded
// path where a silent gap is least affordable. The mode is durable in the
// cursor and the degradation is a `partial_provider_surface` coverage row.
//
// THE [A20] HAZARD, and it is not theoretical here: the response carries an
// `accounts[]` sidecar of FULL account records — `lastSeenAt`, follower and
// subscriber counters, like counters, `timelineStats`. `lastSeenAt` changes
// every minute. Journaling it verbatim would make every body unique and destroy
// the ~9:1 content-address dedup collapse the disk budget rests on. So
// `accounts[]` — and ONLY `accounts[]` — goes through the 18-field allowlist
// before journaling; every other key of the response is stored verbatim.
//
// THE BUDGET RULE, same as WP-F1's and for the same reason: the per-lane daily
// cap is counted in HTTP ATTEMPTS (retries included — a cap counted in logical
// calls would let a retry storm multiply real egress by up to 4), it lives in
// the cursor so it survives leases and restarts, and crossing it DEFERS THE
// LANE TO THE NEXT UTC DAY. It never drops: a response already fetched is
// journaled before the cap is consulted again.
//
// …AND THE HEAD'S SHARE OF IT IS RESERVED. Both phases spend the same daily
// allowance, so a backfill that walks at chunk speed used to drink the day on
// its first dispatch and leave the head one poll per UTC day — observed on
// production with four of six pages parked in `backfill` since ~00:15 UTC.
// The backfill now stops when ITS OWN spend (`backfillCallsToday`) reaches
// `backfillAttemptCeiling(dailyCap)` and comes back when the head is next due;
// the forward poll keeps the full allowance. Its own counter because the head
// always spends first: bounding the lane-wide counter would hand the head the
// backfill's share and park the walk for good.
//
// THE REPEAT-REQUEST GUARD is WP-F1's lesson, paid for on production on
// 2026-08-22: a walk that re-issues the identical request spends a whole day's
// cap proving nothing. The identical `before` twice in one walk stops the walk
// and writes a terminal coverage row instead.

import {
  assertOwnedPageSyncLease,
  getCheckpoint,
  type CaptureCoverageStatus,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import {
  CAPTURE_COVERAGE_PLANES,
  FANSLY_NOTIFICATION_DECLARED_TYPE_CODES,
  FANSLY_NOTIFICATION_TYPE_GROUPS,
} from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { composeRequestObservers } from "./chunk-budget.ts";
import type { ExecutorRequestContext, StreamChunkResult } from "./executor-handlers.ts";
import {
  classifyFanslyResponse,
  createFanslyLaneCoverageWriter,
  createFanslyLaneJournal,
  createFanslyLaneRuntime,
  fanslyUtcDayKey,
  FanslyLaneInvalidResponseError,
  nextFanslyUtcDayStart,
  rollFanslyUtcDay,
  spreadFanslyContinuation,
} from "./fansly-lane.ts";
import { isPageAllowlisted } from "./fansly-stream-gate.ts";
import { summarizeCheckpoint } from "./observability.ts";
import { createSyncRateLimitWaiter } from "./rate-limiter.ts";
import {
  FANSLY_NOTIFICATIONS_CAPTURE_MAPPER_VERSION,
  retentionDate,
  trimFanslyNotificationsPayload,
} from "./shared.ts";

const STREAM = "notifications" as const;
const OBSERVATION_KIND = "notifications" as const;

/** The head of the list. The UI's own first call sends exactly this. */
const HEAD_CURSOR = "0";

/** The stream's cadence, and therefore how often the head MUST be polled. Used
 *  only to interrupt a long backfill: a multi-day backfill that skipped head
 *  polls would lose exactly the facts this lane exists to keep. */
const FORWARD_POLL_INTERVAL_MS = 1_800_000;

/**
 * Pages the FORWARD walk may take before it gives up on reaching overlap.
 *
 * At 50 rows a page and ~15 notifications/day this is ~33 days of silence — far
 * past any plausible outage. Reaching it means something is wrong with the
 * cursor, not that the page is popular, so the walk stops with an anomaly
 * rather than paging until the daily cap is gone.
 */
const FORWARD_MAX_PAGES_PER_POLL = 20;

/** Backfill calls in one dispatch before a jittered continuation. The chunk
 *  budget (5 requests / 45 s) bites long before this on a healthy lane; this is
 *  the ceiling for a lane that is being re-queued aggressively. */
const BACKFILL_CALLS_PER_CHUNK = 30;

/** Scheduled head polls in one UTC day at this lane's cadence — the 48 polls
 *  Decision #226 budgets the daily cap around. */
const FORWARD_POLLS_PER_UTC_DAY = Math.floor(86_400_000 / FORWARD_POLL_INTERVAL_MS);

/**
 * Attempts the one-off deep backfill MUST leave for the forward head poll.
 *
 * Both phases spend one UTC-day allowance (`dailyCap - callsToday`), so the
 * backfill — which walks as fast as the chunk budget lets it — used to drink
 * the whole day on its first dispatch and leave the head ONE poll per day.
 * That contradicts Decision #226's own budget ("48 head polls plus
 * pagination") in the lane where a missed poll is a PERMANENT loss: the
 * provider announces a liker, a reply or a purchase once.
 *
 * 48 polls at one attempt each, plus a quarter as headroom for the polls that
 * page or retry (an attempt, not a call, is what the cap counts). The forward
 * poll itself is never bounded by this — it keeps the full allowance,
 * including whatever the backfill did not spend.
 */
export const FORWARD_HEAD_RESERVED_ATTEMPTS = Math.ceil(FORWARD_POLLS_PER_UTC_DAY * 1.25);

/**
 * How many attempts the backfill may spend ON ITS OWN ACCOUNT in one UTC day
 * before it yields the rest to the head — measured against
 * `backfillCallsToday`, never against the lane-wide counter the head also
 * spends from. Never below 1: `fanslyNotificationsDailyCallBudget` is
 * live-editable (min 1), and a cap dialled down during a ban scare must slow
 * the one-off walk down, not end historical capture in silence.
 */
export function backfillAttemptCeiling(dailyCap: number): number {
  return Math.max(1, dailyCap - FORWARD_HEAD_RESERVED_ATTEMPTS);
}


// ── cursor state ─────────────────────────────────────────────────────────────

/** Which `type` form the lane is issuing. Durable, because a provider that
 *  refuses the unfiltered form refuses it on every chunk. */
export type FanslyNotificationsFilterMode = "unfiltered" | "declared_csv" | "type_groups";

interface ForwardWalkState {
  /** `before` for the next forward call; null = start at the head. */
  beforeRef: string | null;
  /** The newest id of THIS poll's first page. Committed to
   *  `newestSeenNotificationId` only when the walk reaches overlap or runs out
   *  — an early commit would skip whatever sits between here and the overlap. */
  pendingHeadRef: string | null;
  /** Repeat-request guard: the `before` the previous forward call carried. */
  lastRequestedBefore: string | null;
  pages: number;
}

interface BackfillWalkState {
  /** `before` for the next backfill call. Starts at the head. */
  nextBeforeRef: string;
  /** Repeat-request guard. Same `before` twice ⇒ the walk is looping. */
  lastRequestedBefore: string | null;
  /** ISO instant of the OLDEST notification the provider ever served —
   *  `notificationFloorAt`. */
  floorAt: string | null;
  /** The observation that journaled this walk's last response, so a terminal
   *  coverage row points at the bytes that prove it. */
  lastObservationId: number | null;
  done: boolean;
}

export interface FanslyNotificationsCursorState {
  version: 1;
  /** Which phase the NEXT dispatch resumes in. */
  phase: "forward" | "backfill";
  /** The UTC day `callsToday` belongs to; a different day resets the counter. */
  utcDay: string;
  /** HTTP ATTEMPTS spent by this lane on `utcDay`. Retries included. */
  callsToday: number;
  /**
   * The BACKFILL'S OWN share of `callsToday`, same UTC day, retries included.
   *
   * Its own counter because the head always spends first (the cursor starts in
   * `forward`, and a due head poll interrupts a running backfill), so measuring
   * the backfill's ceiling against the lane-wide counter let the head consume
   * the backfill's whole allowance: at any cap ≤ 61 the walk got zero calls per
   * day, forever, with no anomaly. The reserve is about the HEAD's share, so
   * the thing it bounds has to be the BACKFILL's spend.
   */
  backfillCallsToday: number;
  /** The overlap stop for the forward poll. */
  newestSeenNotificationId: string | null;
  /** ISO instant of the last completed forward poll. */
  lastForwardPollAt: string | null;
  filterMode: FanslyNotificationsFilterMode;
  /** Next group to issue while `filterMode === "type_groups"`. */
  typeGroupIndex: number;
  /** The one-time "is the unfiltered form actually serving rows?" probe. */
  unfilteredProbeSpent: boolean;
  /**
   * Consecutive type-form REFUSALS, durable across chunks.
   *
   * It has to survive a chunk boundary for the same reason WP-F1's window
   * guard does: the loop that burned a day's cap on production spanned five
   * chunks, so a counter that lived inside one chunk would have watched it
   * happen five times and said nothing. Reset to 0 by any served call.
   */
  filterRefusals: number;
  /** The `post_likes` negative-coverage row has been written for this page. It
   *  is a standing claim, not a per-chunk one. */
  postLikesCoverageWritten: boolean;
  forward: ForwardWalkState;
  /** null once the one-off deep backfill has finished. */
  backfill: BackfillWalkState | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseFilterMode(value: unknown): FanslyNotificationsFilterMode {
  return value === "declared_csv" || value === "type_groups" ? value : "unfiltered";
}

function parseForwardWalk(value: unknown): ForwardWalkState {
  const record = asRecord(value);
  return {
    beforeRef: asNullableString(record?.beforeRef),
    pendingHeadRef: asNullableString(record?.pendingHeadRef),
    lastRequestedBefore: asNullableString(record?.lastRequestedBefore),
    pages: Math.max(0, asInt(record?.pages, 0)),
  };
}

function parseBackfillWalk(value: unknown): BackfillWalkState | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  return {
    nextBeforeRef: asNullableString(record.nextBeforeRef) ?? HEAD_CURSOR,
    lastRequestedBefore: asNullableString(record.lastRequestedBefore),
    floorAt: asNullableString(record.floorAt),
    lastObservationId: typeof record.lastObservationId === "number"
        && Number.isSafeInteger(record.lastObservationId)
      ? record.lastObservationId
      : null,
    done: record.done === true,
  };
}

export function parseFanslyNotificationsCursorState(
  value: unknown,
): FanslyNotificationsCursorState | null {
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
    phase: state.phase === "backfill" ? "backfill" : "forward",
    utcDay,
    callsToday: Math.max(0, asInt(state.callsToday, 0)),
    // A cursor written before this field existed reads as "the backfill has
    // spent nothing today", which is the safe default: the UTC day it belongs
    // to is the one being resumed and the lane-wide cap still bounds it.
    backfillCallsToday: Math.max(0, asInt(state.backfillCallsToday, 0)),
    newestSeenNotificationId: asNullableString(state.newestSeenNotificationId),
    lastForwardPollAt: asNullableString(state.lastForwardPollAt),
    filterMode: parseFilterMode(state.filterMode),
    typeGroupIndex: Math.max(0, asInt(state.typeGroupIndex, 0)),
    unfilteredProbeSpent: state.unfilteredProbeSpent === true,
    filterRefusals: Math.max(0, asInt(state.filterRefusals, 0)),
    postLikesCoverageWritten: state.postLikesCoverageWritten === true,
    forward: parseForwardWalk(state.forward),
    backfill: Object.hasOwn(state, "backfill") && state.backfill === null
      ? null
      : parseBackfillWalk(state.backfill) ?? emptyBackfillWalk(),
  };
}

function emptyForwardWalk(): ForwardWalkState {
  return { beforeRef: null, pendingHeadRef: null, lastRequestedBefore: null, pages: 0 };
}

function emptyBackfillWalk(): BackfillWalkState {
  return {
    nextBeforeRef: HEAD_CURSOR,
    lastRequestedBefore: null,
    floorAt: null,
    lastObservationId: null,
    done: false,
  };
}

export function emptyFanslyNotificationsCursorState(now: Date): FanslyNotificationsCursorState {
  return {
    version: 1,
    // FIRST ENABLE polls the head first — the deep backfill is history, and
    // history keeps. What does not keep is the notification that arrives while
    // we are busy walking backwards.
    phase: "forward",
    utcDay: utcDayKey(now),
    callsToday: 0,
    backfillCallsToday: 0,
    newestSeenNotificationId: null,
    lastForwardPollAt: null,
    filterMode: "unfiltered",
    typeGroupIndex: 0,
    unfilteredProbeSpent: false,
    filterRefusals: 0,
    postLikesCoverageWritten: false,
    forward: emptyForwardWalk(),
    backfill: emptyBackfillWalk(),
  };
}

export const utcDayKey = fanslyUtcDayKey;

/** A new UTC day resets the attempt counter. Nothing else about the cursor
 *  changes: a walk that deferred mid-page resumes at exactly that page. */
export const rollUtcDay = rollFanslyUtcDay;

/** The shared roll owns the lane-wide counter; the backfill's share belongs to
 *  the same UTC day, so it rolls with it. `rollUtcDay` returns the SAME object
 *  when the day has not changed, which is the test used here. */
export function rollNotificationsUtcDay(
  state: FanslyNotificationsCursorState,
  now: Date,
): FanslyNotificationsCursorState {
  const rolled = rollUtcDay(state, now);
  return rolled === state ? rolled : { ...rolled, backfillCallsToday: 0 };
}

// ── shape helpers over the journaled bodies ──────────────────────────────────

/** The notification rows of a response, or `[]`. The rest of the envelope
 *  (tips, accountMedia, subscriptions, …) is journaled and parsed elsewhere. */
export function notificationRows(payload: unknown): Record<string, unknown>[] {
  const record = asRecord(payload);
  if (record === null) {
    return [];
  }
  return Array.isArray(record.notifications)
    ? record.notifications.filter((row): row is Record<string, unknown> => asRecord(row) !== null)
    : [];
}

export function classifyNotificationResponse(payload: unknown) {
  return classifyFanslyResponse(payload, {
    isValid: (value) => {
      const record = asRecord(value);
      return record !== null && Array.isArray(record.notifications);
    },
    isEmpty: (value) => notificationRows(value).length === 0,
  });
}

/**
 * Snowflake ids sort lexicographically WITHIN one length, so compare length
 * first. Returns < 0 when `left` is older.
 *
 * This is the same comparison WP-F1 uses for the broadcast walk, extracted
 * because the forward poll's overlap test and the backfill's cursor both need
 * it and a second, subtly different copy is how a walk starts skipping pages.
 */
export function compareNotificationRefs(left: string, right: string): number {
  if (left.length !== right.length) {
    return left.length - right.length;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function pageRefBounds(
  rows: readonly Record<string, unknown>[],
): { newest: string | null; oldest: string | null } {
  let newest: string | null = null;
  let oldest: string | null = null;
  for (const row of rows) {
    const id = asNullableString(row.id) ?? asNullableString(row.idString);
    if (id === null) {
      continue;
    }
    if (newest === null || compareNotificationRefs(id, newest) > 0) {
      newest = id;
    }
    if (oldest === null || compareNotificationRefs(id, oldest) < 0) {
      oldest = id;
    }
  }
  return { newest, oldest };
}

/** The oldest `createdAt` on the page, as an ISO instant. Fansly serves
 *  notification timestamps in SECONDS. */
export function oldestCreatedAtIso(rows: readonly Record<string, unknown>[]): string | null {
  let oldest: number | null = null;
  for (const row of rows) {
    const created = row.createdAt;
    if (typeof created !== "number" || !Number.isFinite(created) || created <= 0) {
      continue;
    }
    oldest = oldest === null || created < oldest ? created : oldest;
  }
  return oldest === null ? null : new Date(oldest * 1000).toISOString();
}

/** True when the page carries a row at or older than the overlap stop. */
export function pageReachesOverlap(
  rows: readonly Record<string, unknown>[],
  newestSeen: string,
): boolean {
  for (const row of rows) {
    const id = asNullableString(row.id) ?? asNullableString(row.idString);
    if (id !== null && compareNotificationRefs(id, newestSeen) <= 0) {
      return true;
    }
  }
  return false;
}

/** The `types` argument for a filter mode. `null` is the unfiltered form. */
export function typesForFilterMode(
  mode: FanslyNotificationsFilterMode,
  groupIndex: number,
): readonly number[] | null {
  if (mode === "unfiltered") {
    return null;
  }
  if (mode === "declared_csv") {
    return FANSLY_NOTIFICATION_DECLARED_TYPE_CODES;
  }
  const group = FANSLY_NOTIFICATION_TYPE_GROUPS[
    groupIndex % FANSLY_NOTIFICATION_TYPE_GROUPS.length
  ];
  return group ?? FANSLY_NOTIFICATION_DECLARED_TYPE_CODES;
}

/** 401/403 is a dead session, not a filter problem: it must never trigger the
 *  type fork, and it must reach the executor's auth-pause path unchanged. */
function isAuthFailure(error: unknown): boolean {
  return error instanceof FanslyApiError && (error.status === 401 || error.status === 403);
}

/**
 * A 429 is the PROVIDER'S PACE, not a statement about the `type` form, and it
 * belongs to the executor: `classifyTaskFailure` maps FanslyApiError(429) to
 * the `rate_limit` retry class and takes its wake-up instant from the error's
 * own `retryAfterAt`. A terminal 429 reaches here whenever the adapter's
 * Retry-After exceeds the 60 s in-process clamp (Decision #275), so reading it
 * as a refusal discarded the deadline AND narrowed the lane one durable step
 * per occurrence — unfiltered → declared_csv → one type group per call — with
 * no path back.
 *
 * Only 429 is excluded: it is the single transient 4xx on the executor's retry
 * path. 408/425 are NOT classified there (they fall into `provider_bad_data`
 * like any other 4xx), and 404 has its own bounded provider_404 ladder, so
 * neither is carved out here.
 */
function isClientRefusal(error: unknown): boolean {
  return error instanceof FanslyApiError
    && typeof error.status === "number"
    && error.status >= 400
    && error.status < 500
    && error.status !== 401
    && error.status !== 403
    && error.status !== 429;
}

// ── the handler ──────────────────────────────────────────────────────────────

function skip(reason: string): StreamChunkResult {
  return { satisfied: true, yieldReason: null, stats: { skipped: reason }, gatedSkip: reason };
}

/** Backfill continuation spacing: the configured delay ± 30 % jitter, so a deep
 *  walk cannot run contiguously at ~23 requests/minute. Burst shape, not daily
 *  volume, is the real ban-risk surface. */
export function backfillContinuationAt(
  now: Date,
  delayMs: number,
  random: () => number = Math.random,
): Date {
  return spreadFanslyContinuation(now, delayMs, random);
}

/** Is a head poll due? Used ONLY to interrupt a running backfill — a lane that
 *  spent three days walking history without polling the head would lose exactly
 *  the facts nothing else can recover. */
export function forwardPollDue(
  state: FanslyNotificationsCursorState,
  now: Date,
): boolean {
  if (state.lastForwardPollAt === null) {
    return true;
  }
  const last = Date.parse(state.lastForwardPollAt);
  return !Number.isFinite(last) || now.getTime() - last >= FORWARD_POLL_INTERVAL_MS;
}

/** When the head is next due. A backfill that stops on the head reserve comes
 *  back THEN — not after the UTC roll, which is what parked the whole lane in
 *  `backfill` for the rest of the day. */
export function nextForwardPollAt(
  state: Pick<FanslyNotificationsCursorState, "lastForwardPollAt">,
  now: Date,
): Date {
  const last = state.lastForwardPollAt === null ? Number.NaN : Date.parse(state.lastForwardPollAt);
  const due = Number.isFinite(last) ? last + FORWARD_POLL_INTERVAL_MS : now.getTime();
  return new Date(Math.max(due, now.getTime()));
}

export async function fanslyNotificationsChunk(
  app: AppContext,
  input: ExecutorRequestContext & { syncRunId: number; now?: Date },
): Promise<StreamChunkResult> {
  if (input.pageContext.platform !== "fansly") {
    return skip("not_fansly");
  }
  await input.telemetry.recordPhaseStarted(STREAM);

  const effective = await loadEffectiveConfig(app.db, app.config);
  if (effective.fanslyNotificationsSyncEnabled !== true) {
    return skip("flag_off");
  }
  // FAIL-CLOSED (S4): empty = NO pages. Deliberately NOT `fanslyNewStreamAllowed`,
  // whose empty CSV means every page — using it here would open the lane
  // fleet-wide on the deploy that ships it.
  if (!isPageAllowlisted(effective.fanslyNotificationsPageAllowlist, input.pageContext.page.label)) {
    return skip("not_allowlisted");
  }

  const now = input.now ?? new Date();
  const pageId = input.pageContext.page.id;
  const dailyCap = Math.max(1, effective.fanslyNotificationsDailyCallBudget ?? 96);
  const continuationDelayMs = Math.max(0, effective.fanslyBackfillContinuationDelayMs ?? 20_000);

  const checkpoint = await getCheckpoint(app.db, pageId, STREAM);
  await input.telemetry.recordCheckpointLoaded(STREAM, summarizeCheckpoint(checkpoint));
  let state = rollNotificationsUtcDay(
    parseFanslyNotificationsCursorState(checkpoint?.state)
      ?? emptyFanslyNotificationsCursorState(now),
    now,
  );

  const lane = createFanslyLaneRuntime({
    db: app.db,
    pageId,
    stream: STREAM,
    cursorText: () => state.newestSeenNotificationId,
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
  });
  const { attemptBudget, complete: completeLane, requestContext, saveProgress } = lane;

  let journaled = 0;
  /** Pages this dispatch actually got a body for. Gates the type-group
   *  rotation below: a walk that only collected refusals has already had its
   *  index moved by the refusal branch. */
  let served = 0;
  let deferred: string | null = null;
  /**
   * The type fork's TERMINAL. Widening is finite: unfiltered → the declared CSV
   * → one filter group per call → give up. Without this a provider that refuses
   * every form would have the lane widen, retry, refuse, widen … until the
   * day's cap was gone — the exact failure WP-F1 shipped and had to hot-fix,
   * in a different costume.
   */
  const filterRefusalLimit = FANSLY_NOTIFICATION_TYPE_GROUPS.length + 2;
  let filterExhausted = state.filterRefusals >= filterRefusalLimit;

  /**
   * Journal FIRST, always, and TRIM ONLY `accounts[]`.
   *
   * The [A20] allowlist runs here rather than in the adapter for the same
   * reason the follower and conversation lanes put it here: the adapter is a
   * transport and must hand the whole body through, and the ONE place that
   * decides what reaches the journal should be the one place a test can pin.
   */
  const journal = createFanslyLaneJournal({
    db: app.db,
    pageId,
    syncRunId: input.syncRunId,
    mapperVersion: FANSLY_NOTIFICATIONS_CAPTURE_MAPPER_VERSION,
    payloadKind: "mapping_critical",
    retainUntil: retentionDate(),
    onJournal: () => { journaled += 1; },
  });
  const persist = (requestParams: Record<string, unknown>, payload: unknown) =>
    journal(OBSERVATION_KIND, requestParams, trimFanslyNotificationsPayload(payload));

  /** Room for one more call today? Crossing this defers; it never drops. */
  const hasDayCapacity = attemptBudget.hasCapacity;

  /**
   * ONE WALK, ONE FILTER FORM — so this runs at a walk boundary, never between
   * two pages of the same walk. Rotating inside `fetchPage` would have sent
   * page N+1 through a different `type` filter than the `before` cursor it
   * inherited from page N: rows outside the new group are skipped and the
   * committed head ref jumps between groups.
   *
   * It still has to rotate SOMEWHERE: the index used to move only on a
   * refusal, so a lane that reached `type_groups` polled whichever group it
   * landed on forever and never asked for the others again — the purchase
   * codes 32007/45012 among them. Everything captured through a narrowed form
   * is already claimed `partial_provider_surface`, so rotating widens what is
   * asked for without making any coverage claim stronger.
   */
  const rotateTypeGroupAtWalkBoundary = () => {
    if (served === 0 || state.filterMode !== "type_groups") {
      return;
    }
    state = {
      ...state,
      typeGroupIndex: (state.typeGroupIndex + 1) % FANSLY_NOTIFICATION_TYPE_GROUPS.length,
    };
  };


  /**
   * A poll made through a NARROWED type form captured part of the provider's
   * surface, not all of it — so it must not claim `window_captured` or a clean
   * `in_progress`. Without this the degradation claim would be overwritten by
   * the very next successful call and the coverage row would read as if
   * nothing were wrong.
   */
  const archiveStatus = (fresh: CaptureCoverageStatus): CaptureCoverageStatus =>
    state.filterMode === "unfiltered" ? fresh : "partial_provider_surface";

  const coverage = createFanslyLaneCoverageWriter({
    db: app.db,
    pageId,
    scopeRef: "",
    acquisitionMode: "retroactive",
  });

  /**
   * One journaled call, with the type fork attached.
   *
   * Returns the page's payload, or null when the provider refused every form
   * this lane knows how to ask in. The response is journaled before anything
   * looks at it; the fork only decides how the NEXT call is shaped.
   */
  const fetchPage = async (
    before: string,
    context: "forward" | "backfill",
  ): Promise<{ payload: unknown; observationId: number | null } | null> => {
    await assertOwnedPageSyncLease(app.db);
    const types = typesForFilterMode(state.filterMode, state.typeGroupIndex);
    try {
      const response = await app.adapter.getNotificationsPage(requestContext, {
        before,
        after: HEAD_CURSOR,
        types,
      });
      const persisted = await persist({
        context,
        before,
        after: HEAD_CURSOR,
        filterMode: state.filterMode,
        types: types === null ? null : [...types],
      }, response.raw);
      if (classifyNotificationResponse(response.raw) === "invalid") {
        throw new FanslyLaneInvalidResponseError(OBSERVATION_KIND);
      }
      served += 1;
      if (state.filterRefusals !== 0) {
        state = { ...state, filterRefusals: 0 };
      }
      return { payload: response.raw, observationId: persisted.observationId ?? null };
    } catch (error) {
      if (isAuthFailure(error) || !isClientRefusal(error)) {
        // A dead session and a 5xx both belong to the executor, unchanged.
        throw error;
      }
      // The unfiltered form was REFUSED. Widen to the client's full declared
      // CSV — never the eight-code UI list, which drops two money codes.
      const refusals = state.filterRefusals + 1;
      const nextMode: FanslyNotificationsFilterMode = state.filterMode === "unfiltered"
        ? "declared_csv"
        : "type_groups";
      // Already iterating groups: try the NEXT group rather than the same one.
      const nextGroupIndex = state.filterMode === "type_groups"
        ? (state.typeGroupIndex + 1) % FANSLY_NOTIFICATION_TYPE_GROUPS.length
        : state.typeGroupIndex;
      filterExhausted = refusals >= filterRefusalLimit;
      await input.telemetry.addAnomaly({
        code: "fansly_notifications_type_filter_refused",
        severity: "warn",
        message:
          "Fansly refused the notification type form; falling back to a narrower one",
        details: {
          from: state.filterMode,
          to: nextMode,
          groupIndex: nextGroupIndex,
          exhausted: filterExhausted,
          status: error instanceof FanslyApiError ? error.status ?? null : null,
          before,
        },
      });
      state = {
        ...state,
        filterMode: nextMode,
        typeGroupIndex: nextGroupIndex,
        filterRefusals: refusals,
      };
      await coverage(
        CAPTURE_COVERAGE_PLANES.notifications,
        // Bounded by the PROVIDER's behaviour: the wide form is not served, so
        // whatever the narrow one omits is a gap we can name.
        "partial_provider_surface",
        "none",
        {
          newestCapturedAt: now,
          reasonCode: "type_filter_refused",
          cursor: { filterMode: nextMode, before },
        },
      );
      await saveProgress();
      return null;
    }
  };

  /**
   * THE ONE-TIME "is the unfiltered form actually serving?" PROBE.
   *
   * An empty unfiltered page is ambiguous: either nothing happened, or the
   * provider is quietly filtering the unfiltered form to nothing. One call with
   * the declared CSV at the SAME cursor tells the two apart, and it is spent
   * once per page — after that the answer is durable in the cursor.
   */
  const probeUnfilteredForm = async (before: string): Promise<void> => {
    if (state.unfilteredProbeSpent || state.filterMode !== "unfiltered" || !hasDayCapacity()) {
      return;
    }
    state = { ...state, unfilteredProbeSpent: true };
    await assertOwnedPageSyncLease(app.db);
    const types = FANSLY_NOTIFICATION_DECLARED_TYPE_CODES;
    const response = await app.adapter.getNotificationsPage(requestContext, {
      before,
      after: HEAD_CURSOR,
      types,
    });
    await persist({
      context: "filter_probe",
      before,
      after: HEAD_CURSOR,
      filterMode: "declared_csv",
      types: [...types],
    }, response.raw);
    if (notificationRows(response.raw).length === 0) {
      // Both forms agree the page is empty. The unfiltered form stands.
      return;
    }
    // The CSV form serves rows where the unfiltered form served none: the
    // unfiltered call is being filtered, and A1's "capture unknown types" is
    // not available on this provider. Say so out loud.
    state = { ...state, filterMode: "declared_csv" };
    await input.telemetry.addAnomaly({
      code: "fansly_notifications_unfiltered_form_empty",
      severity: "warn",
      message:
        "Fansly served rows for the declared type CSV but none unfiltered; "
        + "switching to the declared CSV and losing the unknown-code surface",
      details: { before },
    });
    await coverage(
      CAPTURE_COVERAGE_PLANES.notifications,
      "partial_provider_surface",
      "none",
      {
        newestCapturedAt: now,
        reasonCode: "unfiltered_form_filtered",
        cursor: { filterMode: "declared_csv", before },
      },
    );
  };

  // The liker plane's coverage row: written once, and it is a NEGATIVE claim
  // this lane owes the serving layer. `not_started` + `forward_only` reads as
  // "nothing is here, nothing retroactively can be" — which is the truth until
  // a like code is live-confirmed ([E4]).
  if (!state.postLikesCoverageWritten) {
    await coverage(
      CAPTURE_COVERAGE_PLANES.postLikes,
      "not_started",
      "none",
      {
        acquisitionMode: "forward_only",
        reasonCode: "no_like_code_confirmed",
        cursor: { note: "E4: no Fansly like code is live-confirmed; post_likes stays empty" },
      },
    );
    state = { ...state, postLikesCoverageWritten: true };
  }

  // A backfill that has been running long enough to miss a head poll yields to
  // the head poll. History keeps; the head does not.
  if (state.phase === "backfill" && forwardPollDue(state, now)) {
    state = { ...state, phase: "forward", forward: emptyForwardWalk() };
  }

  // ── FORWARD POLL ───────────────────────────────────────────────────────────
  if (state.phase === "forward") {
    let complete = false;
    let stopReason: string | null = null;

    while (
      input.budget.hasRequestCapacity(1) && input.budget.hasWallClockCapacity()
    ) {
      if (!hasDayCapacity()) {
        deferred = "daily_call_budget";
        break;
      }
      const before = state.forward.beforeRef ?? HEAD_CURSOR;
      // REPEAT-REQUEST GUARD. The identical `before` twice in one walk AFTER A
      // PAGE CAME BACK is a loop's first visible step (WP-F1 spent a whole
      // day's cap on that shape on production), and there is nothing to learn
      // from issuing it again.
      if (state.forward.lastRequestedBefore === before) {
        await input.telemetry.addAnomaly({
          code: "fansly_notifications_cursor_repeat",
          severity: "warn",
          message: "Fansly notification pagination did not advance; forward poll stopped",
          details: { before, phase: "forward" },
        });
        complete = true;
        stopReason = "cursor_repeat";
        break;
      }

      const page = await fetchPage(before, "forward");
      if (page === null) {
        if (filterExhausted) {
          stopReason = "type_filter_exhausted";
          await saveProgress();
          break;
        }
        // The form was refused and the mode widened; the same cursor is a
        // DIFFERENT request now. Nothing to undo — the mark is only armed by a
        // request that came back with a body.
        continue;
      }
      // ARMED ONLY BY A SERVED PAGE, and this is the whole point: the mark used
      // to be written (and durably saved by the attempt observer) BEFORE the
      // request went out, so any rethrow — a terminal 429, a 5xx, a dead
      // session — left the lane looking at its own dead attempt and the retry
      // declared a provider loop. An attempted request that never returned a
      // body is not a repeat.
      state = {
        ...state,
        forward: { ...state.forward, lastRequestedBefore: before, pages: state.forward.pages + 1 },
      };
      const rows = notificationRows(page.payload);
      const bounds = pageRefBounds(rows);

      if (state.forward.pendingHeadRef === null && bounds.newest !== null) {
        state = { ...state, forward: { ...state.forward, pendingHeadRef: bounds.newest } };
      }
      // Seed the backfill from the head page rather than spending a second
      // identical call on `before=0`.
      if (
        state.backfill !== null && !state.backfill.done
        && state.backfill.nextBeforeRef === HEAD_CURSOR && bounds.oldest !== null
      ) {
        state = {
          ...state,
          backfill: { ...state.backfill, nextBeforeRef: bounds.oldest },
        };
      }

      if (rows.length === 0) {
        // Nothing new. One probe decides whether that is the truth or a filter.
        await probeUnfilteredForm(before);
        complete = true;
        stopReason = "empty_page";
        await saveProgress();
        break;
      }

      const overlap = state.newestSeenNotificationId !== null
        && pageReachesOverlap(rows, state.newestSeenNotificationId);
      // FIRST EVER POLL: one page is the whole forward obligation. Everything
      // older belongs to the deep backfill, which is exactly what it is for —
      // paging the whole history here would spend the day's cap in the lane
      // that has to stay responsive.
      const firstPoll = state.newestSeenNotificationId === null;

      if (overlap || firstPoll || bounds.oldest === null) {
        complete = true;
        stopReason = overlap ? "overlap" : firstPoll ? "first_poll" : "no_cursor";
        await saveProgress();
        break;
      }
      if (state.forward.pages >= FORWARD_MAX_PAGES_PER_POLL) {
        // Not a hole we hide: the walk stops, the anomaly names it, and the
        // NEXT poll resumes from the same cursor because the head is not
        // committed below.
        await input.telemetry.addAnomaly({
          code: "fansly_notifications_forward_walk_capped",
          severity: "warn",
          message: "Fansly notification forward walk hit its page cap before reaching overlap",
          details: { pages: state.forward.pages, before, newestSeen: state.newestSeenNotificationId },
        });
        stopReason = "page_cap";
        await saveProgress();
        break;
      }
      state = { ...state, forward: { ...state.forward, beforeRef: bounds.oldest } };
      await saveProgress();
    }

    if (complete) {
      // COMMIT THE HEAD, and only now: an earlier commit would have skipped
      // whatever sat between the head and the overlap if the walk was cut short.
      const committedHead = state.forward.pendingHeadRef ?? state.newestSeenNotificationId;
      state = {
        ...state,
        newestSeenNotificationId: committedHead,
        lastForwardPollAt: now.toISOString(),
        forward: emptyForwardWalk(),
        phase: state.backfill !== null && !state.backfill.done ? "backfill" : "forward",
      };
      // The walk is over, so this is where the narrowed lane may change form.
      rotateTypeGroupAtWalkBoundary();
      await coverage(
        CAPTURE_COVERAGE_PLANES.notifications,
        archiveStatus("window_captured"),
        "none",
        {
          newestCapturedAt: now,
          reasonCode: state.filterMode === "unfiltered" ? stopReason : "type_filter_narrowed",
          cursor: {
            newestSeenNotificationId: committedHead,
            filterMode: state.filterMode,
          },
        },
      );
      if (state.phase === "forward") {
        // Head polled, no backfill left: the slot is satisfied.
        await completeLane(input.syncRunId);
        return {
          satisfied: true,
          yieldReason: null,
          stats: {
            phase: "forward",
            journaled,
            callsToday: state.callsToday,
            dailyCap,
            stopReason,
            filterMode: state.filterMode,
          },
        };
      }
      // Hand the rest of the day to the backfill, spaced.
      await saveProgress();
      return {
        satisfied: false,
        yieldReason: null,
        continuationRetryAt: backfillContinuationAt(now, continuationDelayMs),
        stats: {
          phase: "forward",
          journaled,
          callsToday: state.callsToday,
          dailyCap,
          stopReason,
          filterMode: state.filterMode,
          next: "backfill",
        },
      };
    }

    await saveProgress();
    return {
      satisfied: false,
      yieldReason: deferred === null ? input.budget.resolveYieldReason(1) : null,
      ...(deferred === null ? {} : { continuationRetryAt: nextFanslyUtcDayStart(now) }),
      stats: {
        phase: "forward",
        journaled,
        callsToday: state.callsToday,
        dailyCap,
        deferred,
        stopReason,
        filterMode: state.filterMode,
      },
    };
  }

  // ── DEEP BACKFILL (one-off, first enable) ─────────────────────────────────
  const backfill = state.backfill;
  if (backfill === null || backfill.done) {
    state = { ...state, phase: "forward" };
    await completeLane(input.syncRunId);
    return {
      satisfied: true,
      yieldReason: null,
      stats: { phase: "backfill", journaled, skipped: "backfill_complete" },
    };
  }

  let callsInChunk = 0;
  const backfillCeiling = backfillAttemptCeiling(dailyCap);
  while (
    input.budget.hasRequestCapacity(1) && input.budget.hasWallClockCapacity()
    && callsInChunk < BACKFILL_CALLS_PER_CHUNK
  ) {
    if (!hasDayCapacity()) {
      deferred = "daily_call_budget";
      break;
    }
    // THE HEAD'S RESERVE. History keeps; the head does not — so the one-off
    // walk stops at ITS OWN share of the day and hands the rest back to the
    // forward poll. Measured on `backfillCallsToday`, never on the lane-wide
    // counter: the head always spends first, so bounding the lane-wide number
    // let the head eat this budget and park the walk permanently at any cap
    // the reserve covers.
    if (state.backfillCallsToday >= backfillCeiling) {
      deferred = "head_reserve";
      break;
    }
    const before = backfill.nextBeforeRef;
    // The repeat-request guard, again, and this is the walk it matters most in:
    // a backfill that re-asks for the same page walks nowhere at full speed.
    if (backfill.lastRequestedBefore === before) {
      backfill.done = true;
      await input.telemetry.addAnomaly({
        code: "fansly_notifications_cursor_repeat",
        severity: "warn",
        message: "Fansly notification backfill cursor did not advance; walk stopped",
        details: { before, phase: "backfill" },
      });
      await coverage(
        CAPTURE_COVERAGE_PLANES.notifications,
        // Bounded by the PROVIDER, not by us and not by exhaustion.
        "partial_provider_surface",
        backfill.lastObservationId === null ? "none" : "terminal_response",
        {
          oldestCapturedAt: backfill.floorAt === null ? null : new Date(backfill.floorAt),
          newestCapturedAt: now,
          proofObservationId: backfill.lastObservationId,
          reasonCode: "repeat_request",
          cursor: {
            notificationFloorAt: backfill.floorAt,
            nextBeforeRef: before,
          },
        },
      );
      state = { ...state, backfill };
      await saveProgress();
      break;
    }
    callsInChunk += 1;

    // The attempts this call costs — retries included — land on the backfill's
    // own counter, which is what its ceiling is measured against.
    const spentBefore = state.callsToday;
    const page = await fetchPage(before, "backfill");
    state = {
      ...state,
      backfillCallsToday: state.backfillCallsToday + (state.callsToday - spentBefore),
    };
    if (page === null) {
      if (filterExhausted) {
        state = { ...state, backfill };
        await saveProgress();
        break;
      }
      // Form refused and widened; the same cursor is a different request now,
      // and the repeat mark was never armed for a call that brought no body.
      state = { ...state, backfill };
      continue;
    }
    // ARMED ONLY BY A SERVED PAGE (see the forward walk): a rethrown 429, 5xx
    // or dead session must leave the walk resumable at exactly this cursor,
    // not looking like a provider that ignored `before`.
    backfill.lastRequestedBefore = before;
    backfill.lastObservationId = page.observationId ?? backfill.lastObservationId;
    const rows = notificationRows(page.payload);
    const bounds = pageRefBounds(rows);
    const oldestIso = oldestCreatedAtIso(rows);
    if (oldestIso !== null) {
      backfill.floorAt = backfill.floorAt === null || oldestIso < backfill.floorAt
        ? oldestIso
        : backfill.floorAt;
    }

    if (rows.length === 0 || bounds.oldest === null) {
      // THE FLOOR. The empty response IS the evidence and it is journaled, so
      // the coverage row points at the observation rather than restating it.
      backfill.done = true;
      await coverage(
        CAPTURE_COVERAGE_PLANES.notifications,
        // AN EMPTY PAGE MEANS DIFFERENT THINGS IN THE TWO FORMS, and conflating
        // them would be the worst claim this lane can make. Unfiltered, an
        // empty page is the archive's FLOOR. Through a narrowed type filter it
        // only means "no rows of THESE types" — the floor may be years deeper,
        // and `provider_exhausted` would tell the serving layer we reached the
        // end of history when we reached the end of a filter.
        archiveStatus("provider_exhausted"),
        "empty_window",
        {
          oldestCapturedAt: backfill.floorAt === null ? null : new Date(backfill.floorAt),
          newestCapturedAt: now,
          proofObservationId: page.observationId,
          reasonCode: state.filterMode === "unfiltered"
            ? "empty_window"
            : "type_filter_narrowed",
          cursor: {
            notificationFloorAt: backfill.floorAt,
            nextBeforeRef: before,
          },
        },
      );
      state = { ...state, backfill };
      await saveProgress();
      break;
    }

    backfill.nextBeforeRef = bounds.oldest;
    state = { ...state, backfill };
    await coverage(
      CAPTURE_COVERAGE_PLANES.notifications,
      archiveStatus("in_progress"),
      "none",
      {
        oldestCapturedAt: backfill.floorAt === null ? null : new Date(backfill.floorAt),
        newestCapturedAt: now,
        reasonCode: state.filterMode === "unfiltered"
          ? "backfill_walking"
          : "type_filter_narrowed",
        cursor: {
          notificationFloorAt: backfill.floorAt,
          nextBeforeRef: backfill.nextBeforeRef,
        },
      },
    );
    await saveProgress();
  }

  // NO ROTATION HERE. A chunk is not a walk: the deep backfill spans many
  // chunks and carries `nextBeforeRef` across them, so rotating at a chunk seam
  // sends page N+1 through a different `type` filter than the cursor it
  // inherited — exactly what the walk-boundary rule exists to prevent. It also
  // double-advances when a chunk served a page and then took a refusal, which
  // skips a group nobody ever asked for. The forward boundary rotates often
  // enough alone: a due head poll interrupts a running backfill, so the form
  // changes at least once per head cadence.
  if (backfill.done) {
    // `backfill: null` is what "the one-off walk is over" looks like durably.
    state = { ...state, phase: "forward", backfill: null };
    await completeLane(input.syncRunId);
    return {
      satisfied: true,
      yieldReason: null,
      stats: {
        phase: "backfill",
        journaled,
        callsToday: state.callsToday,
        backfillCallsToday: state.backfillCallsToday,
        dailyCap,
        notificationFloorAt: backfill.floorAt,
        backfillDone: true,
      },
    };
  }

  await saveProgress();
  return {
    satisfied: false,
    yieldReason: deferred === null ? input.budget.resolveYieldReason(1) : null,
    // Deferred at the cap: come back after the UTC roll — nothing may be spent
    // today. Deferred on the HEAD'S RESERVE: come back when the head is due,
    // because attempts remain and they belong to the forward poll. Otherwise a
    // jittered continuation, because burst shape is the ban-risk surface.
    continuationRetryAt: deferred === null
      ? backfillContinuationAt(now, continuationDelayMs)
      : deferred === "head_reserve"
      ? nextForwardPollAt(state, now)
      : nextFanslyUtcDayStart(now),
    stats: {
      phase: "backfill",
      journaled,
      callsToday: state.callsToday,
      backfillCallsToday: state.backfillCallsToday,
      dailyCap,
      backfillCeiling,
      deferred,
      notificationFloorAt: backfill.floorAt,
      nextBeforeRef: backfill.nextBeforeRef,
    },
  };
}
