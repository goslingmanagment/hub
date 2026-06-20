import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  listDmMessageDailyAggregates,
  rebuildDmMessageDailyAggregates,
  tombstoneDmMessageArchive,
  upsertDmMessageArchive,
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

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
});

describe("DM daily analytics aggregates", () => {
  it("rebuilds aggregate-only UTC facts idempotently and corrects tombstones", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, { slug: "dm-analytics", name: "DM Analytics" });
    const page = await createOnlyFansPage(testDb.db, {
      modelId: model.id,
      label: "dm-analytics-of",
    });
    const base = {
      platform: "onlyfans" as const,
      platformAccountId: page.id,
      ofapiAccountId: "acct_analytics",
      senderPlatformUserId: null,
      priceMills: null,
      isOpened: null,
      isTip: false,
      tipAmountMills: 0n,
      inReplyToMessageId: null,
      source: "webhook" as const,
      rawShapeVersion: "ofapi-message-v1",
      mediaMetadata: [],
      retentionPolicy: "default",
      retainUntil: new Date("2036-06-20T00:00:00.000Z"),
    };

    await upsertDmMessageArchive(testDb.db, {
      ...base,
      platformConversationId: "100",
      fanPlatformUserId: "100",
      platformMessageId: "inbound",
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-06-20T00:10:00.000Z"),
      textPlain: "not copied to aggregate",
      sourceEventType: "messages.received",
      sourceIdempotencyKey: "evt_inbound",
      sourceJournalId: 1,
      sourceFanoutSeq: 10,
      sourceReceivedAt: new Date("2026-06-20T00:10:01.000Z"),
    });
    await upsertDmMessageArchive(testDb.db, {
      ...base,
      platformConversationId: "100",
      fanPlatformUserId: "100",
      platformMessageId: "outbound",
      senderRole: "model",
      isSentByMe: true,
      messageCreatedAt: new Date("2026-06-20T00:12:00.000Z"),
      textPlain: "not copied to aggregate",
      priceMills: 25_000n,
      sourceEventType: "messages.sent",
      sourceIdempotencyKey: "evt_outbound",
      sourceJournalId: 2,
      sourceFanoutSeq: 11,
      sourceReceivedAt: new Date("2026-06-20T00:12:01.000Z"),
    });
    await upsertDmMessageArchive(testDb.db, {
      ...base,
      platformConversationId: "200",
      fanPlatformUserId: "200",
      platformMessageId: "tip",
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-06-20T00:15:00.000Z"),
      textPlain: "not copied to aggregate",
      isTip: true,
      tipAmountMills: 5_000n,
      sourceEventType: "messages.received",
      sourceIdempotencyKey: "evt_tip",
      sourceJournalId: 3,
      sourceFanoutSeq: 12,
      sourceReceivedAt: new Date("2026-06-20T00:15:01.000Z"),
    });
    await tombstoneDmMessageArchive(testDb.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: "acct_analytics",
      platformMessageId: "deleted-only",
      deletedAt: new Date("2026-06-20T00:20:00.000Z"),
      source: "webhook",
      sourceEventType: "messages.deleted",
      sourceIdempotencyKey: "evt_deleted",
      sourceJournalId: 4,
      sourceFanoutSeq: 13,
      sourceReceivedAt: new Date("2026-06-20T00:20:01.000Z"),
      retentionPolicy: "default",
      retainUntil: new Date("2036-06-20T00:00:00.000Z"),
    });

    const rebuild = async () => rebuildDmMessageDailyAggregates(testDb!.db, {
      fromBusinessDate: "2026-06-20",
      throughBusinessDate: "2026-06-20",
      rebuiltAt: new Date("2026-06-20T01:00:00.000Z"),
    });
    await rebuild();
    await rebuild();

    let [row] = await listDmMessageDailyAggregates(testDb.db, {
      fromBusinessDate: "2026-06-20",
      throughBusinessDate: "2026-06-20",
    });
    expect(row).toMatchObject({
      platformAccountId: page.id,
      businessDate: "2026-06-20",
      archiveRows: 4,
      inboundMessages: 2,
      outboundMessages: 1,
      deletedMessages: 1,
      distinctConversations: 2,
      paidOutboundMessages: 1,
      paidOutboundPriceMills: 25_000n,
      tipMessages: 1,
      tipAmountMills: 5_000n,
      sourceMaxFanoutSeq: 13,
    });
    expect(row).not.toHaveProperty("textPlain");
    expect(Object.keys(row ?? {})).not.toContain("mediaMetadata");

    await tombstoneDmMessageArchive(testDb.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: "acct_analytics",
      platformMessageId: "outbound",
      deletedAt: new Date("2026-06-20T00:30:00.000Z"),
      source: "webhook",
      sourceEventType: "messages.deleted",
      sourceIdempotencyKey: "evt_outbound_deleted",
      sourceJournalId: 5,
      sourceFanoutSeq: 14,
      sourceReceivedAt: new Date("2026-06-20T00:30:01.000Z"),
      retentionPolicy: "default",
      retainUntil: new Date("2036-06-20T00:00:00.000Z"),
    });
    await rebuild();

    [row] = await listDmMessageDailyAggregates(testDb.db, {
      fromBusinessDate: "2026-06-20",
      throughBusinessDate: "2026-06-20",
    });
    expect(row).toMatchObject({
      archiveRows: 4,
      outboundMessages: 0,
      deletedMessages: 2,
      paidOutboundMessages: 0,
      paidOutboundPriceMills: 0n,
      sourceMaxFanoutSeq: 14,
    });
  });
});
