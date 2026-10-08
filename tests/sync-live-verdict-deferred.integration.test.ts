import { readdirSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";
import {
  claimDmLiveMessagesForConfirm,
  confirmDmLiveMessages,
  confirmDmLiveMessagesInTransaction,
  createFanslyPage,
  createModel,
  dmLiveAwaitingConfirmSql,
  readDmLiveUnion,
  readSyncLivePathFacts,
  readSyncOverlayMetrics,
  type Database,
} from "@agency_hub_core/db";

import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// A socket message no longer vanishes after a day (arena "vanished chat",
// plan §3, R1): the parity window defers a row without a REST copy
// (`confirm_wait_reason`) instead of closing it `not_found`; only a REST read
// settles it later. Here: the migration's backfill on rows the previous image
// left, the previous image's statements on the migrated table (its rollback
// target), and this build's readers of a deferred row.

const MIGRATIONS_DIR = path.resolve("packages/db/migrations");
const MIGRATIONS = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort();
const MIGRATION = MIGRATIONS.find((file) => file.endsWith("_dm_live_confirm_wait_reason.sql"))!;

const FAN = "700000000000000001";
const GROUP = "800000000000000001";

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

function dbOf(target: StartedTestDatabase): Database {
  return target.db as unknown as Database;
}

async function query<T extends Record<string, unknown>>(target: StartedTestDatabase, text: string, values: unknown[] = []): Promise<T[]> {
  return (await target.pool.query<T>(text, values)).rows;
}

/** An overlay row written `hoursAgo` hours ago, as the apply writes a create. */
async function liveRow(target: StartedTestDatabase, pageId: number, id: string, input: {
  group?: string; hoursAgo: number; deleted?: boolean;
}) {
  await target.pool.query(
    `insert into dm_live_messages (page_id, platform_message_id, platform_conversation_id, sender_platform_user_id,
                                   is_sent_by_page, created_at, content, decoder_version, first_visible_at, confirm_due_at,
                                   deleted_at)
     values ($1, $2, $3, $4, false, clock_timestamp() - make_interval(secs => $5 * 3600 + 1), 'socket ' || $2, 1,
             clock_timestamp() - make_interval(secs => $5 * 3600), clock_timestamp() - make_interval(secs => $5 * 3600 - 30),
             case when $6 then clock_timestamp() end)`,
    [pageId, id, input.group ?? GROUP, FAN, input.hoursAgo, input.deleted === true],
  );
}

/** A verdict as the previous image wrote it: `confirmed_at` = first visibility + `afterHours`. */
async function verdict(target: StartedTestDatabase, pageId: number, id: string, outcome: string, afterHours: number, source: string | null = null) {
  await target.pool.query(
    `update dm_live_messages set confirmed_at = first_visible_at + make_interval(secs => $3 * 3600 + 60),
                                 confirm_outcome = $4, confirm_source = $5
      where page_id = $1 and platform_message_id = $2`,
    [pageId, id, afterHours, outcome, source],
  );
}

/** One `messages.page` read of `group`, sent `hoursAgo` hours ago, in the given apply state. */
async function read(target: StartedTestDatabase, pageId: number, group: string, hoursAgo: number, applyState = "applied") {
  await target.pool.query(
    `insert into sync_attempts (page_id, resource, subject, class, owner_generation, setting_ms, jitter_u, pause_ms,
                                admitted_at, sent_at, completed_at, operation, request, outcome, http_status, apply_state,
                                applied_at)
     values ($1, 'dm-messages.head', $2, 'urgent', 1, 2000, 0, 2000,
             clock_timestamp() - make_interval(secs => $3 * 3600 + 1), clock_timestamp() - make_interval(secs => $3 * 3600),
             clock_timestamp() - make_interval(secs => $3 * 3600 - 1), 'messages.page', '{}'::jsonb, 'response',
             case when $4 = 'applied' then 200 else 500 end, $4,
             case when $4 = 'applied' then clock_timestamp() - make_interval(secs => $3 * 3600 - 2) end)`,
    [pageId, group, hoursAgo, applyState],
  );
}

describe("the migration", () => {
  it("defers the timer's not_found verdicts that no applied read of the chat preceded, and nothing else", async (context) => {
    if (!testDb) return context.skip();
    const partial = await startIntegrationTestDatabase({ through: MIGRATIONS[MIGRATIONS.indexOf(MIGRATION) - 1]! });
    if (!partial) return context.skip();
    try {
      await partial.pool.query("insert into models (slug, name) values ('seed-model', 'Seed')");
      const [seeded] = await query<{ id: string }>(partial,
        "insert into pages (model_id, platform, label) select id, 'fansly', 'seed-fansly' from models where slug = 'seed-model' returning id::text");
      const pageId = Number(seeded!.id);
      // Each row in a chat of its own (a read covers its chat's rows only).
      // Every row became visible 30 h ago; a timer verdict came 24 h later.
      const chat = (n: number) => `80000000000000010${n}`;
      const rows: Array<[string, Parameters<typeof liveRow>[3], () => Promise<void>]> = [
        // The chat answered every read with an error: no applied read.
        ["910000000000000001", { hoursAgo: 30, group: chat(1) }, () => read(partial, pageId, chat(1), 20, "none")],
        // No read at all; deleted on the socket since.
        ["910000000000000002", { hoursAgo: 30, group: chat(2), deleted: true }, async () => {}],
        // An applied read of another chat only.
        ["910000000000000003", { hoursAgo: 30, group: chat(3) }, () => read(partial, pageId, chat(9), 20)],
        // An applied read of the chat, but sent before the message was visible.
        ["910000000000000004", { hoursAgo: 30, group: chat(4) }, () => read(partial, pageId, chat(4), 31)],
        // An applied read of the chat in between: REST did cover it. Stays not_found.
        ["910000000000000005", { hoursAgo: 30, group: chat(5) }, () => read(partial, pageId, chat(5), 10)],
      ];
      for (const [message, input, journal] of rows) {
        await liveRow(partial, pageId, message, input);
        await verdict(partial, pageId, message, "not_found", 24);
        await journal();
      }
      const covered = "910000000000000005";
      // The DM apply's own not_found (a minute after visibility, from a read): stays.
      await liveRow(partial, pageId, "910000000000000006", { hoursAgo: 30, group: chat(6) });
      await verdict(partial, pageId, "910000000000000006", "not_found", 0);
      // Other verdicts and a row still awaited: untouched.
      await liveRow(partial, pageId, "910000000000000007", { hoursAgo: 30, group: chat(6) });
      await verdict(partial, pageId, "910000000000000007", "match", 0, "message_archive");
      await liveRow(partial, pageId, "910000000000000008", { hoursAgo: 30, group: chat(6) });
      await verdict(partial, pageId, "910000000000000008", "excluded", 24);
      await liveRow(partial, pageId, "910000000000000009", { hoursAgo: 1, group: chat(6) });
      const before = await query(partial, "select platform_message_id, to_jsonb(m) as row from dm_live_messages m order by 1");

      const { runMigrations } = await import("../packages/db/src/migrate-runner.ts");
      const client = await partial.pool.connect();
      try {
        await runMigrations({ db: client, migrationsDir: MIGRATIONS_DIR, through: MIGRATION });
        // The bound on the lock wait is the migration's own: gone with its transaction.
        expect((await client.query("show lock_timeout")).rows).toEqual([{ lock_timeout: "0" }]);
      } finally {
        client.release();
      }

      const after = await query<{ id: string; outcome: string | null; confirmed: boolean; due: boolean; reason: string | null }>(partial,
        `select platform_message_id as id, confirm_outcome as outcome, confirmed_at is not null as confirmed,
                confirm_due_at is not null as due, confirm_wait_reason as reason
           from dm_live_messages order by 1`);
      const deferred = { outcome: null, confirmed: false, due: false, reason: "age_without_rest" };
      expect(after).toEqual([
        { id: "910000000000000001", ...deferred },
        { id: "910000000000000002", ...deferred },
        { id: "910000000000000003", ...deferred },
        { id: "910000000000000004", ...deferred },
        { id: covered, outcome: "not_found", confirmed: true, due: true, reason: null },
        { id: "910000000000000006", outcome: "not_found", confirmed: true, due: true, reason: null },
        { id: "910000000000000007", outcome: "match", confirmed: true, due: true, reason: null },
        { id: "910000000000000008", outcome: "excluded", confirmed: true, due: true, reason: null },
        { id: "910000000000000009", outcome: null, confirmed: false, due: true, reason: null },
      ]);
      // The rows it leaves are unchanged to the byte (but the new column).
      const untouched = await query(partial,
        "select platform_message_id, to_jsonb(m) - 'confirm_wait_reason' as row from dm_live_messages m where confirm_wait_reason is null order by 1");
      expect(untouched).toEqual(before.filter((row) => !["910000000000000001", "910000000000000002", "910000000000000003",
        "910000000000000004"].includes(String(row.platform_message_id))));
      // The CHECK holds the vocabulary.
      await expect(partial.pool.query("update dm_live_messages set confirm_wait_reason = 'timeout' where platform_message_id = '910000000000000009'"))
        .rejects.toMatchObject({ code: "23514" });
    } finally {
      await partial.stop();
    }
  });
});

describe("the previous image on the migrated table (the rollback target)", () => {
  async function page(target: StartedTestDatabase) {
    const db = dbOf(target);
    const model = await createModel(db, { slug: "deferred-model", name: "Deferred" });
    const created = await createFanslyPage(db, { modelId: model!.id, label: "deferred-page" });
    const pageId = created!.id;
    await target.pool.query(
      `insert into fans (platform, platform_user_id) values ('fansly', $1) on conflict do nothing`, [FAN],
    );
    await target.pool.query(
      `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id)
       select $1, f.id, $2, $3 from fans f where f.platform = 'fansly' and f.platform_user_id = $3`,
      [pageId, GROUP, FAN],
    );
    return pageId;
  }

  async function deferredRow(target: StartedTestDatabase, pageId: number, id: string) {
    await liveRow(target, pageId, id, { hoursAgo: 25 });
    await target.pool.query(
      `update dm_live_messages set confirm_due_at = null, confirm_wait_reason = 'age_without_rest'
        where page_id = $1 and platform_message_id = $2`,
      [pageId, id],
    );
  }

  it("never looks at a deferred row, does not count it, shows it; its apply confirms one without naming the column", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await page(testDb);
    const id = "920000000000000001";
    await deferredRow(testDb, pageId, id);

    // Its parity pass: the statement this build keeps (`confirm_due_at <= now()`).
    expect(await confirmDmLiveMessages(dbOf(testDb), { limit: 10 })).toMatchObject({ checked: 0 });
    // Its alert 3, as that image has it.
    const [previousAlert] = await query<{ n: number }>(testDb, `
      select count(*)::int as n
        from dm_live_messages m
        left join page_dm_threads t
          on t.platform_account_id = m.page_id and t.platform_conversation_id = m.platform_conversation_id
       where m.page_id = $1
         and m.confirmed_at is null
         and m.confirm_due_at is not null
         and m.deleted_at is null
         and m.is_sent_by_page is false
         and m.first_visible_at < statement_timestamp() - 900000::double precision * interval '1 millisecond'
         and coalesce(t.is_visible, true)
         and coalesce(t.metadata ->> 'messageSyncExcludedReason'::text, '') = ''`, [pageId]);
    expect(previousAlert).toEqual({ n: 0 });
    // Its readers (unchanged here): the overlay arm hides `not_found` only.
    const shown = await readDmLiveUnion(dbOf(testDb), {
      pageId, platformConversationId: GROUP, store: "message_archive", limit: 10,
      readStore: async () => [] as Array<{ id: string }>, storeKey: (row) => ({ messageId: row.id, at: null }),
    });
    expect(shown.map((item) => item.source === "live" ? item.message.platformMessageId : null)).toEqual([id]);

    // Its DM apply confirms the row by `confirmed_at is null`, as that image
    // writes it: no CHECK refuses it, and the stale reason means nothing.
    await testDb.pool.query(`
      update dm_live_messages m set
        confirmed_at = clock_timestamp(),
        confirm_source = v.source,
        confirm_outcome = v.outcome,
        mismatch_fields = case when v.fields = '' then null else string_to_array(v.fields, ',') end,
        updated_at = clock_timestamp()
      from jsonb_to_recordset($2::jsonb)
        as v(message_id text, outcome text, source text, fields text)
      where m.page_id = $1 and m.platform_message_id = v.message_id and m.confirmed_at is null`,
    [pageId, JSON.stringify([{ message_id: id, outcome: "match", source: "message_archive", fields: "" }])]);
    expect(await query(testDb, "select confirm_outcome, confirm_wait_reason from dm_live_messages where platform_message_id = $1", [id]))
      .toEqual([{ confirm_outcome: "match", confirm_wait_reason: "age_without_rest" }]);
    expect((await readSyncLivePathFacts(dbOf(testDb), { pageId, decodeWindowMs: 600_000, unconfirmedAfterMs: 900_000 })).unconfirmed.count).toBe(0);
  });
});

describe("this build's readers of a deferred row", () => {
  it("alert 3 and its predicate leave it out, the readers show it, a REST read settles it and clears the reason", async (context) => {
    if (!testDb) return context.skip();
    const db = dbOf(testDb);
    const model = await createModel(db, { slug: "reader-model", name: "Reader" });
    const pageId = (await createFanslyPage(db, { modelId: model!.id, label: "reader-page" }))!.id;
    await testDb.pool.query("insert into fans (platform, platform_user_id) values ('fansly', $1) on conflict do nothing", [FAN]);
    await testDb.pool.query(
      `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id)
       select $1, f.id, $2, $3 from fans f where f.platform = 'fansly' and f.platform_user_id = $3`,
      [pageId, GROUP, FAN],
    );
    const returned = "930000000000000001";
    const covered = "930000000000000002";
    const awaited = "930000000000000003";
    await liveRow(testDb, pageId, returned, { hoursAgo: 26 });
    await liveRow(testDb, pageId, covered, { hoursAgo: 25 });
    await liveRow(testDb, pageId, awaited, { hoursAgo: 1 });
    // The pass defers both old rows; the young one keeps its next look.
    await testDb.pool.query("update dm_live_messages set confirm_due_at = clock_timestamp() - interval '1 second'");
    expect(await confirmDmLiveMessages(db, { limit: 10 })).toEqual({
      checked: 3, match: 0, mismatch: 0, excluded: 0, deferred: 2, rescheduled: 1,
    });

    // Alert 3 counts only the awaited one; the shared predicate says the same.
    const facts = await readSyncLivePathFacts(db, { pageId, decodeWindowMs: 600_000, unconfirmedAfterMs: 900_000 });
    expect(facts.unconfirmed.count).toBe(1);
    const awaiting = await db.execute<{ id: string }>(sql`
      select m.platform_message_id as id from dm_live_messages m where ${dmLiveAwaitingConfirmSql(sql`m`)} order by 1`);
    expect(awaiting.rows.map((row) => row.id)).toEqual([awaited]);
    // The readers show all three.
    const union = async () => (await readDmLiveUnion(db, {
      pageId, platformConversationId: GROUP, store: "message_archive", limit: 10,
      readStore: async () => [] as Array<{ id: string }>, storeKey: (row) => ({ messageId: row.id, at: null }),
    })).map((item) => item.source === "live" ? item.message.platformMessageId : null);
    expect(await union()).toEqual([awaited, covered, returned]);

    // A REST read returns one deferred message and covers the other's place.
    await testDb.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, fan_native_id, is_sent_by_me,
                                    occurred_at, text_plain)
       select page_id, 'fansly', platform_conversation_id, platform_message_id, $2, false, created_at, content
         from dm_live_messages where page_id = $1 and platform_message_id = $3`,
      [pageId, FAN, returned],
    );
    const counts = await db.transaction(async (tx) => {
      const claim = await claimDmLiveMessagesForConfirm(tx as unknown as Database, {
        pageId, messageIds: [returned], notFoundMessageIds: [covered],
      });
      expect([...claim.messageIds]).toEqual([returned, covered]);
      return confirmDmLiveMessagesInTransaction(tx as unknown as Database, claim);
    });
    expect(counts).toMatchObject({ checked: 2, match: 1, notFound: 1 });
    expect(await query(testDb, `select platform_message_id as id, confirm_outcome, confirm_source, confirm_wait_reason,
      confirmed_at is not null as confirmed from dm_live_messages order by 1`)).toEqual([
      { id: returned, confirm_outcome: "match", confirm_source: "message_archive", confirm_wait_reason: null, confirmed: true },
      { id: covered, confirm_outcome: "not_found", confirm_source: null, confirm_wait_reason: null, confirmed: true },
      { id: awaited, confirm_outcome: null, confirm_source: null, confirm_wait_reason: null, confirmed: false },
    ]);
    // `not_found` is the read's verdict, so the overlay arm hides that one
    // now; the returned one is the store's (its REST copy wins the dedup).
    expect(await union()).toEqual([awaited]);
    // `dm_live_not_found`: the DM apply's verdicts of the window.
    expect((await readSyncOverlayMetrics(db, { since: new Date(Date.now() - 3_600_000) })).notFound).toBe(1);
  });
});
