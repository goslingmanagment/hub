import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  insertObservation,
  setPageOfapiAccountId,
  tombstoneDmMessageArchive,
  upsertDmMessageArchive,
  upsertDmMessageArchiveFromReadthrough,
  type UpsertDmMessageArchiveInput,
} from "@agency_hub_core/db";

import { OFAPI_READTHROUGH_OBSERVATION_KIND } from "../apps/runtime/src/services/health-floors.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

// The two live writers of dm_message_archive that every OnlyFans webhook goes
// through: the webhook upsert (a row REST material already advanced is
// fill-only for a late webhook) and the tombstone (a repeat is a no-op).

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

const OFAPI_ACCT = "acct_rt";
const FAN = "777100777";

async function seedPage(label = "rt-page", ofapiAccountId = OFAPI_ACCT) {
  const model = await createModel(testDb!.db, { slug: label, name: label });
  if (!model) {
    throw new Error("model seed failed");
  }
  const page = await createOnlyFansPage(testDb!.db, { modelId: model.id, label });
  if (!page) {
    throw new Error("page seed failed");
  }
  await setPageOfapiAccountId(testDb!.db, { pageId: page.id, ofapiAccountId });
  return page;
}

function webhookRowInput(overrides: Partial<UpsertDmMessageArchiveInput> = {}): UpsertDmMessageArchiveInput {
  return {
    platform: "onlyfans",
    platformAccountId: 0,
    ofapiAccountId: OFAPI_ACCT,
    platformConversationId: FAN,
    fanPlatformUserId: FAN,
    platformMessageId: "600",
    senderPlatformUserId: FAN,
    senderRole: "fan",
    isSentByMe: false,
    messageCreatedAt: new Date("2026-07-01T10:00:00Z"),
    textPlain: "webhook text",
    priceMills: null,
    isOpened: null,
    isTip: false,
    tipAmountMills: 0n,
    inReplyToMessageId: null,
    source: "webhook",
    sourceEventType: "messages.received",
    sourceIdempotencyKey: `wh-${overrides.platformMessageId ?? "600"}-${overrides.sourceReceivedAt?.getTime() ?? "t"}`,
    sourceJournalId: 1,
    sourceFanoutSeq: null,
    sourceReceivedAt: new Date("2026-07-01T10:00:05Z"),
    rawShapeVersion: "ofapi-message-v1",
    mediaMetadata: [],
    retentionPolicy: "default",
    retainUntil: new Date("2126-07-01T10:00:00Z"),
    ...overrides,
  };
}

async function archiveRow(messageId: string) {
  const { rows } = await testDb!.pool.query(
    `select text_plain, price_mills::text as price_mills, deleted_at,
            source_idempotency_key, source_journal_id::text as source_journal_id,
            rest_material_observation_id::text as rest_obs_id, retain_until
     from dm_message_archive where platform_message_id = $1`,
    [messageId],
  );
  return rows[0] as Record<string, unknown> | undefined;
}

describe("dm_message_archive writers", () => {
  it("webhook writer W: once REST advanced a row, a late webhook is fill-only; a newer webhook still owns webhook material", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // Webhook-owned row updated by a NEWER webhook fact → replace (W true).
    const first = await upsertDmMessageArchive(testDb.db, webhookRowInput({
      platformAccountId: page.id,
      platformMessageId: "900",
      textPlain: "v1 text",
      sourceReceivedAt: new Date("2026-07-01T10:00:05Z"),
      sourceIdempotencyKey: "wh-900-a",
    }));
    expect(first.status).toBe("written");
    const newer = await upsertDmMessageArchive(testDb.db, webhookRowInput({
      platformAccountId: page.id,
      platformMessageId: "900",
      textPlain: "v2 text",
      sourceReceivedAt: new Date("2026-07-01T10:00:10Z"),
      sourceIdempotencyKey: "wh-900-b",
    }));
    expect(newer.status).toBe("written");
    expect((await archiveRow("900"))!.text_plain).toBe("v2 text");

    // REST advances the row (fills price) → rest_material_observation_id set.
    const observation = await insertObservation(testDb.db, {
      source: "readthrough",
      producer: "read-gateway",
      platform: "onlyfans",
      accountId: page.id,
      kind: OFAPI_READTHROUGH_OBSERVATION_KIND,
      payload: { ofapiAccountId: OFAPI_ACCT, chatId: FAN, conversationRef: FAN, cursors: {}, body: { data: [] } },
      payloadHash: Buffer.alloc(32),
      idempotencyKey: "rt-900",
    });
    const rest = await upsertDmMessageArchiveFromReadthrough(testDb.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: OFAPI_ACCT,
      platformConversationId: FAN,
      fanPlatformUserId: FAN,
      platformMessageId: "900",
      senderPlatformUserId: FAN,
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-07-01T10:00:00Z"),
      textPlain: "v2 text",
      priceMills: 7000n,
      isTip: false,
      tipAmountMills: 0n,
      mediaMetadata: [],
      observationId: observation.observationId,
      observationReceivedAt: observation.receivedAt,
      retentionPolicy: "default",
      retainUntil: new Date("2126-07-01T10:00:00Z"),
    });
    expect(rest.status).toBe("written");
    expect((await archiveRow("900"))!.rest_obs_id).not.toBeNull();

    // A late/retried webhook (older source_received_at, diverging text) must
    // NOT replace REST-advanced material — fill-only + monotone (W false).
    const late = await upsertDmMessageArchive(testDb.db, webhookRowInput({
      platformAccountId: page.id,
      platformMessageId: "900",
      textPlain: "stale retry text",
      priceMills: null,
      sourceReceivedAt: new Date("2026-07-01T10:00:07Z"),
      sourceIdempotencyKey: "wh-900-late",
    }));
    expect(late.status).toBe("noop");
    const after = await archiveRow("900");
    expect(after).toMatchObject({ text_plain: "v2 text", price_mills: "7000" });
  });

  it("tombstone repeats are guarded no-ops: provenance and retain_until stop refreshing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const base = {
      platform: "onlyfans" as const,
      platformAccountId: page.id,
      ofapiAccountId: OFAPI_ACCT,
      platformMessageId: "990",
      source: "webhook" as const,
      sourceEventType: "messages.deleted" as const,
      retentionPolicy: "default",
    };
    const first = await tombstoneDmMessageArchive(testDb.db, {
      ...base,
      deletedAt: new Date("2026-07-02T00:00:00Z"),
      sourceIdempotencyKey: "del-990-a",
      sourceJournalId: 90,
      sourceReceivedAt: new Date("2026-07-02T00:00:01Z"),
      retainUntil: new Date("2126-07-02T00:00:00Z"),
    });
    expect(first.status).toBe("written");
    const repeat = await tombstoneDmMessageArchive(testDb.db, {
      ...base,
      deletedAt: new Date("2026-07-03T00:00:00Z"),
      sourceIdempotencyKey: "del-990-b",
      sourceJournalId: 91,
      sourceReceivedAt: new Date("2026-07-03T00:00:01Z"),
      retainUntil: new Date("2126-07-03T00:00:00Z"),
    });
    expect(repeat.status).toBe("noop");
    const row = await archiveRow("990");
    expect(row).toMatchObject({ source_idempotency_key: "del-990-a", source_journal_id: "90" });
    expect(row!.deleted_at).toEqual(new Date("2026-07-02T00:00:00Z"));
    expect(row!.retain_until).toEqual(new Date("2126-07-02T00:00:00Z"));
  });
});
