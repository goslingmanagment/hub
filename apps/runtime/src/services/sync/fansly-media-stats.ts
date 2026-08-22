// WP-F4 — the `media_stats` capture handler: per-media traffic, over ALL media,
// at an age-decayed cadence.
//
// One journaled call reads one media item's traffic for one window. That is the
// whole lane, and it is the one lane in this initiative that can overload the
// platform, so everything below is about the five things that keep it polite.
//
// ── 1. THE SHAPE OF THE DEMAND, SAID OUT LOUD (A16) ─────────────────────────
//
// The cadence decays with the item's age: fresh (≤30 d) daily, mid (31–180 d)
// weekly, long tail (>180 d) every `fanslyMediaStatsLongTailCycleDays`,
// round-robin by last visit. For a page publishing ~5 media a day that gives
//
//     R = H + Mid/7 + L/cycle
//
// and A16's binding table, which this lane reports rather than restates:
//
//     M =  2 000 ⇒ 294 calls/day wanted, long tail comes round every  26 days
//     M =  5 000 ⇒ 394              ⇒                                 96 days — QUARTERLY
//     M = 10 000 ⇒ 560              ⇒                                212 days
//     M = 20 000 ⇒ 894              ⇒                                446 days
//
// NOTHING IS DROPPED at any M — every item is still visited round-robin, just
// less often. But the long tail must never be described as "monthly" when it is
// quarterly, so `estimatedCycleDays` is computed from the LIVE class census and
// the LIVE cap on every dispatch, and the log line says "quarterly" in words
// once it passes 90 days. It is never a documentation constant.
//
// This lane is DELIBERATELY designed to run at 100 % of its own cap when M is
// large (§6.1 exempts it from the 70 %-of-its-own-cap rule by name). Raising
// `fanslyMediaStatsDailyCallBudget` toward what the decay wants is a NAMED
// per-lane step: one lane, one value, owner-approved, backed out on any 429 or
// latency regression.
//
// ── 2. THIRTY-ONE DAYS, NOT A HUNDRED — the F1 lesson, applied ──────────────
//
// `datapointLimit: 100` says a window may CARRY 100 buckets; it never said the
// provider would honour a 100-day one. On production 2026-08-22 `/it/amoie/stats`
// answered a 100-day window with its own DEFAULT trailing 31 days, 200 and all,
// and the walk that derived its next window from THAT re-issued the same request
// until the day's cap was gone — 25 byte-identical responses.
//
// The HAR proves `/it/moie/statsnew` honours a HISTORICAL 31-day window exactly
// (`beforeDate 2026-08-01 / afterDate 2026-07-01` came back
// `dateBefore 2026-07-31 / dateAfter 2026-06-30`). So the per-media backfill
// walks in 31-day windows, NOT the plan's 100, and every call — backfill and
// steady alike — goes through `windowWasHonoured` and the repeat-request guard.
// A window the provider will not honour halves ONCE and then STOPS that item:
// an unwalked span is a hole we know about; a loop is a day of egress spent
// proving nothing.
//
// ── 2b. WHERE THE WALK STOPS, which "two empty windows" never answered ──────
//
// This route honours EVERY historical window exactly — and answers all of them,
// back to 2006, with ONE datapoint row whose counters are all zero. So a floor
// rule reading "no datapoints" never fired: production 2026-08-22 spent 1 198
// calls walking EIGHT media items 240 windows each, to 2006-04. Two rules end
// that, and both are about what the response MEANS rather than how many rows it
// has:
//
//   - AN ALL-ZERO WINDOW IS EMPTY. Every counter zero (or absent) is no traffic;
//     the body is still journaled verbatim, because capture-first is not a floor
//     rule and the zero row is itself the evidence.
//   - AN ITEM HAS NO TRAFFIC BEFORE IT EXISTED. The walk never asks for a window
//     ending more than one span before the item's own creation instant —
//     `created_at_platform`, or first sight when the platform served none, which
//     is the SAME age basis the tier is computed from. Reaching it is a floor
//     with a name: `floorBasis: 'created_at'`. It is also the repair for the
//     eight cursors already sitting at 2006 — they hit it on their next visit.
//
// ── 2c. EVERY VISIT COUNTS AS A VISIT ──────────────────────────────────────
//
// `last_visited_at` is what retires an item from the never-visited band, and a
// backfill visit used not to stamp it: an item stayed "never visited" until its
// WHOLE history was walked. With the newest-first priority that is a treadmill —
// the same eight items were re-picked every day while 5 507 rows had never been
// looked at once. So a visit that journaled anything stamps the row, the
// backfill resumes from `backfill_cursor` on the item's NEXT visit, and the
// steady window for the tier runs in the same visit if the budget still allows
// it. Deep history now arrives over several cycles instead of in one burst,
// which is the trade: fairness across the catalogue, bounded by the creation
// floor above.
//
// ── 3. THE QUEUE IS NOT A PROJECTION ────────────────────────────────────────
//
// Rows live in `subject_refresh_state` (`plane='media_stats'`), which is
// capture-plane operational state (§3.4) and which no `projection:rebuild`
// truncates. Four queue columns on the rebuildable `creator_media` — v1's
// proposal — would be wiped by an ordinary repair, re-marking the WHOLE
// catalogue as first-sight and releasing a per-media backfill storm bounded only
// by this lane's own daily cap. [A19] removed the global per-page cap, so that
// cap is the whole bound. A test pins the isolation.
//
// Rows are seeded from `creator_media` in bounded keyset batches on first
// enable AND — for anything projected afterwards — in the SAME TRANSACTION as
// the `creator_media` upsert (the F5/F6 precedent, `media-plane.ts`).
//
// ── 4. PRIORITY, AND THE TWO SIGNALS THAT JUMP THE QUEUE ────────────────────
//
//   (1) DIRTY. WP-F2 has been marking purchased media dirty since it shipped
//       (`dirty_reason='purchase_notification'`) and fetching nothing; this is
//       the consumer. The current top-50 of `stats_top_media` is marked the same
//       way, once a day, for zero platform calls — an item that just entered the
//       top-50 is the one whose series is worth having today.
//   (2) NEVER VISITED, NEWEST FIRST.
//   (3) DUE BY CLASS, oldest visit first.
//
// ── 5. BURST SHAPE IS THE BAN-RISK SURFACE, not daily volume ────────────────
//
// A chunk spends its 5 requests in ~13 s and is re-queued, so an unspaced walk
// runs contiguously at ~23 req/min for as long as it has work — a 300-call day
// is ~13 contiguous minutes. Continuations therefore carry
// `fanslyBackfillContinuationDelayMs` ± 30 % jitter, both for the first-sight
// backfill and for the steady round-robin, because at this lane's volume the
// steady state IS a deep walk.
//
// [E5] — VIDEO COLUMNS STAY UNPROMISED. All six observed `/it/moie/statsnew`
// responses carried exactly seven stat keys and NO video fields, even for an
// asset that is `media.type = 2, mimetype = video/mp4`. The columns exist
// because the ACCOUNT-level media datapoints do carry them. Nothing here, in the
// dashboard or in the datasets may claim per-media watch metrics until [E5]
// settles.

import {
  assertOwnedPageSyncLease,
  countMediaStatsRefreshProgress,
  getCheckpoint,
  listMediaStatsRefreshChunk,
  markMediaStatsTopMediaDirty,
  mediaStatsIntervalDays,
  recordMediaStatsBackfillProgress,
  recordMediaStatsFailure,
  recordMediaStatsVisit,
  seedMediaStatsQueue,
  upsertCaptureCoverage,
  upsertCheckpoint,
  upsertCheckpointProgress,
  type CaptureCoverageStatus,
  type MediaStatsRefreshCandidate,
  type MediaStatsTier,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import type { HttpRequestEvent, HttpRequestObserver } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { isPageAllowlisted } from "../voice-notes.ts";
import { composeRequestObservers } from "./chunk-budget.ts";
import type { ExecutorRequestContext, StreamChunkResult } from "./executor-handlers.ts";
import {
  backfillContinuationAt,
  isEmptyStatsWindow,
  narrowedSpanDays,
  parseWindowGuard,
  servedWindow,
  windowWasHonoured,
  type BackfillWindowGuard,
} from "./fansly-stats.ts";
import { summarizeCheckpoint } from "./observability.ts";
import { createSyncRateLimitWaiter } from "./rate-limiter.ts";
import { persistRawPayload, retentionDate } from "./shared.ts";

const STREAM = "media_stats" as const;

/** The SAME mapper version the account-statistics lane stamps: `media_offer_stats`
 *  is a kind of the ONE `fansly-stats` family, not a second registration. */
const MAPPER_VERSION = "fansly-stats-v1";

/** The observation kind this lane journals under. Claimed by `fansly-stats`
 *  (F1 registered it so the kind would be parseable the day capture could write
 *  it) and declared in `observation-kinds.ts`. */
const OBSERVATION_KIND = "media_offer_stats";

/** One coverage row per page, per §3.4. Deliberately NOT one per media: a
 *  coverage row per item would be a second queue, of the same cardinality, in a
 *  table whose contract is "how far back does this plane reach". */
export const FANSLY_MEDIA_STATS_COVERAGE_PLANE = "media_stats";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const DAILY_PERIOD_MS = 86_400_000;
const HOURLY_PERIOD_MS = 3_600_000;

/**
 * THE STEADY WINDOW PER TIER.
 *
 * Fresh items are read at HOURLY granularity over the last day because that is
 * where the numbers actually move; everything older is read daily. The spans are
 * constants rather than config keys for the reason §6.1 gives: they describe how
 * traffic decays with an item's age, and the one thing an operator should be
 * turning is how much of that decay the lane can afford — the daily cap — plus
 * the long-tail cycle, which A6 names explicitly.
 */
const FRESH_TRAILING_HOURS = 24;
const MID_TRAILING_DAYS = 30;
const LONG_TAIL_TRAILING_DAYS = 90;

/**
 * The span the provider is PROVEN to honour on this route (HAR 2026-08-19: a
 * historical `2026-07-01 → 2026-08-01` request came back `2026-06-30 →
 * 2026-07-31`, exact). Every backfill window and every split long-tail window is
 * this wide.
 */
const BACKFILL_WINDOW_DAYS = 31;
const BACKFILL_OVERLAP_DAYS = 1;
/** Two consecutive all-empty windows ⇒ the floor. Unlike the ACCOUNT lane there
 *  is no year-further-back probe: an item cannot have traffic before it was
 *  published, so an empty window here is not the [E10] long-idle-account case. */
const BACKFILL_EMPTY_STREAK_LIMIT = 2;
/**
 * How far past an item's own creation the walk may still ask.
 *
 * ONE span, not zero: the creation instant is the platform's or ours, the
 * provider snaps windows to its bucket grid, and a window that straddles the
 * publication day is the last one that can carry anything. Past that there is
 * nothing to find — which the provider will happily confirm, one zero-valued
 * bucket at a time, all the way to 2006.
 */
const BACKFILL_CREATION_SLACK_DAYS = 31;
/** The six counters `/it/moie/statsnew` serves per `stats[]` row ([E5]: seven
 *  keys, six of them counters and one of them `type`). All zero — or absent —
 *  is NO TRAFFIC, which is what makes a floor reachable at all. */
const MEDIA_STAT_COUNTER_KEYS = [
  "views",
  "previewViews",
  "uniqueViewers",
  "previewUniqueViewers",
  "interactionTime",
  "previewInteractionTime",
] as const;
/** How many 31-day backfill windows ONE media may take in one visit. Bounded so
 *  a single item with years of history cannot spend a whole chunk, while a
 *  newest-first depth-first walk still finishes an item in a few dispatches. */
const BACKFILL_WINDOWS_PER_VISIT = 4;
/** The three 31-day windows a long-tail refresh falls back to when the provider
 *  refuses the 90-day span. 3 × 31 = 93 ≥ 90. */
const LONG_TAIL_SPLIT_WINDOWS = 3;
/** Media visited in ONE dispatch before a jittered continuation. The chunk
 *  budget (5 requests / 45 s) bites long before this; it is the ceiling for a
 *  lane being re-queued aggressively. */
const MEDIA_PER_CHUNK = 25;
/** Media seeded per dispatch on first enable. Bounded so a page with thousands
 *  of media does not hold a write lock, and keyset so the next batch resumes
 *  exactly where this one stopped. */
const SEED_BATCH_SIZE = 500;
/** The platform's own top-N page size. */
const TOP_MEDIA_MARK_LIMIT = 50;
/** A cycle longer than this is QUARTERLY OR WORSE and the log line says so. */
const QUARTERLY_DAYS = 90;

// ── cursor state ─────────────────────────────────────────────────────────────

/**
 * What the lane has learned about the 90-day long-tail window.
 *
 * Durable and page-scoped, because the discovery costs a call and the answer is
 * a property of the ROUTE, not of one media item. `split_31` triples what a
 * long-tail visit costs, so the mode is reported in the progress block.
 */
export type LongTailWindowMode = "unproven" | "ninety" | "split_31";

export interface FanslyMediaStatsCursorState {
  version: 1;
  /** The UTC day `callsToday` belongs to; a different day resets the counters. */
  utcDay: string;
  /** HTTP ATTEMPTS spent by this lane on `utcDay`. Retries included. */
  callsToday: number;
  /** Due items this lane could not reach today because the cap was spent.
   *  Reported, never acted on: they are simply first in tomorrow's queue. */
  deferredToday: number;
  /** Keyset cursor of the first-enable seeding sweep. */
  seedCursor: string | null;
  seedComplete: boolean;
  /** The UTC day the top-50 dirty marks were last refreshed. Zero calls. */
  topMarkedDay: string | null;
  longTailWindowMode: LongTailWindowMode;
  /** The mode discovery is announced ONCE, ever. */
  longTailWindowAnnounced: boolean;
}

/** The per-MEDIA first-sight backfill, stored in
 *  `subject_refresh_state.backfill_cursor`. */
interface MediaBackfillCursor {
  version: 1;
  /** Exclusive upper bound of the NEXT window, epoch ms. */
  nextBeforeMs: number;
  emptyStreak: number;
  /** The walk has reached its floor, or stopped on an unhonoured window. */
  done: boolean;
  /** ISO instant of the oldest bucket the provider ever served for this item. */
  floorAt: string | null;
  /** Why it stopped, when it stopped for a reason other than the floor. */
  stopReason: string | null;
  /** WHAT ended the walk: `created_at` (the item did not exist before this),
   *  `empty_window` (two all-empty windows), or null while it is still open.
   *  A floor with a name is a floor an operator can argue with. */
  floorBasis: string | null;
  guard: BackfillWindowGuard;
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

function asLongTailMode(value: unknown): LongTailWindowMode {
  return value === "ninety" || value === "split_31" ? value : "unproven";
}

export function parseFanslyMediaStatsCursorState(
  value: unknown,
): FanslyMediaStatsCursorState | null {
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
    deferredToday: Math.max(0, asInt(state.deferredToday, 0)),
    seedCursor: asNullableString(state.seedCursor),
    seedComplete: state.seedComplete === true,
    topMarkedDay: asNullableString(state.topMarkedDay),
    longTailWindowMode: asLongTailMode(state.longTailWindowMode),
    longTailWindowAnnounced: state.longTailWindowAnnounced === true,
  };
}

export function emptyFanslyMediaStatsCursorState(now: Date): FanslyMediaStatsCursorState {
  return {
    version: 1,
    utcDay: utcDayKey(now),
    callsToday: 0,
    deferredToday: 0,
    seedCursor: null,
    seedComplete: false,
    topMarkedDay: null,
    longTailWindowMode: "unproven",
    longTailWindowAnnounced: false,
  };
}

export function utcDayKey(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** A new UTC day resets the attempt counter and the deferred tally, and NOTHING
 *  else: a refresh queue is durable state and a window-mode discovery is a fact,
 *  not a daily allowance. */
export function rollUtcDay(
  state: FanslyMediaStatsCursorState,
  now: Date,
): FanslyMediaStatsCursorState {
  const today = utcDayKey(now);
  return state.utcDay === today
    ? state
    : { ...state, utcDay: today, callsToday: 0, deferredToday: 0 };
}

/** A cursor written before this lane existed parses as an item that has walked
 *  nothing yet, which is exactly what it is. */
export function parseMediaBackfillCursor(
  value: unknown,
  now: Date,
): MediaBackfillCursor {
  const record = asRecord(value);
  return {
    version: 1,
    nextBeforeMs: asInt(record?.nextBeforeMs, now.getTime()),
    emptyStreak: Math.max(0, asInt(record?.emptyStreak, 0)),
    done: record?.done === true,
    floorAt: asNullableString(record?.floorAt),
    stopReason: asNullableString(record?.stopReason),
    floorBasis: asNullableString(record?.floorBasis),
    guard: parseWindowGuard(record?.guard, BACKFILL_WINDOW_DAYS),
  };
}

/**
 * The instant an item's history CANNOT reach past: its own creation, less one
 * window span.
 *
 * The basis is `created_at_platform` and, when the platform never served one,
 * first sight — the SAME `coalesce` the queue computes the item's tier from, so
 * an item cannot be classed by one age and walked by another. Neither ⇒ null,
 * and null means no creation floor: we never invent a publication date, and the
 * empty-window rule owns the item instead.
 */
export function mediaBackfillCreationFloorMs(
  candidate: { createdAtPlatform: Date | null; firstSeenAt: Date | null },
): number | null {
  const basis = candidate.createdAtPlatform ?? candidate.firstSeenAt;
  return basis === null ? null : basis.getTime() - BACKFILL_CREATION_SLACK_DAYS * DAY_MS;
}

/**
 * Did this window carry any traffic at all?
 *
 * `/it/moie/statsnew` answers a window from 2006 with a datapoint row whose
 * counters are all zero, so "the array is non-empty" is not evidence of
 * anything. Any non-zero counter in any `stats[]` row is; nothing else is.
 *
 * The response is journaled verbatim either way — capture-first is not a floor
 * rule, and the zero-valued row IS the evidence the coverage claim rests on.
 */
export function mediaStatsWindowIsEmpty(payload: unknown): boolean {
  if (isEmptyStatsWindow(payload)) {
    return true;
  }
  const record = asRecord(payload);
  const dataset = record === null ? null : asRecord(record.dataset);
  const points = dataset !== null && Array.isArray(dataset.datapoints) ? dataset.datapoints : [];
  for (const point of points) {
    const row = asRecord(point);
    for (const stat of row !== null && Array.isArray(row.stats) ? row.stats : []) {
      const values = asRecord(stat);
      if (values === null) {
        continue;
      }
      for (const key of MEDIA_STAT_COUNTER_KEYS) {
        const value = values[key];
        if (typeof value === "number" && value !== 0) {
          return false;
        }
      }
    }
  }
  return true;
}

function backfillCursorJson(cursor: MediaBackfillCursor): Record<string, unknown> {
  return { ...cursor } as unknown as Record<string, unknown>;
}

// ── the cycle estimate ───────────────────────────────────────────────────────

export interface MediaStatsCycleEstimate {
  /** Calls a day the decay WANTS, at the live class census. */
  requestsPerDayWanted: number;
  /** Days the long tail actually comes round in, at the live cap. */
  estimatedCycleDays: number;
  /** True when the decay wants more than the cap can fund. */
  saturating: boolean;
  /** True when the cycle is 90 days or worse — "quarterly", in words. */
  quarterlyOrWorse: boolean;
}

/**
 * What the LIVE M and the LIVE cap actually deliver (A16 item 3).
 *
 * `requestsPerDayWanted = H + Mid/7 + L/cycle` — one call per item per visit,
 * the same arithmetic A16's table is built from. The long tail's real cycle is
 * whatever budget is LEFT after the daily and weekly tiers have taken theirs:
 *
 *     estimatedCycleDays = L / (cap − H − Mid/7)
 *
 * which is why the answer can be FASTER than the nominal cycle (26 days at
 * M = 2 000 against a nominal 30) and much slower at scale (96 days at
 * M = 5 000 — quarterly, and this lane says so). The division is deliberately
 * NOT rounded before it is applied: A16's own numbers only reproduce on the
 * unrounded weekly term.
 *
 * When the fresh and mid tiers alone exceed the cap the denominator is clamped
 * to 1, and the number returned means "at LEAST this many days" — the long tail
 * is not being funded at all, which is what `saturating` and the due backlog
 * report.
 */
export function estimateMediaStatsCycle(input: {
  fresh: number;
  mid: number;
  longTail: number;
  dailyCap: number;
  longTailCycleDays: number;
}): MediaStatsCycleEstimate {
  const cycleDays = Math.max(1, input.longTailCycleDays);
  const weekly = input.mid / MEDIA_STATS_MID_INTERVAL_DAYS_LOCAL;
  const wanted = input.fresh + weekly + input.longTail / cycleDays;
  const leftover = input.dailyCap - input.fresh - weekly;
  const estimatedCycleDays = input.longTail === 0
    ? cycleDays
    : Math.round(input.longTail / Math.max(1, leftover));
  return {
    requestsPerDayWanted: Math.round(wanted),
    estimatedCycleDays,
    saturating: wanted > input.dailyCap,
    quarterlyOrWorse: estimatedCycleDays > QUARTERLY_DAYS,
  };
}

/** Kept local so the estimate reads as arithmetic rather than a lookup; it is
 *  the same 7 the repository's tier table uses. */
const MEDIA_STATS_MID_INTERVAL_DAYS_LOCAL = 7;

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

/**
 * The media offer this body is about.
 *
 * `dataset.datasetMediaOfferId` is the key the route actually serves (HAR
 * 2026-08-19, 6/6). The other two spellings are accepted because a payload that
 * cannot be attributed is a payload whose buckets are unusable, and tolerating a
 * rename costs nothing.
 */
export function servedMediaOfferRef(payload: unknown): string | null {
  const record = asRecord(payload);
  if (record === null) {
    return null;
  }
  const dataset = asRecord(record.dataset);
  return asNullableString(dataset?.datasetMediaOfferId)
    ?? asNullableString(dataset?.mediaOfferId)
    ?? asNullableString(record.mediaOfferId);
}

/** How many `datapoints[].stats[]` rows this body carried — the `known_count`
 *  the queue stores, and the only honest measure of "what did this look see". */
export function countMediaStatBuckets(payload: unknown): number {
  const record = asRecord(payload);
  const dataset = record === null ? null : asRecord(record.dataset);
  if (dataset === null || !Array.isArray(dataset.datapoints)) {
    return 0;
  }
  let count = 0;
  for (const point of dataset.datapoints) {
    const row = asRecord(point);
    if (row !== null && Array.isArray(row.stats)) {
      count += row.stats.length;
    }
  }
  return count;
}

/**
 * Did the served window actually COVER the span we asked for?
 *
 * `windowWasHonoured` is the loop guard, and it is the right one everywhere a
 * walk DERIVES its next window from what came back: it catches a served window
 * reaching materially newer than the request, or missing it entirely — the
 * production signature where the provider answers with its own default trailing
 * window and the walk re-issues the same request forever.
 *
 * It cannot catch THIS case, and the difference is worth stating rather than
 * discovering: the 90-day long-tail refresh is a TRAILING window, so a provider
 * that answers it with its default trailing 31 days returns a window with the
 * SAME END and a nearer start. Nothing reaches newer than we asked, nothing is
 * disjoint, and `windowWasHonoured` correctly says "no contradiction" — there
 * is none. What there is, is 59 days we asked for and did not get.
 *
 * So the 90-day probe checks coverage as well: the served start must be within
 * a day of the requested one. Served bounds we did not get are no evidence and
 * no contradiction — the empty-window rule owns that case, here as everywhere.
 */
export function servedWindowCoversRequest(
  requested: { afterMs: number; beforeMs: number },
  served: { afterMs: number | null; beforeMs: number | null },
): boolean {
  if (served.afterMs === null) {
    return true;
  }
  return served.afterMs - requested.afterMs <= DAY_MS;
}

function isAuthFailure(error: unknown): boolean {
  return error instanceof FanslyApiError && (error.status === 401 || error.status === 403);
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

/** What one window request came back as. `null` means the call was refused
 *  before any egress (a repeat) or failed. */
interface WindowOutcome {
  raw: unknown;
  honoured: boolean;
  served: { afterMs: number | null; beforeMs: number | null };
  empty: boolean;
  buckets: number;
  observationId: number | null;
}

export async function fanslyMediaStatsChunk(
  app: AppContext,
  input: ExecutorRequestContext & { syncRunId: number; now?: Date },
): Promise<StreamChunkResult> {
  if (input.pageContext.platform !== "fansly") {
    return skip("not_fansly");
  }
  await input.telemetry.recordPhaseStarted(STREAM);

  const effective = await loadEffectiveConfig(app.db, app.config);
  if (effective.fanslyMediaStatsSyncEnabled !== true) {
    return skip("flag_off");
  }
  // FAIL-CLOSED (S4): empty = NO pages. Deliberately NOT `fanslyNewStreamAllowed`,
  // whose empty CSV means every page — using it here would start a
  // 300-call-a-day per-media walk on every Fansly page on the deploy that
  // shipped it.
  if (!isPageAllowlisted(effective.fanslyMediaStatsPageAllowlist, input.pageContext.page.label)) {
    return skip("not_allowlisted");
  }

  const now = input.now ?? new Date();
  const pageId = input.pageContext.page.id;
  const dailyCap = Math.max(1, effective.fanslyMediaStatsDailyCallBudget ?? 300);
  const longTailCycleDays = Math.max(1, effective.fanslyMediaStatsLongTailCycleDays ?? 30);
  const continuationDelayMs = Math.max(0, effective.fanslyBackfillContinuationDelayMs ?? 20_000);

  const checkpoint = await getCheckpoint(app.db, pageId, STREAM);
  await input.telemetry.recordCheckpointLoaded(STREAM, summarizeCheckpoint(checkpoint));
  let state = rollUtcDay(
    parseFanslyMediaStatsCursorState(checkpoint?.state)
      ?? emptyFanslyMediaStatsCursorState(now),
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
  let visited = 0;
  let bucketsSeen = 0;
  let backfillWindows = 0;
  let topMarked = 0;
  let deferred: string | null = null;
  let moreWork = false;

  /** Room for one more call today? Crossing this defers; it never drops. */
  const hasDayCapacity = () => state.callsToday < dailyCap;
  const hasChunkCapacity = () =>
    input.budget.hasRequestCapacity(1) && input.budget.hasWallClockCapacity();

  const saveProgress = async () => {
    const advanced = await upsertCheckpointProgress(app.db, {
      platformAccountId: pageId,
      stream: STREAM,
      cursorText: state.longTailWindowMode,
      state: { ...state } as unknown as Record<string, unknown>,
    });
    await input.telemetry.recordCheckpointAdvanced(STREAM, summarizeCheckpoint(advanced));
  };

  /**
   * ONE window, journaled FIRST and judged afterwards.
   *
   * The order is the whole discipline: the bytes are durable before the shape is
   * read, before the cap is re-consulted, before anything decides whether the
   * walk has anywhere left to go. A budget never turns a captured response into
   * a dropped one.
   *
   * `issued` is the per-visit repeat-request guard. The identical
   * `(period, after, before)` twice in one visit is a loop's first visible step
   * and there is nothing to learn from issuing it — the durable half of the same
   * guard lives in each item's backfill cursor and covers chunk boundaries.
   */
  const requestWindow = async (
    subjectRef: string,
    params: { periodMs: number; afterMs: number; beforeMs: number; mode: string; tier: string },
    issued: Set<string>,
  ): Promise<WindowOutcome | "repeat" | "failed"> => {
    const key = `${params.periodMs}:${params.afterMs}:${params.beforeMs}`;
    if (issued.has(key)) {
      await input.telemetry.addAnomaly({
        code: "fansly_media_stats_window_repeat",
        severity: "warn",
        message: "Fansly per-media window was about to repeat; the item's walk stopped",
        details: {
          mediaOfferRef: subjectRef,
          periodMs: params.periodMs,
          afterDate: new Date(params.afterMs).toISOString(),
          beforeDate: new Date(params.beforeMs).toISOString(),
        },
      });
      return "repeat";
    }
    issued.add(key);

    const beforeDate = new Date(params.beforeMs);
    const afterDate = new Date(params.afterMs);
    await assertOwnedPageSyncLease(app.db);
    let raw: unknown;
    try {
      const response = await app.adapter.getMediaOfferStats(requestContext, {
        mediaOfferId: subjectRef,
        beforeDate,
        afterDate,
        periodMs: params.periodMs,
      });
      raw = response.raw;
    } catch (error) {
      // A dead session is the executor's business, not this loop's: re-raise it
      // untouched so the auth pause fires. Everything else is scoped to ONE
      // media item — a single unreachable item must not wedge a queue of
      // thousands.
      if (isAuthFailure(error)) {
        throw error;
      }
      state = { ...state, callsToday: state.callsToday + attempts.take() };
      await input.telemetry.addAnomaly({
        code: "fansly_media_stats_item_failed",
        severity: "warn",
        message: "Fansly per-media statistics failed for one item; the queue continues",
        details: {
          mediaOfferRef: subjectRef,
          status: error instanceof FanslyApiError ? error.status ?? null : null,
        },
      });
      await recordMediaStatsFailure(app.db, {
        pageId,
        subjectRef,
        nextDueAt: new Date(now.getTime() + DAY_MS),
      });
      return "failed";
    }

    const persisted = await persistRawPayload(app.db, {
      platformAccountId: pageId,
      syncRunId: input.syncRunId,
      endpoint: OBSERVATION_KIND,
      requestParams: {
        mediaOfferId: subjectRef,
        beforeDate: beforeDate.toISOString(),
        afterDate: afterDate.toISOString(),
        periodMs: params.periodMs,
        tier: params.tier,
        mode: params.mode,
      },
      responsePayload: raw,
      mapperVersion: MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: "inserting Fansly media offer stats raw payload",
      platform: "fansly",
    });
    journaled += 1;
    // The cap is counted in ATTEMPTS, folded in AFTER the response is safe.
    state = { ...state, callsToday: state.callsToday + attempts.take() };

    const served = servedWindow(raw);
    const buckets = countMediaStatBuckets(raw);
    bucketsSeen += buckets;
    return {
      raw,
      served,
      honoured: windowWasHonoured({ afterMs: params.afterMs, beforeMs: params.beforeMs }, served),
      // ALL-ZERO IS EMPTY. This route answers any window back to 2006 with one
      // zero-valued bucket, and a floor rule reading row COUNTS never fired.
      empty: mediaStatsWindowIsEmpty(raw),
      buckets,
      observationId: persisted.observationId ?? null,
    };
  };

  /**
   * THE UNHONOURED-WINDOW ACTION, per media.
   *
   * First disagreement: halve the span and try once more from the SAME upper
   * bound — a provider that refuses 31 days may well answer 15, and one extra
   * request is cheap next to an unwalked history. Second disagreement, or a span
   * already at the narrowing floor: STOP this item's backfill. Not "retry
   * tomorrow", not "derive from what came back" — both of those are the loop
   * that spent a whole day's cap on production.
   *
   * The anomaly is raised once per item per stop, and the stop is durable in the
   * item's own cursor.
   */
  const handleUnhonouredWindow = async (
    subjectRef: string,
    cursor: MediaBackfillCursor,
    requested: { afterMs: number; beforeMs: number },
    detail: {
      trigger: "served_window" | "repeat_request";
      served?: { afterMs: number | null; beforeMs: number | null };
    },
  ): Promise<"narrowed" | "stopped"> => {
    const narrower = narrowedSpanDays(cursor.guard.spanDays);
    if (!cursor.guard.narrowed && narrower < cursor.guard.spanDays) {
      cursor.guard.spanDays = narrower;
      cursor.guard.narrowed = true;
      return "narrowed";
    }
    cursor.done = true;
    cursor.stopReason = "window_not_honoured";
    await input.telemetry.addAnomaly({
      code: "fansly_media_stats_window_not_honoured",
      severity: "warn",
      message:
        "Fansly did not honour the requested per-media window; that item's backfill stopped",
      details: {
        mediaOfferRef: subjectRef,
        trigger: detail.trigger,
        spanDays: cursor.guard.spanDays,
        requestedAfter: new Date(requested.afterMs).toISOString(),
        requestedBefore: new Date(requested.beforeMs).toISOString(),
        servedAfter: detail.served?.afterMs == null
          ? null
          : new Date(detail.served.afterMs).toISOString(),
        servedBefore: detail.served?.beforeMs == null
          ? null
          : new Date(detail.served.beforeMs).toISOString(),
      },
    });
    return "stopped";
  };

  // ── SEEDING ────────────────────────────────────────────────────────────────
  //
  // First enable only, in bounded keyset batches, and it costs ZERO platform
  // calls: `creator_media` is already in the database. Everything projected
  // AFTER this sweep is queued by the media-plane writer in the same transaction
  // as its own upsert, so the seeding never has to run twice.
  if (!state.seedComplete) {
    for (;;) {
      const seeded = await seedMediaStatsQueue(app.db, {
        pageId,
        afterSubjectRef: state.seedCursor,
        limit: SEED_BATCH_SIZE,
        dueAt: now,
      });
      state = { ...state, seedCursor: seeded.cursor };
      if (seeded.scanned < SEED_BATCH_SIZE) {
        state = { ...state, seedComplete: true };
        break;
      }
      if (!input.budget.hasWallClockCapacity()) {
        break;
      }
    }
    await saveProgress();
  }

  // ── THE FREE SIGNAL: today's top-50 (A16 / §2.2) ──────────────────────────
  //
  // The account response already ranks this page's media, and WP-F1 projects
  // that ranking into `stats_top_media`. Promoting the current top-50 into the
  // dirty band costs NOTHING — no call, no window — and it is the cheapest
  // freshness this lane can buy. Once a UTC day: re-marking on every dispatch
  // would keep fifty items permanently dirty and starve the round-robin.
  const today = utcDayKey(now);
  if (state.topMarkedDay !== today) {
    const marked = await markMediaStatsTopMediaDirty(app.db, {
      pageId,
      limit: TOP_MEDIA_MARK_LIMIT,
      dueAt: now,
      // Anything already visited today is fresh enough; re-marking it would
      // spend a call re-reading numbers we have.
      visitedSince: new Date(now.getTime() - DAY_MS),
    });
    topMarked = marked.marked;
    state = { ...state, topMarkedDay: today };
    await saveProgress();
  }

  // ── THE WALK ───────────────────────────────────────────────────────────────
  const candidates = await listMediaStatsRefreshChunk(app.db, {
    pageId,
    limit: MEDIA_PER_CHUNK,
    now,
    longTailCycleDays,
  });
  moreWork = candidates.length >= MEDIA_PER_CHUNK;

  for (const candidate of candidates) {
    if (!hasChunkCapacity()) {
      moreWork = true;
      break;
    }
    if (!hasDayCapacity()) {
      deferred = "daily_call_budget";
      break;
    }
    const outcome = await visitCandidate(candidate);
    if (outcome === "deferred") {
      deferred = "daily_call_budget";
      break;
    }
    if (outcome === "yielded") {
      moreWork = true;
      break;
    }
  }

  return await finish();

  /**
   * ONE MEDIA ITEM, and the visit rule this lane now runs on.
   *
   * A visit walks the item's first-sight backfill (up to four windows) and then,
   * ONLY IF the day cap and the chunk budget both still allow it, the steady
   * window for the tier it is in today. Whatever it fetched, it stamps
   * `last_visited_at` — a backfill visit included — and the walk resumes from
   * `backfill_cursor` on the item's next turn.
   *
   * THE OLD RULE WAS THE OPPOSITE and it is what production paid for: a backfill
   * visit did not count as a visit, so an item stayed in the never-visited band
   * until its WHOLE history was walked, the newest-first priority kept handing
   * the budget back to the same eight items, and 5 507 rows had never been looked
   * at once. Depth-first per item is only cheap when histories are short; the
   * creation floor is what now makes them short.
   *
   * TWO THINGS DO NOT STAMP: a look that FAILED (a failed look is not a look, and
   * retiring an item from the never-visited band on the strength of an error is
   * how an unreachable item disappears), and a steady refresh cut in half by the
   * cap when no backfill window was journaled either — tomorrow re-reads it whole
   * rather than half.
   */
  async function visitCandidate(
    candidate: MediaStatsRefreshCandidate,
  ): Promise<"visited" | "skipped" | "deferred" | "yielded"> {
    const issued = new Set<string>();
    const cursor = parseMediaBackfillCursor(candidate.backfillCursor, now);
    const cursorAtEntry = JSON.stringify(backfillCursorJson(cursor));
    let buckets = 0;
    let journaledWindows = 0;
    let status: "visited" | "skipped" | "deferred" | "yielded" = "skipped";

    if (!cursor.done) {
      const walk = await runBackfill(candidate, cursor, issued);
      if (walk.status === "failed") {
        // The failure is already recorded against the item and its cursor is
        // left where it was, so the next dispatch retries the same window.
        return "skipped";
      }
      buckets += walk.buckets;
      journaledWindows += walk.windows;
      status = walk.status === "ok" ? "skipped" : walk.status;
    }

    // THE STEADY WINDOW, budget permitting. On a visit whose backfill is not yet
    // done this is the part that gets dropped first: history is durable in the
    // cursor and today's numbers will still be there tomorrow.
    let steadyComplete = false;
    if (status !== "deferred" && status !== "yielded" && hasDayCapacity() && hasChunkCapacity()) {
      const steady = await runSteady(candidate, cursor, issued);
      if (steady.status === "failed") {
        return "skipped";
      }
      buckets += steady.buckets;
      steadyComplete = steady.complete;
      status = steady.status === "ok" ? "visited" : steady.status;
    }

    if (journaledWindows === 0 && !steadyComplete) {
      // Nothing durable to call a visit. The cursor may still have MOVED — a
      // repeat guard or the creation floor closes a walk without any egress —
      // and that has to survive; an untouched cursor is not rewritten.
      if (JSON.stringify(backfillCursorJson(cursor)) !== cursorAtEntry) {
        await recordMediaStatsBackfillProgress(app.db, {
          pageId,
          subjectRef: candidate.subjectRef,
          backfillCursor: backfillCursorJson(cursor),
        });
      }
      await saveProgress();
      return status === "visited" ? "skipped" : status;
    }

    visited += 1;
    const intervalDays = mediaStatsIntervalDays(candidate.tier, longTailCycleDays);
    await recordMediaStatsVisit(app.db, {
      pageId,
      subjectRef: candidate.subjectRef,
      tier: candidate.tier,
      knownCount: buckets,
      visitedAt: now,
      nextDueAt: new Date(now.getTime() + intervalDays * DAY_MS),
      backfillCursor: backfillCursorJson(cursor),
      // A backfill-only visit read OLD windows. The dirty mark asks for TODAY's
      // numbers, so it survives until a steady refresh answers it.
      clearDirty: steadyComplete,
    });
    await saveProgress();
    return status === "skipped" ? "visited" : status;
  }

  /** What one item's backfill did this visit. `windows` counts JOURNALED
   *  responses — the measure of whether this was a look at all. */
  interface WalkResult {
    status: "ok" | "deferred" | "yielded" | "failed";
    windows: number;
    buckets: number;
  }

  /** Backwards 31-day daily windows, to the empty floor or to the item's own
   *  creation — whichever comes first. */
  async function runBackfill(
    candidate: MediaStatsRefreshCandidate,
    cursor: MediaBackfillCursor,
    issued: Set<string>,
  ): Promise<WalkResult> {
    // THE CREATION FLOOR, from the same age basis the tier is computed from.
    const creationFloorMs = mediaBackfillCreationFloorMs(candidate);
    let windows = 0;
    let journaledWindows = 0;
    let buckets = 0;
    let status: WalkResult["status"] = "ok";
    while (windows < BACKFILL_WINDOWS_PER_VISIT && !cursor.done) {
      // AN ITEM HAS NO TRAFFIC BEFORE IT EXISTED. Checked before the budget, so
      // a cursor already past the floor — the eight production cursors sitting
      // at 2006-04 — closes on its next visit without spending a request.
      if (creationFloorMs !== null && cursor.nextBeforeMs < creationFloorMs) {
        cursor.done = true;
        cursor.stopReason = "created_at_floor";
        cursor.floorBasis = "created_at";
        break;
      }
      if (!hasDayCapacity()) {
        status = "deferred";
        break;
      }
      if (!hasChunkCapacity()) {
        status = "yielded";
        break;
      }
      const requested = {
        beforeMs: cursor.nextBeforeMs,
        afterMs: cursor.nextBeforeMs - cursor.guard.spanDays * DAY_MS,
      };
      // The DURABLE half of the repeat guard, spent before any egress: this is
      // the one that survives a chunk boundary, and the loop on production
      // spanned five chunks.
      if (
        cursor.guard.lastBeforeMs === requested.beforeMs
        && cursor.guard.lastAfterMs === requested.afterMs
      ) {
        await handleUnhonouredWindow(candidate.subjectRef, cursor, requested, {
          trigger: "repeat_request",
        });
        break;
      }
      cursor.guard.lastBeforeMs = requested.beforeMs;
      cursor.guard.lastAfterMs = requested.afterMs;

      const outcome = await requestWindow(candidate.subjectRef, {
        periodMs: DAILY_PERIOD_MS,
        afterMs: requested.afterMs,
        beforeMs: requested.beforeMs,
        mode: "backfill",
        tier: candidate.tier,
      }, issued);
      windows += 1;
      backfillWindows += 1;
      if (outcome === "failed") {
        return { status: "failed", windows: journaledWindows, buckets };
      }
      if (outcome === "repeat") {
        await handleUnhonouredWindow(candidate.subjectRef, cursor, requested, {
          trigger: "repeat_request",
        });
        break;
      }
      journaledWindows += 1;
      buckets += outcome.buckets;
      cursor.guard.lastObservationId = outcome.observationId ?? cursor.guard.lastObservationId;

      if (!outcome.honoured) {
        const action = await handleUnhonouredWindow(candidate.subjectRef, cursor, requested, {
          trigger: "served_window",
          served: outcome.served,
        });
        if (action === "stopped") {
          break;
        }
        // Narrowed: try once more from the SAME upper bound.
        continue;
      }

      if (outcome.empty) {
        cursor.emptyStreak += 1;
        if (cursor.emptyStreak >= BACKFILL_EMPTY_STREAK_LIMIT) {
          // The floor. Two consecutive EMPTY windows — no non-zero counter in
          // either — means the item had no traffic before this point, and unlike
          // the account lane there is no [E10] long-idle case to probe past,
          // because an item cannot have traffic before it was published. Every
          // empty response is journaled: the empty window IS the floor evidence.
          cursor.done = true;
          cursor.stopReason = "empty_window_streak";
          cursor.floorBasis = "empty_window";
          break;
        }
        cursor.nextBeforeMs -= cursor.guard.spanDays * DAY_MS;
        continue;
      }

      cursor.emptyStreak = 0;
      // The floor only ever moves BACKWARDS.
      if (outcome.served.afterMs !== null) {
        const servedFloor = new Date(outcome.served.afterMs).toISOString();
        cursor.floorAt = cursor.floorAt === null || servedFloor < cursor.floorAt
          ? servedFloor
          : cursor.floorAt;
        // DERIVED FROM THE RETURNED BOUNDS, with one day of overlap: the
        // provider snaps windows to its own bucket grid, and a walk that stepped
        // back from OUR bound would drift a bucket per window and leave holes.
        cursor.nextBeforeMs = outcome.served.afterMs + BACKFILL_OVERLAP_DAYS * DAY_MS;
      } else {
        cursor.nextBeforeMs -= cursor.guard.spanDays * DAY_MS;
      }
    }

    return { status, windows: journaledWindows, buckets };
  }

  /** What one item's steady refresh did. `complete` means every window the tier
   *  asks for came back — a half-read tier is not a refresh. */
  interface SteadyResult {
    status: "ok" | "deferred" | "yielded" | "failed";
    buckets: number;
    complete: boolean;
  }

  /** The tier's trailing window: one call, except a long tail on a route that
   *  refuses 90 days. */
  async function runSteady(
    candidate: MediaStatsRefreshCandidate,
    cursor: MediaBackfillCursor,
    issued: Set<string>,
  ): Promise<SteadyResult> {
    const windows = steadyWindows(candidate.tier, now, state.longTailWindowMode);
    let buckets = 0;
    let served = 0;

    for (const [index, window] of windows.entries()) {
      if (!hasDayCapacity()) {
        // Out of the day's budget, possibly part way through a multi-window
        // long-tail refresh. What was fetched is journaled; the refresh is NOT
        // complete, so an item with nothing else to show for the visit stays
        // unvisited and tomorrow re-reads it whole rather than half.
        return { status: "deferred", buckets, complete: false };
      }
      if (!hasChunkCapacity()) {
        return { status: "yielded", buckets, complete: false };
      }
      const outcome = await requestWindow(candidate.subjectRef, {
        periodMs: window.periodMs,
        afterMs: window.afterMs,
        beforeMs: window.beforeMs,
        mode: "steady",
        tier: candidate.tier,
      }, issued);
      if (outcome === "failed") {
        return { status: "failed", buckets, complete: false };
      }
      if (outcome === "repeat") {
        break;
      }
      buckets += outcome.buckets;
      served += 1;

      // ── THE 90-DAY DISCOVERY, settled by what the route actually served ──
      //
      // It runs on the FIRST long-tail window only, and it is durable and
      // page-scoped: the answer is a property of the route, not of one item.
      if (candidate.tier === "long_tail" && index === 0) {
        // BOTH checks. `windowWasHonoured` is the loop guard every call carries;
        // the coverage check is what sees a same-end, narrower answer, which is
        // the only shape a refused TRAILING window can take.
        const covered = outcome.honoured
          && servedWindowCoversRequest(
            { afterMs: window.afterMs, beforeMs: window.beforeMs },
            outcome.served,
          );
        if (!covered && state.longTailWindowMode !== "split_31") {
          state = { ...state, longTailWindowMode: "split_31" };
          if (!state.longTailWindowAnnounced) {
            state = { ...state, longTailWindowAnnounced: true };
            await input.telemetry.addAnomaly({
              code: "fansly_media_stats_long_tail_window_split",
              severity: "info",
              message:
                "Fansly refused the 90-day per-media window; long-tail refresh now takes three "
                + "31-day windows, which TRIPLES what a long-tail visit costs",
              details: {
                mediaOfferRef: candidate.subjectRef,
                requestedSpanDays: LONG_TAIL_TRAILING_DAYS,
                servedAfter: outcome.served.afterMs === null
                  ? null
                  : new Date(outcome.served.afterMs).toISOString(),
                servedBefore: outcome.served.beforeMs === null
                  ? null
                  : new Date(outcome.served.beforeMs).toISOString(),
              },
            });
          }
          await saveProgress();
          // Re-run this item under the split plan, from the top. The window just
          // fetched is journaled either way — it is simply not the window we
          // asked for.
          const rerun = await runSteady(candidate, cursor, issued);
          return { ...rerun, buckets: buckets + rerun.buckets };
        }
        if (covered && state.longTailWindowMode === "unproven") {
          state = { ...state, longTailWindowMode: "ninety" };
          if (!state.longTailWindowAnnounced) {
            state = { ...state, longTailWindowAnnounced: true };
            await input.telemetry.addAnomaly({
              code: "fansly_media_stats_long_tail_window_proven",
              severity: "info",
              message:
                "Fansly HONOURS the 90-day per-media window; long-tail refresh is one call an item",
              details: { mediaOfferRef: candidate.subjectRef },
            });
          }
          await saveProgress();
        }
      }
    }

    return { status: "ok", buckets, complete: served === windows.length };
  }

  /**
   * The one exit. Every path reports the class census, the due backlog and the
   * live cycle — a dispatch that visited nothing still has to say where the
   * queue stands, because a progress block that goes blank when a lane defers
   * reads like the queue vanished.
   */
  async function finish(): Promise<StreamChunkResult> {
    const progress = await countMediaStatsRefreshProgress(app.db, {
      pageId,
      now,
      longTailCycleDays,
    });
    const cycle = estimateMediaStatsCycle({
      fresh: progress.fresh,
      mid: progress.mid,
      longTail: progress.longTail,
      dailyCap,
      longTailCycleDays,
    });
    // Due work this dispatch could not reach today. Reported, never acted on:
    // these are simply first in tomorrow's queue.
    const deferredToday = deferred === null
      ? state.deferredToday
      : Math.max(state.deferredToday, progress.dueNow);
    state = { ...state, deferredToday };

    const stats: Record<string, unknown> = {
      journaled,
      callsToday: state.callsToday,
      calledToday: state.callsToday,
      dailyCap,
      // ── the queue block ──
      mediaKnown: progress.mediaKnown,
      queueSize: progress.queueSize,
      classes: {
        fresh: progress.fresh,
        mid: progress.mid,
        longTail: progress.longTail,
        dirty: progress.dirty,
      },
      neverVisited: progress.neverVisited,
      dueToday: progress.dueNow,
      deferredToday,
      backfillComplete: progress.backfillComplete,
      // Items whose backfill STOPPED on a window the provider would not
      // honour. A hole we know about, which is the whole point of stopping
      // rather than looping — and it belongs where an operator reads, not in a
      // bespoke query.
      backfillStopped: progress.backfillStopped,
      // ── the honesty block (A16 item 3) ──
      estimatedCycleDays: cycle.estimatedCycleDays,
      requestsPerDayWanted: cycle.requestsPerDayWanted,
      saturating: cycle.saturating,
      longTailCycleDays,
      longTailWindowMode: state.longTailWindowMode,
      // ── this dispatch ──
      visitedThisChunk: visited,
      bucketsSeenThisChunk: bucketsSeen,
      backfillWindowsThisChunk: backfillWindows,
      topMediaMarkedDirty: topMarked,
      seedComplete: state.seedComplete,
      ...(deferred === null ? {} : { deferred }),
    };

    // The cycle is stated in WORDS, not left as a number nobody reads: A16's
    // whole point is that a long tail described as "monthly" while it is
    // quarterly is a lie the plan must not tell.
    app.logger.info(
      {
        pageId,
        mediaKnown: progress.mediaKnown,
        queueSize: progress.queueSize,
        fresh: progress.fresh,
        mid: progress.mid,
        longTail: progress.longTail,
        dirty: progress.dirty,
        dueToday: progress.dueNow,
        callsToday: state.callsToday,
        dailyCap,
        requestsPerDayWanted: cycle.requestsPerDayWanted,
        estimatedCycleDays: cycle.estimatedCycleDays,
        longTailWindowMode: state.longTailWindowMode,
      },
      cycle.quarterlyOrWorse
        ? `Fansly per-media statistics: the long tail comes round every `
          + `${cycle.estimatedCycleDays} days — QUARTERLY or worse, not monthly`
        : "Fansly per-media statistics cycle",
    );

    // COVERAGE. ONE row per page, never one per media (§3.4): a coverage row per
    // item would be a second queue of the same cardinality in a table whose
    // contract is "how far back does this plane reach". `proof` is `none`
    // because this row's claim is an aggregate over thousands of looks and no
    // single response proves it — pointing at the last one would be a lineage
    // that reads as evidence and is not. The per-look evidence is in the
    // journal, one observation per window, which is exactly what A21 says
    // per-look history is: a query, not a third copy.
    const everyItemVisited = progress.queueSize > 0
      && progress.neverVisited === 0
      && progress.backfillComplete >= progress.queueSize;
    const status: CaptureCoverageStatus = progress.queueSize === 0
      ? "not_started"
      : deferred !== null
      ? "budget_deferred"
      : everyItemVisited
      ? "window_captured"
      : "in_progress";
    await upsertCaptureCoverage(app.db, {
      pageId,
      platform: "fansly",
      plane: FANSLY_MEDIA_STATS_COVERAGE_PLANE,
      // Page-scoped: `page_id` is already in the key; the ref makes the scope
      // legible in a raw query.
      scopeRef: String(pageId),
      status,
      // Per-media windows are addressable backwards in time (the HAR proves a
      // historical window is served), so nothing this lane has not captured yet
      // is lost — it can still be asked for.
      acquisitionMode: "retroactive",
      proof: "none",
      newestCapturedAt: now,
      expectedCount: progress.queueSize,
      observedUniqueCount: progress.queueSize - progress.neverVisited,
      reasonCode: cycle.saturating ? "saturating_by_design" : null,
      cursor: {
        dueToday: progress.dueNow,
        deferredToday,
        estimatedCycleDays: cycle.estimatedCycleDays,
        requestsPerDayWanted: cycle.requestsPerDayWanted,
        longTailWindowMode: state.longTailWindowMode,
        backfillComplete: progress.backfillComplete,
        backfillStopped: progress.backfillStopped,
      },
    });

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
    if (!hasChunkCapacity()) {
      await saveProgress();
      return {
        satisfied: false,
        yieldReason: input.budget.resolveYieldReason(1),
        // SPREAD. At this lane's volume the steady state IS a deep walk, so the
        // continuation is jittered even when no backfill is running: an unspaced
        // 300-call day is ~13 contiguous minutes at ~23 requests a minute.
        continuationRetryAt: backfillContinuationAt(now, continuationDelayMs),
        stats,
      };
    }
    // An item whose backfill is not finished no longer holds the dispatch open:
    // it was VISITED, so it comes round again on its tier's cadence and resumes
    // from its cursor. What still holds the dispatch open is unreached DUE work,
    // which `moreWork` and the chunk-capacity branch above both cover.
    if (moreWork) {
      await saveProgress();
      return {
        satisfied: false,
        yieldReason: null,
        continuationRetryAt: backfillContinuationAt(now, continuationDelayMs),
        stats,
      };
    }
    const completed = await upsertCheckpoint(app.db, {
      platformAccountId: pageId,
      stream: STREAM,
      cursorText: state.longTailWindowMode,
      state: { ...state } as unknown as Record<string, unknown>,
      lastSuccessfulRunId: input.syncRunId,
    });
    await input.telemetry.recordCheckpointAdvanced(STREAM, summarizeCheckpoint(completed));
    return { satisfied: true, yieldReason: null, stats };
  }
}

/**
 * The steady windows for a tier, newest first.
 *
 * Fresh reads the last 24 hours at HOURLY granularity, mid the last 30 days
 * daily, long tail the last 90 days daily — as ONE window where the route
 * honours 90 days, and as three 31-day windows where it does not. The split
 * TRIPLES what a long-tail visit costs, which is why the mode is durable, is
 * announced once, and is reported in the progress block rather than discovered
 * silently on every visit.
 */
export function steadyWindows(
  tier: MediaStatsTier,
  now: Date,
  longTailMode: LongTailWindowMode,
): Array<{ periodMs: number; afterMs: number; beforeMs: number }> {
  const end = now.getTime();
  if (tier === "fresh") {
    return [{
      periodMs: HOURLY_PERIOD_MS,
      beforeMs: end,
      afterMs: end - FRESH_TRAILING_HOURS * HOUR_MS,
    }];
  }
  if (tier === "mid") {
    return [{
      periodMs: DAILY_PERIOD_MS,
      beforeMs: end,
      afterMs: end - MID_TRAILING_DAYS * DAY_MS,
    }];
  }
  if (longTailMode === "split_31") {
    return Array.from({ length: LONG_TAIL_SPLIT_WINDOWS }, (_unused, index) => {
      const beforeMs = end - index * BACKFILL_WINDOW_DAYS * DAY_MS;
      return {
        periodMs: DAILY_PERIOD_MS,
        beforeMs,
        afterMs: beforeMs - BACKFILL_WINDOW_DAYS * DAY_MS,
      };
    });
  }
  return [{
    periodMs: DAILY_PERIOD_MS,
    beforeMs: end,
    afterMs: end - LONG_TAIL_TRAILING_DAYS * DAY_MS,
  }];
}
