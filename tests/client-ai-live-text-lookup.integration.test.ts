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
      platform: "onlyfans" as const,
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

// chat-extension R20 HF-8б: the same lookup for a Fansly page. A Fansly
// conversation ref is the group id, which names the chat itself; the page's
// socket overlay (dm_live_messages) is one more store of the page, read only
// where the caller says it served the transcript.
describe("[R20 HF-8б] fresh-text store lookup on a Fansly page", () => {
  /** Fansly ids are 18-digit snowflakes, past what a double holds exactly. */
  const GROUP = "300000000000000001";
  const OTHER_GROUP = "300000000000000009";
  const FANSLY_FAN = "400000000000000002";
  const CREATOR = "500000000000000003";
  const LIVE_AT = new Date("2026-10-04T10:00:09.000Z");
  const id = (n: number) => String(880_000_000_000_000_000n + BigInt(n));

  async function seedFanslyPage(label: string, account: string | null = CREATOR) {
    const model = await createModel(testDb!.db, { slug: label, name: label });
    const page = (await createFanslyPage(testDb!.db, { modelId: model!.id, label }))!;
    await testDb!.pool.query("update pages set external_page_id = $1 where id = $2", [account, page.id]);
    return page;
  }

  /** A socket overlay row. `stub`: a deletion frame that came before (or
   *  without) the create: no sender, no time, no text; `group: null` when the
   *  frame named none. `mine: null`: the socket did not know the page's own
   *  account, so it could not tell the sender. */
  async function liveRow(pageId: number, ref: string, input: {
    group?: string | null; mine?: boolean | null; deleted?: boolean; stub?: boolean; at?: Date;
  } = {}) {
    const group = input.group === undefined ? GROUP : input.group;
    const stub = input.stub ?? false;
    const mine = input.mine === undefined ? false : input.mine;
    await testDb!.pool.query(
      `insert into dm_live_messages (page_id, platform_message_id, platform_conversation_id, sender_platform_user_id,
         is_sent_by_page, created_at, content, decoder_version, first_visible_at, deleted_at)
       values ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9)`,
      [pageId, ref, group, stub ? null : mine ? CREATOR : FANSLY_FAN, stub ? null : mine,
        stub ? null : input.at ?? LIVE_AT, stub ? null : "live", stub ? null : new Date(),
        input.deleted ? new Date() : null],
    );
  }

  function fanslyLookup(pageId: number, messageRefs: string[], input: {
    group?: string; others?: readonly number[] | null; liveOverlay?: boolean;
  } = {}) {
    return lookupAiLiveTextMessages(testDb!.db, {
      pageId,
      platform: "fansly",
      conversationRef: input.group ?? GROUP,
      messageRefs,
      otherPageIds: input.others === undefined ? [] : input.others,
      liveOverlay: input.liveOverlay ?? true,
    });
  }

  it("reads the overlay only where it served the transcript", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedFanslyPage("live-fs");
    await liveRow(page.id, id(1));
    await liveRow(page.id, id(2), { deleted: true });
    await liveRow(page.id, id(3), { group: OTHER_GROUP });
    const refs = [id(1), id(2), id(3)];
    // The archive served (the page's readers do not read the overlay, or the
    // switch could not be read): the overlay judges nothing.
    expect(Object.fromEntries(await fanslyLookup(page.id, refs, { liveOverlay: false }))).toEqual({
      [id(1)]: UNSEEN, [id(2)]: UNSEEN, [id(3)]: UNSEEN,
    });
    expect(Object.fromEntries(await fanslyLookup(page.id, refs))).toEqual({
      [id(1)]: { ...UNSEEN, isSentByMe: false, occurredAt: LIVE_AT },
      [id(2)]: { ...UNSEEN, deleted: true, isSentByMe: false, occurredAt: LIVE_AT },
      [id(3)]: { ...UNSEEN, foreign: true },
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a deletion only the socket knows reads deleted, whatever group its mark names", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedFanslyPage("live-fs");
    const other = await seedFanslyPage("live-fs-2", "500000000000000004");
    // Sent and deleted while the archive never held it.
    await liveRow(page.id, id(11), { deleted: true });
    // A deletion frame before any create: a stub, with this group or with none.
    await liveRow(page.id, id(12), { stub: true, deleted: true });
    await liveRow(page.id, id(13), { stub: true, deleted: true, group: null });
    // Archived live; the socket saw it deleted since. The live union hides it on that mark.
    await archiveRow(page.id, id(14), { platform: "fansly", conv: GROUP });
    await liveRow(page.id, id(14), { stub: true, deleted: true });
    // A deletion mark of another page is that page's.
    await liveRow(other.id, id(15), { deleted: true });
    // A deleted message of another group: another chat's, and gone.
    await liveRow(page.id, id(16), { group: OTHER_GROUP, deleted: true });

    const states = await fanslyLookup(page.id, [id(11), id(12), id(13), id(14), id(15), id(16)]);
    expect(Object.fromEntries(states)).toEqual({
      [id(11)]: { ...UNSEEN, deleted: true, isSentByMe: false, occurredAt: LIVE_AT },
      [id(12)]: { ...UNSEEN, deleted: true },
      [id(13)]: { ...UNSEEN, deleted: true },
      [id(14)]: { ...UNSEEN, deleted: true, isSentByMe: false, occurredAt: ARCHIVE_AT },
      [id(15)]: UNSEEN,
      [id(16)]: { ...UNSEEN, foreign: true, deleted: true },
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("places a message of this group by its sender and time; a row of another group is another chat's", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedFanslyPage("live-fs");
    // The socket alone: the fan's, the page's, and one whose sender the socket could not tell.
    await liveRow(page.id, id(21));
    await liveRow(page.id, id(22), { mine: true });
    await liveRow(page.id, id(23), { mine: null });
    // Both the archive and the socket: the archive's time, the one every reader orders by.
    await archiveRow(page.id, id(24), { platform: "fansly", conv: GROUP });
    await liveRow(page.id, id(24));
    // They disagree on the sender: nobody is named; the archive still places it.
    await archiveRow(page.id, id(25), { platform: "fansly", conv: GROUP, mine: true });
    await liveRow(page.id, id(25));
    // A content-pending archive stub without a chat names nothing; the socket does.
    await archiveRow(page.id, id(26), { platform: "fansly", conv: null, pending: true, at: null });
    await liveRow(page.id, id(26), { mine: true });
    // Another group of the page: in either store, foreign and nothing more.
    await liveRow(page.id, id(27), { group: OTHER_GROUP });
    await archiveRow(page.id, id(28), { platform: "fansly", conv: OTHER_GROUP });
    // A deletion stub that names another group.
    await liveRow(page.id, id(29), { stub: true, deleted: true, group: OTHER_GROUP });

    const refs = [id(21), id(22), id(23), id(24), id(25), id(26), id(27), id(28), id(29)];
    expect(Object.fromEntries(await fanslyLookup(page.id, refs))).toEqual({
      [id(21)]: { ...UNSEEN, isSentByMe: false, occurredAt: LIVE_AT },
      [id(22)]: { ...UNSEEN, isSentByMe: true, occurredAt: LIVE_AT },
      [id(23)]: { ...UNSEEN, occurredAt: LIVE_AT },
      [id(24)]: { ...UNSEEN, isSentByMe: false, occurredAt: ARCHIVE_AT },
      [id(25)]: { ...UNSEEN, occurredAt: ARCHIVE_AT },
      [id(26)]: { ...UNSEEN, isSentByMe: true, occurredAt: LIVE_AT },
      [id(27)]: { ...UNSEEN, foreign: true },
      [id(28)]: { ...UNSEEN, foreign: true },
      [id(29)]: { ...UNSEEN, foreign: true, deleted: true },
    });
    // Asked for the group they belong to, the other group's ids are its own.
    expect(Object.fromEntries(await fanslyLookup(page.id, [id(27), id(28)], { group: OTHER_GROUP }))).toEqual({
      [id(27)]: { ...UNSEEN, isSentByMe: false, occurredAt: LIVE_AT },
      [id(28)]: { ...UNSEEN, isSentByMe: false, occurredAt: ARCHIVE_AT },
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("another page's row under this group is this chat seen from that page; under another group, another chat", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedFanslyPage("live-fs");
    const sibling = await seedFanslyPage("live-fs-2", "500000000000000004");
    const unknown = await seedFanslyPage("live-fs-3", null);
    // Two pages of this hub write to each other: one group, held by both pages.
    await archiveRow(sibling.id, id(31), { platform: "fansly", conv: GROUP, mine: true });
    // The sibling's other chats, and a page whose account is unknown: a group
    // id names the chat whoever the page is, so only the group decides.
    await archiveRow(sibling.id, id(32), { platform: "fansly", conv: OTHER_GROUP });
    await archiveRow(unknown.id, id(33), { platform: "fansly", conv: GROUP });
    await archiveRow(unknown.id, id(34), { platform: "fansly", conv: OTHER_GROUP });
    // Another page's socket is that page's: only its archive is read.
    await liveRow(sibling.id, id(35), { group: OTHER_GROUP });

    const refs = [id(31), id(32), id(33), id(34), id(35)];
    const foreign = async (others: readonly number[] | null) => Object.fromEntries(
      [...await fanslyLookup(page.id, refs, { others })].map(([ref, state]) => [ref, state.foreign]),
    );
    const none = { [id(31)]: false, [id(32)]: false, [id(33)]: false, [id(34)]: false, [id(35)]: false };
    expect(await foreign([])).toEqual(none);
    expect(await foreign([sibling.id])).toEqual({ ...none, [id(32)]: true });
    expect(await foreign(null)).toEqual({ ...none, [id(32)]: true, [id(34)]: true });
    // Another page's row places the id and nothing else: its sender and time are that page's.
    for (const [, state] of await fanslyLookup(page.id, refs, { others: null })) {
      expect(state).toMatchObject({ deleted: false, isSentByMe: null, occurredAt: null });
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("without the overlay the statement does not name it: every OnlyFans lookup, and a Fansly page off the overlay", async (context) => {
    if (!testDb) return context.skip();
    // Only a live_union transcript sets `liveOverlay`, and only a Fansly page
    // reads the overlay (platformHasLiveOverlay): an OnlyFans lookup never has it.
    const page = await seedPage("live-of", { ofapi: "acct_live" });
    const fansly = await seedFanslyPage("live-fs");
    for (const asked of [
      { pageId: page.id, platform: "onlyfans" as const, conversationRef: FAN, messageRefs: ["701"], otherPageIds: null },
      { pageId: fansly.id, platform: "fansly" as const, conversationRef: GROUP, messageRefs: [id(1)], otherPageIds: null },
    ]) {
      const plan = await explainAiLiveTextMessagesQuery(testDb.db, asked);
      expect(plan, asked.platform).not.toContain("dm_live_messages");
      expect(await explainAiLiveTextMessagesQuery(testDb.db, { ...asked, liveOverlay: false }), asked.platform).toBe(plan);
      expect(await explainAiLiveTextMessagesQuery(testDb.db, { ...asked, liveOverlay: true }), asked.platform)
        .toContain("dm_live_messages");
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("probes the overlay by its primary key", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedFanslyPage("live-fs");
    const other = await seedFanslyPage("live-fs-2", "500000000000000004");
    for (const [pageId, base] of [[page.id, 1_000_000], [other.id, 5_000_000]] as const) {
      await testDb.pool.query(
        `insert into dm_live_messages (page_id, platform_message_id, platform_conversation_id, sender_platform_user_id,
           is_sent_by_page, created_at, content, decoder_version, first_visible_at)
         select $1::bigint, ($3::int + g)::text, case when g <= 5000 then $2 else (700000 + g % 40)::text end, $4, false,
                now() - (g || ' seconds')::interval, 'live ' || g, 1, now()
         from generate_series(1, 25000) g`,
        [pageId, GROUP, base, FANSLY_FAN],
      );
      await testDb.pool.query(
        `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain, backfill_source)
         select $1, 'fansly', case when g <= 5000 then $2 else 'conv-' || (g % 40) end, ($3::int + 500000 + g)::text, 'fan', false,
                now() - (g || ' seconds')::interval, 'spread ' || g, 'seed'
         from generate_series(1, 25000) g`,
        [pageId, GROUP, base],
      );
    }
    await testDb.pool.query("analyze dm_live_messages, message_archive, pages");

    const input = {
      pageId: page.id,
      platform: "fansly" as const,
      conversationRef: GROUP,
      messageRefs: ["1000001", "1000002", "1500001", "5000001", "1", "2", "3"],
      otherPageIds: null,
      liveOverlay: true,
    };
    const plan = await explainAiLiveTextMessagesQuery(testDb.db, input);
    expect(plan).toContain("dm_live_messages_pkey");
    expect(plan).toMatch(/Index Cond: .*page_id = .*platform_message_id = ANY \('\{1000001,/);
    expect(plan).not.toMatch(/Seq Scan on dm_live_messages\b/);
    expect(plan).not.toContain("dm_live_messages_thread");
    expect(plan).not.toMatch(/Seq Scan on message_archive\b/);
    expect(Object.fromEntries(await lookupAiLiveTextMessages(testDb.db, input))).toMatchObject({
      "1000001": { foreign: false, deleted: false, isSentByMe: false },
      "1500001": { foreign: false, deleted: false, isSentByMe: false },
      // The other page's socket is not read.
      "5000001": UNSEEN,
      "1": UNSEEN,
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
