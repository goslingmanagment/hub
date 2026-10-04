import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AI_KNOWN_MESSAGE_LOOKUP_MAX_REFS,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  explainAiLiveTextMessagesQuery,
  lookupAiLiveTextMessages,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

// chat-extension H-4c: the store lookup behind the fresh-text merge. For each
// message id a client sent with its text it answers four things: is the id
// another chat's (the request is refused), was the message deleted (the item
// is left out), who sent it (a swapped sender is refused), and when (a message
// the hub can place keeps the hub's time).

const FAN = "555001";
const OTHER_FAN = "555002";
const UNSEEN = { foreign: false, deleted: false, isSentByMe: null, occurredAt: null };
/** When the seeded messages were sent, by each store: told apart on purpose. */
const ARCHIVE_AT = new Date("2026-10-04T10:00:00.000Z");
const DM_AT = new Date("2026-10-04T10:00:05.000Z");

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) {
    // Physical: the plan check below runs after ANALYZE.
    await resetIntegrationDatabase(testDb.pool, { physical: true });
  }
});

async function seedPage(label: string, input: { account?: string | null; ofapi?: string } = {}) {
  const model = await createModel(testDb!.db, { slug: label, name: label });
  const page = await createOnlyFansPage(testDb!.db, { modelId: model!.id, label });
  await setPageOfapiAccountId(testDb!.db, { pageId: page!.id, ofapiAccountId: input.ofapi ?? `acct_${label.replace(/\W/g, "")}` });
  await testDb!.pool.query("update pages set external_page_id = $1 where id = $2", [input.account ?? null, page!.id]);
  return page!;
}

async function archiveRow(pageId: number, ref: string, input: {
  conv?: string | null; mine?: boolean; deleted?: boolean; pending?: boolean; platform?: string; at?: Date | null;
} = {}) {
  await testDb!.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role,
       is_sent_by_me, occurred_at, text_plain, deleted_at, content_pending, backfill_source)
     values ($1, $2, $3, $4, 'fan', $5, $6, 'archive', $7, $8, 'seed')`,
    [pageId, input.platform ?? "onlyfans", input.conv === undefined ? FAN : input.conv, ref, input.mine ?? false,
      input.at === undefined ? ARCHIVE_AT : input.at, input.deleted ? new Date() : null, input.pending ?? false],
  );
}

async function dmRow(pageId: number, ofapiAccountId: string, ref: string, input: {
  conv?: string | null; mine?: boolean; deleted?: boolean;
} = {}) {
  const conv = input.conv === undefined ? FAN : input.conv;
  await testDb!.pool.query(
    `insert into dm_message_archive (platform, platform_account_id, ofapi_account_id, platform_conversation_id,
       platform_message_id, sender_role, is_sent_by_me, message_created_at, text_plain, is_tip, tip_amount_mills,
       deleted_at, source, source_event_type, source_idempotency_key, source_journal_id, source_received_at, retain_until)
     values ('onlyfans', $1, $2, $3, $4, 'fan', $5, $6, 'dm', false, 0, $7, 'webhook', $8, $9, 1, now(),
       now() + interval '100 years')`,
    [pageId, ofapiAccountId, conv, ref, input.mine ?? false,
      // A delete webhook names no chat: its stub has neither a chat nor a time.
      conv === null ? null : DM_AT, input.deleted ? new Date() : null,
      input.deleted ? "messages.deleted" : "messages.received", `live-${pageId}-${ref}`],
  );
}

async function hotRow(pageId: number, ref: string, input: { conv?: string; deleted?: boolean } = {}) {
  const thread = await testDb!.pool.query<{ id: number }>(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id) values ($1, $2)
     on conflict (platform_account_id, platform_conversation_id) do update set last_seen_at = now()
     returning id`,
    [pageId, input.conv ?? FAN],
  );
  await testDb!.pool.query(
    `insert into page_dm_messages (conversation_id, platform_account_id, platform_message_id, sender_role,
       created_at, content, deleted_at)
     values ($1, $2, $3, 'fan', now(), '', $4)`,
    [thread.rows[0]!.id, pageId, ref, input.deleted ? new Date() : null],
  );
}

function lookup(pageId: number, messageRefs: string[], input: {
  conv?: string; others?: readonly number[] | null;
} = {}) {
  return lookupAiLiveTextMessages(testDb!.db, {
    pageId,
    platform: "onlyfans",
    conversationRef: input.conv ?? FAN,
    messageRefs,
    otherPageIds: input.others === undefined ? [] : input.others,
  });
}

describe("fresh-text store lookup", () => {
  it("names the sender and the time where a store holds the message's content for this conversation", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("live-of", { ofapi: "acct_live" });
    await archiveRow(page.id, "101");
    await archiveRow(page.id, "102", { mine: true });
    await dmRow(page.id, "acct_live", "103");
    await dmRow(page.id, "acct_live", "104", { mine: true });
    // Both stores, the same sender: the archive's time, the one every reader orders by.
    await archiveRow(page.id, "105", { mine: true });
    await dmRow(page.id, "acct_live", "105", { mine: true });
    // The stores disagree on the sender: nobody is named. The message is still placed.
    await archiveRow(page.id, "106");
    await dmRow(page.id, "acct_live", "106", { mine: true });
    // A stub holds no content, so it names neither a sender nor a time:
    // tombstone-first in the archive, and the hot table's row.
    await archiveRow(page.id, "107", { mine: true, pending: true });
    await hotRow(page.id, "108");
    // An archive row without a time cannot place the message: the webhook
    // store's time where it has one, none where it has not.
    await archiveRow(page.id, "109", { at: null });
    await dmRow(page.id, "acct_live", "109");
    await archiveRow(page.id, "110", { at: null });

    const refs = ["101", "102", "103", "104", "105", "106", "107", "108", "109", "110", "999"];
    expect(Object.fromEntries(await lookup(page.id, refs))).toEqual({
      "101": { ...UNSEEN, isSentByMe: false, occurredAt: ARCHIVE_AT },
      "102": { ...UNSEEN, isSentByMe: true, occurredAt: ARCHIVE_AT },
      "103": { ...UNSEEN, isSentByMe: false, occurredAt: DM_AT },
      "104": { ...UNSEEN, isSentByMe: true, occurredAt: DM_AT },
      "105": { ...UNSEEN, isSentByMe: true, occurredAt: ARCHIVE_AT },
      "106": { ...UNSEEN, occurredAt: ARCHIVE_AT },
      "107": UNSEEN,
      "108": UNSEEN,
      "109": { ...UNSEEN, isSentByMe: false, occurredAt: DM_AT },
      "110": { ...UNSEEN, isSentByMe: false },
      "999": UNSEEN,
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reads a tombstone from any store of the page, a chat-less delete stub included", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("live-of", { ofapi: "acct_live" });
    const other = await seedPage("live-of-2", { ofapi: "acct_live2" });
    await archiveRow(page.id, "201", { deleted: true });
    await dmRow(page.id, "acct_live", "202", { deleted: true });
    await hotRow(page.id, "203", { deleted: true });
    // Live in the archive, tombstoned by a delete webhook that named no chat.
    await archiveRow(page.id, "204");
    await dmRow(page.id, "acct_live", "204", { conv: null, deleted: true });
    // The delete stub alone: the hub never held the message, and still knows it is gone.
    await dmRow(page.id, "acct_live", "205", { conv: null, deleted: true });
    // Another page's tombstones are not this page's.
    await archiveRow(other.id, "206", { deleted: true });
    await dmRow(other.id, "acct_live2", "207", { conv: null, deleted: true });
    await hotRow(other.id, "208", { deleted: true });

    const states = await lookup(page.id, ["201", "202", "203", "204", "205", "206", "207", "208"]);
    expect(Object.fromEntries([...states].map(([ref, state]) => [ref, state.deleted]))).toEqual({
      "201": true, "202": true, "203": true, "204": true, "205": true, "206": false, "207": false, "208": false,
    });
    expect([...states.values()].every((state) => !state.foreign)).toBe(true);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("calls an id foreign when the page holds it under another conversation", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("live-of", { ofapi: "acct_live" });
    await archiveRow(page.id, "301", { conv: OTHER_FAN });
    await dmRow(page.id, "acct_live", "302", { conv: OTHER_FAN });
    await archiveRow(page.id, "303", { conv: OTHER_FAN, deleted: true });
    // No chat named: a delete stub, and an archive row without a conversation.
    await dmRow(page.id, "acct_live", "304", { conv: null, deleted: true });
    await archiveRow(page.id, "305", { conv: null });
    // The hot table is read through this conversation's thread only.
    await hotRow(page.id, "306", { conv: OTHER_FAN });

    // Another chat's message is named foreign and nothing more: neither its sender nor its time.
    expect(Object.fromEntries(await lookup(page.id, ["301", "302", "303", "304", "305", "306"]))).toEqual({
      "301": { ...UNSEEN, foreign: true },
      "302": { ...UNSEEN, foreign: true },
      "303": { ...UNSEEN, foreign: true, deleted: true },
      "304": { ...UNSEEN, deleted: true },
      "305": UNSEEN,
      "306": UNSEEN,
    });
    // Asked for the chat they belong to, the same ids are this chat's own.
    expect(Object.fromEntries(await lookup(page.id, ["301", "302"], { conv: OTHER_FAN }))).toEqual({
      "301": { ...UNSEEN, isSentByMe: false, occurredAt: ARCHIVE_AT },
      "302": { ...UNSEEN, isSentByMe: false, occurredAt: DM_AT },
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reads another page's archives only for the pages it is given", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("live-of", { account: "100000001", ofapi: "acct_live" });
    const sibling = await seedPage("live-vip-of", { account: "100000002", ofapi: "acct_vip" });
    const stranger = await seedPage("mia-of", { account: "100000003", ofapi: "acct_mia" });
    // The same fan writes to both of the model's pages: two chats, two sets of ids.
    await archiveRow(sibling.id, "401");
    await archiveRow(stranger.id, "402");
    // Messages only the webhook store holds so far: a snapshot of the other
    // page's chat taken seconds after the fan wrote there is made of these.
    await dmRow(sibling.id, "acct_vip", "403");
    await dmRow(stranger.id, "acct_mia", "404");
    // A delete webhook of another page names no chat, so it places the id in none.
    await dmRow(sibling.id, "acct_vip", "405", { conv: null, deleted: true });

    const refs = ["401", "402", "403", "404", "405"];
    const states = async (others: readonly number[] | null) => [...await lookup(page.id, refs, { others })];
    const foreign = async (others: readonly number[] | null) => (
      Object.fromEntries((await states(others)).map(([ref, state]) => [ref, state.foreign]))
    );
    const none = { "401": false, "402": false, "403": false, "404": false, "405": false };
    // No other page: nothing is read. An empty list is "none", never "all".
    expect(await foreign([])).toEqual(none);
    // The request's own page in the list changes nothing.
    expect(await foreign([page.id])).toEqual(none);
    expect(await foreign([page.id, sibling.id])).toEqual({ ...none, "401": true, "403": true });
    expect(await foreign([stranger.id])).toEqual({ ...none, "402": true, "404": true });
    // Every page (the owner).
    expect(await foreign(null)).toEqual({ ...none, "401": true, "402": true, "403": true, "404": true });
    // Another page's row says where the id belongs and nothing else: its
    // tombstone, its sender and its time are that page's.
    for (const [, state] of await states(null)) {
      expect(state).toMatchObject({ deleted: false, isSentByMe: null, occurredAt: null });
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("knows the same chat from its other side, and decides nothing where an account is unknown", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("live-of", { account: "100000001", ofapi: "acct_live" });
    const sibling = await seedPage("live-vip-of", { account: "100000002", ofapi: "acct_vip" });
    const third = await seedPage("mia-of", { account: "100000003", ofapi: "acct_mia" });
    const unknown = await seedPage("no-account-of", { account: null, ofapi: "acct_unknown" });
    // Two pages of this hub write to each other: the message is archived under
    // both, each with the other's account as the conversation. Each case below
    // is seeded in both stores of the other page: the archive (50x), and the
    // webhook store alone (51x), which holds a message first.
    await archiveRow(sibling.id, "501", { conv: "100000001", mine: true });
    await dmRow(sibling.id, "acct_vip", "511", { conv: "100000001", mine: true });
    // The sibling's chat with someone else is foreign to it, and so is a third
    // page's chat with the sibling.
    await archiveRow(sibling.id, "502", { conv: OTHER_FAN });
    await dmRow(sibling.id, "acct_vip", "512", { conv: OTHER_FAN });
    await archiveRow(third.id, "503", { conv: "100000002" });
    await dmRow(third.id, "acct_mia", "513", { conv: "100000002" });
    // A page whose account is unknown could be a second record of this very
    // account: its chat with the same fan decides nothing. Its chat with anyone
    // else cannot be this chat, whoever the page is.
    await archiveRow(unknown.id, "505", { conv: "100000002" });
    await dmRow(unknown.id, "acct_unknown", "515", { conv: "100000002" });
    await archiveRow(unknown.id, "506", { conv: OTHER_FAN });
    await dmRow(unknown.id, "acct_unknown", "516", { conv: OTHER_FAN });

    const foreign = async (refs: string[], conv: string) => Object.fromEntries(
      [...await lookup(page.id, refs, { conv, others: null })].map(([ref, state]) => [ref, state.foreign]),
    );
    expect(await foreign(["501", "502", "503", "505", "506", "511", "512", "513", "515", "516"], "100000002")).toEqual({
      "501": false, "502": true, "503": true, "505": false, "506": true,
      "511": false, "512": true, "513": true, "515": false, "516": true,
    });

    // With this page's own account unknown, a row of the fan's own page cannot
    // be told from the mirror, whatever conversation it names: it decides
    // nothing. A row of any other page with another conversation still can.
    await testDb.pool.query("update pages set external_page_id = null where id = $1", [page.id]);
    expect(await foreign(["501", "502", "503", "511", "512", "513"], "100000002")).toEqual({
      "501": false, "502": false, "503": false, "511": false, "512": false, "513": false,
    });
    expect(await foreign(["502", "503", "512", "513"], FAN)).toEqual({
      "502": true, "503": true, "512": true, "513": true,
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("never reads a page of another platform", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("live-of", { account: "100000001", ofapi: "acct_live" });
    const model = await createModel(testDb.db, { slug: "live-fs", name: "live-fs" });
    const fansly = (await createFanslyPage(testDb.db, { modelId: model!.id, label: "live-fs" }))!;
    // Ids are per platform: a Fansly message with the same number is not this one.
    await archiveRow(fansly.id, "601", { platform: "fansly", conv: OTHER_FAN });
    expect(Object.fromEntries(await lookup(page.id, ["601"], { others: null }))).toEqual({ "601": UNSEEN });
    // Asked for a Fansly page, the lookup reads no OnlyFans page: neither its
    // archive nor its webhook store.
    await archiveRow(page.id, "602", { conv: OTHER_FAN });
    await dmRow(page.id, "acct_live", "603", { conv: OTHER_FAN });
    const fromFansly = await lookupAiLiveTextMessages(testDb.db, {
      pageId: fansly.id, platform: "fansly", conversationRef: FAN, messageRefs: ["602", "603"], otherPageIds: null,
    });
    expect(Object.fromEntries(fromFansly)).toEqual({ "602": UNSEEN, "603": UNSEEN });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("answers every ref once, runs nothing for none and refuses an unbounded list", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("live-of");
    await archiveRow(page.id, "101");
    expect(await lookup(page.id, [])).toEqual(new Map());
    expect(Object.fromEntries(await lookup(page.id, ["101", "101", "999"]))).toEqual({
      "101": { ...UNSEEN, isSentByMe: false, occurredAt: ARCHIVE_AT },
      "999": UNSEEN,
    });
    const tooMany = Array.from({ length: AI_KNOWN_MESSAGE_LOOKUP_MAX_REFS + 1 }, (_, n) => String(n + 1));
    await expect(lookup(page.id, tooMany)).rejects.toThrow(/at most/);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("is point lookups on the stores' unique keys, on this page and on the others", async (context) => {
    if (!testDb) return context.skip();
    const pages = [
      await seedPage("live-of", { account: "100000001", ofapi: "acct_live" }),
      await seedPage("live-vip-of", { account: "100000002", ofapi: "acct_live2" }),
      await seedPage("mia-of", { account: "100000003", ofapi: "acct_live3" }),
    ];
    // One long conversation plus a spread that dominates the tables, on three
    // pages: without it the planner rightly prefers sequential scans and the
    // assertions below would test nothing.
    for (const [index, page] of pages.entries()) {
      const base = 1_000_000 * (index + 1);
      await testDb.pool.query(
        `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain, backfill_source)
         select $1, 'onlyfans', case when g <= 5000 then $2 else 'conv-' || (g % 40) end, ($3::int + g)::text, 'fan', false,
                now() - (g || ' seconds')::interval, 'spread ' || g, 'seed'
         from generate_series(1, 25000) g`,
        [page.id, FAN, base],
      );
      await testDb.pool.query(
        `insert into dm_message_archive (platform, platform_account_id, ofapi_account_id, platform_conversation_id, platform_message_id, sender_role, is_sent_by_me, message_created_at, text_plain, is_tip, tip_amount_mills, source, source_event_type, source_idempotency_key, source_journal_id, source_received_at, retain_until)
         select 'onlyfans', $1::bigint, $2, case when g <= 3000 then $3 else 'conv-' || (g % 40) end, ($4::int + 500000 + g)::text, 'fan', false,
                now() - (g || ' seconds')::interval, 'dm ' || g, false, 0, 'webhook', 'messages.received', 'live-spread-' || $1::bigint || '-' || g, 1, now(), now() + interval '100 years'
         from generate_series(1, 15000) g`,
        [page.id, index === 0 ? "acct_live" : `acct_live${index + 1}`, FAN, base],
      );
      await testDb.pool.query(
        `with threads as (
           insert into page_dm_threads (platform_account_id, platform_conversation_id)
           select $1::bigint, case when n = 0 then $2 else 'conv-' || n end from generate_series(0, 39) n
           returning id, platform_conversation_id
         )
         insert into page_dm_messages (conversation_id, platform_account_id, platform_message_id, sender_role, created_at, content)
         select t.id, $1::bigint, ($3::int + 800000 + row_number() over ())::text, 'fan', now(), ''
         from threads t cross join generate_series(1, 250) g`,
        [page.id, FAN, base],
      );
    }
    await testDb.pool.query("analyze message_archive, dm_message_archive, page_dm_messages, page_dm_threads, pages");

    // A full snapshot: sixty ids, some held here, some on the other pages (in
    // their archive, or so far only in their webhook store), most unseen.
    const messageRefs = [
      "1000001", "1000002", "1500001", "2000001", "3000001", "2500001", "3500001",
      ...Array.from({ length: 53 }, (_, n) => String(n + 1)),
    ];
    const input = {
      pageId: pages[0]!.id,
      platform: "onlyfans",
      conversationRef: FAN,
      messageRefs,
      otherPageIds: null,
    };
    const plan = await explainAiLiveTextMessagesQuery(testDb.db, input);
    // Each message store is probed by its unique key with the named ids in the
    // index condition, both archives of the other pages included (five probes:
    // this page's archive, webhook store and hot table, the others' archive
    // and webhook store); none is scanned by conversation, by account or whole.
    expect(plan).toContain("message_archive_account_id_platform_message_ref_key");
    expect(plan).toContain("dm_message_archive_platform_account_message_uniq");
    expect(plan).toContain("page_dm_messages_conversation_message_uniq");
    expect(plan.match(/Index Cond: .*= ANY \('\{1000001,/g)).toHaveLength(5);
    expect(plan.match(/dm_message_archive_platform_account_message_uniq/g)).toHaveLength(2);
    for (const table of ["message_archive", "dm_message_archive", "page_dm_messages"]) {
      expect(plan, table).not.toMatch(new RegExp(`Seq Scan on ${table}\\b`));
    }
    expect(plan).not.toContain("message_archive_account_conv_idx");
    expect(plan).not.toContain("dm_message_archive_page_conversation_idx");
    expect(plan).not.toContain("dm_message_archive_page_message_created_idx");

    const states = await lookupAiLiveTextMessages(testDb.db, input);
    expect(states.size).toBe(60);
    expect(Object.fromEntries(
      ["1000001", "1500001", "2000001", "3000001", "2500001", "3500001", "1"].map((ref) => [ref, states.get(ref)]),
    )).toEqual({
      "1000001": { ...UNSEEN, isSentByMe: false, occurredAt: expect.any(Date) },
      "1500001": { ...UNSEEN, isSentByMe: false, occurredAt: expect.any(Date) },
      // The same fan's chats on the two other pages, in either of their stores.
      "2000001": { ...UNSEEN, foreign: true },
      "3000001": { ...UNSEEN, foreign: true },
      "2500001": { ...UNSEEN, foreign: true },
      "3500001": { ...UNSEEN, foreign: true },
      "1": UNSEEN,
    });
    // A caller with no other page reads no other page: the statement does not name them.
    const own = await explainAiLiveTextMessagesQuery(testDb.db, { ...input, otherPageIds: [pages[0]!.id] });
    expect(own.match(/Index Cond: .*= ANY \('\{1000001,/g)).toHaveLength(3);
    expect(own.match(/dm_message_archive_platform_account_message_uniq/g)).toHaveLength(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
