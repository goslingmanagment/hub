// R2 convergence drill: the endpoint-scour data plane must stay erased after
// an ordinary projection rebuild. It exercises both scopes and all four
// storage shapes named by the repair brief: projection tables, events,
// observations, and the retained sync-raw journal.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  ensureDomainEventPartitions,
} from "@agency_hub_core/db";

import {
  executeErasure,
} from "../apps/runtime/src/services/erasure/index.ts";
import { rebuildFanslyCommentsProjection, runFanslyCommentsProjection } from
  "../apps/runtime/src/services/projections/fansly-comments.ts";
import { rebuildFanslyEngagementProjection, runFanslyEngagementProjection } from
  "../apps/runtime/src/services/projections/fansly-engagement.ts";
import { rebuildMediaPlaneProjection, runMediaPlaneProjection } from
  "../apps/runtime/src/services/projections/media-plane.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

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
    pool: testDb!.pool,
    config: { lakeDir: "/nonexistent-erasure-r2-lake" } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

async function seedPage(slug: string) {
  const model = await createModel(testDb!.db, { slug, name: slug });
  if (!model) throw new Error(`Expected model ${slug}`);
  const page = await createFanslyPage(testDb!.db, {
    modelId: model.id,
    label: `${slug}-page`,
  });
  if (!page) throw new Error(`Expected page ${slug}`);
  await testDb!.pool.query(
    "update pages set external_page_id = $1 where id = $2",
    [`acct-${slug}`, page.id],
  );
  await ensureDomainEventPartitions(testDb!.db);
  const owner = await testDb!.pool.query<{ id: string }>(
    `insert into users (username, role) values ($1, 'owner') returning id::text`,
    [`${slug}-owner`],
  );
  return { page, ownerId: Number(owner.rows[0]!.id) };
}

async function seedObservation(pageId: number, key: string, payload: unknown): Promise<number> {
  const result = await testDb!.pool.query<{ id: string }>(
    `insert into observations (
       source, producer, platform, account_id, kind, payload, payload_hash,
       idempotency_key, received_at, parse_version
     ) values (
       'pull', 'sync:fansly:dm_messages', 'fansly', $1, $2, $3::jsonb,
       sha256($4::bytea), $4, '2026-08-20T00:00:00Z', 1
     ) returning id::text`,
    [pageId, key, JSON.stringify(payload), `r2:${pageId}:${key}`],
  );
  return Number(result.rows[0]!.id);
}

async function seedEvent(input: {
  pageId: number;
  seq: number;
  type: string;
  observationId: number;
  conversationRef?: string | null;
  data: Record<string, unknown>;
}): Promise<void> {
  await testDb!.pool.query(
    `insert into domain_events (
       account_id, account_seq, type, occurred_at, fan_identity_ref,
       conversation_ref, data, schema_version, observation_id, dedup_key
     ) values ($1, $2, $3, '2026-08-20T00:00:00Z', null, $4, $5::jsonb, 1, $6, $7)`,
    [
      input.pageId,
      input.seq,
      input.type,
      input.conversationRef ?? null,
      JSON.stringify(input.data),
      input.observationId,
      `r2:${input.pageId}:${input.seq}`,
    ],
  );
}

async function seedRaw(pageId: number, key: string, payload: unknown): Promise<void> {
  await testDb!.pool.query(
    `insert into sync_raw_payloads (
       page_id, endpoint, request_params, response_payload, mapper_version,
       payload_kind, captured_at, retain_until
     ) values ($1, '/r2/convergence', '{}'::jsonb, $2::jsonb, 'r2-v1', $3,
               '2026-08-20T00:00:00Z', '2126-08-20T00:00:00Z')`,
    [pageId, JSON.stringify(payload), key],
  );
}

async function count(table: string, pageColumn: string, pageId: number): Promise<number> {
  const result = await testDb!.pool.query<{ n: string }>(
    `select count(*)::text as n from ${table} where ${pageColumn} = $1`,
    [pageId],
  );
  return Number(result.rows[0]!.n);
}

describe("endpoint-scour erasure convergence (R2)", () => {
  it("page erasure removes projection rows, events, observations, and raw captures and rebuild keeps them absent", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, ownerId } = await seedPage("r2-page-convergence");
    const observationId = await seedObservation(page.id, "post_replies", { page: "secret" });
    await seedEvent({
      pageId: page.id,
      seq: 1,
      type: "post.comment_observed",
      observationId,
      data: {
        commentRef: "page-comment",
        parentPostRef: "page-post",
        rootRef: "page-post",
        authorRef: "page-fan",
        textPlain: "page secret",
        publishedAt: "2026-08-19T00:00:00.000Z",
        attachmentCount: 0,
        possiblyTruncated: false,
        contentHash: "a".repeat(64),
      },
    });
    await seedRaw(page.id, "page-raw", { pageSecret: "raw page capture" });
    await runFanslyCommentsProjection(appStub(), { accountId: page.id });
    expect(await count("post_comments", "page_id", page.id)).toBe(1);

    await executeErasure(
      appStub(),
      { scopeType: "page", pageLabel: page.label },
      { initiatedBy: ownerId },
    );
    expect(await count("post_comments", "page_id", page.id)).toBe(0);
    expect(await count("domain_events", "account_id", page.id)).toBe(0);
    expect(await count("observations", "account_id", page.id)).toBe(0);
    expect(await count("sync_raw_payloads", "page_id", page.id)).toBe(0);

    await rebuildFanslyCommentsProjection(appStub(), { accountId: page.id });
    expect(await count("post_comments", "page_id", page.id)).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("fan erasure reaches historical data-only and group-keyed events, raw capture, then all three rebuilds stay empty", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, ownerId } = await seedPage("r2-fan-convergence");
    const fanRef = "770770770";
    const groupRef = "990990990";
    await testDb.pool.query(
      `insert into page_dm_threads (
         platform_account_id, platform_conversation_id, partner_platform_user_id
       ) values ($1, $2, $3)`,
      [page.id, groupRef, fanRef],
    );

    const commentObservation = await seedObservation(page.id, "comment", { authorRef: fanRef });
    const notificationObservation = await seedObservation(page.id, "notification", {
      correlationGroupRef: fanRef,
    });
    const messageObservation = await seedObservation(page.id, "message", {
      conversationRef: groupRef,
      fanRef,
    });
    await seedRaw(page.id, "fan-raw", { buyer: fanRef });

    await seedEvent({
      pageId: page.id,
      seq: 1,
      type: "post.comment_observed",
      observationId: commentObservation,
      data: {
        commentRef: "fan-comment",
        parentPostRef: "fan-post",
        rootRef: "fan-post",
        authorRef: fanRef,
        textPlain: "fan words",
        publishedAt: "2026-08-19T00:00:00.000Z",
        attachmentCount: 0,
        possiblyTruncated: false,
        contentHash: "b".repeat(64),
      },
    });
    await seedEvent({
      pageId: page.id,
      seq: 2,
      type: "notification.observed",
      observationId: notificationObservation,
      data: {
        notificationRef: "fan-purchase",
        rawTypeCode: 2007,
        correlationRef: "bought-media",
        correlationGroupRef: fanRef,
        metadataJson: {},
        occurredAtSeconds: "2026-08-19T00:00:00.000Z",
        acknowledgedAtSeconds: null,
        contentHash: "c".repeat(64),
      },
    });
    await seedEvent({
      pageId: page.id,
      seq: 3,
      type: "message.attachments_observed",
      observationId: messageObservation,
      conversationRef: groupRef,
      data: {
        messageId: "creator-sent-message",
        conversationRef: groupRef,
        senderRef: "creator-ref",
        messageCreatedAt: "2026-08-19T00:00:00.000Z",
        buyerRefs: [],
        attachments: [{
          pos: 0,
          contentType: 1,
          contentRef: "offered-media",
          mediaOfferRef: "offered-media",
          bundleRef: null,
          purchased: false,
          buyerRefs: [],
          permissionEntries: [],
        }],
        contentHash: "d".repeat(64),
      },
    });

    await runFanslyCommentsProjection(appStub(), { accountId: page.id });
    await runFanslyEngagementProjection(appStub(), { accountId: page.id });
    await runMediaPlaneProjection(appStub(), { accountId: page.id });
    expect(await count("post_comments", "page_id", page.id)).toBe(1);
    expect(await count("platform_notifications", "page_id", page.id)).toBe(1);
    expect(await count("message_media_offers", "page_id", page.id)).toBe(1);

    await executeErasure(
      appStub(),
      { scopeType: "fan", platform: "fansly", fanRef },
      { initiatedBy: ownerId },
    );
    expect(await count("post_comments", "page_id", page.id)).toBe(0);
    expect(await count("platform_notifications", "page_id", page.id)).toBe(0);
    expect(await count("message_media_offers", "page_id", page.id)).toBe(0);
    expect(await count("domain_events", "account_id", page.id)).toBe(0);
    expect(await count("observations", "account_id", page.id)).toBe(0);
    expect(await count("sync_raw_payloads", "page_id", page.id)).toBe(0);

    await rebuildFanslyCommentsProjection(appStub(), { accountId: page.id });
    await rebuildFanslyEngagementProjection(appStub(), { accountId: page.id });
    await rebuildMediaPlaneProjection(appStub(), { accountId: page.id });
    expect(await count("post_comments", "page_id", page.id)).toBe(0);
    expect(await count("platform_notifications", "page_id", page.id)).toBe(0);
    expect(await count("message_media_offers", "page_id", page.id)).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
