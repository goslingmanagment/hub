import { sql } from "drizzle-orm";

import {
  listCaptureCoverage,
  listPostEngagementRefreshChunk,
  markCaptureCoverageNotCurrent,
  postEngagementIntervalDays,
  postEngagementTier,
  recordPostEngagementRefreshFailures,
  recordPostEngagementRefreshVisits,
  type CaptureCoverageRow,
  type Database,
  type PostEngagementRefreshCandidate,
} from "@agency_hub_core/db";
import { FANSLY_HEAD_CURSOR, POST_BATCH_SIZE, type FanslyPostsPage } from "@agency_hub_core/fansly";

import {
  assertFanslyPostsPageContract,
  FANSLY_RECENT_POST_REFRESH_LOOKBACK_DAYS,
  fanslyPublishedAt,
  inspectFanslyPostTipsScope,
} from "../lib/posts-rules.ts";
import {
  parsePostsCoverageChain,
  POSTS_COVERAGE_PLANE,
  postsCoverageAfterFailure,
  postsCoverageAfterWalk,
  type PostsWalkSummary,
} from "../lib/posts-coverage.ts";
import { writeFanslyLaneCoverage } from "../lib/lane.ts";
import { ApplyQuarantine } from "../../engine/commit.ts";
import type { OutcomeDecision } from "../../engine/errors.ts";
import type {
  ApplyInput,
  ApplyResult,
  CaptureOutcomeInput,
  CaptureOutcomeResult,
  DemandSignal,
  RequestPlan,
  ResourceModule,
  StepPlan,
} from "../../engine/resource.ts";
import { readFanslyPageFacts } from "../lib/page-facts.ts";
import {
  clearQueueSubjectBlocks,
  recordQueueSubjectFailures,
  standingRecheckAt,
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
// backfill (goal, owner, a new page, or a refresh that finds no floor): the
// same walk without the cutoff.
// A page that does not advance its cursor, or an item outside the contract,
// quarantines the walk (raw kept, alert 2).
//
// A completed walk writes the timeline's coverage (`capture_coverage`, plane
// `posts`, `lib/posts-coverage.ts`): a full walk's empty page proves the
// floor, every refresh that reaches the head the claim holds moves it, one
// that does not — or finds no floor — writes `window_captured` and asks for a
// backfill; a failed step of either walk says why the claim is not current.
//
// engagement (standing walk over the `post_engagement` queue, design §4.3):
// up to 100 due posts per `GET /post?ids=` (never-read → dirty → by decay
// tier), the served ones re-dated by their tier, the omitted ones a day out;
// an HTTP failure opens the queue rows' breaker. The legacy daily cap and
// continuations are retired.

export type PostsVariant = "refresh" | "backfill" | "engagement";

const DAY_MS = 86_400_000;
/** The engagement walk looks at its queue again this long after it found
 *  nothing due (the legacy phase ran once per 6-hour posts cadence). */
export const POST_ENGAGEMENT_RECHECK_MS = 6 * 60 * 60 * 1000;
/** Ids the provider left out of a batch are asked again after this long
 *  (legacy: a post it drops is not one whose counters were seen). */
const UNSERVED_RETRY_MS = DAY_MS;

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
  /** ISO: the admission of the head page — every post published by then is
   *  on the timeline the walk reads (the coverage head). */
  headReadAt: string | null;
  /** ISO: the publication of the oldest post the walk saw (a full walk's floor). */
  oldestPublishedAt: string | null;
}

export interface PostsWalkCursor {
  /** The newest post a completed walk saw. */
  headPostId: string | null;
  /** ISO: when a full walk (every retained post with its tips) completed. */
  tipsBackfilledAt: string | null;
  walk: PostsWalk | null;
  last: Record<string, unknown> | null;
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
    headReadAt: text(walkRecord.headReadAt),
    oldestPublishedAt: text(walkRecord.oldestPublishedAt),
  };
  return {
    headPostId: text(record.headPostId),
    tipsBackfilledAt: text(record.tipsBackfilledAt),
    walk,
    last: typeof record.last === "object" && record.last !== null ? record.last as Record<string, unknown> : null,
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
    headReadAt: null,
    oldestPublishedAt: null,
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

function earlierIso(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(right) < Date.parse(left) ? right : left;
}

// ── the coverage of the timeline (`capture_coverage`, plane `posts`) ─────────

const BACKFILL_KEY = "posts.backfill";

async function postsCoverageRow(db: Database, pageId: number): Promise<CaptureCoverageRow | null> {
  const rows = await listCaptureCoverage(db, { pageId, plane: POSTS_COVERAGE_PLANE });
  return rows.find((row) => row.scopeRef === "") ?? null;
}

/** The page's posts Hub holds, published inside the claim's window. */
async function countPostsWithin(tx: Database, pageId: number, from: Date | null, to: Date): Promise<number> {
  const result = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from creator_posts
     where account_id = ${pageId} and published_at <= ${to}
       ${from === null ? sql`` : sql`and published_at >= ${from}`}
  `);
  return Number(result.rows[0]?.n ?? 0);
}

/** An open, running or quarantined backfill already answers for the floor. */
async function openBackfillExists(tx: Database, pageId: number): Promise<boolean> {
  const result = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from sync_work
     where page_id = ${pageId} and not shadow and resource = ${BACKFILL_KEY} and subject = ''
       and state in ('open', 'running', 'quarantined')
  `);
  return Number(result.rows[0]?.n ?? 0) > 0;
}

/** The claim a completed walk leaves (`lib/posts-coverage.ts`), and the
 *  backfill a refresh asks for when no floor holds. */
async function settleWalkCoverage(tx: Database, input: {
  pageId: number;
  now: Date;
  resource: string;
  bounded: boolean;
  walk: PostsWalkSummary;
  pages: number;
  served: number;
}): Promise<DemandSignal[]> {
  const row = await postsCoverageRow(tx, input.pageId);
  const claim = postsCoverageAfterWalk(input.walk, parsePostsCoverageChain(row?.cursor), input.now);
  await writeFanslyLaneCoverage({
    db: tx,
    pageId: input.pageId,
    plane: POSTS_COVERAGE_PLANE,
    scopeRef: "",
    status: claim.status,
    acquisitionMode: "retroactive",
    proof: claim.proof,
    proofObservationId: claim.proofObservationId,
    oldestCapturedAt: claim.oldestCapturedAt,
    newestCapturedAt: claim.newestCapturedAt,
    replaceWindowBounds: true,
    // Fansly states no number of posts.
    expectedCount: null,
    observedUniqueCount: await countPostsWithin(tx, input.pageId, claim.oldestCapturedAt, claim.newestCapturedAt),
    reasonCode: claim.reasonCode,
    nextProbeAt: claim.nextProbeAt,
    cursor: {
      ...claim.chain,
      lastWalk: {
        resource: input.resource,
        end: input.walk.end,
        cutoffAt: input.walk.cutoffAt,
        headReadAt: input.walk.headReadAt,
        pages: input.pages,
        served: input.served,
        completedAt: input.now.toISOString(),
      },
    },
  });
  if (!claim.needsBackfill || !input.bounded || await openBackfillExists(tx, input.pageId)) return [];
  return [{ resource: BACKFILL_KEY, demand: { reason: `posts_coverage:${claim.reasonCode}` } }];
}

/** A failed step of a walk that went out: a current claim says why it is not
 *  current any more (the chain stays for the next round to restore). */
async function walkFailureInCapture(tx: Database, decision: OutcomeDecision, input: CaptureOutcomeInput): Promise<CaptureOutcomeResult> {
  const unchanged: CaptureOutcomeResult = { decision };
  if (!input.sent || decision.errorClass === "ok") return unchanged;
  const row = await postsCoverageRow(tx, input.pageId);
  if (row === null) return unchanged;
  const failure = postsCoverageAfterFailure({
    errorClass: decision.errorClass,
    status: row.status,
    newestCapturedAt: row.newestCapturedAt,
    now: input.now,
  });
  if (failure === null) return unchanged;
  await markCaptureCoverageNotCurrent(tx, {
    pageId: input.pageId,
    platform: "fansly",
    plane: POSTS_COVERAGE_PLANE,
    scopeRef: "",
    from: row.status,
    status: failure.status,
    reasonCode: failure.reasonCode,
  });
  return unchanged;
}

function walkModule(variant: "refresh" | "backfill"): ResourceModule {
  const bounded = variant === "refresh";
  return {
    async plan(work, ctx): Promise<StepPlan> {
      const facts = await readFanslyPageFacts(ctx.db, ctx.pageId);
      if (facts === null) return { kind: "quarantine", reason: "page_missing" };
      if (facts.externalId === null) {
        // `account.poll` writes the id (made due).
        return { kind: "wait", reason: "dependency", until: null, enqueue: [{ resource: "account.poll", demand: { reason: `dependency:${work.resource}` } }] };
      }
      const cursor = parsePostsWalkCursor(work.cursor);
      const walk = cursor.walk;
      if (walk !== null && walk.pendingTips !== null && walk.pendingTips.length > 0) {
        return { kind: "request", request: tipsRequest(walk.pendingTips) };
      }
      return { kind: "request", request: timelineRequest(facts.externalId, walk?.before ?? FANSLY_HEAD_CURSOR) };
    },

    async apply(tx, input: ApplyInput): Promise<ApplyResult> {
      const now = input.now;
      const cursor = parsePostsWalkCursor(input.work.cursor);
      let walk = cursor.walk ?? freshWalk(cursor.headPostId, bounded ? refreshCutoffAt(input.attempt.admittedAt) : null);
      const counters: Record<string, number> = {};

      const complete = async (end: PostsWalkEnd, finished: PostsWalk): Promise<ApplyResult> => {
        const completedAt = now.toISOString();
        const headPostId = finished.capturedHeadPostId ?? cursor.headPostId;
        // The head page's admission. A walk an older image began has none: a
        // bounded one was first admitted its lookback after its cutoff.
        const headReadAt = finished.headReadAt ?? (finished.cutoffAt === null
          ? null
          : new Date(Date.parse(finished.cutoffAt) + FANSLY_RECENT_POST_REFRESH_LOOKBACK_DAYS * DAY_MS).toISOString());
        // A full walk completes on its empty page, in this apply: that page
        // is the observation that proves the floor.
        const followups = headReadAt === null ? [] : await settleWalkCoverage(tx, {
          pageId: input.pageId,
          now,
          resource: input.work.resource,
          bounded,
          walk: { end, cutoffAt: finished.cutoffAt, headReadAt, oldestPublishedAt: finished.oldestPublishedAt, endObservationId: input.observation.id },
          pages: finished.pageIndex,
          served: finished.captured,
        });
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
        };
        return { work: { satisfiesRevision: true, close: "done", closeReason: `walk_${end}`, cursor: next, proof: receipt }, followups, counters };
      };
      const goOn = (nextWalk: PostsWalk): ApplyResult => ({
        work: { satisfiesRevision: false, nextDueAt: now, cursor: { ...cursor, walk: nextWalk } },
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
          return walk.end === null ? goOn(walk) : await complete(walk.end, walk);
        }
        const scope = inspectFanslyPostTipsScope(input.response, { requestedTargetIds: targetIds, receiverId: input.ownRef ?? "" });
        if (!scope.accepted) counters.post_tips_scope_drift = 1;
        walk = { ...walk, pendingTips: null, tipsScopeDrifts: walk.tipsScopeDrifts + (scope.accepted ? 0 : 1) };
        return walk.end === null ? goOn(walk) : await complete(walk.end, walk);
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
        // Admission, not receipt: a post published before the head page was
        // asked for is on it, a later one may not be.
        headReadAt: walk.headReadAt ?? (requestedBefore === FANSLY_HEAD_CURSOR ? input.attempt.admittedAt.toISOString() : null),
        oldestPublishedAt: posts.reduce(
          (oldest, post) => earlierIso(oldest, fanslyPublishedAt(post.createdAt)?.toISOString() ?? null),
          walk.oldestPublishedAt,
        ),
      };
      const end: PostsWalkEnd | null = posts.length === 0
        ? "timeline_exhausted"
        : wholePageOlderThan(posts, walk.cutoffAt) ? "cutoff_reached" : null;
      if (end !== null) {
        // The closing page's tips are read too, then the walk completes.
        return ids.length > 0 ? goOn({ ...walk, pendingTips: ids, end }) : await complete(end, walk);
      }
      const nextBefore = ids.at(-1) ?? null;
      if (nextBefore === null || nextBefore === requestedBefore) {
        throw new ApplyQuarantine("posts_cursor_stuck", { before: requestedBefore });
      }
      return goOn({ ...walk, before: nextBefore, pendingTips: ids });
    },

    outcomeInCapture: (tx, decision, input) => walkFailureInCapture(tx, decision, input),
  };
}

// ── engagement (standing walk over `post_engagement`) ───────────────────────

export const POST_ENGAGEMENT_QUEUE: SubjectQueueWalk<PostEngagementRefreshCandidate> = {
  plane: "post_engagement",
  pickDue: (db, input) => listPostEngagementRefreshChunk(db, { pageId: input.pageId, limit: input.limit, now: input.now }),
};

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
  async plan(_work, ctx): Promise<StepPlan> {
    const due = await POST_ENGAGEMENT_QUEUE.pickDue(ctx.db, { pageId: ctx.pageId, now: ctx.now, limit: POST_BATCH_SIZE });
    if (due.length === 0) return { kind: "wait", reason: "not_due", until: standingRecheckAt(ctx.now, POST_ENGAGEMENT_RECHECK_MS) };
    const ids = due.map((candidate) => candidate.subjectRef);
    return { kind: "request", request: { spec: "posts.by_ids", params: { ids } } satisfies RequestPlan<"posts.by_ids"> };
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
    // The walk row stays: the next plan takes the next due batch, or rests.
    return {
      work: { satisfiesRevision: true, nextDueAt: now, cursor: { last: receipt }, result: receipt },
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
