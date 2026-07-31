// W10 (decision #134): the message-archive shadow rebuild — staged flow
// (preflight → shadow build → fidelity verify → atomic switch), the hard
// detached-partition gate, and the backfill-discard case the Stage 10 suite
// never covered (legacy seeds with pruned originals surviving a rebuild).

import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendDomainEvents,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  listArchiveConversationMessages,
  setPageOfapiAccountId,
  upsertFans,
  upsertPageDmMessages,
} from "@agency_hub_core/db";
import { normalizeDmMessageText } from "@agency_hub_core/shared";

import {
  rebuildMessageArchiveProjection,
  runMessageArchiveBackfills,
  runMessageArchiveProjection,
} from "../apps/runtime/src/services/projections/message-archive.ts";
import {
  buildMessageArchiveShadow,
  runArchiveRebuildPreflight,
  switchMessageArchiveShadow,
  verifyMessageArchiveShadow,
} from "../apps/runtime/src/services/projections/message-archive-rebuild.ts";
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
  const model = (await createModel(testDb!.db, { slug: "reb", name: "Reb" }))!;
  const ofPage = (await createOnlyFansPage(testDb!.db, { modelId: model.id, label: "reb-of" }))!;
  await setPageOfapiAccountId(testDb!.db, { pageId: ofPage.id, ofapiAccountId: "acct_reb" });
  const fanslyPage = (await createFanslyPage(testDb!.db, { modelId: model.id, label: "reb-fansly" }))!;
  return { ofPage, fanslyPage };
}

function messageEvent(input: {
  ref: string;
  type?: string;
  fan?: string;
  text?: string;
  price?: number;
  occurredAt?: Date;
}) {
  return {
    type: input.type ?? "message.received",
    occurredAt: input.occurredAt ?? new Date("2026-06-25T12:00:00Z"),
    fanIdentityRef: input.fan ?? "fan-1",
    conversationRef: input.fan ?? "fan-1",
    messageRef: input.ref,
    transactionRef: null,
    data: { text: input.text ?? "hello", price: input.price ?? 0, isTip: false },
    schemaVersion: 1,
    observationId: 1,
    dedupKey: `msg:${input.type === "message.sent" ? "sent" : "received"}:${input.ref}`,
  };
}

/** Legacy hot-table seed: thread + message for the fansly page, then the
 * Stage 10 backfill copies it into the LIVE archive as a legacy-seed row. */
async function seedFanslyHotMessage(fanslyPageId: number) {
  const [fan] = await upsertFans(testDb!.db, [{
    platform: "fansly",
    platformUserId: "fansly-fan-1",
    username: "ff1",
  }]);
  const conversation = await testDb!.pool.query<{ id: number }>(
    `insert into page_dm_threads (
       platform_account_id, fan_id, platform_conversation_id,
       partner_platform_user_id, conversation_flags, unread_count,
       stored_message_count, message_backfill_complete, is_visible,
       last_seen_generation, metadata, updated_at
     ) values ($1, $2, 'conv-f1', 'fansly-fan-1', 0, 0, 0, false, true, 1, '{}'::jsonb, now())
     returning id`,
    [fanslyPageId, fan!.id],
  );
  await upsertPageDmMessages(testDb!.db, [{
    conversationId: conversation.rows[0]!.id,
    platformAccountId: fanslyPageId,
    platformMessageId: "fm-1",
    senderPlatformUserId: "fansly-fan-1",
    senderRole: "fan",
    createdAt: new Date("2026-06-20T10:00:00Z"),
    content: "fansly tip message",
    totalTipAmountCents: 2000, // cents → 20_000 mills
    inReplyToMessageId: null,
    inReplyToRootMessageId: null,
  }]);
}

/** Legacy dm_message_archive seed (frozen OFAPI cold archive origin). */
async function seedDmArchiveRow(ofPageId: number) {
  await testDb!.pool.query(
    `insert into dm_message_archive (
       platform, platform_account_id, ofapi_account_id, platform_conversation_id,
       fan_platform_user_id, platform_message_id, sender_role, is_sent_by_me,
       message_created_at, text_plain, is_tip, tip_amount_mills,
       source, source_event_type, source_idempotency_key, source_received_at, retain_until
     ) values (
       'onlyfans', $1, 'acct_reb', 'conv-legacy', '42', 'dm-legacy-1', 'fan', false,
       '2026-05-01T00:00:00Z', 'legacy cold-archive text', false, 0,
       'webhook', 'messages.received', 'idem-legacy-1', now(), now() + interval '100 years'
     )`,
    [ofPageId],
  );
}

/** The switch consumes message_archive_shadow (renamed into place); tests
 * that switched re-create it from the 0083 migration for the next test. */
async function recreateShadowTable() {
  const migration = await readFile(
    path.resolve("packages/db/migrations/0083_w10_message_archive_shadow.sql"),
    "utf8",
  );
  await testDb!.pool.query(migration);
}

const RAW_HTML = "<p>Hello</p><br>world &amp; more";

describe("message-archive shadow rebuild (W10)", () => {
  it("staged flow: lift + replay + backfill → zero-loss verify → atomic switch → reads unchanged", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { ofPage, fanslyPage } = await seedPages();

    await appendDomainEvents(testDb.db, ofPage.id, [
      messageEvent({ ref: "m-1", fan: "777", text: "hi there" }),
      messageEvent({ ref: "m-2", fan: "777", type: "message.sent", text: RAW_HTML, price: 25 }),
    ]);
    await appendDomainEvents(testDb.db, ofPage.id, [{
      type: "message.deleted",
      occurredAt: new Date("2026-06-26T00:00:00Z"),
      messageRef: "m-1",
      data: {},
      schemaVersion: 1,
      observationId: 2,
      dedupKey: "msg:deleted:m-1",
    }]);
    await runMessageArchiveProjection(appStub());

    // A51 forward fix: the LIVE projection writer already strips HTML — the
    // ledger keeps the verbatim text, the projection derives text_plain.
    const liveText = await testDb.pool.query<{ text_plain: string }>(
      "select text_plain from message_archive where message_ref = 'm-2'",
    );
    expect(liveText.rows[0]!.text_plain).toBe(normalizeDmMessageText(RAW_HTML));
    expect(liveText.rows[0]!.text_plain).not.toContain("<");

    // Simulate pre-A51 dirty history: the row was projected before the strip.
    await testDb.pool.query(
      "update message_archive set text_plain = $1 where message_ref = 'm-2'",
      [RAW_HTML],
    );

    // Legacy seeds via the Stage 10 backfills, then PRUNE the hot original —
    // from here the archive row is the ONLY copy of fm-1.
    await seedFanslyHotMessage(fanslyPage.id);
    await seedDmArchiveRow(ofPage.id);
    await runMessageArchiveBackfills(appStub());
    await testDb.pool.query(
      "delete from page_dm_messages where platform_message_id = 'fm-1'",
    );

    // R0 preflight: the corrected census (dm_message_archive included as an
    // origin) marks only the pruned fansly row unrecoverable.
    const preflight = await runArchiveRebuildPreflight(appStub());
    const ofCensus = preflight.accounts.find((a) => a.accountId === ofPage.id)!;
    expect(ofCensus).toMatchObject({
      totalRows: 3,
      eventSourcedRows: 2,
      legacySeedsBySource: { dm_message_archive: 1 },
      unrecoverableIfDropped: 0,
      detachedPartitionsHoldingEvents: [],
    });
    const fanslyCensus = preflight.accounts.find((a) => a.accountId === fanslyPage.id)!;
    expect(fanslyCensus).toMatchObject({
      totalRows: 1,
      eventSourcedRows: 0,
      legacySeedsBySource: { hot_table: 1 },
      unrecoverableIfDropped: 1,
    });

    // R1 shadow build — the fansly account has NO events (archive-rows-only
    // account: the union scope must still pick it up).
    const build = await buildMessageArchiveShadow(appStub());
    expect(build.accounts).toBe(2);
    const ofBuild = build.results.find((r) => r.accountId === ofPage.id)!;
    expect(ofBuild).toMatchObject({ lifted: 1, inserted: 2, tombstoned: 1, highSeq: 3 });
    const fanslyBuild = build.results.find((r) => r.accountId === fanslyPage.id)!;
    expect(fanslyBuild).toMatchObject({ lifted: 1, inserted: 0, highSeq: 0 });

    // R2 fidelity proof: nothing missing; the one material diff is the
    // EXPECTED A51 healing (old dirty HTML vs shadow stripped).
    const verify = await verifyMessageArchiveShadow(appStub());
    expect(verify.ok).toBe(true);
    expect(verify.missing).toBe(0);
    expect(verify.extra).toBe(0);
    expect(verify.compared).toBe(4);
    expect(verify.mismatches).toMatchObject({
      textPlain: 1,
      occurredAt: 0,
      priceMills: 0,
      tipAmountMills: 0,
      deletedAt: 0,
      conversationRef: 0,
      fanNativeId: 0,
    });
    expect(verify.diffSample).toHaveLength(1);
    expect(verify.diffSample[0]).toMatchObject({ messageRef: "m-2", healedHtml: true });

    // R3 atomic switch.
    const switched = await switchMessageArchiveShadow(appStub());
    expect(switched.retiredTable).toMatch(/^message_archive_retired_\d{14}$/);
    expect(switched.liveRows).toBe(4);
    expect(switched.retiredRows).toBe(4);
    expect(switched.watermarksReset).toBe(2);

    // The archive generation moved in the SAME transaction as the rename. Agent
    // read cursors carry the generation they were minted under; without this
    // bump a cursor from before the swap would resume against a different
    // physical table, skip rows, and still report "the snapshot is exhausted".
    expect(switched.archiveGeneration).toBeGreaterThan(0);
    const generation = await testDb.pool.query<{ generation: string; reason: string | null }>(
      "select generation::text as generation, reason from archive_generation where id = 1",
    );
    expect(generation.rows[0]).toMatchObject({
      generation: String(switched.archiveGeneration),
      reason: "message_archive rebuild swap",
    });

    // The shadow name is consumed; the retired table is KEPT in full.
    const relations = await testDb.pool.query<{ shadow: string | null; retired: string | null }>(
      `select to_regclass('public.message_archive_shadow')::text as shadow,
              to_regclass($1)::text as retired`,
      [`public.${switched.retiredTable}`],
    );
    expect(relations.rows[0]!.shadow).toBeNull();
    expect(relations.rows[0]!.retired).not.toBeNull();
    const retiredCount = await testDb.pool.query<{ n: string }>(
      `select count(*)::text as n from "${switched.retiredTable}"`,
    );
    expect(retiredCount.rows[0]!.n).toBe("4");

    // Canonical index names follow the live table.
    const indexes = await testDb.pool.query<{ indexname: string }>(
      "select indexname from pg_indexes where tablename = 'message_archive' order by indexname",
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "message_archive_account_conv_idx",
      "message_archive_account_occurred_idx",
      "message_archive_account_id_platform_message_ref_key",
      "message_archive_ofapi_native_order_idx",
      "message_archive_pkey",
      "message_archive_text_search_idx",
    ].sort());

    // Zero loss through the switch: the pruned-original legacy row is live,
    // provenance intact; the tombstone survived; the dirty row healed.
    const lifted = await testDb.pool.query<{ backfill_source: string; tip_amount_mills: string }>(
      `select backfill_source, tip_amount_mills::text as tip_amount_mills
       from message_archive where message_ref = 'fm-1' and source_event_id is null`,
    );
    expect(lifted.rows[0]).toMatchObject({ backfill_source: "hot_table", tip_amount_mills: "20000" });
    const healed = await testDb.pool.query<{ text_plain: string }>(
      "select text_plain from message_archive where message_ref = 'm-2'",
    );
    expect(healed.rows[0]!.text_plain).toBe(normalizeDmMessageText(RAW_HTML));
    const tombstone = await testDb.pool.query(
      "select 1 from message_archive where message_ref = 'm-1' and deleted_at is not null",
    );
    expect(tombstone.rows).toHaveLength(1);

    // Reads unchanged: the same repo reader answers over the new table.
    const conversation = await listArchiveConversationMessages(testDb.db, {
      conversationRef: "777",
    });
    expect(conversation.map((row) => row.messageRef).sort()).toEqual(["m-1", "m-2"]);

    // Watermarks force-reset to the shadow's replay high-seq — the sweep
    // resumes into the NEW table without replaying or skipping anything.
    const watermarks = await testDb.pool.query<{ projection: string; account_id: string; high_seq: string }>(
      `select projection, account_id::text as account_id, high_seq::text as high_seq
       from projection_seq_watermarks where projection like 'message_archive%' order by account_id`,
    );
    expect(watermarks.rows).toEqual([
      { projection: "message_archive", account_id: String(ofPage.id), high_seq: "3" },
      { projection: "message_archive", account_id: String(fanslyPage.id), high_seq: "0" },
    ]);

    await appendDomainEvents(testDb.db, ofPage.id, [
      messageEvent({ ref: "m-4", fan: "777", text: "post-switch" }),
    ]);
    const swept = await runMessageArchiveProjection(appStub());
    expect(swept.inserted).toBe(1);
    const postSwitch = await testDb.pool.query(
      "select 1 from message_archive where message_ref = 'm-4'",
    );
    expect(postSwitch.rows).toHaveLength(1);

    await recreateShadowTable();
  });

  it("hard-refuses the replay while a detached partition holds the account's events", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { ofPage } = await seedPages();
    await appendDomainEvents(testDb.db, ofPage.id, [
      messageEvent({ ref: "d-1", fan: "9" }),
      messageEvent({ ref: "d-2", fan: "9" }),
    ]);

    // Simulate Stage 28 tiering: detach the June 2026 partition (where the
    // seeded events live) into tiered_pending_drop.
    await testDb.pool.query("alter table domain_events detach partition domain_events_2026_06");
    await testDb.pool.query("create schema if not exists tiered_pending_drop");
    await testDb.pool.query("alter table domain_events_2026_06 set schema tiered_pending_drop");
    try {
      const preflight = await runArchiveRebuildPreflight(appStub(), { accountId: ofPage.id });
      expect(preflight.partitions.detached).toContainEqual({
        schema: "tiered_pending_drop",
        name: "domain_events_2026_06",
        totalRows: 2,
      });
      expect(preflight.accounts[0]!.detachedPartitionsHoldingEvents).toEqual([
        { schema: "tiered_pending_drop", name: "domain_events_2026_06", rows: 2 },
      ]);

      await expect(
        buildMessageArchiveShadow(appStub(), { accountId: ofPage.id }),
      ).rejects.toThrow(/HARD-REFUSED.*tiered_pending_drop\.domain_events_2026_06/s);
      const shadowRows = await testDb.pool.query(
        "select 1 from message_archive_shadow",
      );
      expect(shadowRows.rows).toHaveLength(0);
    } finally {
      // Re-attach (the Stage 28.3 restore path's end state) so the suite's
      // remaining tests keep a landing partition for June 2026.
      await testDb.pool.query(
        "alter table tiered_pending_drop.domain_events_2026_06 set schema public",
      );
      await testDb.pool.query(
        `alter table domain_events attach partition domain_events_2026_06
         for values from ('2026-06-01') to ('2026-07-01')`,
      );
    }

    // Gate lifts once the partition is attached again.
    const build = await buildMessageArchiveShadow(appStub(), { accountId: ofPage.id });
    expect(build.results[0]).toMatchObject({ inserted: 2, highSeq: 2 });
  });

  it("documents the backfill-discard: the old delete+replay rebuild destroys pruned legacy seeds", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { fanslyPage } = await seedPages();
    await seedFanslyHotMessage(fanslyPage.id);
    await runMessageArchiveBackfills(appStub());
    await testDb.pool.query(
      "delete from page_dm_messages where platform_message_id = 'fm-1'",
    );
    const before = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from message_archive where account_id = $1",
      [fanslyPage.id],
    );
    expect(before.rows[0]!.n).toBe("1");

    // The Stage 10 rebuild (no CLI dispatches here anymore — W10 replaced
    // it) silently discards the row: no event to replay, no origin to
    // re-backfill. THIS is why the shadow flow lifts instead of re-deriving.
    await rebuildMessageArchiveProjection(appStub(), { accountId: fanslyPage.id });
    const after = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from message_archive where account_id = $1",
      [fanslyPage.id],
    );
    expect(after.rows[0]!.n).toBe("0");
  });

  it("switch refuses while the shadow is missing rows — nothing renamed", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { ofPage } = await seedPages();
    await appendDomainEvents(testDb.db, ofPage.id, [
      messageEvent({ ref: "r-1", fan: "5" }),
    ]);
    await runMessageArchiveProjection(appStub());

    const verify = await verifyMessageArchiveShadow(appStub());
    expect(verify.ok).toBe(false);
    expect(verify.missing).toBe(1);
    expect(verify.missingSample).toEqual([{
      accountId: ofPage.id,
      platform: "onlyfans",
      messageRef: "r-1",
      backfillSource: null,
      sourceEventId: expect.any(Number),
    }]);

    await expect(switchMessageArchiveShadow(appStub())).rejects.toThrow(/REFUSED/);
    const relations = await testDb.pool.query<{ live: string | null; shadow: string | null }>(
      `select to_regclass('public.message_archive')::text as live,
              to_regclass('public.message_archive_shadow')::text as shadow`,
    );
    expect(relations.rows[0]!.live).not.toBeNull();
    expect(relations.rows[0]!.shadow).not.toBeNull();
  });
});
