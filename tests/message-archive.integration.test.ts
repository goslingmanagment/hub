import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendDomainEvents,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  insertObservation,
  setPageOfapiAccountId,
  upsertFans,
  upsertPageDmMessages,
} from "@agency_hub_core/db";

import {
  rebuildMessageArchiveProjection,
  runMessageArchiveBackfills,
  runMessageArchiveProjection,
} from "../apps/runtime/src/services/projections/message-archive.ts";
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
