import { sql } from "drizzle-orm";

import {
  listPostEngagementRefreshChunk,
  postEngagementIntervalDays,
  postEngagementTier,
  recordPostEngagementRefreshFailures,
  recordPostEngagementRefreshVisits,
  seedPostEngagementQueue,
  type Database,
  type PostEngagementRefreshCandidate,
} from "@agency_hub_core/db";
import { FANSLY_HEAD_CURSOR, POST_BATCH_SIZE, type FanslyPostsPage } from "@agency_hub_core/fansly";

import {
  assertFanslyPostsPageContract,
  FANSLY_RECENT_POST_REFRESH_LOOKBACK_DAYS,
  fanslyPublishedAt,
  inspectFanslyPostTipsScope,
  parsePostsCursorState,
} from "../../../services/sync/posts.ts";
import { ApplyQuarantine } from "../../engine/commit.ts";
import type {
  ApplyInput,
  ApplyResult,
  LegacyImport,
  RequestPlan,
  ResourceModule,
  ShadowResult,
  StepPlan,
} from "../../engine/resource.ts";
import { replayByCanonicalDrafts } from "../lib/family-replay.ts";
import { advanceShadowWalk, type ShadowWalkProgress } from "../lib/offset-walk.ts";
import { readFanslyPageFacts } from "../lib/page-facts.ts";
import {
  advanceShadowPass,
  clearQueueSubjectBlocks,
  currentShadowPass,
  dueAtLookOf,
  EMPTY_SHADOW_PASS,
  parseShadowPass,
  recordQueueSubjectFailures,
  shadowPassWaitUntil,
  standingRecheckAt,
  type ShadowPass,
  type SubjectQueueWalk,
} from "../lib/subject-queue.ts";

// `posts.refresh`, `posts.backfill`, `posts.engagement` (plan §5, design
// §5.15). Journaled exactly as the legacy `posts` stream journals: timeline
// pages and `GET /post?ids=` reads as `posts`, the companion tips read as
// `post_tips` (an answer that escapes its requested posts or receiver in the
// existing quarantine envelope, fansly/capture.ts; one that is not an array
// raw, counted, and walked past as legacy does). The rows become events by
// inline canonicalization (`pull/posts`) and the `creator_posts` projection,
// which seeds the reply and engagement queues in its own transaction.
//
// refresh (poll, 6 h): timeline page → the tips of that page → the next page
// (`before` = the page's last id), down to an empty page or a page wholly
// older than now − 14 d (whose tips are read too, then the walk completes).
// backfill (goal, owner or legacy import): the same walk without the cutoff.
// A page that does not advance its cursor, or an item outside the contract,
// quarantines the walk (raw kept, alert 2).
//
// engagement (standing walk over the `post_engagement` queue, design §4.3):
// up to 100 due posts per `GET /post?ids=` (never-read → dirty → by decay
// tier), the served ones re-dated by their tier, the omitted ones a day out;
// an HTTP failure opens the queue rows' breaker. The legacy daily cap and
// continuations are retired.

export type PostsVariant = "refresh" | "backfill" | "engagement";

const REFRESH_KEY = "posts.refresh";
const BACKFILL_KEY = "posts.backfill";
const ENGAGEMENT_KEY = "posts.engagement";
const DAY_MS = 86_400_000;
/** A shadow walk of a page without its native id re-checks this often. */
const IDENTITY_RECHECK_MS = 60 * 60 * 1000;
/** Shadow only: the timeline's page size is the server's; the walk length is
 *  estimated from the stored posts at this many a page — measured on the
 *  legacy journal (`sync_http_attempts.response_shape.returnedItems` of every
 *  `timeline_posts` read, 2026-09-29 … 10-02: 15, 168 of 168). */
export const TIMELINE_PAGE_ESTIMATE = 15;
/** The engagement walk looks at its queue again this long after it found
 *  nothing due (the legacy phase ran once per 6-hour posts cadence). */
export const POST_ENGAGEMENT_RECHECK_MS = 6 * 60 * 60 * 1000;
/** Ids the provider left out of a batch are asked again after this long
 *  (legacy: a post it drops is not one whose counters were seen). */
const UNSERVED_RETRY_MS = DAY_MS;
/** Rows seeded per batch when the switch carries the queue over. */
const ENGAGEMENT_SEED_BATCH_SIZE = 500;

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : null;
}

function parseShadow(value: unknown): ShadowWalkProgress | null {
  const record = recordOf(value);
  const steps = count(record.steps);
  const done = count(record.done);
  return steps === null || done === null ? null : { steps, done };
}

// ── the timeline walk (refresh / backfill) ──────────────────────────────────

export type PostsWalkEnd = "timeline_exhausted" | "cutoff_reached";

interface PostsWalk {
  /** ISO lower publication bound; null = the full walk. */
  cutoffAt: string | null;
  /** `before` of the next timeline page ("0" = the head). */
  before: string;
  pageIndex: number;
  /** The newest post the walk saw (its first page's first id). */
  capturedHeadPostId: string | null;
  /** The head the previous walk committed (reported, not a stop). */
  anchorPostId: string | null;
  anchorReached: boolean;
  captured: number;
  /** The last timeline page's posts whose tips are read next. */
  pendingTips: string[] | null;
  /** The walk ends once the pending tips are read. */
  end: PostsWalkEnd | null;
  tipsScopeDrifts: number;
  /** Tips answers that were not an array (journaled, counted, walked past). */
  tipsContractDrifts: number;
}

export interface PostsWalkCursor {
  /** The newest post a completed walk saw. */
  headPostId: string | null;
  /** ISO: when a full walk (every retained post with its tips) completed. */
  tipsBackfilledAt: string | null;
  walk: PostsWalk | null;
  last: Record<string, unknown> | null;
  shadow: ShadowWalkProgress | null;
}

export function parsePostsWalkCursor(value: unknown): PostsWalkCursor {
  const record = recordOf(value);
  const walkRecord = recordOf(record.walk);
  const before = text(walkRecord.before);
  const end = walkRecord.end === "timeline_exhausted" || walkRecord.end === "cutoff_reached" ? walkRecord.end : null;
  const walk: PostsWalk | null = before === null ? null : {
    cutoffAt: text(walkRecord.cutoffAt),
    before,
    pageIndex: count(walkRecord.pageIndex) ?? 0,
    capturedHeadPostId: text(walkRecord.capturedHeadPostId),
    anchorPostId: text(walkRecord.anchorPostId),
    anchorReached: walkRecord.anchorReached === true,
    captured: count(walkRecord.captured) ?? 0,
    pendingTips: stringList(walkRecord.pendingTips),
    end,
    tipsScopeDrifts: count(walkRecord.tipsScopeDrifts) ?? 0,
    tipsContractDrifts: count(walkRecord.tipsContractDrifts) ?? 0,
  };
  return {
    headPostId: text(record.headPostId),
    tipsBackfilledAt: text(record.tipsBackfilledAt),
    walk,
    last: typeof record.last === "object" && record.last !== null ? record.last as Record<string, unknown> : null,
    shadow: parseShadow(record.shadow),
  };
}

function freshWalk(anchorPostId: string | null, cutoffAt: string | null): PostsWalk {
  return {
    cutoffAt,
    before: FANSLY_HEAD_CURSOR,
    pageIndex: 0,
    capturedHeadPostId: null,
    anchorPostId,
    anchorReached: false,
    captured: 0,
    pendingTips: null,
    end: null,
    tipsScopeDrifts: 0,
    tipsContractDrifts: 0,
  };
}

/** The refresh's frozen lower bound: 14 days before the walk's first
 *  admission (deterministic from the journal, so a re-apply agrees). */
export function refreshCutoffAt(admittedAt: Date): string {
  return new Date(admittedAt.getTime() - FANSLY_RECENT_POST_REFRESH_LOOKBACK_DAYS * DAY_MS).toISOString();
}

/** A timeline page wholly older than the cutoff ends a bounded walk (a whole
 *  page is a safer boundary than the first old or pinned item). */
export function wholePageOlderThan(posts: ReadonlyArray<{ createdAt?: unknown }>, cutoffAt: string | null): boolean {
  if (cutoffAt === null || posts.length === 0) return false;
  const cutoff = Date.parse(cutoffAt);
  return posts.every((post) => {
    const publishedAt = fanslyPublishedAt(post.createdAt);
    return publishedAt !== null && publishedAt.getTime() < cutoff;
  });
}

function timelineRequest(accountId: string, before: string): RequestPlan<"posts.timeline"> {
  return { spec: "posts.timeline", params: { accountId, before } };
}

function tipsRequest(targetIds: readonly string[]): RequestPlan<"posts.tips"> {
  return { spec: "posts.tips", params: { targetIds: [...targetIds] } };
}

function requestedTargetIds(request: RequestPlan): string[] {
  return stringList(recordOf(request.params).targetIds) ?? [];
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Estimated steps of a shadow walk: a timeline page per `TIMELINE_PAGE_ESTIMATE`
 *  stored posts in its window plus the closing page, each non-empty page
 *  followed by its tips read. */
async function estimatedWalkSteps(db: Database, input: { pageId: number; cutoffAt: string | null }): Promise<number> {
  const result = await db.execute<{ n: string }>(sql`
    select count(*)::text as n from creator_posts
     where account_id = ${input.pageId}
       and platform = 'fansly'
       and (${input.cutoffAt}::timestamptz is null or published_at >= ${input.cutoffAt}::timestamptz)
  `);
  const stored = Number(result.rows[0]?.n ?? 0);
  const pages = Math.ceil(stored / TIMELINE_PAGE_ESTIMATE) + 1;
  // A bounded walk ends on a wholly-old page (tips read); a full one on an
  // empty page (no tips).
  return input.cutoffAt === null ? 2 * pages - 1 : 2 * pages;
}

/** The steps of a shadow walk started at `now` (its `shadow()` estimate, and
 *  the shadow report's assumed run size, rule A1.rate-assumed). */
async function shadowWalkSteps(db: Database, input: { pageId: number; now: Date; bounded: boolean }): Promise<number> {
  const cutoffAt = input.bounded ? refreshCutoffAt(input.now) : null;
  return Math.max(1, await estimatedWalkSteps(db, { pageId: input.pageId, cutoffAt }));
}

async function newestPostIds(db: Database, pageId: number): Promise<string[]> {
  const result = await db.execute<{ id: string }>(sql`
    select platform_post_id as id from creator_posts
     where account_id = ${pageId} and platform = 'fansly'
     order by published_at desc nulls last, platform_post_id desc
     limit ${TIMELINE_PAGE_ESTIMATE}
  `);
  return result.rows.map((row) => row.id);
}

function walkModule(variant: "refresh" | "backfill"): ResourceModule {
  const bounded = variant === "refresh";
  return {
    async plan(work, ctx): Promise<StepPlan> {
      const facts = await readFanslyPageFacts(ctx.db, ctx.pageId);
      if (facts === null) return { kind: "quarantine", reason: "page_missing" };
      if (facts.externalId === null) {
        // Live: `account.poll` writes the id (made due); shadow re-checks.
        return ctx.shadow
          ? { kind: "wait", reason: "dependency", until: new Date(ctx.now.getTime() + IDENTITY_RECHECK_MS) }
          : { kind: "wait", reason: "dependency", until: null, enqueue: [{ resource: "account.poll", demand: { reason: `dependency:${work.resource}` } }] };
      }
      const cursor = parsePostsWalkCursor(work.cursor);
      const walk = cursor.walk;
      if (walk !== null && walk.pendingTips !== null && walk.pendingTips.length > 0) {
        return { kind: "request", request: tipsRequest(walk.pendingTips) };
      }
      if (ctx.shadow && cursor.shadow !== null && cursor.shadow.done % 2 === 1) {
        // A shadow walk alternates as live does: every timeline page is
        // followed by its tips read (the newest stored posts stand in).
        const ids = await newestPostIds(ctx.db, ctx.pageId);
        if (ids.length > 0) return { kind: "request", request: tipsRequest(ids) };
      }
      return { kind: "request", request: timelineRequest(facts.externalId, walk?.before ?? FANSLY_HEAD_CURSOR) };
    },

    async apply(tx, input: ApplyInput): Promise<ApplyResult> {
      const now = input.now;
      const cursor = parsePostsWalkCursor(input.work.cursor);
      let walk = cursor.walk ?? freshWalk(cursor.headPostId, bounded ? refreshCutoffAt(input.attempt.admittedAt) : null);
      const counters: Record<string, number> = {};

      const complete = (end: PostsWalkEnd, finished: PostsWalk): ApplyResult => {
        const completedAt = now.toISOString();
        const headPostId = finished.capturedHeadPostId ?? cursor.headPostId;
        const receipt = {
          completedAt,
          end,
          pages: finished.pageIndex,
          captured: finished.captured,
          cutoffAt: finished.cutoffAt,
          anchorReached: finished.anchorReached,
          headPostId,
          tipsScopeDrifts: finished.tipsScopeDrifts,
          tipsContractDrifts: finished.tipsContractDrifts,
        };
        const next: PostsWalkCursor = {
          headPostId,
          // The first walk that read every retained post with its tips.
          tipsBackfilledAt: cursor.tipsBackfilledAt ?? (finished.cutoffAt === null ? completedAt : null),
          walk: null,
          last: receipt,
          shadow: null,
        };
        return { work: { satisfiesRevision: true, close: "done", closeReason: `walk_${end}`, cursor: next, proof: receipt }, followups: [], counters };
      };
      const goOn = (nextWalk: PostsWalk): ApplyResult => ({
        work: { satisfiesRevision: false, nextDueAt: now, cursor: { ...cursor, walk: nextWalk, shadow: null } },
        followups: [],
        counters,
      });

      if (input.request.spec === "posts.tips") {
        const targetIds = requestedTargetIds(input.request);
        if (walk.pendingTips === null || !sameIds(targetIds, walk.pendingTips)) {
          throw new ApplyQuarantine("post_tips_cursor_mismatch", { requested: targetIds.length, pending: walk.pendingTips?.length ?? null });
        }
        // The companion read is attribution, not the timeline's source of
        // posts (legacy: "do not wedge the whole posts lane"): an answer that
        // is not an array is journaled raw and counted, and the walk goes on.
        if (!Array.isArray(input.response)) {
          counters.post_tips_contract_drift = 1;
          walk = { ...walk, pendingTips: null, tipsContractDrifts: walk.tipsContractDrifts + 1 };
          return walk.end === null ? goOn(walk) : complete(walk.end, walk);
        }
        const scope = inspectFanslyPostTipsScope(input.response, { requestedTargetIds: targetIds, receiverId: input.ownRef ?? "" });
        if (!scope.accepted) counters.post_tips_scope_drift = 1;
        walk = { ...walk, pendingTips: null, tipsScopeDrifts: walk.tipsScopeDrifts + (scope.accepted ? 0 : 1) };
        return walk.end === null ? goOn(walk) : complete(walk.end, walk);
      }

      const requestedBefore = text(recordOf(input.request.params).before) ?? FANSLY_HEAD_CURSOR;
      if (requestedBefore !== walk.before || walk.pendingTips !== null) {
        throw new ApplyQuarantine("posts_cursor_mismatch", { requested: requestedBefore, walk: walk.before });
      }
      const posts = (input.parsed as FanslyPostsPage).posts;
      try {
        assertFanslyPostsPageContract({ contractAccepted: true, items: posts });
      } catch (error) {
        throw new ApplyQuarantine("posts_page_contract", { before: requestedBefore, error: error instanceof Error ? error.message : "invalid" });
      }
      const ids = posts.map((post) => post.id);
      walk = {
        ...walk,
        pageIndex: walk.pageIndex + 1,
        captured: walk.captured + posts.length,
        capturedHeadPostId: walk.capturedHeadPostId ?? ids[0] ?? null,
        anchorReached: walk.anchorReached || (walk.anchorPostId !== null && ids.includes(walk.anchorPostId)),
      };
      const end: PostsWalkEnd | null = posts.length === 0
        ? "timeline_exhausted"
        : wholePageOlderThan(posts, walk.cutoffAt) ? "cutoff_reached" : null;
      if (end !== null) {
        // The closing page's tips are read too, then the walk completes.
        return ids.length > 0 ? goOn({ ...walk, pendingTips: ids, end }) : complete(end, walk);
      }
      const nextBefore = ids.at(-1) ?? null;
      if (nextBefore === null || nextBefore === requestedBefore) {
        throw new ApplyQuarantine("posts_cursor_stuck", { before: requestedBefore });
      }
      return goOn({ ...walk, before: nextBefore, pendingTips: ids });
    },

    async shadow(work, _request, ctx): Promise<ShadowResult> {
      const cursor = parsePostsWalkCursor(work.cursor);
      const progress = cursor.shadow ?? { steps: await shadowWalkSteps(ctx.db, { pageId: ctx.pageId, now: ctx.now, bounded }), done: 0 };
      const step = advanceShadowWalk(progress, () => progress.steps);
      return step.finished
        ? { work: { satisfiesRevision: true, close: "done", closeReason: "shadow", cursor: { ...cursor, shadow: null } }, followups: [] }
        : { work: { satisfiesRevision: false, nextDueAt: ctx.now, cursor: { ...cursor, shadow: step.progress } }, followups: [] };
    },

    async estimateRunSteps(_work, ctx): Promise<number> {
      return shadowWalkSteps(ctx.db, { pageId: ctx.pageId, now: ctx.now, bounded });
    },

    replay: replayByCanonicalDrafts,

    async importLegacy(tx, page): Promise<LegacyImport> {
      const result = await tx.execute<{ state: unknown; cursorText: string | null }>(sql`
        select state, cursor_text as "cursorText" from page_sync_cursors where page_id = ${page.pageId} and stream = 'posts'
      `);
      const legacy = parsePostsCursorState(result.rows[0]?.state ?? null);
      const headPostId = legacy?.headPostId ?? text(result.rows[0]?.cursorText) ?? null;
      const tipsBackfilledAt = legacy?.fanslyPostTipsBackfilledAt ?? null;
      if (bounded) {
        const cursor: PostsWalkCursor = { headPostId, tipsBackfilledAt, walk: null, last: null, shadow: null };
        return { cursors: [{ resource: REFRESH_KEY, subject: "", cursor }], notes: { refresh: legacy === null ? "none" : "page_sync_cursors.posts" } };
      }
      // The one-time full walk is owed while legacy never completed it; a
      // full walk legacy left mid-way resumes at its page.
      if (tipsBackfilledAt !== null) return { cursors: [], notes: { backfill: "complete" } };
      const midWay = legacy !== null && legacy.completedAt === null && legacy.fanslyRecentRefreshCutoffAt === null && legacy.before !== FANSLY_HEAD_CURSOR;
      const cursor: PostsWalkCursor = {
        headPostId,
        tipsBackfilledAt: null,
        walk: midWay
          ? { ...freshWalk(null, null), before: legacy.before, pageIndex: legacy.pageIndex, capturedHeadPostId: legacy.capturedHeadPostId }
          : null,
        last: null,
        shadow: null,
      };
      return { cursors: [{ resource: BACKFILL_KEY, subject: "", cursor }], notes: { backfill: midWay ? "resumed" : "owed" } };
    },
  };
}

// ── engagement (standing walk over `post_engagement`) ───────────────────────

export const POST_ENGAGEMENT_QUEUE: SubjectQueueWalk<PostEngagementRefreshCandidate> = {
  plane: "post_engagement",
  pickDue: (db, input) => listPostEngagementRefreshChunk(db, {
    pageId: input.pageId,
    limit: input.limit,
    now: input.now,
    ...(input.after === null ? {} : { after: input.after }),
  }),
};

interface EngagementCursor {
  last: Record<string, unknown> | null;
  shadow: ShadowPass;
}

function parseEngagementCursor(value: unknown): EngagementCursor {
  const record = recordOf(value);
  return {
    last: typeof record.last === "object" && record.last !== null ? record.last as Record<string, unknown> : null,
    shadow: parseShadowPass(record.shadow),
  };
}

function idsOf(request: RequestPlan): string[] {
  return stringList(recordOf(request.params).ids) ?? [];
}

/** Each post's decay tier at `now`, from its publication instant. */
async function engagementTiers(db: Database, input: { pageId: number; ids: readonly string[]; now: Date }) {
  const result = await db.execute<{ id: string; publishedAt: Date | string | null }>(sql`
    select platform_post_id as id, published_at as "publishedAt" from creator_posts
     where account_id = ${input.pageId} and platform_post_id = any(${sql.param([...input.ids])}::text[])
  `);
  const published = new Map(result.rows.map((row) => [row.id, row.publishedAt === null ? null : new Date(row.publishedAt)] as const));
  return new Map(input.ids.map((id) => [id, postEngagementTier(published.get(id) ?? null, input.now)] as const));
}

const engagementModule: ResourceModule = {
  /** The shadow report's look check (rule A1.floor-idle): the shadow plan's
   *  pick at the look, less what changed since. */
  async dueAtLook(work, ctx) {
    const cursor = parseEngagementCursor(work.cursor);
    const pass = currentShadowPass(cursor.shadow, ctx.now, POST_ENGAGEMENT_RECHECK_MS);
    if (pass.ended) return { count: 0, examples: [], queued: null };
    return dueAtLookOf(ctx.db, {
      pageId: ctx.pageId,
      plane: POST_ENGAGEMENT_QUEUE.plane,
      at: ctx.now,
      pick: (limit) => POST_ENGAGEMENT_QUEUE.pickDue(ctx.db, { pageId: ctx.pageId, now: ctx.now, limit, after: pass.after }),
    });
  },

  async plan(work, ctx): Promise<StepPlan> {
    const cursor = parseEngagementCursor(work.cursor);
    const pass = ctx.shadow ? currentShadowPass(cursor.shadow, ctx.now, POST_ENGAGEMENT_RECHECK_MS) : EMPTY_SHADOW_PASS;
    if (pass.ended) return { kind: "wait", reason: "not_due", until: shadowPassWaitUntil(pass, ctx.now, POST_ENGAGEMENT_RECHECK_MS) };
    const due = await POST_ENGAGEMENT_QUEUE.pickDue(ctx.db, { pageId: ctx.pageId, now: ctx.now, limit: POST_BATCH_SIZE, after: pass.after });
    if (due.length === 0) {
      const until = ctx.shadow ? shadowPassWaitUntil(pass, ctx.now, POST_ENGAGEMENT_RECHECK_MS) : standingRecheckAt(ctx.now, POST_ENGAGEMENT_RECHECK_MS);
      return { kind: "wait", reason: "not_due", until };
    }
    return { kind: "request", request: { spec: "posts.by_ids", params: { ids: due.map((candidate) => candidate.subjectRef) } } };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const now = input.now;
    const ids = idsOf(input.request);
    const page = input.parsed as FanslyPostsPage;
    // Only the posts the answer NAMED were refreshed: an id it dropped is not
    // a post whose counters were seen.
    const served = new Set(page.posts.map((post) => (typeof post.id === "string" ? post.id : null)).filter((id): id is string => id !== null));
    const tiers = await engagementTiers(tx, { pageId: input.pageId, ids, now });
    const visits = ids.filter((id) => served.has(id)).map((id) => {
      const tier = tiers.get(id) ?? "fresh";
      return { subjectRef: id, tier, nextDueAt: new Date(now.getTime() + postEngagementIntervalDays(tier) * DAY_MS) };
    });
    const unserved = ids.filter((id) => !served.has(id));
    await recordPostEngagementRefreshVisits(tx, { pageId: input.pageId, visits, visitedAt: now });
    await recordPostEngagementRefreshFailures(tx, { pageId: input.pageId, subjectRefs: unserved, nextDueAt: new Date(now.getTime() + UNSERVED_RETRY_MS) });
    await clearQueueSubjectBlocks(tx, { pageId: input.pageId, plane: POST_ENGAGEMENT_QUEUE.plane, subjectRefs: visits.map((visit) => visit.subjectRef) });
    const byTier: Record<string, number> = {};
    for (const visit of visits) byTier[visit.tier] = (byTier[visit.tier] ?? 0) + 1;
    const receipt = { refreshedAt: now.toISOString(), requested: ids.length, refreshed: visits.length, unserved: unserved.length, byTier };
    const cursor: EngagementCursor = { ...parseEngagementCursor(input.work.cursor), last: receipt };
    // The walk row stays: the next plan takes the next due batch, or rests.
    return {
      work: { satisfiesRevision: true, nextDueAt: now, cursor, result: receipt },
      followups: [],
      counters: { posts_refreshed: visits.length, posts_unserved: unserved.length },
    };
  },

  async onSubjectOutcome(tx, work, outcome, step): Promise<void> {
    // A terminal answer climbs the same ladder: the walk row reopens at once,
    // so a subject left due would be asked again and again.
    if (outcome.kind === "ok") return;
    await recordQueueSubjectFailures(tx, {
      pageId: work.pageId,
      plane: POST_ENGAGEMENT_QUEUE.plane,
      subjectRefs: idsOf(step.request),
      now: new Date(),
    });
  },

  async shadow(work, request, ctx): Promise<ShadowResult> {
    const cursor = parseEngagementCursor(work.cursor);
    const pass = currentShadowPass(cursor.shadow, ctx.now, POST_ENGAGEMENT_RECHECK_MS);
    const ids = new Set(idsOf(request));
    // The subjects this step took, with their keysets (the plan's batch).
    const batch = await POST_ENGAGEMENT_QUEUE.pickDue(ctx.db, { pageId: ctx.pageId, now: ctx.now, limit: POST_BATCH_SIZE, after: pass.after });
    const taken = batch.filter((candidate) => ids.has(candidate.subjectRef));
    const advanced = advanceShadowPass({ pass: cursor.shadow, now: ctx.now, recheckMs: POST_ENGAGEMENT_RECHECK_MS, taken, limit: POST_BATCH_SIZE });
    return {
      work: { satisfiesRevision: true, nextDueAt: advanced.nextDueAt, cursor: { ...cursor, shadow: advanced.pass } },
      followups: [],
      counters: { posts_requested: ids.size },
    };
  },

  replay: replayByCanonicalDrafts,

  async importLegacy(tx, page): Promise<LegacyImport> {
    // The first-enable seeding of the queue (zero platform calls) is
    // finished here when legacy left it unfinished; every post projected
    // later is queued by the creator-posts projector itself.
    const result = await tx.execute<{ state: unknown }>(sql`
      select state from page_sync_cursors where page_id = ${page.pageId} and stream = 'posts'
    `);
    const legacy = parsePostsCursorState(result.rows[0]?.state ?? null);
    let seedCursor = legacy?.fanslyPostEngagement.seedCursor ?? null;
    let seeded = 0;
    if (legacy?.fanslyPostEngagement.seedComplete !== true) {
      for (;;) {
        const batch = await seedPostEngagementQueue(tx, {
          pageId: page.pageId,
          afterSubjectRef: seedCursor,
          limit: ENGAGEMENT_SEED_BATCH_SIZE,
          dueAt: new Date(),
        });
        seedCursor = batch.cursor;
        seeded += batch.inserted;
        if (batch.scanned < ENGAGEMENT_SEED_BATCH_SIZE) break;
      }
    }
    const cursor: EngagementCursor = { last: null, shadow: EMPTY_SHADOW_PASS };
    return { cursors: [{ resource: ENGAGEMENT_KEY, subject: "", cursor }], notes: { engagementSeeded: seeded } };
  },
};

export function postsModule(variant: PostsVariant): ResourceModule {
  switch (variant) {
    case "refresh":
      return walkModule("refresh");
    case "backfill":
      return walkModule("backfill");
    case "engagement":
      return engagementModule;
  }
}
