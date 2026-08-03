import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendProjectionOnlyDomainEvents,
  createFanslyPage,
  createModel,
  insertObservation,
  upsertCreatorPost,
} from "@agency_hub_core/db";

import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import {
  rebuildCreatorPostsProjection,
  runCreatorPostsProjection,
} from "../apps/runtime/src/services/projections/creator-posts.ts";
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

function appStub() {
  return {
    db: testDb!.db,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

async function seedPostsObservation(input: {
  accountId: number;
  key: string;
  receivedAt: Date;
  posts: unknown[];
  tipGoals?: unknown[];
}) {
  const payload = {
    posts: input.posts,
    ...(input.tipGoals === undefined ? {} : { tipGoals: input.tipGoals }),
    account: { id: "model-native" },
  };
  return insertObservation(testDb!.db, {
    source: "pull",
    producer: "sync:fansly:posts",
    platform: "fansly",
    accountId: input.accountId,
    kind: "posts",
    payload,
    payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
    idempotencyKey: input.key,
    receivedAt: input.receivedAt,
  });
}

async function seedPostTipsObservation(input: {
  accountId: number;
  key: string;
  receivedAt: Date;
  tips: unknown[];
}) {
  return insertObservation(testDb!.db, {
    source: "pull",
    producer: "sync:fansly:post_tips",
    platform: "fansly",
    accountId: input.accountId,
    kind: "post_tips",
    payload: input.tips,
    payloadHash: createHash("sha256").update(JSON.stringify(input.tips)).digest(),
    idempotencyKey: input.key,
    receivedAt: input.receivedAt,
  });
}

describe("creator posts domain projection", () => {
  it("keeps raw sightings and events, advances current lineage, never deletes on absence, and rebuilds", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const model = await createModel(testDb.db, { slug: "posts", name: "Posts" });
    if (!model) throw new Error("model seed failed");
    const page = await createFanslyPage(testDb.db, { modelId: model.id, label: "posts-page" });
    if (!page) throw new Error("page seed failed");
    const publishedAt = new Date("2026-07-20T10:00:00Z");
    const firstSeen = new Date("2026-08-01T10:00:00Z");
    const secondSeen = new Date("2026-08-02T10:00:00Z");
    const editedSeen = new Date("2026-08-03T10:00:00Z");

    const firstObservation = await seedPostsObservation({
      accountId: page.id,
      key: "posts-page-1",
      receivedAt: firstSeen,
      posts: [{
        id: "post-1",
        content: "<p>first text</p>",
        createdAt: Math.floor(publishedAt.getTime() / 1000),
        attachments: [{ id: "media-1" }],
      }],
    });
    expect(await runCanonicalization(appStub())).toMatchObject({ appended: 2, stamped: 1 });
    expect(await runCreatorPostsProjection(appStub())).toMatchObject({ upserted: 1 });

    const firstEvent = await testDb.pool.query<{
      type: string;
      post_ref: string | null;
      observation_id: string;
    }>(
      `select type, post_ref, observation_id::text
       from domain_events where type = 'post.observed'`,
    );
    expect(firstEvent.rows).toEqual([{
      type: "post.observed",
      post_ref: "post-1",
      observation_id: String(firstObservation.observationId),
    }]);
    const checkpoint = await testDb.pool.query<{ hidden_count: string }>(
      `select data->>'hiddenCount' as hidden_count
       from domain_events where type = 'stream.projection_checkpoint'`,
    );
    expect(checkpoint.rows).toEqual([{ hidden_count: "1" }]);

    // A later unchanged sighting is a new canonical observation (same
    // content_hash), so last_observed_at and lineage advance honestly.
    const secondObservation = await seedPostsObservation({
      accountId: page.id,
      key: "posts-page-2",
      receivedAt: secondSeen,
      posts: [{
        id: "post-1",
        content: "<p>first text</p>",
        createdAt: Math.floor(publishedAt.getTime() / 1000),
        attachments: [{ id: "media-1" }],
      }],
    });
    expect(await runCanonicalization(appStub())).toMatchObject({ appended: 2, stamped: 1 });
    expect(await runCreatorPostsProjection(appStub())).toMatchObject({ upserted: 1 });

    const afterSecond = await testDb.pool.query<{
      first_observed_at: Date;
      last_observed_at: Date;
      content_hash: string;
      source_observation_id: string;
      source_account_seq: string;
    }>(
      `select first_observed_at, last_observed_at, content_hash,
              source_observation_id::text, source_account_seq::text
       from creator_posts where account_id = $1 and platform_post_id = 'post-1'`,
      [page.id],
    );
    expect(afterSecond.rows[0]!.first_observed_at.toISOString()).toBe(firstSeen.toISOString());
    expect(afterSecond.rows[0]!.last_observed_at.toISOString()).toBe(secondSeen.toISOString());
    expect(afterSecond.rows[0]!.source_observation_id).toBe(String(secondObservation.observationId));
    const unchangedHash = afterSecond.rows[0]!.content_hash;

    await seedPostsObservation({
      accountId: page.id,
      key: "posts-page-3",
      receivedAt: editedSeen,
      posts: [{
        id: "post-1",
        content: "edited <b>&amp; raw</b>\r\n",
        createdAt: Math.floor(publishedAt.getTime() / 1000),
        attachments: [{ id: "media-1" }, { id: "media-2" }],
      }],
    });
    await runCanonicalization(appStub());
    await runCreatorPostsProjection(appStub());

    const edited = await testDb.pool.query<{
      text_plain: string;
      content_hash: string;
      attachment_count: number;
      first_observed_at: Date;
      last_observed_at: Date;
      source_event_id: string;
      source_observation_id: string;
      source_account_seq: string;
    }>(
      `select text_plain, content_hash, attachment_count,
              first_observed_at, last_observed_at,
              source_event_id::text, source_observation_id::text,
              source_account_seq::text
       from creator_posts where account_id = $1 and platform_post_id = 'post-1'`,
      [page.id],
    );
    expect(edited.rows[0]).toMatchObject({
      text_plain: "edited <b>&amp; raw</b>\r\n",
      attachment_count: 2,
    });
    expect(edited.rows[0]!.content_hash).not.toBe(unchangedHash);
    expect(edited.rows[0]!.first_observed_at.toISOString()).toBe(firstSeen.toISOString());
    expect(edited.rows[0]!.last_observed_at.toISOString()).toBe(editedSeen.toISOString());

    // An out-of-order projector replay cannot regress the current head.
    const stale = await upsertCreatorPost(testDb.db, {
      accountId: page.id,
      platform: "fansly",
      platformPostId: "post-1",
      textPlain: "stale",
      publishedAt,
      observedAt: firstSeen,
      contentHash: "0".repeat(64),
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
      sourceEventId: 1,
      sourceObservationId: firstObservation.observationId,
      sourceAccountSeq: 1,
    });
    expect(stale).toEqual({ applied: false, id: null });

    // Empty is a valid page and positive absence proof of NOTHING. It stamps
    // parse progress but emits no tombstone and leaves the row intact.
    await seedPostsObservation({
      accountId: page.id,
      key: "posts-empty",
      receivedAt: new Date("2026-08-04T10:00:00Z"),
      posts: [],
    });
    expect(await runCanonicalization(appStub())).toMatchObject({ appended: 0, stamped: 1 });
    expect(await runCreatorPostsProjection(appStub())).toMatchObject({ upserted: 0 });

    const durableCounts = await testDb.pool.query<{
      observations: string;
      post_events: string;
      current_posts: string;
    }>(
      `select
         (select count(*)::text from observations where kind = 'posts') as observations,
         (select count(*)::text from domain_events where type = 'post.observed') as post_events,
         (select count(*)::text from creator_posts where account_id = $1) as current_posts`,
      [page.id],
    );
    expect(durableCounts.rows[0]).toEqual({
      observations: "4",
      post_events: "3",
      current_posts: "1",
    });

    const beforeRebuild = edited.rows[0]!;
    expect(await rebuildCreatorPostsProjection(appStub(), { accountId: page.id }))
      .toMatchObject({ upserted: 3 });
    const afterRebuild = await testDb.pool.query(
      `select text_plain, content_hash, attachment_count,
              first_observed_at, last_observed_at,
              source_event_id::text, source_observation_id::text,
              source_account_seq::text
       from creator_posts where account_id = $1 and platform_post_id = 'post-1'`,
      [page.id],
    );
    expect(afterRebuild.rows[0]).toEqual(beforeRebuild);
  });

  it("keeps the newest observed material when an older observation is appended later", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const model = await createModel(testDb.db, { slug: "posts-replay", name: "Posts Replay" });
    if (!model) throw new Error("model seed failed");
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "posts-replay-page",
    });
    if (!page) throw new Error("page seed failed");

    const publishedAt = new Date("2026-07-20T10:00:00Z");
    const baselineSeen = new Date("2026-08-01T10:00:00Z");
    const freshSeen = new Date("2026-08-03T10:00:00Z");
    const staleSeen = new Date("2026-08-02T10:00:00Z");

    await seedPostsObservation({
      accountId: page.id,
      key: "posts-replay-baseline",
      receivedAt: baselineSeen,
      posts: [{
        id: "post-replay",
        content: "baseline",
        createdAt: Math.floor(publishedAt.getTime() / 1000),
        attachments: [],
      }],
    });
    await runCanonicalization(appStub());
    await runCreatorPostsProjection(appStub());

    const freshObservation = await seedPostsObservation({
      accountId: page.id,
      key: "posts-replay-fresh",
      receivedAt: freshSeen,
      posts: [{
        id: "post-replay",
        content: "fresh <p>&amp; verbatim</p>\n",
        createdAt: Math.floor(publishedAt.getTime() / 1000),
        attachments: [{ id: "fresh-media" }],
      }],
    });
    await runCanonicalization(appStub());
    await runCreatorPostsProjection(appStub());

    const freshHead = await testDb.pool.query<{
      text_plain: string;
      last_observed_at: Date;
      source_event_id: string;
      source_observation_id: string;
      source_account_seq: string;
    }>(
      `select text_plain, last_observed_at, source_event_id::text,
              source_observation_id::text, source_account_seq::text
       from creator_posts where account_id = $1 and platform_post_id = 'post-replay'`,
      [page.id],
    );
    expect(freshHead.rows[0]).toMatchObject({
      text_plain: "fresh <p>&amp; verbatim</p>\n",
      source_observation_id: String(freshObservation.observationId),
    });
    expect(freshHead.rows[0]!.last_observed_at.toISOString()).toBe(freshSeen.toISOString());

    // This observation is appended later (therefore receives a higher ledger
    // seq) but was captured earlier. It must advance the projection watermark
    // without replacing the genuinely newer provider material or lineage.
    await seedPostsObservation({
      accountId: page.id,
      key: "posts-replay-late-stale",
      receivedAt: staleSeen,
      posts: [{
        id: "post-replay",
        content: "stale replay",
        createdAt: Math.floor(publishedAt.getTime() / 1000),
        attachments: [],
      }],
    });
    await runCanonicalization(appStub());
    expect(await runCreatorPostsProjection(appStub())).toMatchObject({ upserted: 0 });

    const afterStale = await testDb.pool.query<{
      text_plain: string;
      last_observed_at: Date;
      source_event_id: string;
      source_observation_id: string;
      source_account_seq: string;
      high_seq: string;
      max_event_seq: string;
    }>(
      `select cp.text_plain, cp.last_observed_at, cp.source_event_id::text,
              cp.source_observation_id::text, cp.source_account_seq::text,
              pw.high_seq::text,
              (select max(de.account_seq)::text from domain_events de
               where de.account_id = cp.account_id) as max_event_seq
       from creator_posts cp
       join projection_seq_watermarks pw
         on pw.projection = 'creator_posts' and pw.account_id = cp.account_id
       where cp.account_id = $1 and cp.platform_post_id = 'post-replay'`,
      [page.id],
    );
    expect(afterStale.rows[0]).toMatchObject({
      text_plain: freshHead.rows[0]!.text_plain,
      source_event_id: freshHead.rows[0]!.source_event_id,
      source_observation_id: freshHead.rows[0]!.source_observation_id,
      source_account_seq: freshHead.rows[0]!.source_account_seq,
    });
    expect(afterStale.rows[0]!.last_observed_at.toISOString()).toBe(freshSeen.toISOString());
    expect(afterStale.rows[0]!.high_seq).toBe(afterStale.rows[0]!.max_event_seq);

    // Same observation instant: the later ledger seq is the deterministic
    // correction tie-break and becomes the current material lineage.
    const tieObservation = await seedPostsObservation({
      accountId: page.id,
      key: "posts-replay-same-time-correction",
      receivedAt: freshSeen,
      posts: [{
        id: "post-replay",
        content: "same-time correction",
        createdAt: Math.floor(publishedAt.getTime() / 1000),
        attachments: [{ id: "corrected-media-1" }, { id: "corrected-media-2" }],
      }],
    });
    await runCanonicalization(appStub());
    expect(await runCreatorPostsProjection(appStub())).toMatchObject({ upserted: 1 });

    const afterTieBreak = await testDb.pool.query<{
      text_plain: string;
      attachment_count: number;
      last_observed_at: Date;
      source_observation_id: string;
      source_account_seq: string;
    }>(
      `select text_plain, attachment_count, last_observed_at,
              source_observation_id::text, source_account_seq::text
       from creator_posts where account_id = $1 and platform_post_id = 'post-replay'`,
      [page.id],
    );
    expect(afterTieBreak.rows[0]).toMatchObject({
      text_plain: "same-time correction",
      attachment_count: 2,
      source_observation_id: String(tieObservation.observationId),
    });
    expect(afterTieBreak.rows[0]!.last_observed_at.toISOString()).toBe(freshSeen.toISOString());
    expect(Number(afterTieBreak.rows[0]!.source_account_seq))
      .toBeGreaterThan(Number(freshHead.rows[0]!.source_account_seq));

    const beforeRebuild = afterTieBreak.rows[0]!;
    await rebuildCreatorPostsProjection(appStub(), { accountId: page.id });
    const afterRebuild = await testDb.pool.query(
      `select text_plain, attachment_count, last_observed_at,
              source_observation_id::text, source_account_seq::text
       from creator_posts where account_id = $1 and platform_post_id = 'post-replay'`,
      [page.id],
    );
    expect(afterRebuild.rows[0]).toEqual(beforeRebuild);
  });

  it("projects cumulative Fansly post money and individual tips without regressing newer heads", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const model = await createModel(testDb.db, {
      slug: "post-monetization",
      name: "Post Monetization",
    });
    if (!model) throw new Error("model seed failed");
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "post-monetization-page",
    });
    if (!page) throw new Error("page seed failed");

    const publishedAt = new Date("2026-07-27T21:55:00Z");
    const firstSeen = new Date("2026-08-01T08:00:00Z");
    const staleSeen = new Date("2026-08-01T12:00:00Z");
    const tipSeen = new Date("2026-08-02T09:00:00Z");
    const freshSeen = new Date("2026-08-03T10:00:00Z");
    const postMaterial = {
      id: "birthday-post",
      content: "spoil the birthday girl",
      createdAt: Math.floor(publishedAt.getTime() / 1000),
      attachments: [
        { id: "media-1", contentType: 1000 },
        { contentType: 7100, contentId: "goal-birthday" },
      ],
    };

    const firstObservation = await seedPostsObservation({
      accountId: page.id,
      key: "post-money-first",
      receivedAt: firstSeen,
      posts: [{
        ...postMaterial,
        tipAmount: 500_000,
        attachmentTipAmount: 0,
      }],
      tipGoals: [{
        id: "goal-birthday",
        label: "spoil the birthday girl",
        goalAmount: 1_000_000,
        currentAmount: 480_000,
        hideAmounts: 0,
      }],
    });
    expect(await runCanonicalization(appStub())).toMatchObject({ appended: 2, stamped: 1 });
    expect(await runCreatorPostsProjection(appStub())).toMatchObject({ upserted: 1 });

    const initialHead = await testDb.pool.query<{
      text_plain: string;
      attachment_count: number;
      tip_amount_mills: string;
      attachment_tip_amount_mills: string;
      post_tip_total_mills: string;
      tip_goal_current_mills: string;
      content_hash: string;
      source_observation_id: string;
    }>(
      `select text_plain, attachment_count,
              tip_amount_mills::text, attachment_tip_amount_mills::text,
              post_tip_total_mills::text, tip_goal_current_mills::text,
              content_hash, source_observation_id::text
       from creator_posts
       where account_id = $1 and platform_post_id = 'birthday-post'`,
      [page.id],
    );
    expect(initialHead.rows[0]).toMatchObject({
      text_plain: postMaterial.content,
      attachment_count: 2,
      tip_amount_mills: "500000",
      attachment_tip_amount_mills: "0",
      post_tip_total_mills: "500000",
      tip_goal_current_mills: "480000",
      source_observation_id: String(firstObservation.observationId),
    });

    const tipObservation = await seedPostTipsObservation({
      accountId: page.id,
      key: "post-money-tip-1",
      receivedAt: tipSeen,
      tips: [{
        id: "tip-250",
        senderId: "fan-22",
        receiverId: "creator-native",
        amount: 250_000,
        message: "happy birthday",
        senderTransactionId: "sender-tx-250",
        receiverTransactionId: "receiver-tx-250",
        tipGoalId: "goal-birthday",
        targets: [
          { id: "birthday-post", type: 1000 },
          { id: "goal-birthday", type: 7100 },
        ],
        createdAt: Math.floor(new Date("2026-07-31T20:59:00Z").getTime() / 1000),
      }, {
        id: "tip-20-direct",
        senderId: "fan-33",
        receiverId: "creator-native",
        amount: 20_000,
        message: "I'm competitive haha",
        senderTransactionId: "sender-tx-20",
        receiverTransactionId: "receiver-tx-20",
        targets: [{ id: "birthday-post", type: 1000 }],
        createdAt: Math.floor(new Date("2026-07-31T21:00:00Z").getTime() / 1000),
      }],
    });
    // Simulate raw captured and stamped by the previous parser generation.
    // Family v3 must replay it, append v2 material and recover the messages.
    await testDb.pool.query(
      "update observations set parse_version = 2 where id = $1",
      [tipObservation.observationId],
    );
    expect(await runCanonicalization(appStub())).toMatchObject({ appended: 3, stamped: 1 });
    expect(await runCreatorPostsProjection(appStub())).toMatchObject({ upserted: 2 });

    const persistedTipEvent = await testDb.pool.query<{
      post_ref: string;
      fan_identity_ref: string;
      transaction_ref: string;
      observation_id: string;
      data: Record<string, unknown>;
    }>(
      `select post_ref, fan_identity_ref, transaction_ref,
              observation_id::text, data
       from domain_events where type = 'post.tip_observed'
       order by data->>'tipId'`,
    );
    expect(persistedTipEvent.rows).toEqual([
      expect.objectContaining({
        post_ref: "birthday-post",
        fan_identity_ref: "fan-33",
        transaction_ref: "receiver-tx-20",
        observation_id: String(tipObservation.observationId),
        data: expect.objectContaining({
          tipId: "tip-20-direct",
          amountMills: 20_000,
          tipGoalRef: null,
          tipMessageText: "I'm competitive haha",
        }),
      }),
      expect.objectContaining({
        post_ref: "birthday-post",
        fan_identity_ref: "fan-22",
        transaction_ref: "receiver-tx-250",
        observation_id: String(tipObservation.observationId),
        data: expect.objectContaining({
          tipId: "tip-250",
          amountMills: 250_000,
          tipGoalRef: "goal-birthday",
          tipMessageText: "happy birthday",
        }),
      }),
    ]);

    const persistedTip = await testDb.pool.query<{
      platform_tip_id: string;
      platform_post_id: string;
      tip_sender_platform_user_id: string;
      post_tip_amount_mills: string;
      receiver_transaction_ref: string;
      sender_transaction_ref: string;
      tip_goal_ref: string | null;
      tip_message_text: string | null;
      occurred_at: Date;
      source_observation_id: string;
    }>(
      `select platform_tip_id, platform_post_id, tip_sender_platform_user_id,
              post_tip_amount_mills::text, receiver_transaction_ref,
              sender_transaction_ref, tip_goal_ref, tip_message_text, occurred_at,
              source_observation_id::text
       from creator_post_tips
       where account_id = $1
       order by platform_tip_id`,
      [page.id],
    );
    expect(persistedTip.rows).toEqual([
      expect.objectContaining({
        platform_tip_id: "tip-20-direct",
        platform_post_id: "birthday-post",
        tip_sender_platform_user_id: "fan-33",
        post_tip_amount_mills: "20000",
        receiver_transaction_ref: "receiver-tx-20",
        sender_transaction_ref: "sender-tx-20",
        tip_goal_ref: null,
        tip_message_text: "I'm competitive haha",
        source_observation_id: String(tipObservation.observationId),
      }),
      expect.objectContaining({
        platform_tip_id: "tip-250",
        platform_post_id: "birthday-post",
        tip_sender_platform_user_id: "fan-22",
        post_tip_amount_mills: "250000",
        receiver_transaction_ref: "receiver-tx-250",
        sender_transaction_ref: "sender-tx-250",
        tip_goal_ref: "goal-birthday",
        tip_message_text: "happy birthday",
        source_observation_id: String(tipObservation.observationId),
      }),
    ]);
    expect(persistedTip.rows[1]!.occurred_at.toISOString())
      .toBe("2026-07-31T20:59:00.000Z");

    // Text, publication time and attachments are byte-identical: this event
    // advances the head solely because the cumulative money snapshot changed.
    const freshObservation = await seedPostsObservation({
      accountId: page.id,
      key: "post-money-fresh",
      receivedAt: freshSeen,
      posts: [{
        ...postMaterial,
        tipAmount: 520_000,
        attachmentTipAmount: 0,
      }],
      tipGoals: [{
        id: "goal-birthday",
        label: "spoil the birthday girl",
        goalAmount: 1_000_000,
        currentAmount: 500_000,
        hideAmounts: 0,
      }],
    });
    expect(await runCanonicalization(appStub())).toMatchObject({ appended: 2, stamped: 1 });
    expect(await runCreatorPostsProjection(appStub())).toMatchObject({ upserted: 1 });

    const freshHead = await testDb.pool.query<{
      text_plain: string;
      published_at: Date;
      attachment_count: number;
      tip_amount_mills: string;
      attachment_tip_amount_mills: string;
      post_tip_total_mills: string;
      tip_goal_linked: boolean;
      tip_goal_ref: string;
      tip_goal_label: string;
      tip_goal_target_mills: string;
      tip_goal_current_mills: string;
      tip_goal_amounts_hidden: boolean;
      content_hash: string;
      first_observed_at: Date;
      last_observed_at: Date;
      source_observation_id: string;
      source_account_seq: string;
    }>(
      `select text_plain, published_at, attachment_count,
              tip_amount_mills::text, attachment_tip_amount_mills::text,
              post_tip_total_mills::text, tip_goal_linked, tip_goal_ref,
              tip_goal_label, tip_goal_target_mills::text,
              tip_goal_current_mills::text, tip_goal_amounts_hidden,
              content_hash, first_observed_at, last_observed_at,
              source_observation_id::text, source_account_seq::text
       from creator_posts
       where account_id = $1 and platform_post_id = 'birthday-post'`,
      [page.id],
    );
    expect(freshHead.rows[0]).toMatchObject({
      text_plain: postMaterial.content,
      attachment_count: 2,
      tip_amount_mills: "520000",
      attachment_tip_amount_mills: "0",
      post_tip_total_mills: "520000",
      tip_goal_linked: true,
      tip_goal_ref: "goal-birthday",
      tip_goal_label: "spoil the birthday girl",
      tip_goal_target_mills: "1000000",
      tip_goal_current_mills: "500000",
      tip_goal_amounts_hidden: false,
      source_observation_id: String(freshObservation.observationId),
    });
    expect(freshHead.rows[0]!.post_tip_total_mills)
      .not.toBe(freshHead.rows[0]!.tip_goal_current_mills);
    expect(freshHead.rows[0]!.published_at.toISOString()).toBe(publishedAt.toISOString());
    expect(freshHead.rows[0]!.first_observed_at.toISOString()).toBe(firstSeen.toISOString());
    expect(freshHead.rows[0]!.last_observed_at.toISOString()).toBe(freshSeen.toISOString());
    expect(freshHead.rows[0]!.content_hash).not.toBe(initialHead.rows[0]!.content_hash);

    // Appended later, but genuinely observed earlier than the current money
    // snapshot. It must advance the watermark without regressing any head field.
    await seedPostsObservation({
      accountId: page.id,
      key: "post-money-late-stale",
      receivedAt: staleSeen,
      posts: [{
        ...postMaterial,
        tipAmount: 410_000,
        attachmentTipAmount: 0,
      }],
      tipGoals: [{
        id: "goal-birthday",
        label: "spoil the birthday girl",
        goalAmount: 1_000_000,
        currentAmount: 400_000,
        hideAmounts: 0,
      }],
    });
    await runCanonicalization(appStub());
    expect(await runCreatorPostsProjection(appStub())).toMatchObject({ upserted: 0 });

    const afterStale = await testDb.pool.query(
      `select text_plain, published_at, attachment_count,
              tip_amount_mills::text, attachment_tip_amount_mills::text,
              post_tip_total_mills::text, tip_goal_linked, tip_goal_ref,
              tip_goal_label, tip_goal_target_mills::text,
              tip_goal_current_mills::text, tip_goal_amounts_hidden,
              content_hash, first_observed_at, last_observed_at,
              source_observation_id::text, source_account_seq::text
       from creator_posts
       where account_id = $1 and platform_post_id = 'birthday-post'`,
      [page.id],
    );
    expect(afterStale.rows[0]).toEqual(freshHead.rows[0]);

    const beforeRebuildPost = afterStale.rows[0]!;
    const beforeRebuildTips = persistedTip.rows;
    expect(await rebuildCreatorPostsProjection(appStub(), { accountId: page.id }))
      .toMatchObject({ upserted: 4 });
    const afterRebuildPost = await testDb.pool.query(
      `select text_plain, published_at, attachment_count,
              tip_amount_mills::text, attachment_tip_amount_mills::text,
              post_tip_total_mills::text, tip_goal_linked, tip_goal_ref,
              tip_goal_label, tip_goal_target_mills::text,
              tip_goal_current_mills::text, tip_goal_amounts_hidden,
              content_hash, first_observed_at, last_observed_at,
              source_observation_id::text, source_account_seq::text
       from creator_posts
       where account_id = $1 and platform_post_id = 'birthday-post'`,
      [page.id],
    );
    const afterRebuildTip = await testDb.pool.query(
      `select platform_tip_id, platform_post_id, tip_sender_platform_user_id,
              post_tip_amount_mills::text, receiver_transaction_ref,
              sender_transaction_ref, tip_goal_ref, tip_message_text, occurred_at,
              source_observation_id::text
       from creator_post_tips
       where account_id = $1
       order by platform_tip_id`,
      [page.id],
    );
    expect(afterRebuildPost.rows[0]).toEqual(beforeRebuildPost);
    expect(afterRebuildTip.rows).toEqual(beforeRebuildTips);
  });

  it("keeps schema-v1 post-tip events projectable without upgrading legacy goal/message", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const model = await createModel(testDb.db, {
      slug: "post-tip-v1",
      name: "Post Tip V1",
    });
    if (!model) throw new Error("model seed failed");
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "post-tip-v1-page",
    });
    if (!page) throw new Error("page seed failed");

    const occurredAt = new Date("2026-07-31T20:59:00Z");
    const observedAt = new Date("2026-08-01T08:00:00Z");
    const contentHash = "a".repeat(64);
    expect(await appendProjectionOnlyDomainEvents(testDb.db, page.id, [{
      type: "post.tip_observed",
      occurredAt,
      fanIdentityRef: "legacy-fan",
      transactionRef: "legacy-receiver-tx",
      postRef: "legacy-post",
      data: {
        platform: "fansly",
        tipId: "legacy-tip",
        senderPlatformUserId: "legacy-fan",
        amountMills: 250_000,
        occurredAt: occurredAt.toISOString(),
        observedAt: observedAt.toISOString(),
        receiverTransactionRef: "legacy-receiver-tx",
        senderTransactionRef: "legacy-sender-tx",
        // V1 could only carry the optional top-level correlation. The v2
        // target parser is the first version allowed to claim exact goal
        // attribution, so the projector must deliberately discard this value.
        tipGoalRef: "legacy-goal",
        contentHash,
      },
      schemaVersion: 1,
      observationId: 501,
      dedupKey: "post-tip:v1:fansly:legacy-tip:legacy-post:fixture:obs:501",
    }], {
      occurredAt: observedAt,
      observationId: 501,
      dedupKey: "projection-checkpoint:post-tip-v1:501",
    })).toMatchObject({ appended: 2 });

    expect(await runCreatorPostsProjection(appStub())).toMatchObject({ upserted: 1 });
    const beforeRebuild = await testDb.pool.query(
      `select platform_tip_id, tip_goal_ref, tip_message_text,
              source_observation_id::text
       from creator_post_tips where account_id = $1`,
      [page.id],
    );
    expect(beforeRebuild.rows).toEqual([{
      platform_tip_id: "legacy-tip",
      tip_goal_ref: null,
      tip_message_text: null,
      source_observation_id: "501",
    }]);

    expect(await rebuildCreatorPostsProjection(appStub(), { accountId: page.id }))
      .toMatchObject({ upserted: 1 });
    const afterRebuild = await testDb.pool.query(
      `select platform_tip_id, tip_goal_ref, tip_message_text,
              source_observation_id::text
       from creator_post_tips where account_id = $1`,
      [page.id],
    );
    expect(afterRebuild.rows).toEqual(beforeRebuild.rows);
  });

  it("migration registers both collection lanes", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const streams = await testDb.pool.query<{ value: string }>(
      `select enumlabel as value
       from pg_enum join pg_type on pg_type.oid = pg_enum.enumtypid
       where pg_type.typname = 'sync_stream' order by enumsortorder`,
    );
    expect(streams.rows.map((row) => row.value)).toContain("posts");

    const constraint = await testDb.pool.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition
       from pg_constraint where conname = 'ofapi_capture_jobs_kind_check'`,
    );
    expect(constraint.rows[0]!.definition).toContain("post_paginate");
  });
});
