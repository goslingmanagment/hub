
import { sql } from "drizzle-orm";

import {
  countPostComments,
  countPostRepliesWalkProgress,
  listPostRepliesWalkChunk,
  listUnnamedPostCommentAuthorRefs,
  recordPostRepliesWalkVisit,
  subjectQueueBackoffOpen,
  type CaptureCoverageStatus,
  type Database,
  type PostRepliesWalkCandidate,
} from "@agency_hub_core/db";
import { FANSLY_ACCOUNT_LOOKUP_BATCH_SIZE } from "@agency_hub_core/fansly";
import { CAPTURE_COVERAGE_PLANES, getDescriptor } from "@agency_hub_core/shared";

import { REPLIES_FULL_PAGE_THRESHOLD } from "../../../services/canonicalize/fansly-comments.ts";
import { writeFanslyLaneCoverage } from "../lib/lane.ts";
import {
  classifyPostRepliesResponse,
  nextRepliesCursor,
  p99PostsLength,
  replyRows,
  type RepliesPaginationMode,
} from "../lib/post-replies-rules.ts";
import { ApplyQuarantine } from "../../engine/commit.ts";
import type {
  ApplyInput,
  ApplyResult,
  DemandSignal,
  RequestPlan,
  ResourceModule,
  StepPlan,
} from "../../engine/resource.ts";
import type { SettingsSource } from "../../engine/ports.ts";
import {
  clearQueueSubjectBlocks,
  recordQueueSubjectFailures,
  standingRecheckAt,
  type SubjectQueueWalk,
} from "../lib/subject-queue.ts";

// `post-replies.walk` and `post-replies.authors` (plan §5, design §5.16): the
// comment archive. `GET /post/{postId}/replies` bare, `?before=<last reply id>`
// only after a full page (≥ 20 rows) and only while the route has not shown
// that it serves one page; journaled as `post_replies` in its `{walk:{postId,
// before}, response}` envelope (fansly/capture.ts), so an empty page still says
// which post it is about. The replies become events by inline
// canonicalization (`pull/comments`). Never `POST /postreply/verify`.
//
// walk (standing walk over the `post_replies` queue, design §4.3): one post at
// a time — never walked newest first, then dirty (its reply count moved),
// then older than `fanslyRepliesRewalkCycleDays` (live config) — page by page
// until a short page, ≤ 20 pages per post. A finished post is visited (known
// count, next re-walk); a failed one opens its queue row's breaker and the
// walk moves on: one unreachable post never stops an archive of thousands.
// What the route does with `before` is learned once and kept
// (`paginationMode`); until it is proven a full page stays `possiblyTruncated`
// and the coverage never claims more than `window_captured`.
//
// authors (planned trigger): the comment authors no `fans` row names, ≤ 100
// per `GET /account?ids=`, journaled raw (`account_lookup`, which no family
// claims — parity with the legacy lane, D17). The walk remembers the last
// 1 000 refs it asked for, as the legacy cursor did.

export type PostRepliesVariant = "walk" | "authors";

const AUTHORS_KEY = "post-replies.authors";
const DAY_MS = 86_400_000;
/** Pages ONE post's walk may take (a safety net, not a coverage limit). */
export const MAX_PAGES_PER_POST = 20;
/** The walk looks at its queue again this long after it found nothing due
 *  (the legacy stream's cadence). */
export const POST_REPLIES_RECHECK_MS = 6 * 60 * 60 * 1000;
const HYDRATED_AUTHOR_MEMORY = 1_000;
const POSTS_LENGTH_SAMPLE_LIMIT = 200;
const DEFAULT_REWALK_CYCLE_DAYS = Number(getDescriptor("fanslyRepliesRewalkCycleDays")?.default ?? "14");

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

/** `fanslyRepliesRewalkCycleDays`, read live (≥ 1). */
async function rewalkCycleDays(settings: SettingsSource | undefined): Promise<number> {
  const configured = settings === undefined ? undefined : (await settings.read()).fanslyRepliesRewalkCycleDays;
  return Math.max(1, configured ?? DEFAULT_REWALK_CYCLE_DAYS);
}

// ── the walk ────────────────────────────────────────────────────────────────

/** The due posts of the reply queue in walk order, under a re-walk cycle. */
export function pickDuePostReplies(
  db: Database,
  input: { pageId: number; now: Date; limit: number; rewalkCycleDays: number },
): Promise<PostRepliesWalkCandidate[]> {
  return listPostRepliesWalkChunk(db, {
    pageId: input.pageId,
    limit: input.limit,
    rewalkBefore: new Date(input.now.getTime() - input.rewalkCycleDays * DAY_MS),
    now: input.now,
  });
}

/** The reply queue at the default re-walk cycle (design §4.3 helper shape). */
export const POST_REPLIES_QUEUE: SubjectQueueWalk<PostRepliesWalkCandidate> = {
  plane: "post_replies",
  pickDue: (db, input) => pickDuePostReplies(db, { ...input, rewalkCycleDays: DEFAULT_REWALK_CYCLE_DAYS }),
};

interface PostWalk {
  postId: string;
  /** `before` of the next page (null: the bare first call). */
  before: string | null;
  /** The ids the previous page served (did the cursor move?). */
  previousPageIds: string[];
  pages: number;
  seen: number;
}

export interface PostRepliesCursor {
  paginationMode: RepliesPaginationMode;
  paginationAnnounced: boolean;
  /** Author refs already asked for (≤ 1 000, newest last). */
  hydratedAuthorRefs: string[];
  /** Observed `posts.length` per page (≤ 200, newest last). */
  postsLengthSamples: number[];
  walk: PostWalk | null;
  last: Record<string, unknown> | null;
}

export function parsePostRepliesCursor(value: unknown): PostRepliesCursor {
  const record = recordOf(value);
  const walkRecord = recordOf(record.walk);
  const postId = text(walkRecord.postId);
  const mode = record.paginationMode;
  return {
    paginationMode: mode === "before" || mode === "single_page" ? mode : "unproven",
    paginationAnnounced: record.paginationAnnounced === true,
    hydratedAuthorRefs: stringList(record.hydratedAuthorRefs).slice(-HYDRATED_AUTHOR_MEMORY),
    postsLengthSamples: Array.isArray(record.postsLengthSamples)
      ? record.postsLengthSamples.filter((item): item is number => count(item) !== null).slice(-POSTS_LENGTH_SAMPLE_LIMIT)
      : [],
    walk: postId === null ? null : {
      postId,
      before: text(walkRecord.before),
      previousPageIds: stringList(walkRecord.previousPageIds),
      pages: count(walkRecord.pages) ?? 0,
      seen: count(walkRecord.seen) ?? 0,
    },
    last: typeof record.last === "object" && record.last !== null ? record.last as Record<string, unknown> : null,
  };
}

function repliesRequest(postId: string, before: string | null): RequestPlan<"post.replies"> {
  return { spec: "post.replies", params: { postId, before } };
}

function repliesParams(request: RequestPlan): { postId: string; before: string | null } {
  const params = recordOf(request.params);
  return { postId: text(params.postId) ?? "", before: text(params.before) };
}

/**
 * What the route did with `before`, settled by the page that came back from a
 * cursor (legacy pagination discovery): the same rows again ⇒ it serves one
 * page; anything else — new rows or an empty page — ⇒ it pages.
 */
export function discoverPagination(previousPageIds: readonly string[], pageIds: readonly string[]): RepliesPaginationMode {
  const same = pageIds.length === previousPageIds.length && pageIds.every((id, index) => id === previousPageIds[index]);
  return same ? "single_page" : "before";
}

/** The comment authors to ask for next: unnamed ones the memory has not
 *  asked for, ≤ 100 (over-read, so a known first hundred still progresses). */
async function pendingAuthors(db: Database, pageId: number, memory: readonly string[]): Promise<string[]> {
  const known = new Set(memory);
  const unnamed = await listUnnamedPostCommentAuthorRefs(db, { pageId, limit: FANSLY_ACCOUNT_LOOKUP_BATCH_SIZE * 4 });
  return unnamed.filter((ref) => !known.has(ref)).slice(0, FANSLY_ACCOUNT_LOOKUP_BATCH_SIZE);
}

/** The authors follow-up of a finished post, and the memory after it. */
async function authorsFollowup(db: Database, pageId: number, cursor: PostRepliesCursor): Promise<{ followups: DemandSignal[]; memory: string[] }> {
  const pending = await pendingAuthors(db, pageId, cursor.hydratedAuthorRefs);
  if (pending.length === 0) return { followups: [], memory: cursor.hydratedAuthorRefs };
  return {
    followups: [{ resource: AUTHORS_KEY, ids: pending, demand: { reason: "unnamed_comment_authors" } }],
    memory: [...cursor.hydratedAuthorRefs, ...pending].slice(-HYDRATED_AUTHOR_MEMORY),
  };
}

/** Whether the page's list of posts is whole: it has no `posts.backfill` row
 *  (a page that never ran one: its known roots are the list), or its newest
 *  one walked the timeline to its end (`sync_work_key_recent`). An open,
 *  paused, quarantined or otherwise closed backfill means roots are still
 *  unknown. */
async function postsListWhole(tx: Database, pageId: number): Promise<boolean> {
  const result = await tx.execute<{ state: string; closeReason: string | null }>(sql`
    select state, close_reason as "closeReason"
      from sync_work
     where page_id = ${pageId} and resource = 'posts.backfill' and subject = '' and not shadow
     order by id desc
     limit 1
  `);
  const newest = result.rows[0];
  return newest === undefined || (newest.state === "done" && newest.closeReason === "walk_timeline_exhausted");
}

/** The archive's coverage after a finished post (legacy rules, minus the
 *  retired budget deferral): complete only when every known root was walked,
 *  nothing is possibly truncated and the list of roots is whole
 *  (`postsListWhole`) — every root walked of a list still being read is
 *  `in_progress` (`posts_list_incomplete`). */
async function writeArchiveCoverage(tx: Database, input: { pageId: number; now: Date; cursor: PostRepliesCursor }) {
  const progress = await countPostRepliesWalkProgress(tx, input.pageId);
  const archive = await countPostComments(tx, input.pageId);
  const everyRootWalked = progress.rootsKnown > 0 && progress.rootsWalked >= progress.rootsKnown;
  const exhausted = everyRootWalked && archive.possiblyTruncated === 0;
  const listWhole = !exhausted || (await postsListWhole(tx, input.pageId));
  const status: CaptureCoverageStatus = progress.rootsKnown === 0
    ? "not_started"
    : exhausted
      ? listWhole ? "provider_exhausted" : "in_progress"
      : everyRootWalked ? "window_captured" : "in_progress";
  await writeFanslyLaneCoverage({
    db: tx,
    pageId: input.pageId,
    plane: CAPTURE_COVERAGE_PLANES.postReplies,
    scopeRef: String(input.pageId),
    status,
    acquisitionMode: "retroactive",
    proof: "none",
    newestCapturedAt: input.now,
    reasonCode: status === "window_captured" ? "pagination_unproven" : listWhole ? null : "posts_list_incomplete",
    expectedCount: progress.rootsKnown,
    observedUniqueCount: progress.rootsWalked,
    cursor: {
      paginationMode: input.cursor.paginationMode,
      possiblyTruncated: archive.possiblyTruncated,
      p99PostsLength: p99PostsLength(input.cursor.postsLengthSamples),
    },
  });
  return { rootsKnown: progress.rootsKnown, rootsWalked: progress.rootsWalked, status };
}

const walkModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const cursor = parsePostRepliesCursor(work.cursor);
    const cycleDays = await rewalkCycleDays(ctx.settings);
    if (cursor.walk !== null && cursor.walk.before !== null) {
      // A post mid-walk continues — unless it failed meanwhile (its breaker
      // is open): then the walk moves on and the post is re-read from its
      // head when it is due again.
      const backoff = await subjectQueueBackoffOpen(ctx.db, { pageId: ctx.pageId, plane: POST_REPLIES_QUEUE.plane, subjectRef: cursor.walk.postId, now: ctx.now });
      if (backoff === false) return { kind: "request", request: repliesRequest(cursor.walk.postId, cursor.walk.before) };
    }
    const [next] = await pickDuePostReplies(ctx.db, { pageId: ctx.pageId, now: ctx.now, limit: 1, rewalkCycleDays: cycleDays });
    if (next === undefined) return { kind: "wait", reason: "not_due", until: standingRecheckAt(ctx.now, POST_REPLIES_RECHECK_MS) };
    return { kind: "request", request: repliesRequest(next.subjectRef, null) };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const now = input.now;
    const cursor = parsePostRepliesCursor(input.work.cursor);
    const params = repliesParams(input.request);
    if (params.postId.length === 0) throw new ApplyQuarantine("post_replies_request_without_post");
    let walk: PostWalk;
    if (params.before === null) {
      walk = { postId: params.postId, before: null, previousPageIds: [], pages: 0, seen: 0 };
    } else if (cursor.walk !== null && cursor.walk.postId === params.postId && cursor.walk.before === params.before) {
      walk = cursor.walk;
    } else {
      throw new ApplyQuarantine("post_replies_cursor_mismatch", { postId: params.postId, before: params.before, walk: cursor.walk?.postId ?? null });
    }
    // The served envelope's `response` (the wire layer's `{__empty: true}` for
    // a 204): the reply page itself.
    const response = input.response;
    const rows = replyRows(response);
    const counters: Record<string, number> = {};
    let next: PostRepliesCursor = cursor;
    const cycleDays = await rewalkCycleDays(input.settings);

    if (classifyPostRepliesResponse(response) === "invalid" || rows === null) {
      // Neither a reply page nor an honest empty answer: journaled, refused as
      // an answer, and about THIS post only — its breaker opens, the walk
      // moves on.
      await recordQueueSubjectFailures(tx, { pageId: input.pageId, plane: POST_REPLIES_QUEUE.plane, subjectRefs: [params.postId], now });
      return {
        work: { satisfiesRevision: true, nextDueAt: now, cursor: { ...next, walk: null } },
        followups: [],
        counters: { reply_page_unreadable: 1 },
      };
    }
    if (recordOf(response).__empty === true) counters.reply_page_empty_body = 1;

    const pageIds = rows.map((row) => text(row.id) ?? "");
    next = { ...next, postsLengthSamples: [...next.postsLengthSamples, rows.length].slice(-POSTS_LENGTH_SAMPLE_LIMIT) };
    walk = { ...walk, pages: walk.pages + 1, seen: walk.seen + rows.length };

    const finish = async (): Promise<ApplyResult> => {
      await recordPostRepliesWalkVisit(tx, {
        pageId: input.pageId,
        subjectRef: walk.postId,
        knownCount: walk.seen,
        visitedAt: now,
        nextDueAt: new Date(now.getTime() + cycleDays * DAY_MS),
      });
      await clearQueueSubjectBlocks(tx, { pageId: input.pageId, plane: POST_REPLIES_QUEUE.plane, subjectRefs: [walk.postId] });
      const authors = await authorsFollowup(tx, input.pageId, next);
      next = { ...next, hydratedAuthorRefs: authors.memory, walk: null };
      const coverage = await writeArchiveCoverage(tx, { pageId: input.pageId, now, cursor: next });
      const receipt = { postId: walk.postId, pages: walk.pages, replies: walk.seen, visitedAt: now.toISOString(), ...coverage };
      counters.posts_walked = 1;
      return {
        // The walk row stays: the next plan takes the next due post, or rests.
        work: { satisfiesRevision: true, nextDueAt: now, cursor: { ...next, last: receipt }, result: receipt },
        followups: authors.followups,
        counters,
      };
    };

    // ── pagination discovery: what the cursor actually did ──
    if (params.before !== null && next.paginationMode === "unproven") {
      const mode = discoverPagination(walk.previousPageIds, pageIds);
      next = { ...next, paginationMode: mode, paginationAnnounced: true };
      counters[`pagination_${mode}`] = 1;
      // The cursor bought nothing: the rows are the ones already read.
      if (mode === "single_page") return finish();
    }
    walk = { ...walk, previousPageIds: pageIds };
    // A cursor only after a suspiciously full page, never once the route
    // has shown it serves one page.
    if (rows.length < REPLIES_FULL_PAGE_THRESHOLD || next.paginationMode === "single_page") return finish();
    const nextBefore = nextRepliesCursor(rows);
    if (nextBefore === null) {
      counters.reply_cursor_missing = 1;
      return finish();
    }
    if (nextBefore === params.before) {
      // The identical `before` twice is a loop's first step.
      counters.reply_cursor_repeat = 1;
      return finish();
    }
    if (walk.pages >= MAX_PAGES_PER_POST) {
      counters.reply_walk_capped = 1;
      return finish();
    }
    return {
      work: { satisfiesRevision: false, nextDueAt: now, cursor: { ...next, walk: { ...walk, before: nextBefore } } },
      followups: [],
      counters,
    };
  },

  async onSubjectOutcome(tx, work, outcome, step): Promise<void> {
    // A terminal answer climbs the same ladder: the walk row reopens at once,
    // so a post left due would be asked again and again.
    if (outcome.kind === "ok") return;
    const { postId } = repliesParams(step.request);
    if (postId.length === 0) return;
    await recordQueueSubjectFailures(tx, { pageId: work.pageId, plane: POST_REPLIES_QUEUE.plane, subjectRefs: [postId], now: new Date() });
  },
};

// ── authors ─────────────────────────────────────────────────────────────────

interface AuthorsCursor {
  /** How many of `params.ids` were asked for (the list only grows at its end). */
  asked: number;
}

function parseAuthorsCursor(value: unknown): AuthorsCursor {
  return { asked: count(recordOf(value).asked) ?? 0 };
}

function authorIds(params: unknown): string[] {
  return [...new Set(stringList(recordOf(params).ids))];
}

function nextAuthorBatch(work: { params: unknown; cursor: unknown }): string[] {
  const asked = parseAuthorsCursor(work.cursor).asked;
  return authorIds(work.params).slice(asked, asked + FANSLY_ACCOUNT_LOOKUP_BATCH_SIZE);
}

function stepAuthors(work: { params: unknown; cursor: unknown }, batch: number, now: Date) {
  const asked = parseAuthorsCursor(work.cursor).asked + batch;
  const left = authorIds(work.params).length - asked;
  return left > 0
    ? { satisfiesRevision: false, nextDueAt: now, cursor: { asked } satisfies AuthorsCursor }
    : { satisfiesRevision: true, close: "done" as const, closeReason: "authors_asked", cursor: { asked } satisfies AuthorsCursor };
}

const authorsModule: ResourceModule = {
  async plan(work): Promise<StepPlan> {
    const batch = nextAuthorBatch(work);
    if (batch.length === 0) return { kind: "done", reason: "authors_asked" };
    return { kind: "request", request: { spec: "accounts.by_ids", params: { ids: batch } } };
  },

  async apply(_tx, input: ApplyInput): Promise<ApplyResult> {
    // Raw-only (D17): the journal IS the capture; nothing parses it.
    const batch = authorIds(input.request.params).length;
    return { work: stepAuthors(input.work, batch, input.now), followups: [], counters: { authors_asked: batch } };
  },
};

export function postRepliesModule(variant: PostRepliesVariant): ResourceModule {
  return variant === "walk" ? walkModule : authorsModule;
}
