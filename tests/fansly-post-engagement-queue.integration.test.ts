// WP-F6 — the `post_engagement` refresh queue, against a real database.
//
// This is the DECAY, and it is the half of the phase that cannot be tested with
// mocks: the tiering, the due-ness arithmetic and the priority order are all SQL
// over `subject_refresh_state` joined to `creator_posts`.
//
// What is pinned here:
//
//  - THE TIER BOUNDARIES. fresh <= 30 d (daily), mid <= 180 d (weekly), long
//    tail beyond (every 30 d). Constants, not config: how engagement on a post
//    decays with its age is a property of the platform.
//  - DUE-NESS FROM `published_at` AND `last_visited_at`, never from a stored
//    `next_due_at` — a post that AGES out of `fresh` must slow down, and a
//    frozen due date would keep it on a daily cadence forever. The one
//    exception is a FAILED row, which waits for its `next_due_at` backoff.
//  - THE PRIORITY ORDER: never-refreshed first, then dirty, then due-by-decay.
//  - A FAILED LOOK IS NOT A LOOK: `last_visited_at` does not move.
//  - THE QUEUE SURVIVES A REBUILD (§3.4 operational state), which is why it is
//    not four columns on the rebuildable `creator_posts`.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  countPostEngagementRefreshProgress,
  createFanslyPage,
  createModel,
  listPostEngagementRefreshChunk,
  POST_ENGAGEMENT_FRESH_DAYS,
  POST_ENGAGEMENT_MID_DAYS,
  postEngagementIntervalDays,
  postEngagementTier,
  recordPostEngagementRefreshFailures,
  recordPostEngagementRefreshVisits,
  seedPostEngagementQueue,
  upsertCreatorPost,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

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

const NOW = new Date("2026-08-22T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60_000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

async function seedPage(label: string) {
  const model = await createModel(testDb!.db, { slug: label, name: label });
  if (!model) throw new Error("model seed failed");
  const page = await createFanslyPage(testDb!.db, { modelId: model.id, label: `${label}-page` });
  if (!page) throw new Error("page seed failed");
  return page;
}

/** A post head written the way the creator-posts projector writes it — which is
 *  also what seeds both of its refresh rows. */
async function seedPost(
  pageId: number,
  postRef: string,
  publishedAt: Date,
  platform: "fansly" | "onlyfans" = "fansly",
) {
  await upsertCreatorPost(testDb!.db, {
    accountId: pageId,
    platform,
    platformPostId: postRef,
    textPlain: "a post",
    publishedAt,
    observedAt: publishedAt,
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

async function visited(pageId: number, subjectRef: string, at: Date) {
  await testDb!.pool.query(
    `update subject_refresh_state
        set last_visited_at = $3, refresh_class = 'long_tail'
      where page_id = $1 and plane = 'post_engagement' and subject_ref = $2`,
    [pageId, subjectRef, at],
  );
}

describe("[sync-critical] WP-F6 the post_engagement refresh queue", () => {
  it("classifies a post's tier from its publication age", () => {
    // Pure arithmetic, pinned so the boundary lives in one place: the handler
    // computes a row's next due date from the same function the SQL tiers with.
    expect(postEngagementTier(daysAgo(1), NOW)).toBe("fresh");
    expect(postEngagementTier(daysAgo(POST_ENGAGEMENT_FRESH_DAYS), NOW)).toBe("fresh");
    expect(postEngagementTier(daysAgo(POST_ENGAGEMENT_FRESH_DAYS + 1), NOW)).toBe("mid");
    expect(postEngagementTier(daysAgo(POST_ENGAGEMENT_MID_DAYS), NOW)).toBe("mid");
    expect(postEngagementTier(daysAgo(POST_ENGAGEMENT_MID_DAYS + 1), NOW)).toBe("long_tail");
    // Publication date unknown ⇒ treat it as fresh rather than inventing an age.
    expect(postEngagementTier(null, NOW)).toBe("fresh");

    expect(postEngagementIntervalDays("fresh")).toBe(1);
    expect(postEngagementIntervalDays("mid")).toBe(7);
    expect(postEngagementIntervalDays("long_tail")).toBe(30);
  });

  it("seeds Fansly posts only, in bounded keyset batches", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage("f6q-seed");
    // Written through the projector's own path, so each already carries its
    // same-transaction row. Clear them to exercise the FIRST-ENABLE sweep, which
    // is what a page whose posts predate this package actually hits.
    for (const ref of ["p-1", "p-2", "p-3"]) await seedPost(page.id, ref, daysAgo(5));
    await seedPost(page.id, "of-1", daysAgo(5), "onlyfans");
    await testDb.pool.query("delete from subject_refresh_state where page_id = $1", [page.id]);

    const first = await seedPostEngagementQueue(testDb.db, {
      pageId: page.id,
      afterSubjectRef: null,
      limit: 2,
      dueAt: NOW,
    });
    expect(first).toMatchObject({ scanned: 2, inserted: 2, cursor: "p-2" });
    const second = await seedPostEngagementQueue(testDb.db, {
      pageId: page.id,
      afterSubjectRef: first.cursor,
      limit: 2,
      dueAt: NOW,
    });
    // `of-1` sorts before `p-*` and is NOT scanned: `GET /post?ids=` is a Fansly
    // route and an OnlyFans post has no batch read to queue.
    expect(second).toMatchObject({ scanned: 1, inserted: 1, cursor: "p-3" });

    const progress = await countPostEngagementRefreshProgress(testDb.db, page.id);
    expect(progress).toMatchObject({ subjectsKnown: 3, subjectsRefreshed: 0, postsKnown: 3 });
  });

  it("re-reads by DECAY: daily, weekly, monthly by the post's age", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage("f6q-decay");
    await seedPost(page.id, "fresh-1", daysAgo(3));
    await seedPost(page.id, "mid-1", daysAgo(60));
    await seedPost(page.id, "tail-1", daysAgo(400));
    // All three looked at two days ago.
    for (const ref of ["fresh-1", "mid-1", "tail-1"]) await visited(page.id, ref, daysAgo(2));

    const due = await listPostEngagementRefreshChunk(testDb.db, {
      pageId: page.id,
      limit: 10,
      now: NOW,
    });
    // Only the fresh one is owed: a two-day-old look is stale for a post
    // published this month and perfectly current for one published last year.
    expect(due.map((row) => row.subjectRef)).toEqual(["fresh-1"]);
    expect(due[0]?.tier).toBe("fresh");

    // Ten days on, the mid-tier post joins it; the long tail still does not.
    const laterDue = await listPostEngagementRefreshChunk(testDb.db, {
      pageId: page.id,
      limit: 10,
      now: new Date(NOW.getTime() + 10 * DAY_MS),
    });
    expect(laterDue.map((row) => row.subjectRef).sort()).toEqual(["fresh-1", "mid-1"]);
  });

  it("slows a post down as it AGES across a tier boundary", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage("f6q-age");
    // Published exactly at the fresh boundary and looked at two days ago: due
    // today…
    await seedPost(page.id, "ageing-1", daysAgo(POST_ENGAGEMENT_FRESH_DAYS));
    await visited(page.id, "ageing-1", daysAgo(2));
    expect((await listPostEngagementRefreshChunk(testDb.db, {
      pageId: page.id,
      limit: 10,
      now: NOW,
    })).map((row) => row.subjectRef)).toEqual(["ageing-1"]);

    // …and NOT due one day later, when the same post has crossed into `mid` and
    // its look is only three days old. This is why due-ness is computed against
    // `now` rather than read from a `next_due_at` frozen at the old tier.
    const dayLater = new Date(NOW.getTime() + DAY_MS);
    expect(await listPostEngagementRefreshChunk(testDb.db, {
      pageId: page.id,
      limit: 10,
      now: dayLater,
    })).toEqual([]);
  });

  it("orders never-refreshed first, then dirty, then due-by-decay", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage("f6q-order");
    await seedPost(page.id, "never-old", daysAgo(300));
    await seedPost(page.id, "never-new", daysAgo(1));
    await seedPost(page.id, "dirty-1", daysAgo(300));
    await seedPost(page.id, "due-1", daysAgo(1));
    await visited(page.id, "dirty-1", daysAgo(1));
    await visited(page.id, "due-1", daysAgo(5));
    await testDb.pool.query(
      `update subject_refresh_state
          set dirty_reason = 'reply_count_changed', refresh_class = 'dirty'
        where page_id = $1 and plane = 'post_engagement' and subject_ref = 'dirty-1'`,
      [page.id],
    );

    const chunk = await listPostEngagementRefreshChunk(testDb.db, {
      pageId: page.id,
      limit: 10,
      now: NOW,
    });
    expect(chunk.map((row) => row.priorityBand)).toEqual([0, 0, 1, 2]);
    // Inside the never-refreshed band, the FRESH tier goes first: a counter
    // that is still moving is worth more than one that settled a year ago.
    expect(chunk.map((row) => row.subjectRef))
      .toEqual(["never-new", "never-old", "dirty-1", "due-1"]);
    // A dirty row is due whatever its decay says — no cutoff can suppress it.
    expect(chunk[2]).toMatchObject({ tier: "long_tail", dirtyReason: "reply_count_changed" });
  });

  it("records a visit with the row's OWN tier interval and clears the dirty mark", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage("f6q-visit");
    await seedPost(page.id, "fresh-1", daysAgo(3));
    await seedPost(page.id, "tail-1", daysAgo(400));
    await testDb.pool.query(
      `update subject_refresh_state
          set dirty_reason = 'reply_count_changed'
        where page_id = $1 and plane = 'post_engagement'`,
      [page.id],
    );

    await recordPostEngagementRefreshVisits(testDb.db, {
      pageId: page.id,
      visitedAt: NOW,
      visits: [
        { subjectRef: "fresh-1", tier: "fresh", nextDueAt: new Date(NOW.getTime() + DAY_MS) },
        {
          subjectRef: "tail-1",
          tier: "long_tail",
          nextDueAt: new Date(NOW.getTime() + 30 * DAY_MS),
        },
      ],
    });

    const rows = await testDb.pool.query<{
      subject_ref: string;
      refresh_class: string;
      dirty_reason: string | null;
      last_visited_at: Date;
      next_due_at: Date;
      consecutive_failures: number;
    }>(
      `select subject_ref, refresh_class, dirty_reason, last_visited_at, next_due_at,
              consecutive_failures
         from subject_refresh_state
        where page_id = $1 and plane = 'post_engagement'
        order by subject_refresh_state.subject_ref`,
      [page.id],
    );
    const [fresh, tail] = rows.rows;
    expect(fresh).toMatchObject({
      subject_ref: "fresh-1",
      refresh_class: "fresh",
      // The VISIT is what clears the mark — nothing else does, so a signal can
      // never be lost between "marked" and "fetched".
      dirty_reason: null,
      consecutive_failures: 0,
    });
    expect(fresh!.next_due_at.toISOString()).toBe(new Date(NOW.getTime() + DAY_MS).toISOString());
    // `refresh_class` is written as the tier the post is in TODAY, which is how
    // a post ages out of `fresh` without anything sweeping it.
    expect(tail).toMatchObject({ refresh_class: "long_tail", dirty_reason: null });
    expect(tail!.next_due_at.toISOString())
      .toBe(new Date(NOW.getTime() + 30 * DAY_MS).toISOString());

    const progress = await countPostEngagementRefreshProgress(testDb.db, page.id);
    expect(progress).toMatchObject({ subjectsRefreshed: 2, subjectsDirty: 0 });
  });

  it("does NOT count a failed look as a look", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage("f6q-fail");
    await seedPost(page.id, "p-1", daysAgo(3));

    await recordPostEngagementRefreshFailures(testDb.db, {
      pageId: page.id,
      subjectRefs: ["p-1"],
      nextDueAt: new Date(NOW.getTime() + DAY_MS),
    });
    await recordPostEngagementRefreshFailures(testDb.db, {
      pageId: page.id,
      subjectRefs: ["p-1"],
      nextDueAt: new Date(NOW.getTime() + DAY_MS),
    });

    const row = await testDb.pool.query<{
      last_visited_at: Date | null;
      consecutive_failures: number;
    }>(
      `select last_visited_at, consecutive_failures from subject_refresh_state
        where page_id = $1 and plane = 'post_engagement' and subject_ref = 'p-1'`,
      [page.id],
    );
    // Moving `last_visited_at` would retire the post from the never-refreshed
    // band on the strength of an error. What moves is the counter an operator
    // reads to tell "unreachable" from "not got to it yet".
    expect(row.rows[0]?.last_visited_at).toBeNull();
    expect(row.rows[0]?.consecutive_failures).toBe(2);
    expect((await countPostEngagementRefreshProgress(testDb.db, page.id)).subjectsRefreshed)
      .toBe(0);
  });

  it("holds a failed post out of the batch until its backoff", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage("f6q-backoff");
    const refsAt = async (now: Date, limit = 10) =>
      (await listPostEngagementRefreshChunk(testDb!.db, { pageId: page.id, limit, now }))
        .map((row) => row.subjectRef);
    const backOff = (subjectRef: string) =>
      recordPostEngagementRefreshFailures(testDb!.db, {
        pageId: page.id,
        subjectRefs: [subjectRef],
        nextDueAt: new Date(NOW.getTime() + DAY_MS),
      });

    // BAND ZERO. A never-refreshed post the provider does not serve — deleted,
    // say — is newest, so without a backoff it heads every batch.
    await seedPost(page.id, "never-dead", daysAgo(1));
    await seedPost(page.id, "never-ok", daysAgo(2));
    expect(await refsAt(NOW, 1)).toEqual(["never-dead"]);
    await backOff("never-dead");
    expect(await refsAt(NOW, 1)).toEqual(["never-ok"]);
    // The backoff runs out and the post gets one more look.
    expect(await refsAt(new Date(NOW.getTime() + DAY_MS), 1)).toEqual(["never-dead"]);

    // THE DUE BAND. Oldest visit first, so a visited-then-failing post would
    // lead the due posts for as long as it keeps failing.
    await visited(page.id, "never-ok", NOW);
    await seedPost(page.id, "mid-fail", daysAgo(60));
    await seedPost(page.id, "mid-due", daysAgo(60));
    await visited(page.id, "mid-fail", daysAgo(40));
    await visited(page.id, "mid-due", daysAgo(10));
    expect(await refsAt(NOW)).toEqual(["mid-fail", "mid-due"]);
    await backOff("mid-fail");
    expect(await refsAt(NOW)).toEqual(["mid-due"]);

    // A SUCCESS resets the counter, and the row is due by its tier again.
    await recordPostEngagementRefreshVisits(testDb.db, {
      pageId: page.id,
      visitedAt: NOW,
      visits: [{
        subjectRef: "mid-fail",
        tier: "mid",
        nextDueAt: new Date(NOW.getTime() + 7 * DAY_MS),
      }],
    });
    expect(await refsAt(NOW)).toEqual(["mid-due"]);
    expect(await refsAt(new Date(NOW.getTime() + 8 * DAY_MS))).toContain("mid-fail");
  });
});
