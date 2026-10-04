import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  clearSubjectQueueBlocks,
  createFanslyPage,
  createModel,
  listPostEngagementRefreshChunk,
  listPostRepliesWalkChunk,
  recordSubjectQueueFailures,
  subjectQueueBackoffOpen,
  upsertCreatorPost,
  type Database,
} from "@agency_hub_core/db";

import { QUEUE_SUBJECT_BREAKER } from "../apps/runtime/src/sync/fansly/lib/subject-queue.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

// The per-subject queue of the Fansly Sync Engine's subject-queue walks
// (design §4.3, D2), against a real database:
//
//  - THE WALK ORDER: `listPostRepliesWalkChunk` /
//    `listPostEngagementRefreshChunk` select exactly what their statements
//    selected in the legacy lanes (pinned against a frozen copy of each on a
//    fixture covering every band, NULLs and microsecond timestamps).
//  - THE QUEUE BREAKER: failures climb the engine's ladder on the queue row,
//    the fifth blocks the subject (daily probe), an answer lifts the block.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

const NOW = new Date("2026-10-02T12:00:00.000Z");
const DAY_MS = 86_400_000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

async function seedPage(label: string): Promise<number> {
  const model = await createModel(db(), { slug: label, name: label });
  const page = await createFanslyPage(db(), { modelId: model!.id, label: `${label}-page` });
  return page!.id;
}

async function seedPost(pageId: number, postRef: string, publishedAt: Date) {
  await upsertCreatorPost(db(), {
    accountId: pageId,
    platform: "fansly",
    platformPostId: postRef,
    textPlain: "a post",
    publishedAt,
    observedAt: NOW,
    contentHash: "a".repeat(64),
    attachmentCount: 0,
    tipAmountMills: null,
    attachmentTipAmountMills: null,
    postTipTotalMills: null,
    tipGoalLinked: null,
    tipGoalRef: null,
    tipGoalLabel: null,
    tipGoalTargetMills: null,
    tipGoalCurrentMills: null,
    tipGoalAmountsHidden: null,
    likeCount: null,
    mediaLikeCount: null,
    replyCount: null,
    fypFlags: null,
    expiresAt: null,
    inReplyToRef: null,
    inReplyToRootRef: null,
    wallRefs: null,
    accountMentionRefs: null,
    hashtags: null,
    hashtagsNormalized: null,
    hashtagParserVersion: null,
    attachmentRefs: null,
    engagementObservedAt: null,
    sourceEventId: 1,
    sourceObservationId: 1,
    sourceAccountSeq: 1,
  });
}

/** A queue fixture over both planes: never-walked (projected posts, and one
 *  queue row whose post never was — the replies walk's only NULL publication
 *  instant, `creator_posts.published_at` being NOT NULL), dirty, due by age, a
 *  failed row in and out of its backoff, and visits that tie to the
 *  microsecond. */
async function seedQueue(pageId: number) {
  const posts: Array<[string, Date]> = [
    ["900000000000000001", daysAgo(1)],
    ["900000000000000002", daysAgo(3)],
    ["900000000000000003", daysAgo(5)],
    ["900000000000000004", daysAgo(40)],
    ["900000000000000005", daysAgo(40)],
    ["900000000000000006", daysAgo(200)],
    ["900000000000000007", daysAgo(200)],
    ["900000000000000008", daysAgo(10)],
    ["900000000000000009", daysAgo(10)],
    ["900000000000000010", daysAgo(500)],
    ["900000000000000011", daysAgo(2)],
  ];
  for (const [ref, publishedAt] of posts) await seedPost(pageId, ref, publishedAt);
  // A queue row whose post was never projected (the replies walk joins left).
  await testDb!.pool.query(
    `insert into subject_refresh_state (page_id, plane, subject_ref, refresh_class, next_due_at)
     values ($1, 'post_replies', '900000000000000099', 'fresh', $2)`,
    [pageId, NOW],
  );
  const set = async (ref: string, assignments: string, values: unknown[] = []) => {
    await testDb!.pool.query(
      `update subject_refresh_state set ${assignments} where page_id = $1 and subject_ref = $2`,
      [pageId, ref, ...values],
    );
  };
  // Visited long ago, two of them at the very same microsecond.
  const tie = "2026-08-01 10:00:00.123456+00";
  await set("900000000000000004", "last_visited_at = $3::timestamptz", [tie]);
  await set("900000000000000005", "last_visited_at = $3::timestamptz", [tie]);
  await set("900000000000000006", "last_visited_at = $3::timestamptz", ["2026-06-01 00:00:00.000001+00"]);
  await set("900000000000000007", "last_visited_at = $3::timestamptz", ["2026-06-01 00:00:00.000002+00"]);
  await set("900000000000000010", "last_visited_at = $3::timestamptz", ["2026-05-01 00:00:00+00"]);
  // Dirty.
  await set("900000000000000008", "last_visited_at = $3::timestamptz, dirty_reason = 'reply_count_changed'", [daysAgo(1)]);
  // Failed: one still backing off, one due again.
  await set("900000000000000009", "consecutive_failures = 2, next_due_at = $3::timestamptz", [new Date(NOW.getTime() + 3_600_000)]);
  await set("900000000000000011", "consecutive_failures = 1, next_due_at = $3::timestamptz", [new Date(NOW.getTime() - 60_000)]);
}

/** The replies statement exactly as the legacy lane ran it. */
async function legacyRepliesChunk(pageId: number, limit: number, rewalkBefore: Date) {
  const band = sql`case when s.last_visited_at is null then 0 when s.dirty_reason is not null then 1 else 2 end`;
  const result = await db().execute<Record<string, unknown>>(sql`
    select s.subject_ref, s.known_count, s.dirty_reason, s.last_visited_at, s.consecutive_failures, ${band} as priority_band
      from subject_refresh_state s
      left join creator_posts p on p.account_id = s.page_id and p.platform_post_id = s.subject_ref
     where s.page_id = ${pageId} and s.plane = 'post_replies'
       and (s.consecutive_failures = 0 or s.next_due_at <= ${NOW})
       and (s.last_visited_at is null or s.dirty_reason is not null or s.last_visited_at < ${rewalkBefore})
     order by ${band} asc,
              case when s.last_visited_at is null then p.published_at end desc nulls last,
              s.last_visited_at asc nulls first,
              s.subject_ref desc
     limit ${limit}
  `);
  return result.rows.map((row) => ({
    subjectRef: row.subject_ref,
    knownCount: row.known_count === null ? null : Number(row.known_count),
    dirtyReason: row.dirty_reason,
    lastVisitedAt: row.last_visited_at === null ? null : new Date(row.last_visited_at as string),
    consecutiveFailures: Number(row.consecutive_failures),
    priorityBand: Number(row.priority_band),
  }));
}

/** The engagement statement exactly as the legacy lane ran it. */
async function legacyEngagementChunk(pageId: number, limit: number) {
  const tier = sql`case when p.published_at is null then 'fresh'
    when p.published_at >= ${new Date(NOW.getTime() - 30 * DAY_MS)} then 'fresh'
    when p.published_at >= ${new Date(NOW.getTime() - 180 * DAY_MS)} then 'mid' else 'long_tail' end`;
  const dueCutoff = sql`case ${tier}
    when 'fresh' then ${new Date(NOW.getTime() - 1 * DAY_MS)}::timestamptz
    when 'mid' then ${new Date(NOW.getTime() - 7 * DAY_MS)}::timestamptz
    else ${new Date(NOW.getTime() - 30 * DAY_MS)}::timestamptz end`;
  const band = sql`case when s.last_visited_at is null then 0 when s.dirty_reason is not null then 1 else 2 end`;
  const result = await db().execute<Record<string, unknown>>(sql`
    select s.subject_ref, p.published_at, s.last_visited_at, s.dirty_reason, s.consecutive_failures,
           ${tier} as tier, ${band} as priority_band
      from subject_refresh_state s
      join creator_posts p on p.account_id = s.page_id and p.platform_post_id = s.subject_ref
     where s.page_id = ${pageId} and s.plane = 'post_engagement'
       and (s.consecutive_failures = 0 or s.next_due_at <= ${NOW})
       and (s.last_visited_at is null or s.dirty_reason is not null or s.last_visited_at < ${dueCutoff})
     order by ${band} asc,
              case ${tier} when 'fresh' then 0 when 'mid' then 1 else 2 end asc,
              s.last_visited_at asc nulls first,
              p.published_at desc nulls last,
              s.subject_ref desc
     limit ${limit}
  `);
  return result.rows.map((row) => ({
    subjectRef: row.subject_ref,
    publishedAt: row.published_at === null ? null : new Date(row.published_at as string),
    lastVisitedAt: row.last_visited_at === null ? null : new Date(row.last_visited_at as string),
    dirtyReason: row.dirty_reason,
    consecutiveFailures: Number(row.consecutive_failures),
    tier: row.tier,
    priorityBand: Number(row.priority_band),
  }));
}

describe("the queue chunk functions keep the legacy lanes' order", () => {
  it("post_replies: the same subjects, fields and order as the frozen statement", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("parity-replies");
    await seedQueue(pageId);
    // The rows each plane holds in one more state: a long-ago visit of the
    // engagement plane that the replies plane does not share.
    const rewalkBefore = daysAgo(30);
    for (const limit of [1, 3, 50]) {
      const now = await listPostRepliesWalkChunk(db(), { pageId, limit, rewalkBefore, now: NOW });
      expect(now).toEqual(await legacyRepliesChunk(pageId, limit, rewalkBefore));
    }
    const all = await listPostRepliesWalkChunk(db(), { pageId, limit: 50, rewalkBefore, now: NOW });
    expect(all.map((row) => row.subjectRef)).toEqual([
      // never walked, newest post first (a failed one whose backoff has
      // passed among them), the unprojected row last within the band
      "900000000000000001", "900000000000000011", "900000000000000002", "900000000000000003",
      "900000000000000099",
      // dirty
      "900000000000000008",
      // due by age: oldest visit first, a microsecond tie by ref descending
      "900000000000000010", "900000000000000006", "900000000000000007", "900000000000000005", "900000000000000004",
    ]);
  });

  it("post_engagement: the same subjects, fields and order as the frozen statement", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("parity-engagement");
    await seedQueue(pageId);
    for (const limit of [1, 4, 100]) {
      const now = await listPostEngagementRefreshChunk(db(), { pageId, limit, now: NOW });
      expect(now).toEqual(await legacyEngagementChunk(pageId, limit));
    }
  });
});

describe("the queue-row breaker", () => {
  it("climbs the ladder, blocks from the fifth failure on, and lifts on an answer", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("breaker");
    await seedPost(pageId, "800000000000000001", daysAgo(1));
    const ref = "800000000000000001";
    const steps: Array<{ failures: number; waitMs: number; blocked: boolean }> = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const [failure] = await recordSubjectQueueFailures(db(), {
        pageId, plane: "post_replies", subjectRefs: [ref, ref], now: NOW, ladder: QUEUE_SUBJECT_BREAKER,
      });
      steps.push({ failures: failure!.consecutiveFailures, waitMs: failure!.nextDueAt.getTime() - NOW.getTime(), blocked: failure!.blocked });
    }
    expect(steps).toEqual([
      { failures: 1, waitMs: 60_000, blocked: false },
      { failures: 2, waitMs: 600_000, blocked: false },
      { failures: 3, waitMs: 3_600_000, blocked: false },
      { failures: 4, waitMs: 21_600_000, blocked: false },
      { failures: 5, waitMs: 86_400_000, blocked: true },
      { failures: 6, waitMs: 86_400_000, blocked: true },
    ]);
    // The other plane of the same post is untouched.
    const other = await testDb.pool.query(
      "select consecutive_failures from subject_refresh_state where page_id = $1 and plane = 'post_engagement' and subject_ref = $2",
      [pageId, ref],
    );
    expect(other.rows[0].consecutive_failures).toBe(0);
    expect(await subjectQueueBackoffOpen(db(), { pageId, plane: "post_replies", subjectRef: ref, now: NOW })).toBe(true);
    expect(await subjectQueueBackoffOpen(db(), { pageId, plane: "post_replies", subjectRef: ref, now: new Date(NOW.getTime() + 2 * DAY_MS) })).toBe(false);
    expect(await subjectQueueBackoffOpen(db(), { pageId, plane: "post_replies", subjectRef: "nope", now: NOW })).toBeNull();

    expect(await clearSubjectQueueBlocks(db(), { pageId, plane: "post_replies", subjectRefs: [ref] })).toBe(1);
    expect(await clearSubjectQueueBlocks(db(), { pageId, plane: "post_replies", subjectRefs: [ref] })).toBe(0);
    const row = await testDb.pool.query(
      "select last_refresh_outcome, consecutive_failures from subject_refresh_state where page_id = $1 and plane = 'post_replies' and subject_ref = $2",
      [pageId, ref],
    );
    expect(row.rows[0]).toEqual({ last_refresh_outcome: null, consecutive_failures: 6 });
    expect(await recordSubjectQueueFailures(db(), { pageId, plane: "post_replies", subjectRefs: [], now: NOW, ladder: QUEUE_SUBJECT_BREAKER })).toEqual([]);
  });
});
