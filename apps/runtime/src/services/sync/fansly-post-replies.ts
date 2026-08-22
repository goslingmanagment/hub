// WP-F5 — the `post_replies` capture handler: the comment archive walk.
//
// One journaled call reads one post's replies. That is the whole lane, and
// everything below is about the three things that make it honest.
//
// ── 1. THE BARE GET, AND THE POST THIS SYSTEM NEVER SENDS ───────────────────
//
// Every observed `GET /post/{id}/replies` in the 2026-08-19 capture was
// preceded ~40 ms by `POST /api/v1/postreply/verify` carrying the same post id
// (5/5). [E1] existed to ask whether that POST was a server-side precondition;
// it is not — the bare GET returns the comments (A25, 2026-08-22). So the
// kernel never issues it. §1 excludes write-shaped calls to the platform, and a
// POST that "only verifies" is still a POST to somebody else's server on an
// account whose failure mode is a model ban. A test greps the adapter for the
// string `postreply/verify` and fails if it ever appears.
//
// ── 2. THE WALK QUEUE, AND WHY IT IS NOT A CURSOR ───────────────────────────
//
// There is no "next post" cursor here, because there is no order in which the
// back-catalogue should be read once. Posts are rows in `subject_refresh_state`
// (`plane='post_replies'`, `known_count` = the reply count that walk last saw),
// seeded in bounded keyset batches on first enable AND — for anything published
// afterwards — in the SAME TRANSACTION as the `creator_posts` upsert. Priority
// per chunk:
//
//   (1) never-walked, NEWEST POST FIRST. A comment archive that starts with the
//       posts nobody remembers is useless for a year.
//   (2) dirty — a head `reply_count` change or a comment-signal notification.
//   (3) round-robin re-walk of rows older than `fanslyRepliesRewalkCycleDays`.
//
// At 100 calls a page a UTC day, the biggest live page (1 318 roots) first-
// passes in ~14 days. That is the intended shape: burst, not daily volume, is
// the ban-risk surface.
//
// ── 3. PAGINATION IS UNPROVEN, AND THE LANE SAYS SO OUT LOUD ────────────────
//
// Five live responses carried 1, 1, 1, 1 and 4 replies. No cursor has ever been
// exercised, so nothing here may claim a complete read of a post with many
// comments. The first call is BARE. A page of >= 20 replies is suspiciously
// full, and only then does the walk try `?before=<last reply id>` — the
// convention `/timelinenew`, `/message` and `/notifications` all use, on a
// route whose replies come back descending by id.
//
// Whatever the cursor does, the lane records it ONCE:
//   - a second page with new rows  ⇒ `paginationMode = "before"`, one anomaly
//     announcing the discovery;
//   - the same page again, or empty ⇒ `paginationMode = "single_page"`, one
//     anomaly, and no post is ever paged again.
// The repeat-cursor guard throws the walk away rather than looping (the posts.ts
// law; WP-F1 spent a whole day's cap proving a loop on production).
//
// Until a mode is proven, a full-looking page stores `possiblyTruncated: true`
// on its rows and this lane's coverage reads `window_captured`, NEVER complete.
//
// ── AUTHOR HYDRATION (A27-1) ────────────────────────────────────────────────
//
// The `accounts[]` sidecar carries the comment's author as a FULL account
// record when it is populated — and it was EMPTY in 2 of 5 captured responses
// despite a comment existing. So the fallback is mandatory, not an optimization:
// at most ONE `/account?ids=` batch per chunk (<= 100 ids), journaled under the
// EXISTING `account_lookup` kind, which no canonicalizer family claims. That is
// deliberate and unchanged by this package: the identity that reaches storage is
// `post_comments.author_ref` plus the display fields the comment event carried,
// and the hydration exists so the identity is CAPTURED, not so it is parsed.
// Because nothing parses it, the "already looked up" set is capture state and
// lives in the cursor — a projection-derived queue would never drain.
//
// ── [A20] ON `accounts[]` ───────────────────────────────────────────────────
//
// That inline account record carries `lastSeenAt`, which changes every minute
// and makes every body unique, destroying the content-address dedup collapse
// the disk budget rests on. So `accounts[]` — and only `accounts[]` — goes
// through the 18-field allowlist before journaling. `posts`, `tips`, `tipGoals`,
// `stories`, `polls`, `accountMedia`, `aggregatedPosts` and every key the
// platform starts serving tomorrow pass through UNTOUCHED.

import {
  assertOwnedPageSyncLease,
  countPostComments,
  countPostRepliesWalkProgress,
  getCheckpoint,
  listPostRepliesWalkChunk,
  listUnnamedPostCommentAuthorRefs,
  recordPostRepliesWalkFailure,
  recordPostRepliesWalkVisit,
  seedPostRepliesWalkQueue,
  upsertCaptureCoverage,
  upsertCheckpoint,
  upsertCheckpointProgress,
  type CaptureCoverageProof,
  type CaptureCoverageStatus,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import type { HttpRequestEvent, HttpRequestObserver } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { REPLIES_FULL_PAGE_THRESHOLD } from "../canonicalize/fansly-comments.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { isPageAllowlisted } from "../voice-notes.ts";
import { composeRequestObservers } from "./chunk-budget.ts";
import type { ExecutorRequestContext, StreamChunkResult } from "./executor-handlers.ts";
import { summarizeCheckpoint } from "./observability.ts";
import { createSyncRateLimitWaiter } from "./rate-limiter.ts";
import {
  FANSLY_POST_REPLIES_CAPTURE_MAPPER_VERSION,
  persistRawPayload,
  retentionDate,
  trimFanslyPostRepliesPayload,
} from "./shared.ts";

const STREAM = "post_replies" as const;

const OBSERVATION_KINDS = {
  /** The walk itself. Claimed by the `fansly-comments` family. */
  postReplies: "post_replies",
  /** The author fallback. The EXISTING kind, deliberately unclaimed — this
   *  package does not claim it and does not parse it. */
  accountLookup: "account_lookup",
} as const;

/** One plane, page-scoped: the archive's progress over this page's roots. */
export const FANSLY_POST_REPLIES_COVERAGE_PLANE = "post_replies";

/** Posts walked in ONE dispatch before a jittered continuation. The chunk
 *  budget (5 requests / 45 s) bites long before this on a healthy lane; this is
 *  the ceiling for a lane being re-queued aggressively. */
const WALK_POSTS_PER_CHUNK = 20;

/** Roots seeded per dispatch on first enable. Bounded so a page with thousands
 *  of posts does not hold a write lock for a second, and keyset so the next
 *  batch resumes exactly where this one stopped even as posts are inserted
 *  underneath it. */
const SEED_BATCH_SIZE = 500;

/** Pages ONE post's walk may take before the lane gives up on it. A safety net
 *  against a cursor that advances by one row a page — not a coverage limit. No
 *  observed response ever carried more than four replies. */
const MAX_PAGES_PER_POST = 20;

/** Ids per `/account?ids=` batch — the adapter's own hard limit. */
const AUTHOR_HYDRATION_BATCH = 100;

/**
 * How many looked-up author refs the cursor remembers.
 *
 * The hydration is journal-only (nothing parses `account_lookup`), so the queue
 * cannot be derived from a projection and has to live here. The cap keeps the
 * checkpoint small; eviction means a re-lookup of an old author much later,
 * which costs one call out of a hundred and captures the identity again.
 */
const HYDRATED_AUTHOR_MEMORY = 1_000;

/** Page-size samples kept for the `p99PostsLength` progress figure. The plan
 *  asks for the p99 of `posts.length` to be MEASURED before the cap is raised;
 *  this is where the measurement comes from. */
const POSTS_LENGTH_SAMPLE_LIMIT = 200;

const BACKFILL_JITTER_FRACTION = 0.3;

// ── cursor state ─────────────────────────────────────────────────────────────

/** What the lane has learned about this route's pagination. Durable, because
 *  the discovery is expensive and must be announced exactly once. */
export type RepliesPaginationMode = "unproven" | "before" | "single_page";

export interface FanslyPostRepliesCursorState {
  version: 1;
  /** The UTC day `callsToday` belongs to; a different day resets the counter. */
  utcDay: string;
  /** HTTP ATTEMPTS spent by this lane on `utcDay`. Retries included. */
  callsToday: number;
  /** Keyset cursor of the first-enable seeding sweep. */
  seedCursor: string | null;
  seedComplete: boolean;
  paginationMode: RepliesPaginationMode;
  /** The discovery anomaly is raised ONCE, ever. */
  paginationAnnounced: boolean;
  /** Author refs already looked up through `/account?ids=`. */
  hydratedAuthorRefs: string[];
  /** Observed `posts.length` values, newest last. */
  postsLengthSamples: number[];
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

function asStringList(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
      .slice(-limit)
    : [];
}

function asPaginationMode(value: unknown): RepliesPaginationMode {
  return value === "before" || value === "single_page" ? value : "unproven";
}

export function parseFanslyPostRepliesCursorState(
  value: unknown,
): FanslyPostRepliesCursorState | null {
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
    seedCursor: asNullableString(state.seedCursor),
    seedComplete: state.seedComplete === true,
    paginationMode: asPaginationMode(state.paginationMode),
    paginationAnnounced: state.paginationAnnounced === true,
    hydratedAuthorRefs: asStringList(state.hydratedAuthorRefs, HYDRATED_AUTHOR_MEMORY),
    postsLengthSamples: Array.isArray(state.postsLengthSamples)
      ? state.postsLengthSamples
        .filter((item): item is number => typeof item === "number" && Number.isSafeInteger(item))
        .slice(-POSTS_LENGTH_SAMPLE_LIMIT)
      : [],
  };
}

export function emptyFanslyPostRepliesCursorState(now: Date): FanslyPostRepliesCursorState {
  return {
    version: 1,
    utcDay: utcDayKey(now),
    callsToday: 0,
    seedCursor: null,
    seedComplete: false,
    paginationMode: "unproven",
    paginationAnnounced: false,
    hydratedAuthorRefs: [],
    postsLengthSamples: [],
  };
}

export function utcDayKey(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** A new UTC day resets the attempt counter and NOTHING else: a walk queue is
 *  durable state and a pagination discovery is a fact, not a daily allowance. */
export function rollUtcDay(
  state: FanslyPostRepliesCursorState,
  now: Date,
): FanslyPostRepliesCursorState {
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

/**
 * The `posts[]` rows of a reply page.
 *
 * `null` means "this is not a reply page" — a shape the walk refuses to read as
 * an answer. An empty array means "no replies", which INCLUDES the adapter's
 * `{__empty: true}` marker for a 204 or a zero-length body: all three forms are
 * the same honest answer, and none of the three has ever been observed live.
 */
export function replyRows(payload: unknown): Record<string, unknown>[] | null {
  const record = asRecord(payload);
  if (record === null) {
    return null;
  }
  if (record.__empty === true) {
    return [];
  }
  if (!Array.isArray(record.posts)) {
    return null;
  }
  return record.posts.filter((row): row is Record<string, unknown> => asRecord(row) !== null);
}

/** The cursor the NEXT page would carry: the last reply's own id. Replies come
 *  back descending by id, which is what makes `before` the plausible form. */
export function nextRepliesCursor(rows: readonly Record<string, unknown>[]): string | null {
  const last = rows[rows.length - 1];
  return last === undefined ? null : asNullableString(last.id);
}

/** The author refs a reply page named, in order, de-duplicated. */
export function replyAuthorRefs(rows: readonly Record<string, unknown>[]): string[] {
  const refs: string[] = [];
  for (const row of rows) {
    const ref = asNullableString(row.accountId);
    if (ref !== null && !refs.includes(ref)) {
      refs.push(ref);
    }
  }
  return refs;
}

/** True when this page carried an `accounts[]` sidecar with rows. EMPTY in 2 of
 *  5 live responses, which is the whole reason the hydration fallback exists. */
export function hasAccountSidecar(payload: unknown): boolean {
  const record = asRecord(payload);
  return record !== null && Array.isArray(record.accounts) && record.accounts.length > 0;
}

/**
 * The p99 of the observed page sizes, by nearest-rank.
 *
 * It is a NAMED criterion of the cap raise (100 → 300/day): "measured
 * `posts.length` p99 known". Reporting it from the lane is what makes that
 * criterion checkable without a bespoke query.
 */
export function p99PostsLength(samples: readonly number[]): number | null {
  if (samples.length === 0) {
    return null;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.ceil(sorted.length * 0.99);
  return sorted[Math.max(0, rank - 1)] ?? null;
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

function isAuthFailure(error: unknown): boolean {
  return error instanceof FanslyApiError && (error.status === 401 || error.status === 403);
}

// ── the handler ──────────────────────────────────────────────────────────────

function skip(reason: string): StreamChunkResult {
  return { satisfied: true, yieldReason: null, stats: { skipped: reason }, gatedSkip: reason };
}

export async function fanslyPostRepliesChunk(
  app: AppContext,
  input: ExecutorRequestContext & { syncRunId: number; now?: Date },
): Promise<StreamChunkResult> {
  if (input.pageContext.platform !== "fansly") {
    return skip("not_fansly");
  }
  await input.telemetry.recordPhaseStarted(STREAM);

  const effective = await loadEffectiveConfig(app.db, app.config);
  if (effective.fanslyPostRepliesSyncEnabled !== true) {
    return skip("flag_off");
  }
  // FAIL-CLOSED (S4): empty = NO pages. Deliberately NOT `fanslyNewStreamAllowed`,
  // whose empty CSV means every page — using it here would open the lane
  // fleet-wide on the deploy that ships it.
  if (!isPageAllowlisted(effective.fanslyPostRepliesPageAllowlist, input.pageContext.page.label)) {
    return skip("not_allowlisted");
  }

  const now = input.now ?? new Date();
  const pageId = input.pageContext.page.id;
  const dailyCap = Math.max(1, effective.fanslyRepliesDailyCallBudget ?? 100);
  const rewalkCycleDays = Math.max(1, effective.fanslyRepliesRewalkCycleDays ?? 14);
  const continuationDelayMs = Math.max(0, effective.fanslyBackfillContinuationDelayMs ?? 20_000);
  const rewalkBefore = new Date(now.getTime() - rewalkCycleDays * 24 * 60 * 60_000);

  const checkpoint = await getCheckpoint(app.db, pageId, STREAM);
  await input.telemetry.recordCheckpointLoaded(STREAM, summarizeCheckpoint(checkpoint));
  let state = rollUtcDay(
    parseFanslyPostRepliesCursorState(checkpoint?.state)
      ?? emptyFanslyPostRepliesCursorState(now),
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
  let walked = 0;
  let repliesSeen = 0;
  let truncatedPages = 0;
  let hydratedAuthors = 0;
  let deferred: string | null = null;

  /**
   * Journal FIRST, always, and apply the [A20] allowlist to the embedded
   * `accounts[]` on the way in.
   *
   * The OBSERVATION additionally carries the walk's request context, because
   * `/post/{postId}/replies` puts the post id in the PATH: an empty reply page
   * is a body with no way to say which post it is about, and that is exactly
   * the body `missing_since` is computed from. `sync_raw_payloads` still stores
   * the (trimmed) response verbatim — the envelope adds context, it removes
   * nothing.
   */
  const persistWalk = async (
    postId: string,
    before: string | null,
    payload: unknown,
  ) => {
    const trimmed = trimFanslyPostRepliesPayload(payload);
    const result = await persistRawPayload(app.db, {
      platformAccountId: pageId,
      syncRunId: input.syncRunId,
      endpoint: OBSERVATION_KINDS.postReplies,
      requestParams: { postId, before },
      responsePayload: trimmed,
      mapperVersion: FANSLY_POST_REPLIES_CAPTURE_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: "inserting Fansly post replies raw payload",
      platform: "fansly",
      observationPayload: { walk: { postId, before }, response: trimmed },
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
      cursorText: state.paginationMode,
      state: { ...state } as unknown as Record<string, unknown>,
    });
    await input.telemetry.recordCheckpointAdvanced(STREAM, summarizeCheckpoint(advanced));
  };

  const completeSlot = async () => {
    const completed = await upsertCheckpoint(app.db, {
      platformAccountId: pageId,
      stream: STREAM,
      cursorText: state.paginationMode,
      state: { ...state } as unknown as Record<string, unknown>,
      lastSuccessfulRunId: input.syncRunId,
    });
    await input.telemetry.recordCheckpointAdvanced(STREAM, summarizeCheckpoint(completed));
  };

  const coverage = async (
    status: CaptureCoverageStatus,
    proof: CaptureCoverageProof,
    extra: {
      proofObservationId?: number | null;
      reasonCode?: string | null;
      observedUniqueCount?: number | null;
      expectedCount?: number | null;
      cursor?: Record<string, unknown>;
    } = {},
  ) => {
    await upsertCaptureCoverage(app.db, {
      pageId,
      platform: "fansly",
      plane: FANSLY_POST_REPLIES_COVERAGE_PLANE,
      // Page-scoped: the archive's progress over THIS page's roots. `page_id` is
      // already in the key; the ref makes the scope legible in a raw query.
      scopeRef: String(pageId),
      status,
      // Comments that exist today can be re-read tomorrow: nothing on this lane
      // is announced once, unlike the notification poll.
      acquisitionMode: "retroactive",
      proof,
      newestCapturedAt: now,
      ...extra,
    });
  };

  // ── SEEDING ────────────────────────────────────────────────────────────────
  //
  // First enable only, in bounded keyset batches, and it costs ZERO platform
  // calls: `creator_posts` is already in the database. Everything published
  // AFTER this sweep is queued by the creator-posts projector in the same
  // transaction as its own upsert, so the seeding never has to run twice.
  if (!state.seedComplete) {
    for (;;) {
      const seeded = await seedPostRepliesWalkQueue(app.db, {
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

  // ── THE WALK ───────────────────────────────────────────────────────────────
  const candidates = await listPostRepliesWalkChunk(app.db, {
    pageId,
    limit: WALK_POSTS_PER_CHUNK,
    rewalkBefore,
  });

  // A full chunk almost certainly means more roots are owed; the continuation
  // is jittered rather than immediate either way.
  let moreWork = candidates.length >= WALK_POSTS_PER_CHUNK;

  for (const candidate of candidates) {
    if (!input.budget.hasRequestCapacity(1) || !input.budget.hasWallClockCapacity()) {
      moreWork = true;
      break;
    }
    if (!hasDayCapacity()) {
      deferred = "daily_call_budget";
      break;
    }

    let before: string | null = null;
    let lastRequestedBefore: string | null = null;
    /** The ids the PREVIOUS page served — the only way to tell "the cursor
     *  moved" from "the route ignored it and served the same page again". */
    let previousPageIds: string[] = [];
    let pages = 0;
    let seenForPost = 0;
    let walkUsable = true;

    for (;;) {
      // REPEAT-REQUEST GUARD, spent before any egress. The identical `before`
      // twice in one walk is a loop's first visible step, and there is nothing
      // to learn from issuing it.
      if (before !== null && before === lastRequestedBefore) {
        await input.telemetry.addAnomaly({
          code: "fansly_replies_cursor_repeat",
          severity: "warn",
          message: "Fansly reply pagination did not advance; post walk stopped",
          details: { postRef: candidate.subjectRef, before },
        });
        break;
      }
      if (pages >= MAX_PAGES_PER_POST) {
        await input.telemetry.addAnomaly({
          code: "fansly_replies_walk_capped",
          severity: "warn",
          message: "Fansly reply walk hit its page cap before exhausting the post",
          details: { postRef: candidate.subjectRef, pages },
        });
        break;
      }

      await assertOwnedPageSyncLease(app.db);
      const requestedBefore: string | null = before;
      let raw: unknown;
      try {
        const response = await app.adapter.getPostRepliesPage(requestContext, {
          postId: candidate.subjectRef,
          before: requestedBefore,
        });
        raw = response.raw;
      } catch (error) {
        // A dead session is the executor's business, not this loop's: re-raise
        // it untouched so the auth pause fires. Everything else is scoped to
        // ONE post — a single unreachable post must not wedge an archive of
        // thousands.
        if (isAuthFailure(error)) {
          throw error;
        }
        state = { ...state, callsToday: state.callsToday + attempts.take() };
        await input.telemetry.addAnomaly({
          code: "fansly_replies_post_failed",
          severity: "warn",
          message: "Fansly reply walk failed for one post; the rest of the queue continues",
          details: {
            postRef: candidate.subjectRef,
            status: error instanceof FanslyApiError ? error.status ?? null : null,
          },
        });
        await recordPostRepliesWalkFailure(app.db, {
          pageId,
          subjectRef: candidate.subjectRef,
          nextDueAt: new Date(now.getTime() + 24 * 60 * 60_000),
        });
        walkUsable = false;
        break;
      }

      lastRequestedBefore = requestedBefore;
      const persisted = await persistWalk(candidate.subjectRef, requestedBefore, raw);
      pages += 1;

      const rows = replyRows(raw);
      if (rows === null) {
        // A body that is neither a reply page nor an honest empty answer. It is
        // journaled (above, before this check) and refused as an ANSWER:
        // recording "no comments" from a shape we cannot read is how an archive
        // deletes itself.
        await input.telemetry.addAnomaly({
          code: "fansly_replies_shape_unreadable",
          severity: "warn",
          message: "Fansly reply page had no posts[]; body journaled, walk not advanced",
          details: { postRef: candidate.subjectRef, before: requestedBefore },
        });
        await recordPostRepliesWalkFailure(app.db, {
          pageId,
          subjectRef: candidate.subjectRef,
          nextDueAt: new Date(now.getTime() + 24 * 60 * 60_000),
        });
        walkUsable = false;
        break;
      }

      const pageIds = rows.map((row) => asNullableString(row.id) ?? "");
      seenForPost += rows.length;
      state = {
        ...state,
        postsLengthSamples: [...state.postsLengthSamples, rows.length]
          .slice(-POSTS_LENGTH_SAMPLE_LIMIT),
      };
      // Logged at INFO: `posts.length` per call is the ONLY way the page-size
      // question gets answered, and a measured p99 is a NAMED criterion of the
      // cap raise.
      app.logger.info(
        {
          pageId,
          postRef: candidate.subjectRef,
          postsLength: rows.length,
          before: requestedBefore,
          accountsSidecar: hasAccountSidecar(raw),
          observationId: persisted.observationId ?? null,
        },
        "Fansly post replies page",
      );

      // ── PAGINATION DISCOVERY, settled by what the cursor actually did ──
      //
      // This runs on the page that CAME BACK from a cursor, not on the decision
      // to send one, because the question is empirical: did `?before=` serve a
      // different page, or did the route ignore it?
      if (requestedBefore !== null && state.paginationMode === "unproven") {
        const sameAsPrevious = pageIds.length === previousPageIds.length
          && pageIds.every((id, index) => id === previousPageIds[index]);
        // An EMPTY page after a cursor means the cursor was honoured and there
        // is nothing older — a route that ignored `before` would have served
        // the same rows again.
        const mode: RepliesPaginationMode = sameAsPrevious ? "single_page" : "before";
        state = { ...state, paginationMode: mode };
        if (!state.paginationAnnounced) {
          state = { ...state, paginationAnnounced: true };
          await input.telemetry.addAnomaly({
            code: "fansly_replies_pagination_discovered",
            severity: "info",
            message: mode === "before"
              ? "Fansly /post/{id}/replies HONOURS ?before= — reply pagination is proven"
              : "Fansly /post/{id}/replies IGNORES ?before= — the route serves one page, "
                + "so a full page stays possiblyTruncated and no post is paged again",
            details: {
              postRef: candidate.subjectRef,
              mode,
              firstPageRows: previousPageIds.length,
              secondPageRows: pageIds.length,
            },
          });
        }
        await saveProgress();
        if (mode === "single_page") {
          // The cursor bought nothing and the rows it served are the rows we
          // already have. Stop, and never page any post again.
          break;
        }
      }

      previousPageIds = pageIds;

      const full = rows.length >= REPLIES_FULL_PAGE_THRESHOLD;
      if (full) {
        truncatedPages += 1;
      }
      // A cursor is attempted ONLY on a suspiciously full page, and never once
      // the route has told us it does not page.
      if (!full || state.paginationMode === "single_page") {
        break;
      }
      const cursor = nextRepliesCursor(rows);
      if (cursor === null) {
        await input.telemetry.addAnomaly({
          code: "fansly_replies_cursor_missing",
          severity: "warn",
          message: "Fansly reply page carried rows with no id; post walk stopped",
          details: { postRef: candidate.subjectRef, rows: rows.length },
        });
        break;
      }
      if (!hasDayCapacity()) {
        // Out of the day's budget mid-post. The pages already fetched are
        // journaled; the post stays UNVISITED so the next dispatch re-reads it
        // from the head rather than resuming into a cursor nobody has proven.
        deferred = "daily_call_budget";
        walkUsable = false;
        break;
      }
      if (!input.budget.hasRequestCapacity(1) || !input.budget.hasWallClockCapacity()) {
        moreWork = true;
        walkUsable = false;
        break;
      }
      before = cursor;
    }

    if (!walkUsable) {
      await saveProgress();
      if (deferred !== null) {
        break;
      }
      continue;
    }

    walked += 1;
    repliesSeen += seenForPost;
    await recordPostRepliesWalkVisit(app.db, {
      pageId,
      subjectRef: candidate.subjectRef,
      knownCount: seenForPost,
      visitedAt: now,
      nextDueAt: new Date(now.getTime() + rewalkCycleDays * 24 * 60 * 60_000),
    });
    await saveProgress();
  }

  // ── AUTHOR HYDRATION (A27-1), at most ONE batch per chunk ─────────────────
  //
  // The `accounts[]` sidecar was EMPTY in 2 of 5 captured responses despite a
  // comment existing, so this path is mandatory rather than an optimization: it
  // is how the author of a comment gets CAPTURED at all on those responses.
  //
  // It journals under the EXISTING `account_lookup` kind, which no
  // canonicalizer family claims — and this package deliberately does not claim
  // it. Nothing parses the result, so the "already looked up" set cannot be
  // derived from a projection and lives in the cursor instead; a
  // projection-derived queue would re-request the same hundred refs every day
  // forever and never drain.
  if (
    deferred === null && hasDayCapacity()
    && input.budget.hasRequestCapacity(1) && input.budget.hasWallClockCapacity()
  ) {
    const known = new Set(state.hydratedAuthorRefs);
    const pending = (await listUnnamedPostCommentAuthorRefs(app.db, {
      pageId,
      // Over-read, then drop what the cursor already remembers, so a page whose
      // first hundred authors are known still makes progress.
      limit: AUTHOR_HYDRATION_BATCH * 4,
    })).filter((ref) => !known.has(ref)).slice(0, AUTHOR_HYDRATION_BATCH);

    if (pending.length > 0) {
      await assertOwnedPageSyncLease(app.db);
      const response = await app.adapter.getAccountsByIdsPage(requestContext, pending);
      await persistRawPayload(app.db, {
        platformAccountId: pageId,
        syncRunId: input.syncRunId,
        endpoint: OBSERVATION_KINDS.accountLookup,
        requestParams: { idCount: pending.length, origin: STREAM },
        responsePayload: response.raw,
        mapperVersion: FANSLY_POST_REPLIES_CAPTURE_MAPPER_VERSION,
        payloadKind: "mapping_critical",
        retainUntil: retentionDate(),
      }, {
        action: "inserting Fansly comment author lookup raw payload",
        platform: "fansly",
      });
      journaled += 1;
      hydratedAuthors = pending.length;
      state = {
        ...state,
        callsToday: state.callsToday + attempts.take(),
        hydratedAuthorRefs: [...state.hydratedAuthorRefs, ...pending]
          .slice(-HYDRATED_AUTHOR_MEMORY),
      };
      await saveProgress();
    }
  }

  return await finish();

  /**
   * The one exit. Every path reports the archive's progress, because a
   * dispatch that walked nothing still has to say where the first pass stands —
   * a progress block that goes blank when a sweep is deferred reads like the
   * archive vanished.
   */
  async function finish(): Promise<StreamChunkResult> {
    const progress = await countPostRepliesWalkProgress(app.db, pageId);
    const archive = await countPostComments(app.db, pageId);

    const stats: Record<string, unknown> = {
      journaled,
      callsToday: state.callsToday,
      dailyCap,
      // ── the progress block ──
      rootsKnown: progress.rootsKnown,
      rootsWalked: progress.rootsWalked,
      rootsDirty: progress.rootsDirty,
      postsKnown: progress.postsKnown,
      commentsSeen: archive.total,
      commentsMissing: archive.missing,
      possiblyTruncated: archive.possiblyTruncated,
      paginationMode: state.paginationMode,
      p99PostsLength: p99PostsLength(state.postsLengthSamples),
      walkedThisChunk: walked,
      repliesSeenThisChunk: repliesSeen,
      truncatedPagesThisChunk: truncatedPages,
      hydratedAuthors,
      seedComplete: state.seedComplete,
      ...(deferred === null ? {} : { deferred }),
    };

    // COVERAGE. `provider_exhausted` is claimable only when every root has been
    // walked AND nothing is marked possibly-truncated: on an unproven-pagination
    // route, a full page means the window was captured, never the whole surface.
    const everyRootWalked = progress.rootsKnown > 0
      && progress.rootsWalked >= progress.rootsKnown;
    const status: CaptureCoverageStatus = progress.rootsKnown === 0
      ? "not_started"
      : deferred !== null
      ? "budget_deferred"
      : everyRootWalked && archive.possiblyTruncated === 0
      ? "provider_exhausted"
      : everyRootWalked
      ? "window_captured"
      : "in_progress";
    await coverage(
      status,
      status === "provider_exhausted" ? "terminal_response" : "none",
      {
        reasonCode: status === "window_captured" ? "pagination_unproven" : null,
        expectedCount: progress.rootsKnown,
        observedUniqueCount: progress.rootsWalked,
        cursor: {
          paginationMode: state.paginationMode,
          possiblyTruncated: archive.possiblyTruncated,
          p99PostsLength: p99PostsLength(state.postsLengthSamples),
        },
      },
    );

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
        continuationRetryAt: walkContinuationAt(now, continuationDelayMs),
        stats,
      };
    }
    if (moreWork) {
      // More roots are owed and there is budget for them; hand the rest of the
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
