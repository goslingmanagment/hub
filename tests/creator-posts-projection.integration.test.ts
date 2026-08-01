import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
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
}) {
  const payload = { posts: input.posts, account: { id: "model-native" } };
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
