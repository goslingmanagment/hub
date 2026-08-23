// WP-F5 — post-replies queue, paging, coverage and attempt invariants.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  getCheckpoint,
  listSubjectRefreshState,
  upsertCreatorPost,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import { millsFromInteger } from "@agency_hub_core/shared";

import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import {
  fanslyPostRepliesChunk,
  hasAccountSidecar,
  nextRepliesCursor,
  p99PostsLength,
  parseFanslyPostRepliesCursorState,
  replyAuthorRefs,
  replyRows,
} from "../apps/runtime/src/services/sync/fansly-post-replies.ts";
import { REPLIES_FULL_PAGE_THRESHOLD } from "../apps/runtime/src/services/canonicalize/fansly-comments.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  fanslyLaneAppStub,
  fanslyLaneInput,
  fanslyLaneTelemetryStub as telemetryStub,
  observeFanslyLaneAttempts,
  seedFanslyLanePage,
} from "./helpers/fansly-lane-harness.ts";

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
});

const NOW = new Date("2026-08-22T09:00:00.000Z");

function ref(n: number): string {
  return `0009${String(10000000000000 + n).padStart(14, "0")}`;
}

/** The [A20] hazard, in the shape WP-F9's probe read off a live reply page. */
function fullAccountSidecar(accountRef: string) {
  return [{
    id: accountRef,
    username: "fixture_fan",
    displayName: "Fixture Fan",
    createdAt: 1690000000,
    followsYou: true,
    notes: [],
    // The eight [A20]-rejected fields; `lastSeenAt` is the one that moves every
    // minute and destroys the dedup collapse.
    lastSeenAt: 1787000123,
    followCount: 41,
    subscriberCount: 7,
    postLikes: 19,
    accountMediaLikes: 4,
    timelineStats: { imageCount: 12 },
    streaming: { lastFetchedAt: 0 },
    version: 3,
  }];
}

function replyPage(options: {
  postRef: string;
  count?: number;
  authorRef?: string;
  withSidecar?: boolean;
  idBase?: number;
}) {
  const count = options.count ?? 1;
  const authorRef = options.authorRef ?? ref(9001);
  const idBase = options.idBase ?? 5000;
  return {
    posts: Array.from({ length: count }, (_unused, index) => ({
      id: ref(idBase + index),
      accountId: authorRef,
      content: index === 1 ? "" : `reply ${index}`,
      inReplyTo: options.postRef,
      inReplyToRoot: options.postRef,
      createdAt: 1786709378 - index,
      attachments: [],
      likeCount: 0,
      mediaLikeCount: 0,
      totalTipAmount: 0,
      attachmentTipAmount: 0,
    })),
    aggregatedPosts: [],
    accountMedia: [],
    accountMediaBundles: [],
    accounts: options.withSidecar === true ? fullAccountSidecar(authorRef) : [],
    tips: [],
    tipGoals: [],
    stories: [],
    polls: [],
  };
}

interface AdapterCall {
  route: string;
  params: Record<string, unknown>;
}

/**
 * An adapter stub that reports ATTEMPTS through the observer, exactly as the
 * real one does: `attemptsPerCall` above 1 is what a retried request looks like
 * to everything downstream of `executeObservedRequest`.
 */
function adapterStub(options: {
  attemptsPerCall?: number;
  reply?: (params: Record<string, unknown>, index: number) => unknown;
  fail?: (route: string, index: number) => Error | null;
} = {}) {
  const attemptsPerCall = options.attemptsPerCall ?? 1;
  const calls: AdapterCall[] = [];
  let physicalAttempts = 0;
  let replyIndex = 0;

  async function observe(
    context: {
      requestObserver?: { onRequestEvent: (event: unknown) => Promise<void> } | null;
      remainingAttempts?: (() => number) | null;
    },
    route: string,
    params: Record<string, unknown>,
  ) {
    const index = calls.length;
    calls.push({ route, params });
    await observeFanslyLaneAttempts(context, {
      attempts: attemptsPerCall,
      requestId: `${route}:${index}`,
      operation: route,
      endpointTemplate: route,
      onAttempt: () => {
        physicalAttempts += 1;
      },
    });
    const failure = options.fail?.(route, index) ?? null;
    if (failure !== null) {
      throw failure;
    }
  }

  const wrap = (body: unknown) => ({ items: body, raw: body });

  return {
    calls,
    get physicalAttempts() {
      return physicalAttempts;
    },
    getPostRepliesPage: vi.fn(async (context: never, params: Record<string, unknown>) => {
      await observe(context, "post_replies", params);
      const index = replyIndex;
      replyIndex += 1;
      return wrap(
        options.reply?.(params, index)
          ?? replyPage({ postRef: String(params.postId) }),
      );
    }),
    getAccountsByIdsPage: vi.fn(async (context: never, ids: string[]) => {
      await observe(context, "account_lookup", { ids });
      return wrap(ids.map((id) => ({ id, username: "fixture_fan" })));
    }),
  };
}

function appStub(
  adapter: ReturnType<typeof adapterStub>,
  configOverrides: Record<string, unknown> = {},
) {
  return fanslyLaneAppStub({
    database: testDb!,
    adapter,
    config: {
      fanslyPostRepliesSyncEnabled: true,
      fanslyPostRepliesPageAllowlist: "replies-lane",
      fanslyRepliesDailyCallBudget: 100,
      fanslyRepliesRewalkCycleDays: 14,
      fanslyBackfillContinuationDelayMs: 20_000,
      ...configOverrides,
    },
  });
}

let syncRunId = 0;

async function seedPage() {
  const seeded = await seedFanslyLanePage(testDb!, {
    slug: "replies",
    name: "Replies",
    label: "replies-lane",
    accountRef: "acct-replies",
    stream: "post_replies",
  });
  syncRunId = seeded.syncRunId;
  return seeded.page;
}

/** A root post, written the way the creator-posts projector writes it — which
 *  is also what seeds its walk row. */
async function seedPost(pageId: number, postRef: string, publishedAt: string) {
  await upsertCreatorPost(testDb!.db, {
    accountId: pageId,
    platform: "fansly",
    platformPostId: postRef,
    textPlain: "a post",
    publishedAt: new Date(publishedAt),
    observedAt: new Date(publishedAt),
    contentHash: "a".repeat(64),
    attachmentCount: 0,
    tipAmountMills: millsFromInteger(0),
    attachmentTipAmountMills: millsFromInteger(0),
    postTipTotalMills: millsFromInteger(0),
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

function input(
  pageId: number,
  telemetry: ReturnType<typeof telemetryStub>,
  budget = new SyncChunkBudget(),
  now = NOW,
) {
  return fanslyLaneInput({
    pageId,
    label: "replies-lane",
    accountRef: "acct-replies",
    egressKey: "fansly:replies",
    telemetry,
    syncRunId,
    now,
    budget,
  }) as never;
}

async function cursor(pageId: number) {
  const checkpoint = await getCheckpoint(testDb!.db, pageId, "post_replies");
  return parseFanslyPostRepliesCursorState(checkpoint?.state);
}

async function observations(pageId: number) {
  const result = await testDb!.pool.query(
    `select kind, payload from observations where account_id = $1 order by id`,
    [pageId],
  );
  return result.rows as Array<{ kind: string; payload: Record<string, unknown> }>;
}

async function requestParams(pageId: number, endpoint: string) {
  const result = await testDb!.pool.query(
    `select request_params, response_payload from sync_raw_payloads
      where page_id = $1 and endpoint = $2 order by id`,
    [pageId, endpoint],
  );
  return result.rows as Array<{
    request_params: Record<string, unknown>;
    response_payload: Record<string, unknown>;
  }>;
}

async function coverageRows(pageId: number) {
  const result = await testDb!.pool.query(
    `select plane, scope_ref, status, proof, reason_code, expected_count,
            observed_unique_count, cursor
       from capture_coverage where page_id = $1 order by plane, scope_ref`,
    [pageId],
  );
  return result.rows as Array<Record<string, unknown>>;
}

async function walkRows(pageId: number) {
  return listSubjectRefreshState(testDb!.db, { pageId, plane: "post_replies" });
}

/** Run chunks until the lane says the slot is satisfied, or the guard trips. */
async function drain(
  pageId: number,
  adapter: ReturnType<typeof adapterStub>,
  telemetry: ReturnType<typeof telemetryStub>,
  maxChunks = 30,
) {
  let result: Awaited<ReturnType<typeof fanslyPostRepliesChunk>> | null = null;
  for (let chunk = 0; chunk < maxChunks; chunk += 1) {
    result = await fanslyPostRepliesChunk(
      appStub(adapter),
      input(pageId, telemetry, new SyncChunkBudget()),
    );
    if (result.satisfied) {
      break;
    }
  }
  return result;
}

describe("[sync-critical] WP-F5 post_replies lane", () => {
  it("is INERT until both gates open", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedPost(page.id, ref(1), "2026-08-01T00:00:00.000Z");
    const adapter = adapterStub();
    const telemetry = telemetryStub();

    const flagOff = await fanslyPostRepliesChunk(
      appStub(adapter, { fanslyPostRepliesSyncEnabled: false }),
      input(page.id, telemetry),
    );
    expect(flagOff.gatedSkip).toBe("flag_off");

    // FAILS CLOSED: an empty allowlist means NO pages, the opposite of the
    // Fansly new-stream allowlist semantic.
    const notAllowlisted = await fanslyPostRepliesChunk(
      appStub(adapter, { fanslyPostRepliesPageAllowlist: "" }),
      input(page.id, telemetry),
    );
    expect(notAllowlisted.gatedSkip).toBe("not_allowlisted");

    expect(adapter.calls).toHaveLength(0);
    expect(await observations(page.id)).toHaveLength(0);
  });

  it("seeds a walk row per post and walks them NEWEST FIRST", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // Deliberately out of publication order in the queue's own key order: the
    // ref that sorts LOWEST is the newest post, so a walk that ordered by ref
    // would read the archive backwards.
    await seedPost(page.id, ref(1), "2026-01-01T00:00:00.000Z");
    await seedPost(page.id, ref(2), "2026-06-01T00:00:00.000Z");
    await seedPost(page.id, ref(3), "2026-08-01T00:00:00.000Z");

    const adapter = adapterStub();
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    const rows = await walkRows(page.id);
    expect(rows.map((row) => row.subjectRef).sort()).toEqual([ref(1), ref(2), ref(3)].sort());
    expect(rows.every((row) => row.lastVisitedAt !== null)).toBe(true);

    // NEWEST FIRST. A comment archive that starts with the posts nobody
    // remembers is useless for a year.
    const walkedOrder = adapter.calls
      .filter((call) => call.route === "post_replies")
      .map((call) => String(call.params.postId));
    expect(walkedOrder.slice(0, 3)).toEqual([ref(3), ref(2), ref(1)]);
  });

  it("seeds the walk row in the SAME TRANSACTION as the post", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();

    // A post that is committed brings its walk row with it.
    await seedPost(page.id, ref(1), "2026-08-01T00:00:00.000Z");
    expect((await walkRows(page.id)).map((row) => row.subjectRef)).toEqual([ref(1)]);

    // And a transaction that ROLLS BACK brings neither. This is the assertion
    // that makes "same transaction" a fact rather than an ordering: if the queue
    // insert rode outside, the post would vanish and the orphan walk row would
    // stay — or worse, the post would land with no walk row and its comments
    // would never be read, with nothing anywhere reporting a problem.
    await expect(testDb.db.transaction(async (tx) => {
      await upsertCreatorPost(tx as never, {
        accountId: page.id,
        platform: "fansly",
        platformPostId: ref(2),
        textPlain: "doomed",
        publishedAt: new Date("2026-08-02T00:00:00.000Z"),
        observedAt: new Date("2026-08-02T00:00:00.000Z"),
        contentHash: "b".repeat(64),
        attachmentCount: 0,
        tipAmountMills: millsFromInteger(0),
        attachmentTipAmountMills: millsFromInteger(0),
        postTipTotalMills: millsFromInteger(0),
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
        sourceEventId: 2,
        sourceObservationId: 2,
        sourceAccountSeq: 2,
      });
      throw new Error("rollback");
    })).rejects.toThrow(/rollback/);

    expect((await walkRows(page.id)).map((row) => row.subjectRef)).toEqual([ref(1)]);
    const posts = await testDb.pool.query(
      "select platform_post_id from creator_posts where account_id = $1",
      [page.id],
    );
    expect(posts.rows.map((row) => (row as { platform_post_id: string }).platform_post_id))
      .toEqual([ref(1)]);
  });

  it("does NOT queue an OnlyFans post", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const model = await createModel(testDb.db, { slug: "of-replies", name: "OF" });
    const page = await createFanslyPage(testDb.db, { modelId: model!.id, label: "of-page" });
    await testDb.pool.query("update pages set platform = 'onlyfans' where id = $1", [page!.id]);
    await upsertCreatorPost(testDb.db, {
      accountId: page!.id,
      platform: "onlyfans",
      platformPostId: "of-post-1",
      textPlain: "a post",
      publishedAt: new Date("2026-08-01T00:00:00.000Z"),
      observedAt: new Date("2026-08-01T00:00:00.000Z"),
      contentHash: "c".repeat(64),
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
      sourceEventId: 3,
      sourceObservationId: 3,
      sourceAccountSeq: 3,
    });
    // `/post/{id}/replies` is a Fansly route; an OnlyFans post has no walk to
    // queue, and queueing one would make the lane's own progress figures lie.
    expect(await walkRows(page!.id)).toEqual([]);
  });

  it("issues the BARE GET and journals the walk envelope beside the verbatim body", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedPost(page.id, ref(1), "2026-08-01T00:00:00.000Z");
    const adapter = adapterStub();
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    const walkCalls = adapter.calls.filter((call) => call.route === "post_replies");
    expect(walkCalls).toHaveLength(1);
    // NO CURSOR on the first call. The bare form is the only one five live
    // responses prove.
    expect(walkCalls[0]?.params).toEqual({ postId: ref(1), before: null });

    const journaled = await requestParams(page.id, "post_replies");
    expect(journaled).toHaveLength(1);
    expect(journaled[0]?.request_params).toEqual({ postId: ref(1), before: null });

    // The OBSERVATION carries the walk context, because the post id lives in
    // the request PATH and an empty page would otherwise name no post at all.
    const stored = await observations(page.id);
    const walk = stored.find((row) => row.kind === "post_replies")!;
    expect(walk.payload.walk).toEqual({ postId: ref(1), before: null });
    expect(Array.isArray((walk.payload.response as { posts: unknown[] }).posts)).toBe(true);
  });

  it("applies [A20] to `accounts[]` on the row that lands in `observations`", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedPost(page.id, ref(1), "2026-08-01T00:00:00.000Z");
    const adapter = adapterStub({
      reply: (params) => replyPage({ postRef: String(params.postId), withSidecar: true }),
    });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    const stored = await observations(page.id);
    const walk = stored.find((row) => row.kind === "post_replies")!;
    const response = walk.payload.response as Record<string, unknown>;
    const accounts = response.accounts as Array<Record<string, unknown>>;
    expect(accounts).toHaveLength(1);
    // The 18-field allowlist kept the identity...
    expect(accounts[0]?.id).toBe(ref(9001));
    expect(accounts[0]?.username).toBe("fixture_fan");
    expect(accounts[0]?.followsYou).toBe(true);
    // ...and dropped every volatile field. `lastSeenAt` moves every minute; on
    // a lane that re-reads thousands of posts, journaling it makes every body
    // unique and destroys the dedup collapse the disk budget rests on.
    for (const rejected of [
      "lastSeenAt",
      "followCount",
      "subscriberCount",
      "postLikes",
      "accountMediaLikes",
      "timelineStats",
      "streaming",
      "version",
    ]) {
      expect(Object.hasOwn(accounts[0]!, rejected), rejected).toBe(false);
    }
    // EVERYTHING ELSE IS VERBATIM. [A20] narrowed exactly one array, not the
    // response: the replies themselves and every sidecar are untouched.
    expect(response.posts).toBeDefined();
    expect(response.tips).toEqual([]);
    expect(response.tipGoals).toEqual([]);
    expect(response.stories).toEqual([]);
    expect(response.polls).toEqual([]);
    expect(response.aggregatedPosts).toEqual([]);

    // The raw table stores the same trimmed body — the envelope adds context,
    // it removes nothing.
    const raw = await requestParams(page.id, "post_replies");
    expect(raw[0]?.response_payload).toEqual(response);
  });

  it("records an EMPTY answer as walked-with-zero-comments, never as a failure", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedPost(page.id, ref(1), "2026-08-01T00:00:00.000Z");
    // The adapter's SYNTHETIC 204 marker. No GET anywhere in the capture ever
    // returned 204, so this is the honest handling of a case never observed.
    const adapter = adapterStub({ reply: () => ({ __empty: true, httpStatus: 204 }) });
    const telemetry = telemetryStub();
    const result = await drain(page.id, adapter, telemetry);

    expect(result?.satisfied).toBe(true);
    expect(telemetry.anomalies).toEqual([]);
    const rows = await walkRows(page.id);
    expect(rows[0]?.lastVisitedAt).not.toBeNull();
    expect(rows[0]?.knownCount).toBe(0);
    expect(rows[0]?.consecutiveFailures).toBe(0);
    // The empty body is still JOURNALED — it is the evidence that this post has
    // no comments, and the roster the projector marks `missing_since` from.
    expect(await requestParams(page.id, "post_replies")).toHaveLength(1);
  });

  it("REFUSES an unreadable body as an answer, journals it, and counts a failure", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedPost(page.id, ref(1), "2026-08-01T00:00:00.000Z");
    const adapter = adapterStub({ reply: () => ({ data: [], total: 0 }) });
    const telemetry = telemetryStub();
    await fanslyPostRepliesChunk(appStub(adapter), input(page.id, telemetry));

    // Journaled (capture first), refused as an answer (recording "no comments"
    // from a shape we cannot read is how an archive deletes itself).
    expect(await requestParams(page.id, "post_replies")).toHaveLength(1);
    expect(telemetry.anomalies.map((anomaly) => anomaly.code))
      .toContain("fansly_replies_shape_unreadable");
    const rows = await walkRows(page.id);
    // `last_visited_at` does NOT move: a failed look is not a look, and moving
    // it would retire the post from the never-walked band on an error.
    expect(rows[0]?.lastVisitedAt).toBeNull();
    expect(rows[0]?.consecutiveFailures).toBe(1);
    expect(await coverageRows(page.id)).toEqual([]);
  });

  it("scopes a per-post failure to that post and re-raises 401 untouched", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedPost(page.id, ref(1), "2026-08-01T00:00:00.000Z");
    await seedPost(page.id, ref(2), "2026-07-01T00:00:00.000Z");

    // One post 404s. The rest of an archive of thousands must not wedge behind
    // it.
    const scoped = adapterStub({
      fail: (route, index) =>
        route === "post_replies" && index === 0 ? new FanslyApiError("gone", 404) : null,
    });
    const telemetry = telemetryStub();
    await drain(page.id, scoped, telemetry);
    expect(telemetry.anomalies.map((anomaly) => anomaly.code))
      .toContain("fansly_replies_post_failed");
    const rows = await walkRows(page.id);
    expect(rows.filter((row) => row.lastVisitedAt !== null)).toHaveLength(1);

    // A dead session is the executor's business: it must reach the auth pause
    // unchanged rather than being counted as one bad post.
    await seedPost(page.id, ref(3), "2026-06-01T00:00:00.000Z");
    const authDead = adapterStub({
      fail: (route) => route === "post_replies" ? new FanslyApiError("unauthorized", 401) : null,
    });
    await expect(fanslyPostRepliesChunk(
      appStub(authDead),
      input(page.id, telemetryStub()),
    )).rejects.toMatchObject({ status: 401 });
  });

  it("lets a healthy post run while failed posts wait for their retry due time", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const healthyRef = ref(1);
    await seedPost(page.id, healthyRef, "2026-08-01T00:00:00.000Z");
    const deadRefs: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const deadRef = ref(index + 10);
      deadRefs.push(deadRef);
      await seedPost(
        page.id,
        deadRef,
        `2026-08-${String(index + 10).padStart(2, "0")}T00:00:00.000Z`,
      );
    }

    const adapter = adapterStub({
      fail: (route, index) =>
        route === "post_replies" && index < 5 ? new FanslyApiError("gone", 404) : null,
    });
    const telemetry = telemetryStub();
    await fanslyPostRepliesChunk(
      appStub(adapter),
      input(page.id, telemetry, new SyncChunkBudget(5)),
    );
    expect(adapter.calls.slice(0, 5).map((call) => call.params.postId)).toEqual(
      [...deadRefs].reverse(),
    );

    const before = adapter.calls.length;
    await fanslyPostRepliesChunk(
      appStub(adapter),
      input(page.id, telemetry, new SyncChunkBudget(5)),
    );
    const secondChunkPosts = adapter.calls.slice(before)
      .filter((call) => call.route === "post_replies")
      .map((call) => call.params.postId);
    expect(secondChunkPosts).toContain(healthyRef);
    expect(secondChunkPosts.some((postId) => deadRefs.includes(String(postId)))).toBe(false);
  });

  it("DEFERS at the 100-attempt cap and keeps the response it already fetched", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    for (let index = 0; index < 6; index += 1) {
      await seedPost(page.id, ref(index + 1), `2026-08-0${index + 1}T00:00:00.000Z`);
    }
    // A cap of 3, and every call RETRIED twice: the cap is counted in HTTP
    // ATTEMPTS, so three attempts is ONE AND A HALF logical calls, and a cap
    // counted in logical calls would let a retry storm multiply real egress.
    const adapter = adapterStub({ attemptsPerCall: 2 });
    const telemetry = telemetryStub();
    const result = await fanslyPostRepliesChunk(
      appStub(adapter, { fanslyRepliesDailyCallBudget: 3 }),
      input(page.id, telemetry),
    );

    expect(result.satisfied).toBe(false);
    expect((result.stats as Record<string, unknown>).deferred).toBe("daily_call_budget");
    // Deferred to the next UTC day, not retried in five minutes.
    expect(result.continuationRetryAt?.toISOString()).toBe("2026-08-23T00:05:00.000Z");

    const state = await cursor(page.id);
    expect(state?.callsToday).toBe(3);
    expect(adapter.physicalAttempts).toBe(3);
    // NEVER DROPS means every response that DID finish is journaled. The
    // fourth retry is refused before egress, so the second logical call has no
    // response to journal and its queue row remains due.
    expect(await requestParams(page.id, "post_replies")).toHaveLength(1);
    expect((await walkRows(page.id)).filter((row) => row.lastVisitedAt !== null)).toHaveLength(1);
  });

  it("resets the day counter across the UTC roll and keeps the queue", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    for (let index = 0; index < 4; index += 1) {
      await seedPost(page.id, ref(index + 1), `2026-08-0${index + 1}T00:00:00.000Z`);
    }
    const adapter = adapterStub();
    const telemetry = telemetryStub();
    await fanslyPostRepliesChunk(
      appStub(adapter, { fanslyRepliesDailyCallBudget: 2 }),
      input(page.id, telemetry),
    );
    expect((await cursor(page.id))?.callsToday).toBe(2);

    const tomorrow = new Date("2026-08-23T09:00:00.000Z");
    await fanslyPostRepliesChunk(
      appStub(adapter, { fanslyRepliesDailyCallBudget: 2 }),
      input(page.id, telemetry, new SyncChunkBudget(), tomorrow),
    );
    const state = await cursor(page.id);
    expect(state?.utcDay).toBe("2026-08-23");
    expect(state?.callsToday).toBe(2);
    // The walk queue is DURABLE state: a new day resets the allowance and
    // nothing else.
    expect((await walkRows(page.id)).filter((row) => row.lastVisitedAt !== null))
      .toHaveLength(4);
  });

  it("prefers a DIRTY post over a re-walk, and never-walked over both", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedPost(page.id, ref(1), "2026-08-01T00:00:00.000Z");
    await seedPost(page.id, ref(2), "2026-07-01T00:00:00.000Z");
    await seedPost(page.id, ref(3), "2026-06-01T00:00:00.000Z");

    // ref(2) walked long ago and marked dirty; ref(3) walked long ago and
    // clean; ref(1) never walked.
    await testDb.pool.query(
      `update subject_refresh_state
          set last_visited_at = $2, dirty_reason = 'reply_count_changed'
        where page_id = $1 and plane = 'post_replies' and subject_ref = $3`,
      [page.id, "2026-07-01T00:00:00.000Z", ref(2)],
    );
    await testDb.pool.query(
      `update subject_refresh_state
          set last_visited_at = $2
        where page_id = $1 and plane = 'post_replies' and subject_ref = $3`,
      [page.id, "2026-07-01T00:00:00.000Z", ref(3)],
    );

    const adapter = adapterStub();
    const telemetry = telemetryStub();
    await fanslyPostRepliesChunk(appStub(adapter), input(page.id, telemetry));

    const order = adapter.calls
      .filter((call) => call.route === "post_replies")
      .map((call) => String(call.params.postId));
    // (1) never-walked, (2) dirty, (3) round-robin re-walk.
    expect(order).toEqual([ref(1), ref(2), ref(3)]);

    // The VISIT is what clears the dirty mark — nothing else does, so a signal
    // can never be lost between "marked" and "fetched".
    const rows = await walkRows(page.id);
    expect(rows.every((row) => row.dirtyReason === null)).toBe(true);
  });

  it("leaves a post alone until the re-walk cycle is up", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedPost(page.id, ref(1), "2026-08-01T00:00:00.000Z");
    const adapter = adapterStub();
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);
    expect(adapter.calls.filter((call) => call.route === "post_replies")).toHaveLength(1);

    // Same day: nothing is due, so nothing is spent.
    await drain(page.id, adapter, telemetry);
    expect(adapter.calls.filter((call) => call.route === "post_replies")).toHaveLength(1);

    // Fifteen days later, the round-robin picks it up again.
    const later = new Date("2026-09-06T09:00:00.000Z");
    await fanslyPostRepliesChunk(
      appStub(adapter),
      input(page.id, telemetry, new SyncChunkBudget(), later),
    );
    expect(adapter.calls.filter((call) => call.route === "post_replies")).toHaveLength(2);
  });

  it("discovers pagination ONCE, announces it once, and never loops", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedPost(page.id, ref(1), "2026-08-01T00:00:00.000Z");

    // A suspiciously FULL first page, then a second page of new rows: the
    // cursor was honoured.
    const adapter = adapterStub({
      reply: (params, index) =>
        index === 0
          ? replyPage({
            postRef: String(params.postId),
            count: REPLIES_FULL_PAGE_THRESHOLD,
            idBase: 5000,
          })
          : replyPage({ postRef: String(params.postId), count: 2, idBase: 6000 }),
    });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    const calls = adapter.calls.filter((call) => call.route === "post_replies");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.params.before).toBeNull();
    // `before` is the LAST row's own id — replies come back descending by id.
    expect(calls[1]?.params.before).toBe(ref(5000 + REPLIES_FULL_PAGE_THRESHOLD - 1));

    const state = await cursor(page.id);
    expect(state?.paginationMode).toBe("before");
    expect(state?.paginationAnnounced).toBe(true);
    const discovery = telemetry.anomalies
      .filter((anomaly) => anomaly.code === "fansly_replies_pagination_discovered");
    // ONCE, ever. A discovery announced on every walk is a discovery nobody
    // reads.
    expect(discovery).toHaveLength(1);
    expect(String((discovery[0] as { message: string }).message)).toMatch(/HONOURS/);
  });

  it("records `single_page` when the cursor serves the SAME rows again", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedPost(page.id, ref(1), "2026-08-01T00:00:00.000Z");
    // The route ignores `before` and answers with the identical page. A walk
    // that trusted the cursor would re-read this forever.
    const adapter = adapterStub({
      reply: (params) =>
        replyPage({
          postRef: String(params.postId),
          count: REPLIES_FULL_PAGE_THRESHOLD,
          idBase: 5000,
        }),
    });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    expect(adapter.calls.filter((call) => call.route === "post_replies")).toHaveLength(2);
    const state = await cursor(page.id);
    expect(state?.paginationMode).toBe("single_page");
    const discovery = telemetry.anomalies
      .filter((anomaly) => anomaly.code === "fansly_replies_pagination_discovered");
    expect(discovery).toHaveLength(1);
    expect(String((discovery[0] as { message: string }).message)).toMatch(/IGNORES/);

    // And no post is ever paged again: the second walk of the same post makes
    // ONE call, not two.
    const later = new Date("2026-09-06T09:00:00.000Z");
    await fanslyPostRepliesChunk(
      appStub(adapter),
      input(page.id, telemetry, new SyncChunkBudget(), later),
    );
    expect(adapter.calls.filter((call) => call.route === "post_replies")).toHaveLength(3);
  });

  it("hydrates unnamed comment authors ONCE per chunk, under `account_lookup`", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedPost(page.id, ref(1), "2026-08-01T00:00:00.000Z");
    // A comment already stored with NO display fields — the shape 2 of 5 live
    // responses produce, and the reason this fallback is mandatory.
    await testDb.pool.query(
      `insert into post_comments (
         page_id, platform, comment_ref, parent_post_ref, author_ref, text_plain,
         occurred_at, changed_at, discovered_via, first_observed_at, last_observed_at,
         content_hash, source_event_id, source_observation_id, source_account_seq
       ) values ($1, 'fansly', $2, $3, $4, 'hi', now(), now(), 'replies_walk', now(), now(),
                 repeat('a', 64), 1, 1, 1)`,
      [page.id, ref(7001), ref(1), ref(9001)],
    );

    const adapter = adapterStub();
    const telemetry = telemetryStub();
    await fanslyPostRepliesChunk(appStub(adapter), input(page.id, telemetry));

    const lookups = adapter.calls.filter((call) => call.route === "account_lookup");
    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.params.ids).toEqual([ref(9001)]);

    // Journaled under the EXISTING kind, which no family claims. This package
    // does not claim it and does not parse it: the hydration exists so the
    // identity is CAPTURED.
    const stored = await observations(page.id);
    expect(stored.filter((row) => row.kind === "account_lookup")).toHaveLength(1);

    // And the cursor REMEMBERS it, so the next chunk does not re-request the
    // same hundred refs forever — nothing parses the response, so a
    // projection-derived queue would never drain.
    expect((await cursor(page.id))?.hydratedAuthorRefs).toEqual([ref(9001)]);
    await fanslyPostRepliesChunk(appStub(adapter), input(page.id, telemetry));
    expect(adapter.calls.filter((call) => call.route === "account_lookup")).toHaveLength(1);
  });

  it("reports the progress block and writes page-scoped coverage", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedPost(page.id, ref(1), "2026-08-01T00:00:00.000Z");
    await seedPost(page.id, ref(2), "2026-07-01T00:00:00.000Z");
    const adapter = adapterStub({
      reply: (params) => replyPage({ postRef: String(params.postId), count: 2 }),
    });
    const telemetry = telemetryStub();
    const result = await drain(page.id, adapter, telemetry);

    const stats = result?.stats as Record<string, unknown>;
    expect(stats.rootsKnown).toBe(2);
    expect(stats.rootsWalked).toBe(2);
    expect(stats.postsKnown).toBe(2);
    expect(stats.paginationMode).toBe("unproven");
    // The p99 of the observed page sizes — a NAMED criterion of the cap raise,
    // reported by the lane so the criterion is checkable without a bespoke
    // query.
    expect(stats.p99PostsLength).toBe(2);
    expect(stats.dailyCap).toBe(100);

    const coverage = await coverageRows(page.id);
    expect(coverage).toHaveLength(1);
    expect(coverage[0]?.plane).toBe("post_replies");
    expect(coverage[0]?.scope_ref).toBe(String(page.id));
    expect(Number(coverage[0]?.expected_count)).toBe(2);
    expect(Number(coverage[0]?.observed_unique_count)).toBe(2);
    // Every root walked and nothing truncated: this IS the provider's whole
    // surface for these posts.
    expect(coverage[0]?.status).toBe("provider_exhausted");
  });

  it("says `window_captured`, never complete, while a page might be truncated", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedPost(page.id, ref(1), "2026-08-01T00:00:00.000Z");
    // A full first page, then a second page of new rows — so the walk finishes,
    // but every row it stored came from a page it could not prove complete.
    const adapter = adapterStub({
      reply: (params, index) =>
        index === 0
          ? replyPage({
            postRef: String(params.postId),
            count: REPLIES_FULL_PAGE_THRESHOLD,
            idBase: 5000,
          })
          : replyPage({ postRef: String(params.postId), count: 1, idBase: 6000 }),
    });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    // The comment rows are written by the PROJECTION, so the coverage claim is
    // what the lane can assert on its own: it walked every root, and it holds
    // pages it cannot bound.
    const coverage = await coverageRows(page.id);
    // The coverage cursor carries the pagination verdict, which is what a later
    // reader needs to know whether "window_captured" was caution or ignorance.
    expect(coverage[0]?.cursor).toMatchObject({ paginationMode: "before" });
    const stats = (await fanslyPostRepliesChunk(
      appStub(adapter),
      input(page.id, telemetryStub(), new SyncChunkBudget(), new Date("2026-09-06T09:00:00.000Z")),
    )).stats as Record<string, unknown>;
    expect(stats.paginationMode).toBe("before");
    expect(Number(stats.p99PostsLength)).toBe(REPLIES_FULL_PAGE_THRESHOLD);
  });
});

describe("WP-F5 reply-page helpers", () => {
  it("tells an unreadable body from an EMPTY one", () => {
    // The distinction the whole archive rests on: `null` is "refuse", `[]` is
    // "this post has no comments", and confusing them either loses comments or
    // deletes them.
    expect(replyRows({ posts: [] })).toEqual([]);
    expect(replyRows({ __empty: true, httpStatus: 204 })).toEqual([]);
    expect(replyRows({ data: [] })).toBeNull();
    expect(replyRows(null)).toBeNull();
    expect(replyRows("nope")).toBeNull();
  });

  it("takes the cursor from the LAST row's own id", () => {
    expect(nextRepliesCursor([{ id: "a" }, { id: "b" }])).toBe("b");
    expect(nextRepliesCursor([])).toBeNull();
    expect(nextRepliesCursor([{ mediaOfferId: "x" }])).toBeNull();
  });

  it("de-duplicates author refs in order", () => {
    expect(replyAuthorRefs([
      { accountId: "a" },
      { accountId: "b" },
      { accountId: "a" },
      {},
    ])).toEqual(["a", "b"]);
  });

  it("knows whether the sidecar was populated", () => {
    expect(hasAccountSidecar({ accounts: [{ id: "a" }] })).toBe(true);
    // EMPTY in 2 of 5 live responses — the fact that makes the hydration
    // fallback mandatory rather than an optimization.
    expect(hasAccountSidecar({ accounts: [] })).toBe(false);
    expect(hasAccountSidecar({})).toBe(false);
  });

  it("computes p99 by nearest rank, and null on no samples", () => {
    expect(p99PostsLength([])).toBeNull();
    expect(p99PostsLength([1])).toBe(1);
    expect(p99PostsLength([1, 1, 1, 1, 9])).toBe(9);
  });
});
