import {
  assertOwnedPageSyncLease,
  countPostEngagementRefreshProgress,
  createOrGetOfapiCaptureJob,
  findActiveOfapiCaptureJobBySlot,
  findPageById,
  getCheckpoint,
  getOfapiCaptureJob,
  listPagesByPlatform,
  listPageSyncStates,
  listPostEngagementRefreshChunk,
  pausePageSync,
  postEngagementIntervalDays,
  recordPostEngagementRefreshFailures,
  recordPostEngagementRefreshVisits,
  seedPostEngagementQueue,
  upsertCheckpoint,
  upsertCheckpointProgress,
  type PageSyncLease,
  type PostEngagementRefreshCandidate,
} from "@agency_hub_core/db";
import { POST_BATCH_SIZE } from "@agency_hub_core/fansly";
import type { HttpRequestEvent, HttpRequestObserver } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { resolveFanslyPlatformAccountId } from "../fansly.ts";
import { isOfapiBackgroundCaptureRunnable } from "../ofapi-capture-jobs.ts";
import type { ResolvedPageContext } from "../page-context.ts";
import { composeRequestObservers, type SyncChunkBudget } from "./chunk-budget.ts";
import type { StreamChunkResult } from "./executor-handlers.ts";
import { summarizeCheckpoint, type SyncRunTelemetry } from "./observability.ts";
import { createSyncRateLimitWaiter } from "./rate-limiter.ts";
import { persistRawPayload, retentionDate } from "./shared.ts";

const FANSLY_POSTS_MAPPER_VERSION = "fansly-posts-v1";
const FANSLY_POST_TIPS_MAPPER_VERSION = "fansly-post-tips-v2";
/** Every six-hour posts run refreshes at least this recent publication window.
 * One additional fully-old provider page may be captured to prove the bound. */
export const FANSLY_RECENT_POST_REFRESH_LOOKBACK_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1_000;
const OFAPI_POSTS_CAPTURE_LIMIT = 100;
const OFAPI_POSTS_CAPTURE_MAX_PAGES = 1_000;
const OFAPI_POSTS_CAPTURE_PRIORITY = 30;

export type OnlyFansPostsCaptureIneligibility =
  | "ofapi_posts_capture_disabled"
  | "ofapi_account_unmapped";

export class PostsCaptureConfigurationError extends Error {
  constructor(readonly code: OnlyFansPostsCaptureIneligibility) {
    super(code === "ofapi_posts_capture_disabled"
      ? "OnlyFans posts capture is disabled; manual action required: enable OFAPI_MIRROR_BACKGROUND_CAPTURE_ENABLED before activating this page"
      : "OnlyFans posts capture requires an OFAPI account mapping; manual action required: map this page before activating posts");
    this.name = "PostsCaptureConfigurationError";
  }
}

export class PostsCaptureJobBlockedError extends Error {
  constructor(
    readonly jobId: string,
    readonly reasonCode: string,
  ) {
    super(`OFAPI posts capture job ${jobId} blocked: ${reasonCode}`);
    this.name = "PostsCaptureJobBlockedError";
  }
}

export function getOnlyFansPostsCaptureIneligibility(
  config: Pick<AppContext["config"], "ofapiMirrorBackgroundCaptureEnabled"> | undefined,
  page: { platform: string; ofapiAccountId?: string | null },
): OnlyFansPostsCaptureIneligibility | null {
  if (page.platform !== "onlyfans") {
    return null;
  }
  if (!isOfapiBackgroundCaptureRunnable(config)) {
    return "ofapi_posts_capture_disabled";
  }
  return typeof page.ofapiAccountId === "string" && page.ofapiAccountId.length > 0
    ? null
    : "ofapi_account_unmapped";
}

async function pauseOnlyFansPostsForPage(app: AppContext, pageId: number, now: Date) {
  const states = await listPageSyncStates(app.db, { pageId, streams: ["posts"] });
  if (states.length === 1 && states[0]?.status === "paused") {
    return false;
  }
  await pausePageSync(app.db, { pageId, streams: ["posts"], now });
  return true;
}

/** Keep an activated OnlyFans lane inert when its global gate or page mapping
 * disappears. Re-enabling either prerequisite does not auto-resume the page;
 * the operator must use the explicit per-page `posts` scope again. */
export async function pauseIneligibleOnlyFansPostsForPage(
  app: AppContext,
  pageId: number,
  now = new Date(),
) {
  const stored = await findPageById(app.db, pageId);
  if (
    !stored ||
    stored.page.platform !== "onlyfans" ||
    getOnlyFansPostsCaptureIneligibility(app.config, stored.page) === null
  ) {
    return false;
  }
  return pauseOnlyFansPostsForPage(app, pageId, now);
}

export async function pauseIneligibleOnlyFansPostsForAllPages(
  app: AppContext,
  now = new Date(),
) {
  let pausedPages = 0;
  const pages = await listPagesByPlatform(app.db, "onlyfans");
  for (const page of pages) {
    if (
      getOnlyFansPostsCaptureIneligibility(app.config, page) !== null &&
      await pauseOnlyFansPostsForPage(app, page.id, now)
    ) {
      pausedPages += 1;
    }
  }
  return pausedPages;
}

type ExecutorRequestContext = {
  budget: SyncChunkBudget;
  pageContext: ResolvedPageContext;
  telemetry: SyncRunTelemetry;
  streamState: PageSyncLease;
  syncRunId: number;
  /** Deterministic clock seam for bounded-refresh tests. */
  now?: Date;
};

export type PostsCursorState = {
  version: 1;
  platform: "fansly" | "onlyfans";
  revision: number;
  headPostId: string | null;
  anchorPostId: string | null;
  capturedHeadPostId: string | null;
  before: string;
  pageIndex: number;
  pendingCaptureJobId: string | null;
  /** Null only on checkpoints written before the companion tip request. */
  fanslyPostTipsCaptureVersion: 1 | null;
  /** Durable one-time upgrade marker. Null on legacy checkpoints forces a
   * full Fansly walk so pre-existing posts receive monetization/tip capture. */
  fanslyPostTipsBackfilledAt: string | null;
  /** Frozen lower publication bound for this ordinary refresh walk. Null only
   * for the one-time full backfill and for non-Fansly state. */
  fanslyRecentRefreshCutoffAt: string | null;
  /** Durable because a refresh may cross chunk or request-generation bounds. */
  fanslyRecentRefreshAnchorReached: boolean;
  completedAt: string | null;
  /** WP-F6. The engagement refresh phase's own state, carried ACROSS request
   *  generations: the timeline walk restarts every cadence, the day's call
   *  count and the seeding sweep must not. */
  fanslyPostEngagement: PostsEngagementCursor;
};

/** WP-F6: the engagement phase's durable state, nested inside the posts cursor
 *  because the phase rides the EXISTING `posts` stream and a stream has one
 *  checkpoint. Its call counter is SEPARATE from the timeline walk's budget by
 *  construction — the timeline is not capped, and capping it here would let a
 *  refresh phase starve the capture the whole system depends on. */
export type PostsEngagementCursor = {
  /** The UTC day `callsToday` belongs to; a different day resets the counter. */
  utcDay: string | null;
  /** HTTP ATTEMPTS this phase spent on `utcDay`. Retries included. */
  callsToday: number;
  /** Keyset cursor of the first-enable seeding sweep over `creator_posts`. */
  seedCursor: string | null;
  seedComplete: boolean;
};

export function emptyPostsEngagementCursor(): PostsEngagementCursor {
  return { utcDay: null, callsToday: 0, seedCursor: null, seedComplete: false };
}

function parsePostsEngagementCursor(value: unknown): PostsEngagementCursor {
  const state = asRecord(value);
  if (!state) {
    // Legacy checkpoints predate the phase. An absent block is "never run",
    // not a parse failure: refusing the whole cursor here would restart the
    // timeline walk from the head on the deploy that ships WP-F6.
    return emptyPostsEngagementCursor();
  }
  const utcDay = typeof state.utcDay === "string" && state.utcDay.length > 0
    ? state.utcDay
    : null;
  const callsToday = typeof state.callsToday === "number"
      && Number.isSafeInteger(state.callsToday) && state.callsToday >= 0
    ? state.callsToday
    : 0;
  const seedCursor = typeof state.seedCursor === "string" && state.seedCursor.length > 0
    ? state.seedCursor
    : null;
  return { utcDay, callsToday, seedCursor, seedComplete: state.seedComplete === true };
}

/** A new UTC day resets the attempt counter and NOTHING else: a seeding sweep
 *  is durable progress, not a daily allowance. */
export function rollPostsEngagementUtcDay(
  engagement: PostsEngagementCursor,
  now: Date,
): PostsEngagementCursor {
  const today = now.toISOString().slice(0, 10);
  return engagement.utcDay === today
    ? engagement
    : { ...engagement, utcDay: today, callsToday: 0 };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === "string" ? value : undefined;
}

type FanslyPostTipScopeReason = "receiver_mismatch" | "post_target_out_of_scope";

export function inspectFanslyPostTipsScope(
  raw: unknown,
  input: { requestedTargetIds: readonly string[]; receiverId: string },
): {
  accepted: boolean;
  rejectedItemIndexes: number[];
  reasons: FanslyPostTipScopeReason[];
} {
  if (!Array.isArray(raw)) {
    // Top-level drift stays in the ordinary post_tips lane as replayable parse
    // debt. Scope is unknowable until a future parser recognizes the envelope.
    return { accepted: true, rejectedItemIndexes: [], reasons: [] };
  }
  const requested = new Set(input.requestedTargetIds);
  const rejectedItemIndexes = new Set<number>();
  const reasons = new Set<FanslyPostTipScopeReason>();
  for (const [index, item] of raw.entries()) {
    const tip = asRecord(item);
    if (!tip) continue;
    const receiverId = typeof tip.receiverId === "string"
      ? tip.receiverId
      : typeof tip.receiverId === "number" && Number.isFinite(tip.receiverId)
        ? String(tip.receiverId)
        : null;
    if (receiverId !== null && receiverId !== input.receiverId) {
      rejectedItemIndexes.add(index);
      reasons.add("receiver_mismatch");
    }
    const flatPostRef = typeof tip.targetId === "string"
      ? tip.targetId
      : typeof tip.targetId === "number" && Number.isFinite(tip.targetId)
        ? String(tip.targetId)
        : null;
    if (flatPostRef !== null && !requested.has(flatPostRef)) {
      rejectedItemIndexes.add(index);
      reasons.add("post_target_out_of_scope");
    }
    if (!Array.isArray(tip.targets)) continue;
    for (const candidate of tip.targets) {
      const target = asRecord(candidate);
      if (!target || target.type !== 1000) continue;
      const postRef = typeof target.id === "string"
        ? target.id
        : typeof target.id === "number" && Number.isFinite(target.id)
          ? String(target.id)
          : null;
      if (postRef !== null && !requested.has(postRef)) {
        rejectedItemIndexes.add(index);
        reasons.add("post_target_out_of_scope");
      }
    }
  }
  return {
    accepted: rejectedItemIndexes.size === 0,
    rejectedItemIndexes: [...rejectedItemIndexes].sort((a, b) => a - b),
    reasons: [...reasons].sort(),
  };
}

export function parsePostsCursorState(value: unknown): PostsCursorState | null {
  const state = asRecord(value);
  if (!state || state.version !== 1 || (state.platform !== "fansly" && state.platform !== "onlyfans")) {
    return null;
  }
  const revision = state.revision;
  const headPostId = nullableString(state.headPostId);
  const anchorPostId = nullableString(state.anchorPostId);
  const capturedHeadPostId = nullableString(state.capturedHeadPostId);
  const before = state.before;
  const pageIndex = state.pageIndex;
  const pendingCaptureJobId = nullableString(state.pendingCaptureJobId);
  const fanslyPostTipsCaptureVersion = state.fanslyPostTipsCaptureVersion === undefined
    || state.fanslyPostTipsCaptureVersion === null
    ? null
    : state.fanslyPostTipsCaptureVersion === 1
      ? 1
      : undefined;
  const fanslyPostTipsBackfilledAt = state.fanslyPostTipsBackfilledAt === undefined
    ? null
    : nullableString(state.fanslyPostTipsBackfilledAt);
  const fanslyRecentRefreshCutoffAt = state.fanslyRecentRefreshCutoffAt === undefined
    ? null
    : nullableString(state.fanslyRecentRefreshCutoffAt);
  const fanslyRecentRefreshAnchorReached = state.fanslyRecentRefreshAnchorReached === undefined
    ? false
    : typeof state.fanslyRecentRefreshAnchorReached === "boolean"
      ? state.fanslyRecentRefreshAnchorReached
      : undefined;
  const completedAt = nullableString(state.completedAt);
  const fanslyPostEngagement = parsePostsEngagementCursor(state.fanslyPostEngagement);
  if (
    typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 ||
    headPostId === undefined || anchorPostId === undefined || capturedHeadPostId === undefined ||
    typeof before !== "string" || before.length === 0 ||
    typeof pageIndex !== "number" || !Number.isSafeInteger(pageIndex) || pageIndex < 0 ||
    pendingCaptureJobId === undefined || fanslyPostTipsCaptureVersion === undefined
    || fanslyPostTipsBackfilledAt === undefined
    || fanslyRecentRefreshCutoffAt === undefined
    || (fanslyRecentRefreshCutoffAt !== null
      && Number.isNaN(new Date(fanslyRecentRefreshCutoffAt).getTime()))
    || fanslyRecentRefreshAnchorReached === undefined
    || completedAt === undefined
  ) {
    return null;
  }
  return {
    version: 1,
    platform: state.platform,
    revision,
    headPostId,
    anchorPostId,
    capturedHeadPostId,
    before,
    pageIndex,
    pendingCaptureJobId,
    fanslyPostTipsCaptureVersion,
    fanslyPostTipsBackfilledAt,
    fanslyRecentRefreshCutoffAt,
    fanslyRecentRefreshAnchorReached,
    completedAt,
    fanslyPostEngagement,
  };
}

function fanslyPublishedAt(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const date = new Date(value >= 1_000_000_000_000 ? value : value * 1_000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && value.length > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function fanslyPublishedAtIsValid(value: unknown) {
  return fanslyPublishedAt(value) !== null;
}

function assertFanslyPostsPageContract(page: {
  contractAccepted: boolean;
  items: Array<{
    id?: unknown;
    createdAt?: unknown;
    content?: unknown;
  }>;
}) {
  if (!page.contractAccepted) {
    throw new Error("Fansly posts response drifted away from {posts: [...]}");
  }
  for (const post of page.items) {
    if (
      typeof post.id !== "string" || post.id.length === 0 ||
      !fanslyPublishedAtIsValid(post.createdAt) ||
      (post.content !== undefined && post.content !== null && typeof post.content !== "string")
    ) {
      throw new Error("Fansly posts response contains an invalid post item");
    }
  }
}

function freshState(
  platform: "fansly" | "onlyfans",
  revision: number,
  priorHeadPostId: string | null,
  fanslyPostTipsBackfilledAt: string | null = null,
  fanslyPostTipsCaptureVersion: 1 | null = null,
  fanslyRecentRefreshCutoffAt: string | null = null,
  // WP-F6: a new request generation restarts the TIMELINE walk. It must not
  // restart the engagement phase's day counter (which would double the day's
  // egress at every cadence boundary) or its seeding sweep (which would
  // re-scan the whole back catalogue).
  fanslyPostEngagement: PostsEngagementCursor = emptyPostsEngagementCursor(),
): PostsCursorState {
  return {
    version: 1,
    platform,
    revision,
    headPostId: priorHeadPostId,
    anchorPostId: priorHeadPostId,
    capturedHeadPostId: null,
    before: "0",
    pageIndex: 0,
    pendingCaptureJobId: null,
    fanslyPostTipsCaptureVersion,
    fanslyPostTipsBackfilledAt,
    fanslyRecentRefreshCutoffAt,
    fanslyRecentRefreshAnchorReached: false,
    completedAt: null,
    fanslyPostEngagement,
  };
}

function resumeFanslyPostsWalk(
  previous: PostsCursorState | null,
  revision: number,
): PostsCursorState | null {
  if (
    previous?.platform !== "fansly"
    || previous.fanslyPostTipsCaptureVersion !== 1
    || previous.completedAt !== null
  ) {
    return null;
  }
  const isFullBackfill = previous.fanslyPostTipsBackfilledAt === null
    && previous.anchorPostId === null
    && previous.fanslyRecentRefreshCutoffAt === null;
  const isBoundedRefresh = previous.fanslyPostTipsBackfilledAt !== null
    && previous.fanslyRecentRefreshCutoffAt !== null;
  if (!isFullBackfill && !isBoundedRefresh) {
    return null;
  }
  // A cadence/request-generation boundary changes ownership, not the provider
  // cursor's meaning. Carry both full-backfill and bounded-refresh positions
  // forward so a multi-chunk walk cannot starve by restarting at the head.
  return { ...previous, revision };
}

function fanslyRecentRefreshCutoff(now: Date) {
  return new Date(
    now.getTime() - FANSLY_RECENT_POST_REFRESH_LOOKBACK_DAYS * DAY_MS,
  ).toISOString();
}

// ── WP-F6: the engagement refresh phase ──────────────────────────────────────
//
// ONE decayed `GET /post?ids=<csv>` read per dispatch, on the EXISTING `posts`
// stream, journaled under the EXISTING `posts` kind so the v6 family parses it
// exactly like a timeline page. No new stream, no new flag on the lane, no new
// dataset — the phase's whole job is to make the counters this system already
// stores STAY true after publication.
//
// WHY IT IS A SEPARATE PHASE AND NOT MORE TIMELINE PAGES. The timeline is
// newest-first and the bounded refresh only walks back 14 days: a post from
// last spring is never re-read by it, so its like count is frozen at whatever it
// was the week it was published. `GET /post?ids=` reads any hundred posts by id,
// which is the only shape that can re-read a back catalogue at all.
//
// WHY IT RUNS AFTER THE WALK. The timeline is how this system learns a post
// EXISTS; the refresh only updates numbers on posts it already has. So the
// phase runs only once the walk has completed for this request generation, and
// takes whatever chunk budget is left. A page whose timeline is still being
// backfilled spends nothing here.
//
// BURST SHAPE, NOT DAILY VOLUME, IS THE BAN-RISK SURFACE (§6.1). One batch per
// dispatch, then a jittered continuation — the same discipline WP-F5's walk
// uses, reusing WP-F1's `fanslyBackfillContinuationDelayMs` ± 30 %.

/** Roots seeded per dispatch on first enable. Bounded so a page with thousands
 *  of posts does not hold a write lock for a second, and keyset so the next
 *  batch resumes exactly where this one stopped. Costs ZERO platform calls. */
const ENGAGEMENT_SEED_BATCH_SIZE = 500;

/** WP-F1's continuation spread, restated here rather than imported so the posts
 *  lane does not take a runtime dependency on the replies lane's module. */
const ENGAGEMENT_JITTER_FRACTION = 0.3;

export function engagementContinuationAt(
  now: Date,
  delayMs: number,
  random: () => number = Math.random,
): Date {
  const jitter = 1 + (random() * 2 - 1) * ENGAGEMENT_JITTER_FRACTION;
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

/** Counts HTTP ATTEMPTS, retries included — the unit the cap is enforced in.
 *  `SyncChunkBudget` counts the same events but is scoped to one chunk; the day
 *  counter has to survive chunks, leases and restarts, so it lives in the
 *  cursor and this observer is what feeds it. */
class EngagementAttemptCounter implements HttpRequestObserver {
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

type EngagementPhaseOutcome = {
  engagement: PostsEngagementCursor;
  stats: Record<string, unknown>;
  /** Set when the phase stopped at its daily cap. */
  deferred: string | null;
  /** True when posts are still due and there is budget to reach them. */
  moreWork: boolean;
};

type EngagementPhaseInput = {
  pageId: number;
  syncRunId: number;
  budget: SyncChunkBudget;
  telemetry: SyncRunTelemetry;
  requestContext: Parameters<AppContext["adapter"]["getPostsByIds"]>[0];
  attempts: EngagementAttemptCounter;
  now: Date;
  dailyCap: number;
};

async function runPostEngagementPhase(
  app: AppContext,
  input: EngagementPhaseInput,
  previous: PostsEngagementCursor,
): Promise<EngagementPhaseOutcome> {
  let engagement = rollPostsEngagementUtcDay(previous, input.now);
  let journaled = 0;
  let refreshed = 0;
  let failed = 0;
  let deferred: string | null = null;
  let moreWork = false;
  const tiers: Record<string, number> = {};

  // ── SEEDING ────────────────────────────────────────────────────────────────
  // First enable only, bounded and keyset, ZERO platform calls: `creator_posts`
  // is already in the database. Everything published AFTERWARDS is queued by the
  // creator-posts projector in the same transaction as its own upsert, so the
  // sweep never has to run twice.
  if (!engagement.seedComplete) {
    for (;;) {
      const seeded = await seedPostEngagementQueue(app.db, {
        pageId: input.pageId,
        afterSubjectRef: engagement.seedCursor,
        limit: ENGAGEMENT_SEED_BATCH_SIZE,
        dueAt: input.now,
      });
      engagement = { ...engagement, seedCursor: seeded.cursor };
      if (seeded.scanned < ENGAGEMENT_SEED_BATCH_SIZE) {
        engagement = { ...engagement, seedComplete: true };
        break;
      }
      if (!input.budget.hasWallClockCapacity()) {
        break;
      }
    }
  }

  const finish = async (): Promise<EngagementPhaseOutcome> => {
    const progress = await countPostEngagementRefreshProgress(app.db, input.pageId);
    return {
      engagement,
      deferred,
      moreWork,
      stats: {
        journaled,
        callsToday: engagement.callsToday,
        dailyCap: input.dailyCap,
        batchSize: POST_BATCH_SIZE,
        seedComplete: engagement.seedComplete,
        refreshedThisChunk: refreshed,
        failedThisChunk: failed,
        tiersThisChunk: tiers,
        subjectsKnown: progress.subjectsKnown,
        subjectsRefreshed: progress.subjectsRefreshed,
        subjectsDirty: progress.subjectsDirty,
        postsKnown: progress.postsKnown,
        ...(deferred === null ? {} : { deferred }),
      },
    };
  };

  if (engagement.callsToday >= input.dailyCap) {
    deferred = "engagement_daily_call_budget";
    return finish();
  }
  if (!input.budget.hasRequestCapacity(1) || !input.budget.hasWallClockCapacity()) {
    moreWork = true;
    return finish();
  }

  const candidates: PostEngagementRefreshCandidate[] = await listPostEngagementRefreshChunk(
    app.db,
    { pageId: input.pageId, limit: POST_BATCH_SIZE, now: input.now },
  );
  if (candidates.length === 0) {
    return finish();
  }
  // A full batch almost certainly means more posts are due; the continuation is
  // jittered either way.
  moreWork = candidates.length >= POST_BATCH_SIZE;

  const ids = candidates.map((candidate) => candidate.subjectRef);
  await assertOwnedPageSyncLease(app.db);
  let response: Awaited<ReturnType<AppContext["adapter"]["getPostsByIds"]>>;
  try {
    response = await app.adapter.getPostsByIds(input.requestContext, ids);
  } catch (error) {
    // The attempts are spent whether or not a body came back; fold them in
    // before anything else so a failing batch cannot be retried for free.
    engagement = {
      ...engagement,
      callsToday: engagement.callsToday + input.attempts.take(),
    };
    // A dead session is the executor's business: re-raise it untouched so the
    // auth pause fires. Everything else is scoped to ONE batch — the timeline
    // walk has already completed and must not be undone by a refresh failure.
    if (isFanslyAuthFailure(error)) {
      throw error;
    }
    failed = ids.length;
    await input.telemetry.addAnomaly({
      code: "fansly_post_engagement_batch_failed",
      severity: "warn",
      message: "Fansly post engagement refresh failed for one batch; the queue continues",
      details: { idCount: ids.length },
    });
    await recordPostEngagementRefreshFailures(app.db, {
      pageId: input.pageId,
      subjectRefs: ids,
      nextDueAt: new Date(input.now.getTime() + DAY_MS),
    });
    return finish();
  }

  // JOURNAL FIRST, ALWAYS — before the contract is inspected and before any
  // queue row moves. The request params name the phase and the ids so a future
  // parser can tell an engagement re-read from a timeline page in the same kind.
  await persistRawPayload(app.db, {
    platformAccountId: input.pageId,
    syncRunId: input.syncRunId,
    endpoint: "posts",
    requestParams: { phase: "engagement", ids },
    responsePayload: response.raw,
    mapperVersion: FANSLY_POSTS_MAPPER_VERSION,
    payloadKind: "posts",
    retainUntil: retentionDate(),
  }, {
    action: "inserting Fansly post engagement refresh raw payload",
    platform: "fansly",
  });
  journaled += 1;
  engagement = {
    ...engagement,
    callsToday: engagement.callsToday + input.attempts.take(),
  };

  if (!response.contractAccepted) {
    // Journaled above, refused as an ANSWER: recording "these posts were
    // refreshed" from a body we cannot read is how a decay queue lies about its
    // own coverage. The batch is retried tomorrow.
    failed = ids.length;
    await input.telemetry.addAnomaly({
      code: "fansly_post_engagement_contract_drift",
      severity: "warn",
      message: "Fansly post batch read drifted away from {posts: [...]}; raw capture retained",
      details: { idCount: ids.length },
    });
    await recordPostEngagementRefreshFailures(app.db, {
      pageId: input.pageId,
      subjectRefs: ids,
      nextDueAt: new Date(input.now.getTime() + DAY_MS),
    });
    return finish();
  }

  // Only the posts the response actually NAMED count as refreshed. An id the
  // provider dropped from the batch is not a post whose counters we have seen,
  // and marking it visited would retire it from the never-refreshed band on the
  // strength of a silence.
  const served = new Set(
    response.items
      .map((post) => (typeof post.id === "string" ? post.id : null))
      .filter((id): id is string => id !== null),
  );
  const visits = candidates
    .filter((candidate) => served.has(candidate.subjectRef))
    .map((candidate) => {
      tiers[candidate.tier] = (tiers[candidate.tier] ?? 0) + 1;
      return {
        subjectRef: candidate.subjectRef,
        tier: candidate.tier,
        nextDueAt: new Date(
          input.now.getTime() + postEngagementIntervalDays(candidate.tier) * DAY_MS,
        ),
      };
    });
  const unserved = ids.filter((id) => !served.has(id));
  await recordPostEngagementRefreshVisits(app.db, {
    pageId: input.pageId,
    visits,
    visitedAt: input.now,
  });
  if (unserved.length > 0) {
    failed = unserved.length;
    await recordPostEngagementRefreshFailures(app.db, {
      pageId: input.pageId,
      subjectRefs: unserved,
      nextDueAt: new Date(input.now.getTime() + DAY_MS),
    });
  }
  refreshed = visits.length;

  if (engagement.callsToday >= input.dailyCap) {
    deferred = "engagement_daily_call_budget";
  }
  return finish();
}

function isFanslyAuthFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
}

export async function fanslyPostsChunk(
  app: AppContext,
  input: ExecutorRequestContext,
): Promise<StreamChunkResult> {
  if (input.pageContext.platform !== "fansly") {
    throw new Error("Fansly posts sync requires a Fansly page");
  }
  await input.telemetry.recordPhaseStarted("posts");
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "posts");
  await input.telemetry.recordCheckpointLoaded("posts", summarizeCheckpoint(checkpoint));
  const previous = parsePostsCursorState(checkpoint?.state);
  const now = input.now ?? new Date();
  const fanslyPostTipsBackfilledAt = previous?.fanslyPostTipsBackfilledAt ?? null;
  const resumedWalk = resumeFanslyPostsWalk(
    previous,
    input.streamState.requestSeq,
  );
  const sameRevisionStateIsReusable = previous?.revision === input.streamState.requestSeq
    && previous.fanslyPostTipsCaptureVersion === 1
    && (
      previous.completedAt !== null
      || previous.fanslyPostTipsBackfilledAt === null
      || previous.fanslyRecentRefreshCutoffAt !== null
    );
  let state = sameRevisionStateIsReusable
    ? previous
    : resumedWalk ?? freshState(
        "fansly",
        input.streamState.requestSeq,
        // Existing v1 checkpoints predate per-post tips. Ignore their head
        // exactly once so an upgrade can backfill every retained Fansly post.
        fanslyPostTipsBackfilledAt === null
          ? null
          : previous?.headPostId ?? checkpoint?.cursorText ?? null,
        fanslyPostTipsBackfilledAt,
        1,
        fanslyPostTipsBackfilledAt === null
          ? null
          : fanslyRecentRefreshCutoff(now),
        // Durable across request generations — see freshState's note.
        previous?.fanslyPostEngagement ?? emptyPostsEngagementCursor(),
      );

  // ── WP-F6: the engagement refresh phase's gate, read LIVE per chunk ────────
  // Deliberately NOT a gate on the timeline walk: the flag being off must leave
  // the `posts` lane behaving exactly as it did before this package.
  const effective = await loadEffectiveConfig(app.db, app.config);
  const engagementEnabled = effective.fanslyPostEngagementRefreshEnabled === true;
  const engagementDailyCap = Math.max(1, effective.fanslyPostEngagementDailyCallBudget ?? 40);
  const engagementDelayMs = Math.max(0, effective.fanslyBackfillContinuationDelayMs ?? 20_000);

  const engagementAttempts = new EngagementAttemptCounter();
  const requestContext = {
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    egressKey: input.pageContext.egressKey,
    requestObserver: composeRequestObservers(
      input.telemetry.getRequestObserver(),
      input.budget,
      engagementAttempts,
    ),
    rateLimitWaiter: createSyncRateLimitWaiter(app, input.pageContext),
  };
  const accountId = resolveFanslyPlatformAccountId(input.pageContext.page);

  /**
   * The ONE exit for a chunk whose timeline walk is done.
   *
   * Every such path runs the refresh phase (when enabled) and then reports both
   * halves — walk stats and engagement stats — from one place, so a dispatch
   * that only refreshed counters still says what the walk's position is.
   */
  const finishWithEngagement = async (
    walkStats: Record<string, unknown>,
    persist: "complete" | "progress",
  ): Promise<StreamChunkResult> => {
    // The phase is the only thing the flag gates. A completed walk still writes
    // its completion checkpoint exactly as it did before this package — turning
    // the flag off must not change one byte of the timeline lane's behaviour.
    const phase = engagementEnabled
      ? await runPostEngagementPhase(app, {
        pageId: input.pageContext.page.id,
        syncRunId: input.syncRunId,
        budget: input.budget,
        telemetry: input.telemetry,
        requestContext,
        attempts: engagementAttempts,
        now,
        dailyCap: engagementDailyCap,
      }, state.fanslyPostEngagement)
      : null;
    if (phase !== null) {
      state = { ...state, fanslyPostEngagement: phase.engagement };
    }
    if (persist === "complete") {
      const completed = await upsertCheckpoint(app.db, {
        platformAccountId: input.pageContext.page.id,
        stream: "posts",
        cursorText: state.headPostId,
        state,
        lastSuccessfulRunId: input.syncRunId,
      });
      await input.telemetry.recordCheckpointAdvanced("posts", summarizeCheckpoint(completed));
    } else if (phase !== null) {
      // The already-complete early return wrote nothing before; it writes now
      // only because the phase moved the day counter or the seeding cursor.
      const advanced = await upsertCheckpointProgress(app.db, {
        platformAccountId: input.pageContext.page.id,
        stream: "posts",
        cursorText: state.headPostId,
        state,
      });
      await input.telemetry.recordCheckpointAdvanced("posts", summarizeCheckpoint(advanced));
    }
    if (phase === null) {
      return { satisfied: true, yieldReason: null, stats: walkStats };
    }
    const stats = { ...walkStats, engagement: phase.stats };
    if (phase.deferred !== null) {
      // Crossed the cap: come back after the UTC roll. The response already
      // fetched was journaled before the counter was consulted.
      return {
        satisfied: false,
        yieldReason: null,
        continuationRetryAt: nextUtcDayStart(now),
        stats,
      };
    }
    if (phase.moreWork) {
      return {
        satisfied: false,
        yieldReason: null,
        continuationRetryAt: engagementContinuationAt(now, engagementDelayMs),
        stats,
      };
    }
    return { satisfied: true, yieldReason: null, stats };
  };

  if (state.completedAt !== null) {
    return finishWithEngagement({
      pages: state.pageIndex,
      headPostId: state.headPostId,
      anchorReached: state.fanslyRecentRefreshAnchorReached,
      recentRefreshCutoffAt: state.fanslyRecentRefreshCutoffAt,
    }, "progress");
  }
  if (state.pageIndex === 0 && state.before === "0") {
    const initialized = await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "posts",
      cursorText: state.headPostId,
      state,
    });
    await input.telemetry.recordCheckpointAdvanced("posts", summarizeCheckpoint(initialized));
  }

  let captured = 0;
  let postTipsContractDrifts = 0;
  let postTipsScopeDrifts = 0;

  // Every non-empty timeline page is followed by one batched target-tip read.
  // Reserve both calls before starting so checkpoint progress always covers a
  // complete page unit, never a timeline page with its tips still uncaptured.
  while (input.budget.hasRequestCapacity(2) && input.budget.hasWallClockCapacity()) {
    await assertOwnedPageSyncLease(app.db);
    const page = await app.adapter.getPostsPage(requestContext, accountId, {
      before: state.before,
      pageIndex: state.pageIndex,
    });
    await persistRawPayload(app.db, {
      platformAccountId: input.pageContext.page.id,
      syncRunId: input.syncRunId,
      endpoint: "posts",
      requestParams: {
        accountId,
        before: state.before,
        after: "0",
        wallId: null,
        pageIndex: state.pageIndex,
        scanMode: state.fanslyRecentRefreshCutoffAt === null
          ? "full_post_tip_backfill"
          : "recent_refresh",
        recentRefreshCutoffAt: state.fanslyRecentRefreshCutoffAt,
      },
      responsePayload: page.raw,
      mapperVersion: FANSLY_POSTS_MAPPER_VERSION,
      payloadKind: "posts",
      retainUntil: retentionDate(),
    }, {
      action: "inserting Fansly posts raw payload",
      platform: "fansly",
    });

    // Contract rejection intentionally happens AFTER raw journal persistence.
    assertFanslyPostsPageContract(page);
    const targetIds = page.items.map((post) => post.id);
    if (targetIds.length > 0) {
      await assertOwnedPageSyncLease(app.db);
      const tips = await app.adapter.getTipsByTargetIds(requestContext, targetIds);
      const tipScope = inspectFanslyPostTipsScope(tips.raw, {
        requestedTargetIds: targetIds,
        receiverId: accountId,
      });
      await persistRawPayload(app.db, {
        platformAccountId: input.pageContext.page.id,
        syncRunId: input.syncRunId,
        endpoint: "post_tips",
        requestParams: { targetIds },
        responsePayload: tips.raw,
        mapperVersion: FANSLY_POST_TIPS_MAPPER_VERSION,
        payloadKind: "post_tips",
        retainUntil: retentionDate(),
      }, {
        action: "inserting Fansly post tips raw payload",
        platform: "fansly",
        ...(tipScope.accepted
          ? {}
          : {
              observationPayload: {
                quarantine: "fansly_post_tips_scope_v1",
                requestedTargetIds: targetIds,
                response: tips.raw,
              },
            }),
      });

      // The companion endpoint is additive attribution, not the timeline's
      // source of post identity. Keep a drifted response raw and unparsed, but
      // do not wedge the whole posts lane (or repeatedly refetch the same
      // timeline page) because one optional companion contract changed.
      if (!tips.contractAccepted) {
        postTipsContractDrifts += 1;
        await input.telemetry.addAnomaly({
          code: "fansly_post_tips_contract_drift",
          severity: "warn",
          message: "Fansly post tips response drifted away from an array; raw capture retained for replay",
          details: {
            targetCount: targetIds.length,
            pageIndex: state.pageIndex,
          },
        });
      } else if (!tipScope.accepted) {
        postTipsScopeDrifts += 1;
        await input.telemetry.addAnomaly({
          code: "fansly_post_tips_scope_drift",
          severity: "warn",
          message: "Fansly post tips response escaped its requested page/receiver scope; raw capture quarantined",
          details: {
            targetCount: targetIds.length,
            pageIndex: state.pageIndex,
            rejectedItemCount: tipScope.rejectedItemIndexes.length,
            rejectedItemIndexes: tipScope.rejectedItemIndexes,
            reasons: tipScope.reasons,
          },
        });
      }
    }
    captured += page.items.length;
    const capturedHeadPostId = state.capturedHeadPostId ?? page.items[0]?.id ?? null;
    const anchorReachedOnPage = state.anchorPostId !== null &&
      page.items.some((post) => post.id === state.anchorPostId);
    const anchorReached = state.fanslyRecentRefreshAnchorReached || anchorReachedOnPage;
    const recentRefreshCutoff = state.fanslyRecentRefreshCutoffAt === null
      ? null
      : new Date(state.fanslyRecentRefreshCutoffAt);
    const timelineExhausted = page.items.length === 0;
    // Fansly's timeline is newest-first, but a wholly-old page is a safer
    // boundary than stopping at the first old/pinned item. Capture that page's
    // companion tips too, then complete the bounded walk.
    const recentRefreshCutoffReached = recentRefreshCutoff !== null
      && page.items.length > 0
      && page.items.every((post) => {
        const publishedAt = fanslyPublishedAt(post.createdAt);
        return publishedAt !== null
          && publishedAt.getTime() < recentRefreshCutoff.getTime();
      });
    if (timelineExhausted || recentRefreshCutoffReached) {
      const completedAt = now.toISOString();
      state = {
        ...state,
        capturedHeadPostId,
        headPostId: capturedHeadPostId ?? state.headPostId,
        before: "0",
        pageIndex: state.pageIndex + 1,
        fanslyPostTipsBackfilledAt: state.fanslyPostTipsBackfilledAt ?? completedAt,
        fanslyRecentRefreshAnchorReached: anchorReached,
        completedAt,
      };
      return finishWithEngagement({
        pages: state.pageIndex,
        captured,
        postTipsContractDrifts,
        postTipsScopeDrifts,
        anchorReached,
        recentRefreshCutoffAt: state.fanslyRecentRefreshCutoffAt,
        recentRefreshCutoffReached,
        timelineExhausted,
        headPostId: state.headPostId,
      }, "complete");
    }

    if (!page.nextBefore || page.nextBefore === state.before) {
      throw new Error("Fansly posts pagination did not advance the before cursor");
    }
    state = {
      ...state,
      capturedHeadPostId,
      before: page.nextBefore,
      pageIndex: state.pageIndex + 1,
      fanslyRecentRefreshAnchorReached: anchorReached,
    };
    const advanced = await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "posts",
      cursorText: state.headPostId,
      state,
    });
    await input.telemetry.recordCheckpointAdvanced("posts", summarizeCheckpoint(advanced));
  }

  return {
    satisfied: false,
    yieldReason: input.budget.resolveYieldReason(2),
    stats: {
      pages: state.pageIndex,
      captured,
      postTipsContractDrifts,
      postTipsScopeDrifts,
      before: state.before,
      anchorReached: state.fanslyRecentRefreshAnchorReached,
      recentRefreshCutoffAt: state.fanslyRecentRefreshCutoffAt,
    },
  };
}

export async function onlyfansPostsChunk(
  app: AppContext,
  input: ExecutorRequestContext,
): Promise<StreamChunkResult> {
  if (input.pageContext.platform !== "onlyfans") {
    throw new Error("OnlyFans posts sync requires an OnlyFans page");
  }
  await input.telemetry.recordPhaseStarted("posts");
  const ineligibility = getOnlyFansPostsCaptureIneligibility(app.config, {
    ...input.pageContext.page,
    platform: input.pageContext.platform,
  });
  if (ineligibility !== null) {
    // The normal path is parked by the planner. This error is the race-safe
    // fallback: it records no false success and the executor classifies it as
    // a configuration wait until the planner restores the durable pause.
    throw new PostsCaptureConfigurationError(ineligibility);
  }
  const ofapiAccountId = input.pageContext.page.ofapiAccountId;
  if (!ofapiAccountId) {
    throw new PostsCaptureConfigurationError("ofapi_account_unmapped");
  }

  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "posts");
  await input.telemetry.recordCheckpointLoaded("posts", summarizeCheckpoint(checkpoint));
  const previous = parsePostsCursorState(checkpoint?.state);
  let state = previous?.revision === input.streamState.requestSeq
    ? previous
    : freshState("onlyfans", input.streamState.requestSeq, previous?.headPostId ?? checkpoint?.cursorText ?? null);

  if (state.completedAt !== null) {
    return { satisfied: true, yieldReason: null, stats: { headPostId: state.headPostId } };
  }

  let job = state.pendingCaptureJobId
    ? await getOfapiCaptureJob(app.db, state.pendingCaptureJobId)
    : null;
  if (state.pendingCaptureJobId && !job) {
    throw new Error(`OFAPI posts capture job ${state.pendingCaptureJobId} is missing`);
  }
  if (job?.state === "cancelled") {
    // Decision #246/#249: an owner-cancelled job released its slot; the
    // checkpoint still names it only because nothing ran in between. Forget it
    // and let the ordinary path find or seed the fresh job.
    job = null;
  }
  if (!job) {
    const activeSlotKey = `page:${input.pageContext.page.id}:posts`;
    job = await findActiveOfapiCaptureJobBySlot(app.db, activeSlotKey);
    if (job && job.kind !== "post_paginate") {
      throw new Error(`OFAPI posts slot is occupied by ${job.kind}`);
    }
    if (!job) {
      const seeded = await createOrGetOfapiCaptureJob(app.db, {
        pageId: input.pageContext.page.id,
        ofapiAccountId,
        kind: "post_paginate",
        activeSlotKey,
        target: {
          anchorPostId: state.headPostId,
          limit: OFAPI_POSTS_CAPTURE_LIMIT,
          requestRevision: input.streamState.requestSeq,
        },
        manifest: {
          version: "posts-sync-v1",
          stream: "posts",
          requestRevision: input.streamState.requestSeq,
        },
        budgetScope: state.headPostId === null ? "bulk" : "live",
        createdBy: "product_signal",
        priority: OFAPI_POSTS_CAPTURE_PRIORITY,
        maxCalls: OFAPI_POSTS_CAPTURE_MAX_PAGES,
        maxCredits: OFAPI_POSTS_CAPTURE_MAX_PAGES,
        maxPages: OFAPI_POSTS_CAPTURE_MAX_PAGES,
        maxItems: null,
      });
      job = seeded.job;
    }
    state = { ...state, pendingCaptureJobId: job.id };
    const initialized = await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "posts",
      cursorText: state.headPostId,
      state,
    });
    await input.telemetry.recordCheckpointAdvanced("posts", summarizeCheckpoint(initialized));
  }

  if (job.state === "complete") {
    const result = asRecord(job.result);
    const nextHeadPostId = nullableString(result?.headPostId);
    if (nextHeadPostId === undefined) {
      throw new Error(`OFAPI posts capture job ${job.id} completed without a valid headPostId`);
    }
    state = {
      ...state,
      headPostId: nextHeadPostId ?? state.headPostId,
      capturedHeadPostId: nextHeadPostId,
      pendingCaptureJobId: null,
      completedAt: new Date().toISOString(),
    };
    const completed = await upsertCheckpoint(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "posts",
      cursorText: state.headPostId,
      state,
      lastSuccessfulRunId: input.syncRunId,
    });
    await input.telemetry.recordCheckpointAdvanced("posts", summarizeCheckpoint(completed));
    return {
      satisfied: true,
      yieldReason: null,
      stats: { captureJobId: job.id, headPostId: state.headPostId, capture: result },
    };
  }
  if (job.state === "blocked") {
    throw new PostsCaptureJobBlockedError(job.id, job.reasonCode ?? "unknown");
  }

  return {
    satisfied: false,
    yieldReason: null,
    ...(job.state === "retry_wait"
      ? { continuationRetryAt: job.nextAttemptAt }
      : job.state === "leased" && job.leaseUntil
        ? { continuationRetryAt: job.leaseUntil }
        : {}),
    stats: {
      captureJobId: job.id,
      captureState: job.state,
      captureReasonCode: job.reasonCode,
      headPostId: state.headPostId,
    },
  };
}
