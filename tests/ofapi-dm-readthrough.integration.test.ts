import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  insertObservation,
  setPageOfapiAccountId,
  tombstoneDmMessageArchive,
  upsertDmMessageArchive,
  type UpsertDmMessageArchiveInput,
} from "@agency_hub_core/db";

import {
  OFAPI_READTHROUGH_OBSERVATION_KIND,
} from "../apps/runtime/src/services/health-floors.ts";
import {
  projectReadthroughObservation,
  runOfapiDmReadthroughReconcile,
  type ReadthroughReconcileRunResult,
} from "../apps/runtime/src/services/ofapi-dm-readthrough.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

// Fast-reply freshness PR4 — the REST readthrough reconcile: the amendment-3
// merge shapes on both writers, project-then-stamp, the rolling-version
// safety, and the counters that turn "conflicts barely exist" into a number.

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

function appStub() {
  return {
    db: testDb!.db,
    config: { ofapiDmReadthroughReconcileEnabled: true, ofapiDmColdArchiveRetentionDays: 36500 },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

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

interface RestItem {
  id: number;
  text?: string;
  isSentByMe?: boolean;
  createdAt?: string;
  price?: number;
  isOpened?: boolean | null;
  isTip?: boolean;
  tipAmount?: number;
  media?: unknown[];
}

async function seedReadthroughObservation(input: {
  pageId: number;
  items: RestItem[];
  chatId?: string;
  key?: string;
  receivedAt?: Date;
}) {
  const payload = {
    ofapiAccountId: OFAPI_ACCT,
    chatId: input.chatId ?? FAN,
    conversationRef: input.chatId ?? FAN,
    cursors: { limit: "100" },
    body: { data: input.items },
  };
  const result = await insertObservation(testDb!.db, {
    source: "readthrough",
    producer: "read-gateway",
    platform: "onlyfans",
    accountId: input.pageId,
    kind: OFAPI_READTHROUGH_OBSERVATION_KIND,
    payload,
    payloadHash: Buffer.alloc(32),
    idempotencyKey: input.key ?? `rt-test-${Math.abs(input.items[0]?.id ?? 0)}-${input.items.length}`,
    ...(input.receivedAt ? { receivedAt: input.receivedAt } : {}),
  });
  return { ...result, payload };
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
    `select platform_message_id, platform_conversation_id, fan_platform_user_id,
            sender_role::text as sender_role, is_sent_by_me, message_created_at,
            text_plain, price_mills::text as price_mills, is_opened, is_tip,
            tip_amount_mills::text as tip_amount_mills, in_reply_to_message_id,
            deleted_at, source, source_event_type, source_idempotency_key,
            source_journal_id::text as source_journal_id,
            rest_material_observation_id::text as rest_obs_id,
            rest_material_observed_at, retain_until, updated_at
     from dm_message_archive where platform_message_id = $1`,
    [messageId],
  );
  return rows[0] as Record<string, unknown> | undefined;
}

describe("readthrough reconcile (fastreply-freshness PR4)", () => {
  it("INSERT arm (M7): rows the webhook lane missed land as rest_reconcile with NULL journal id, then stamp", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const seeded = await seedReadthroughObservation({
      pageId: page.id,
      items: [
        { id: 501, text: "<p>hello</p>", isSentByMe: false, createdAt: "2026-07-01T10:00:00+00:00", price: 5, isOpened: false },
        { id: 502, text: "reply", isSentByMe: true, createdAt: "2026-07-01T10:01:00+00:00" },
        { id: 0, text: "no usable id" } as never, // per-item parse skip
      ],
    });
    expect(seeded.inserted).toBe(true);

    const result = await runOfapiDmReadthroughReconcile(appStub());
    expect(result).toMatchObject({ scanned: 1, stamped: 1, upserts: 2, parseSkips: 1, drops: 0, errored: 0 });

    const row = await archiveRow("501");
    expect(row).toMatchObject({
      platform_conversation_id: FAN,
      fan_platform_user_id: FAN,
      sender_role: "fan",
      is_sent_by_me: false,
      text_plain: "hello",
      price_mills: "5000",
      is_opened: false,
      source: "rest_reconcile",
      source_event_type: "messages.received",
      source_journal_id: null,
      source_idempotency_key: `readthrough:${seeded.observationId}:501`,
      rest_obs_id: String(seeded.observationId),
    });
    const sent = await archiveRow("502");
    expect(sent).toMatchObject({ sender_role: "model", is_sent_by_me: true, source_event_type: "messages.sent" });

    // PROJECT THEN STAMP: the observation sits at the floor version now
    // (the shared descriptor's version — bumped to 2 at the Wave-2 reducer
    // cutover so v1-stamped rows replay through the real reducer).
    const { OFAPI_READTHROUGH_HEALTH_FLOOR } = await import("../apps/runtime/src/services/health-floors.ts");
    const { rows } = await testDb.pool.query(
      "select parse_version from observations where id = $1",
      [seeded.observationId],
    );
    expect(rows[0].parse_version).toBe(OFAPI_READTHROUGH_HEALTH_FLOOR.version);

    // Idempotent replay: a second sweep scans nothing (stamped).
    const again = await runOfapiDmReadthroughReconcile(appStub());
    expect(again.scanned).toBe(0);
  });

  it("UPDATE arm: fill-absent only — non-sentinel conflicts are kept AND counted; true no-op rewrites 0 rows", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const written = await upsertDmMessageArchive(testDb.db, webhookRowInput({
      platformAccountId: page.id,
      platformMessageId: "600",
      textPlain: "webhook text",
      priceMills: 3000n,
    }));
    expect(written.status).toBe("written");
    const before = await archiveRow("600");

    // REST replays the same message with DIFFERENT text/price — Wave 1 keeps
    // the existing material and measures the conflict.
    const seeded = await seedReadthroughObservation({
      pageId: page.id,
      items: [{ id: 600, text: "rest text", isSentByMe: false, createdAt: "2026-07-01T10:00:00+00:00", price: 4 }],
      key: "rt-conflict",
    });
    const result = await runOfapiDmReadthroughReconcile(appStub());
    expect(result.noops).toBe(1);
    expect(result.upserts).toBe(0);
    expect(result.conflicts.text).toBe(1);
    expect(result.conflicts.price).toBe(1);

    const after = await archiveRow("600");
    expect(after).toMatchObject({
      text_plain: "webhook text",
      price_mills: "3000",
      source: "webhook",
      // The guard blocked the row write entirely: no REST provenance, no
      // updated_at churn (chat-open of known messages rewrites 0 rows).
      rest_obs_id: null,
    });
    expect(after!.updated_at).toEqual(before!.updated_at);
    expect(seeded.inserted).toBe(true);
  });

  it("sentinel-aware fill: REST completes a tombstone stub and the tombstone STAYS; source_* never touched", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const stub = await tombstoneDmMessageArchive(testDb.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: OFAPI_ACCT,
      platformMessageId: "700",
      deletedAt: new Date("2026-07-02T00:00:00Z"),
      source: "webhook",
      sourceEventType: "messages.deleted",
      sourceIdempotencyKey: "wh-del-700",
      sourceJournalId: 7,
      sourceReceivedAt: new Date("2026-07-02T00:00:01Z"),
      retentionPolicy: "default",
      retainUntil: new Date("2126-07-02T00:00:00Z"),
    });
    expect(stub.status).toBe("written");

    await seedReadthroughObservation({
      pageId: page.id,
      items: [{ id: 700, text: "was deleted later", isSentByMe: true, createdAt: "2026-07-01T09:00:00+00:00" }],
      key: "rt-stub-hydrate",
    });
    const result = await runOfapiDmReadthroughReconcile(appStub());
    expect(result.upserts).toBe(1);

    const row = await archiveRow("700");
    expect(row).toMatchObject({
      text_plain: "was deleted later",
      sender_role: "model",
      is_sent_by_me: true,
      // deleted_at is sticky — hydration keeps the tombstone.
      source: "webhook",
      source_event_type: "messages.deleted",
      source_idempotency_key: "wh-del-700",
      source_journal_id: "7",
    });
    expect(row!.deleted_at).not.toBeNull();
    expect(row!.message_created_at).toEqual(new Date("2026-07-01T09:00:00Z"));
    expect(row!.rest_obs_id).not.toBeNull();
  });

  it("is_opened advances monotonically on the REST path (true wins, false beats null, never true→false)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // 801: null → false (false beats null). 802: false → true (true wins).
    // 803: true stays true against an incoming false.
    for (const [id, initial] of [["801", null], ["802", false], ["803", true]] as const) {
      const written = await upsertDmMessageArchive(testDb.db, webhookRowInput({
        platformAccountId: page.id,
        platformMessageId: id,
        isOpened: initial,
        sourceIdempotencyKey: `wh-open-${id}`,
      }));
      expect(written.status).toBe("written");
    }
    await seedReadthroughObservation({
      pageId: page.id,
      items: [
        { id: 801, text: "webhook text", isSentByMe: false, createdAt: "2026-07-01T10:00:00+00:00", isOpened: false },
        { id: 802, text: "webhook text", isSentByMe: false, createdAt: "2026-07-01T10:00:00+00:00", isOpened: true },
        { id: 803, text: "webhook text", isSentByMe: false, createdAt: "2026-07-01T10:00:00+00:00", isOpened: false },
      ],
      key: "rt-opened",
    });
    const result = await runOfapiDmReadthroughReconcile(appStub());
    expect(result.upserts).toBe(2); // 801, 802 advanced; 803 is a no-op
    expect(result.noops).toBe(1);
    expect((await archiveRow("801"))!.is_opened).toBe(false);
    expect((await archiveRow("802"))!.is_opened).toBe(true);
    expect((await archiveRow("803"))!.is_opened).toBe(true);
  });

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
    await seedReadthroughObservation({
      pageId: page.id,
      items: [{ id: 900, text: "v2 text", isSentByMe: false, createdAt: "2026-07-01T10:00:00+00:00", price: 7 }],
      key: "rt-900",
    });
    const rest = await runOfapiDmReadthroughReconcile(appStub());
    expect(rest.upserts).toBe(1);
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

  it("rolling-version safety (am.2): a v1 immediate projector after a v2 stamp regresses nothing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const seeded = await seedReadthroughObservation({
      pageId: page.id,
      items: [{ id: 950, text: "settled", isSentByMe: false, createdAt: "2026-07-01T10:00:00+00:00" }],
      key: "rt-rolling",
    });
    // A FUTURE-version worker already consumed this observation (rolling
    // deploy): one version above the current floor.
    await testDb.pool.query(
      "update observations set parse_version = 3 where id = $1",
      [seeded.observationId],
    );
    const row = await upsertDmMessageArchive(testDb.db, webhookRowInput({
      platformAccountId: page.id,
      platformMessageId: "950",
      textPlain: "reduced head",
      sourceIdempotencyKey: "wh-950",
    }));
    expect(row.status).toBe("written");

    const totals: ReadthroughReconcileRunResult = {
      scanned: 0, stamped: 0, upserts: 0, noops: 0, drops: 0,
      parseSkips: 0, deferred: 0, errored: 0,
      conflicts: { text: 0, price: 0, direction: 0, timestamp: 0, reply: 0, media: 0 },
    };
    const outcome = await projectReadthroughObservation(appStub(), {
      id: seeded.observationId,
      receivedAt: seeded.receivedAt,
      accountId: page.id,
      payload: seeded.payload,
    }, totals);
    expect(outcome.status).toBe("projected");

    // The forward-only stamp never regresses, and the fill-only merge left
    // the (notionally reduced) material alone.
    const { rows } = await testDb.pool.query(
      "select parse_version from observations where id = $1",
      [seeded.observationId],
    );
    expect(rows[0].parse_version).toBe(3);
    expect((await archiveRow("950"))!.text_plain).toBe("reduced head");
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

  it("insertObservation returns the EXISTING key's received_at on the duplicate path", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const receivedAt = new Date("2026-07-05T12:00:00Z");
    const first = await seedReadthroughObservation({
      pageId: page.id,
      items: [{ id: 999, text: "x", isSentByMe: false, createdAt: "2026-07-01T10:00:00+00:00" }],
      key: "rt-dup",
      receivedAt,
    });
    expect(first.inserted).toBe(true);
    expect(first.receivedAt).toEqual(receivedAt);
    const dup = await seedReadthroughObservation({
      pageId: page.id,
      items: [{ id: 999, text: "x", isSentByMe: false, createdAt: "2026-07-01T10:00:00+00:00" }],
      key: "rt-dup",
    });
    expect(dup.inserted).toBe(false);
    expect(dup.observationId).toBe(first.observationId);
    // Partition-exact: the duplicate path surfaces the ORIGINAL received_at.
    expect(dup.receivedAt).toEqual(receivedAt);
  });
});
