import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendDomainEvents,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  setPageOfapiAccountId,
  upsertFans,
  upsertPageDmMessages,
} from "@agency_hub_core/db";

import {
  rebuildMessageArchiveProjection,
  runMessageArchiveBackfills,
  runMessageArchiveProjection,
} from "../apps/runtime/src/services/projections/message-archive.ts";
import { appendOfapiMessageMaterialPage } from "../apps/runtime/src/services/ofapi-message-material.ts";
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
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
});

function appStub() {
  return {
    db: testDb!.db,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

async function seedPages() {
  const model = await createModel(testDb!.db, { slug: "arch", name: "Arch" });
  const ofPage = await createOnlyFansPage(testDb!.db, { modelId: model.id, label: "arch-of" });
  await setPageOfapiAccountId(testDb!.db, { pageId: ofPage.id, ofapiAccountId: "acct_arch" });
  const fanslyPage = await createFanslyPage(testDb!.db, { modelId: model.id, label: "arch-fansly" });
  return { ofPage, fanslyPage };
}

function messageEvent(input: {
  ref: string;
  type?: string;
  fan?: string;
  text?: string;
  price?: number;
  isTip?: boolean;
  occurredAt?: Date;
}) {
  return {
    type: input.type ?? "message.received",
    occurredAt: input.occurredAt ?? new Date("2026-06-25T12:00:00Z"),
    fanIdentityRef: input.fan ?? "fan-1",
    conversationRef: input.fan ?? "fan-1",
    messageRef: input.ref,
    transactionRef: null,
    data: { text: input.text ?? "hello", price: input.price ?? 0, isTip: input.isTip ?? false },
    schemaVersion: 1,
    observationId: 1,
    dedupKey: `msg:${input.type === "message.sent" ? "sent" : "received"}:${input.ref}`,
  };
}

describe("message archive projection (Stage 10)", () => {
  it("applies message events behind the watermark, tombstones deletes, and rebuilds identically", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { ofPage } = await seedPages();

    await appendDomainEvents(testDb.db, ofPage.id, [
      messageEvent({ ref: "m-1", fan: "777", text: "hi there", price: 0 }),
      messageEvent({ ref: "m-2", fan: "777", type: "message.sent", text: "ppv", price: 25 }),
      messageEvent({ ref: "m-3", fan: "778", text: "tip!", price: 10, isTip: true }),
    ]);

    const first = await runMessageArchiveProjection(appStub());
    expect(first).toMatchObject({ inserted: 3, tombstoned: 0 });
    // Idempotent: the watermark parks; a second sweep does nothing.
    expect(await runMessageArchiveProjection(appStub())).toMatchObject({
      inserted: 0,
      eventsSeen: 0,
    });

    const rows = await testDb.pool.query<{
      message_ref: string;
      sender_role: string;
      is_sent_by_me: boolean;
      price_mills: string | null;
      tip_amount_mills: string;
      text_plain: string;
    }>(
      `select message_ref, sender_role, is_sent_by_me, price_mills::text as price_mills,
              tip_amount_mills::text as tip_amount_mills, text_plain
       from message_archive where account_id = $1 order by message_ref`,
      [ofPage.id],
    );
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows[0]).toMatchObject({ message_ref: "m-1", sender_role: "fan", is_sent_by_me: false });
    expect(rows.rows[1]).toMatchObject({
      message_ref: "m-2",
      sender_role: "model",
      is_sent_by_me: true,
      price_mills: "25000",
      tip_amount_mills: "0",
    });
    expect(rows.rows[2]).toMatchObject({ message_ref: "m-3", tip_amount_mills: "10000" });

    // Tombstone via message.deleted.
    await appendDomainEvents(testDb.db, ofPage.id, [{
      type: "message.deleted",
      occurredAt: new Date("2026-06-26T00:00:00Z"),
      messageRef: "m-1",
      data: {},
      schemaVersion: 1,
      observationId: 2,
      dedupKey: "msg:deleted:m-1",
    }]);
    expect(await runMessageArchiveProjection(appStub())).toMatchObject({ tombstoned: 1 });
    const tombstone = await testDb.pool.query(
      "select 1 from message_archive where message_ref = 'm-1' and deleted_at is not null",
    );
    expect(tombstone.rows).toHaveLength(1);

    // Rebuild reproduces identical counts from the ledger (the §5.2 proof).
    const before = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from message_archive where account_id = $1",
      [ofPage.id],
    );
    const rebuilt = await rebuildMessageArchiveProjection(appStub(), { accountId: ofPage.id });
    expect(rebuilt.inserted).toBe(3);
    expect(rebuilt.tombstoned).toBe(1);
    const after = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from message_archive where account_id = $1",
      [ofPage.id],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("backfills from the hot table with cents→mills and stays idempotent — both platforms present", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { ofPage, fanslyPage } = await seedPages();

    // Fansly hot rows (the platform-neutral headline half).
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fansly-fan-9",
      username: "ff9",
    }]);
    const conversation = await testDb.pool.query<{ id: number }>(
      `insert into page_dm_threads (
         platform_account_id, fan_id, platform_conversation_id,
         partner_platform_user_id, conversation_flags, unread_count,
         stored_message_count, message_backfill_complete, is_visible,
         last_seen_generation, metadata, updated_at
       ) values ($1, $2, 'conv-f9', 'fansly-fan-9', 0, 0, 0, false, true, 1, '{}'::jsonb, now())
       returning id`,
      [fanslyPage.id, fan!.id],
    );
    await upsertPageDmMessages(testDb.db, [{
      conversationId: conversation.rows[0]!.id,
      platformAccountId: fanslyPage.id,
      platformMessageId: "fm-1",
      senderPlatformUserId: "fansly-fan-9",
      senderRole: "fan",
      createdAt: new Date("2026-06-20T10:00:00Z"),
      content: "fansly tip message",
      totalTipAmountCents: 2000, // cents → 20_000 mills
      inReplyToMessageId: null,
      inReplyToRootMessageId: null,
    }]);

    // OnlyFans side arrives via an event (mixed-source proof).
    await appendDomainEvents(testDb.db, ofPage.id, [messageEvent({ ref: "om-1", fan: "42" })]);
    await runMessageArchiveProjection(appStub());

    const backfill = await runMessageArchiveBackfills(appStub());
    expect(backfill.hotBatches).toBeGreaterThan(0);
    // Idempotent: a second run adds zero rows.
    const countAfterFirst = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from message_archive",
    );
    await runMessageArchiveBackfills(appStub());
    const countAfterSecond = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from message_archive",
    );
    expect(countAfterSecond.rows[0]!.n).toBe(countAfterFirst.rows[0]!.n);

    const platforms = await testDb.pool.query<{ platform: string; n: string }>(
      "select platform, count(*)::text as n from message_archive group by 1 order by 1",
    );
    expect(platforms.rows.map((row) => row.platform).sort()).toEqual(["fansly", "onlyfans"]);

    const fanslyRow = await testDb.pool.query<{
      tip_amount_mills: string;
      is_tip: boolean;
      backfill_source: string;
      conversation_ref: string;
    }>(
      `select tip_amount_mills::text as tip_amount_mills, is_tip, backfill_source, conversation_ref
       from message_archive where platform = 'fansly'`,
    );
    expect(fanslyRow.rows[0]).toMatchObject({
      tip_amount_mills: "20000",
      is_tip: true,
      backfill_source: "hot_table",
      conversation_ref: "conv-f9",
    });
  });

  it("archives tip mills from every producer shape — fansly mills, harvest dollars", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { ofPage, fanslyPage } = await seedPages();

    // Fansly sync-pull events carry tipAmountMills (MILLS verbatim, no price).
    await appendDomainEvents(testDb.db, fanslyPage.id, [{
      type: "message.received",
      occurredAt: new Date("2026-06-25T12:00:00Z"),
      fanIdentityRef: "f-55",
      conversationRef: "conv-55",
      messageRef: "ftip-1",
      data: { text: "fansly tip", tipAmountMills: 6400, isTip: true },
      schemaVersion: 1,
      observationId: 10,
      dedupKey: "msg:received:ftip-1",
    }]);
    // Desktop harvest events carry tipAmount in DOLLARS (price 0 for tips).
    await appendDomainEvents(testDb.db, ofPage.id, [{
      type: "message.received",
      occurredAt: new Date("2026-06-25T12:01:00Z"),
      fanIdentityRef: "h-77",
      conversationRef: "h-77",
      messageRef: "htip-1",
      data: { text: "harvest tip", price: 0, isTip: true, tipAmount: 5 },
      schemaVersion: 1,
      observationId: 11,
      dedupKey: "msg:received:htip-1",
    }]);

    await runMessageArchiveProjection(appStub());
    const rows = await testDb.pool.query<{
      message_ref: string;
      tip_amount_mills: string;
      is_tip: boolean;
    }>(
      `select message_ref, tip_amount_mills::text as tip_amount_mills, is_tip
       from message_archive order by message_ref`,
    );
    expect(rows.rows).toEqual([
      { message_ref: "ftip-1", tip_amount_mills: "6400", is_tip: true },
      { message_ref: "htip-1", tip_amount_mills: "5000", is_tip: true },
    ]);
  });

  it("keeps an out-of-order tombstone: deleted-before-received stubs, then hydrates", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { ofPage } = await seedPages();

    // The deleted event lands FIRST (webhook redelivery reordering).
    await appendDomainEvents(testDb.db, ofPage.id, [{
      type: "message.deleted",
      occurredAt: new Date("2026-06-26T00:00:00Z"),
      messageRef: "ooo-1",
      data: {},
      schemaVersion: 1,
      observationId: 20,
      dedupKey: "msg:deleted:ooo-1",
    }]);
    const first = await runMessageArchiveProjection(appStub());
    expect(first).toMatchObject({ tombstoned: 1 });
    const stub = await testDb.pool.query<{ content_pending: boolean }>(
      `select content_pending from message_archive
       where message_ref = 'ooo-1' and deleted_at is not null`,
    );
    expect(stub.rows).toEqual([{ content_pending: true }]);

    // The content event arrives later: hydrates the stub, KEEPS the tombstone.
    await appendDomainEvents(testDb.db, ofPage.id, [
      messageEvent({ ref: "ooo-1", fan: "888", text: "was deleted", price: 0 }),
    ]);
    const second = await runMessageArchiveProjection(appStub());
    expect(second).toMatchObject({ inserted: 1 });
    const hydrated = await testDb.pool.query<{
      text_plain: string;
      content_pending: boolean;
      deleted: boolean;
    }>(
      `select text_plain, content_pending, (deleted_at is not null) as deleted
       from message_archive where message_ref = 'ooo-1'`,
    );
    expect(hydrated.rows).toEqual([
      { text_plain: "was deleted", content_pending: false, deleted: true },
    ]);

    // A replayed content event never overwrites the hydrated row (first REAL
    // writer wins), and rebuild converges to the same terminal state.
    const rebuilt = await rebuildMessageArchiveProjection(appStub(), { accountId: ofPage.id });
    expect(rebuilt.tombstoned).toBe(1);
    const afterRebuild = await testDb.pool.query<{
      text_plain: string;
      content_pending: boolean;
      deleted: boolean;
    }>(
      `select text_plain, content_pending, (deleted_at is not null) as deleted
       from message_archive where message_ref = 'ooo-1'`,
    );
    expect(afterRebuild.rows).toEqual([
      { text_plain: "was deleted", content_pending: false, deleted: true },
    ]);
  });

  it("projects full OF material without turning it into a business message event", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { ofPage } = await seedPages();
    if (!ofPage) throw new Error("OnlyFans test page was not created");
    await appendOfapiMessageMaterialPage(testDb.db, {
      accountId: ofPage.id,
      observationId: 501,
      observationReceivedAt: new Date("2026-07-16T12:00:00Z"),
      chatId: "chat-55",
      originClass: "capture_background",
      items: [{
        id: "9001",
        createdAt: "2026-07-16T11:00:00Z",
        changedAt: "2026-07-16T11:30:00Z",
        isSentByMe: false,
        fromUser: { id: "fan-55" },
        text: "<p>paid <b>hello</b></p>",
        price: 12,
        isOpened: false,
        isNew: true,
        isTip: false,
        replyToMessage: { id: "8999", text: "<p>parent</p>", isSentByMe: true },
        media: [{ id: "med-1", type: "photo", canView: true, isReady: true }],
      }],
    });

    await runMessageArchiveProjection(appStub());
    const row = await testDb.pool.query<{
      native_message_id: string;
      text_html: string;
      text_plain: string;
      is_opened: boolean;
      is_new: boolean;
      in_reply_to_ref: string;
      origin_class: string;
      serving_contract_version: number;
      source_account_seq: string;
      media_metadata: Array<Record<string, unknown>>;
    }>(`
      select native_message_id::text as native_message_id, text_html, text_plain,
             is_opened, is_new, in_reply_to_ref, origin_class,
             serving_contract_version, source_account_seq::text as source_account_seq,
             media_metadata
      from message_archive where account_id = $1 and message_ref = '9001'
    `, [ofPage.id]);
    expect(row.rows[0]).toMatchObject({
      native_message_id: "9001",
      text_html: "<p>paid <b>hello</b></p>",
      text_plain: "paid hello",
      is_opened: false,
      is_new: true,
      in_reply_to_ref: "8999",
      origin_class: "capture_background",
      serving_contract_version: 1,
      source_account_seq: "1",
    });
    expect(row.rows[0]!.media_metadata).toEqual([
      { id: "med-1", type: "photo", canView: true, isReady: true, duration: null },
    ]);
  });

  it("skips accounts with events but no resolvable page and parks their watermark", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await appendDomainEvents(testDb.db, 999_999, [messageEvent({ ref: "ghost-1" })]);
    const result = await runMessageArchiveProjection(appStub());
    expect(result.inserted).toBe(0);
    const rows = await testDb.pool.query("select 1 from message_archive");
    expect(rows.rows).toHaveLength(0);
  });
});
