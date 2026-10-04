import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AI_KNOWN_MESSAGE_LOOKUP_MAX_REFS,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  explainAiKnownMessagesQuery,
  lookupAiKnownMessages,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

// chat-extension H-4b: the store lookup behind `context_v1.knownFanMessages`.
// The property under test is the scope: an id counts only for the conversation
// the caller named, so another fan's chat on the same page is never described.

const FAN = "555001";
const OTHER_FAN = "555002";
const OFAPI_ACCT = "acct_known";

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

async function seedOnlyFansPage(label = "known-of", ofapiAccountId = OFAPI_ACCT) {
  const model = await createModel(testDb!.db, { slug: label, name: label });
  const page = await createOnlyFansPage(testDb!.db, { modelId: model!.id, label });
  await setPageOfapiAccountId(testDb!.db, { pageId: page!.id, ofapiAccountId });
  return page!;
}

async function archiveRow(pageId: number, ref: string, input: {
  conv?: string | null; deleted?: boolean; platform?: string;
} = {}) {
  await testDb!.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role,
       is_sent_by_me, occurred_at, text_plain, deleted_at, backfill_source)
     values ($1, $2, $3, $4, 'fan', false, now(), 'archive', $5, 'seed')`,
    [pageId, input.platform ?? "onlyfans", input.conv === undefined ? FAN : input.conv, ref,
      input.deleted ? new Date() : null],
  );
}

async function dmRow(pageId: number, ref: string, input: {
  conv?: string | null; deleted?: boolean; ofapiAccountId?: string;
} = {}) {
  const conv = input.conv === undefined ? FAN : input.conv;
  await testDb!.pool.query(
    `insert into dm_message_archive (platform, platform_account_id, ofapi_account_id, platform_conversation_id,
       platform_message_id, sender_role, is_sent_by_me, message_created_at, text_plain, is_tip, tip_amount_mills,
       deleted_at, source, source_event_type, source_idempotency_key, source_journal_id, source_received_at, retain_until)
     values ('onlyfans', $1, $2, $3, $4, 'fan', false, $5, 'dm', false, 0, $6, 'webhook', $7, $8, 1, now(),
       now() + interval '100 years')`,
    [pageId, input.ofapiAccountId ?? OFAPI_ACCT, conv, ref,
      // A delete webhook names no chat: its stub has neither a chat nor a time.
      conv === null ? null : new Date(), input.deleted ? new Date() : null,
      input.deleted ? "messages.deleted" : "messages.received", `known-${pageId}-${ref}`],
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

function lookup(pageId: number, messageRefs: string[], conversationRef = FAN, platform = "onlyfans") {
  return lookupAiKnownMessages(testDb!.db, { pageId, platform, conversationRef, messageRefs });
}

describe("known fan message lookup (context_v1)", () => {
  it("finds a message of this conversation in any store, and its tombstone in any store", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedOnlyFansPage();
    await archiveRow(page.id, "101");
    await dmRow(page.id, "102");
    await hotRow(page.id, "103");
    await archiveRow(page.id, "201", { deleted: true });
    await dmRow(page.id, "202", { deleted: true });
    await hotRow(page.id, "203", { deleted: true });
    // Live in the archive, tombstoned by a delete webhook that named no chat.
    await archiveRow(page.id, "204");
    await dmRow(page.id, "204", { conv: null, deleted: true });
    // Live in the archive, tombstoned only in the hot table.
    await archiveRow(page.id, "205");
    await hotRow(page.id, "205", { deleted: true });

    const states = await lookup(page.id, ["101", "102", "103", "201", "202", "203", "204", "205", "999"]);
    expect(Object.fromEntries(states)).toEqual({
      "101": "present", "102": "present", "103": "present",
      "201": "deleted", "202": "deleted", "203": "deleted", "204": "deleted", "205": "deleted",
      "999": "absent",
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reads another fan's chat on the same page as absent, live or deleted (critic item 5)", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedOnlyFansPage();
    await archiveRow(page.id, "301", { conv: OTHER_FAN });
    await archiveRow(page.id, "302", { conv: OTHER_FAN, deleted: true });
    await dmRow(page.id, "303", { conv: OTHER_FAN });
    await dmRow(page.id, "304", { conv: OTHER_FAN, deleted: true });
    await hotRow(page.id, "305", { conv: OTHER_FAN });
    await hotRow(page.id, "306", { conv: OTHER_FAN, deleted: true });
    // A chat-less delete stub alone says nothing about which chat it was in.
    await dmRow(page.id, "307", { conv: null, deleted: true });
    // An archive row that names no conversation is not this fan's either.
    await archiveRow(page.id, "308", { conv: null, deleted: true });

    const refs = ["301", "302", "303", "304", "305", "306", "307", "308"];
    const states = await lookup(page.id, refs);
    expect([...states.values()]).toEqual(refs.map(() => "absent"));
    // The same ids are real for the chat they belong to.
    expect(Object.fromEntries(await lookup(page.id, refs.slice(0, 6), OTHER_FAN))).toEqual({
      "301": "present", "302": "deleted", "303": "present", "304": "deleted", "305": "present", "306": "deleted",
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("never reads another page's stores, even for the same conversation ref", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedOnlyFansPage();
    const other = await seedOnlyFansPage("known-of-2", "acct_known2");
    await archiveRow(other.id, "401");
    await dmRow(other.id, "402", { ofapiAccountId: "acct_known2", deleted: true });
    await hotRow(other.id, "403", { deleted: true });

    expect([...(await lookup(page.id, ["401", "402", "403"])).values()]).toEqual(["absent", "absent", "absent"]);
    expect(Object.fromEntries(await lookup(other.id, ["401", "402", "403"]))).toEqual({
      "401": "present", "402": "deleted", "403": "deleted",
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reads a Fansly page's archive by its own platform", async (context) => {
    if (!testDb) return context.skip();
    const model = await createModel(testDb.db, { slug: "known-fs", name: "known-fs" });
    const page = (await createFanslyPage(testDb.db, { modelId: model!.id, label: "known-fs" }))!;
    await archiveRow(page.id, "501", { platform: "fansly" });
    await hotRow(page.id, "502", { deleted: true });

    expect(Object.fromEntries(await lookup(page.id, ["501", "502", "503"], FAN, "fansly"))).toEqual({
      "501": "present", "502": "deleted", "503": "absent",
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("answers every ref once, runs nothing for none and refuses an unbounded list", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedOnlyFansPage();
    await archiveRow(page.id, "101");
    expect(await lookup(page.id, [])).toEqual(new Map());
    expect(Object.fromEntries(await lookup(page.id, ["101", "101", "999"]))).toEqual({ "101": "present", "999": "absent" });
    const tooMany = Array.from({ length: AI_KNOWN_MESSAGE_LOOKUP_MAX_REFS + 1 }, (_, n) => String(n + 1));
    await expect(lookup(page.id, tooMany)).rejects.toThrow(/at most/);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("is point lookups on the stores' unique keys, not a scan of the conversation", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedOnlyFansPage();
    const other = await seedOnlyFansPage("known-of-2", "acct_known2");
    // One long conversation plus a spread that dominates the tables, on two
    // pages: without it the planner rightly prefers sequential scans and the
    // assertions below would test nothing.
    for (const [pageId, account, base] of [[page.id, OFAPI_ACCT, 1_000_000], [other.id, "acct_known2", 5_000_000]] as const) {
      await testDb.pool.query(
        `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain, backfill_source)
         select $1, 'onlyfans', case when g <= 5000 then $2 else 'conv-' || (g % 40) end, ($3::int + g)::text, 'fan', false,
                now() - (g || ' seconds')::interval, 'spread ' || g, 'seed'
         from generate_series(1, 25000) g`,
        [pageId, FAN, base],
      );
      await testDb.pool.query(
        `insert into dm_message_archive (platform, platform_account_id, ofapi_account_id, platform_conversation_id, platform_message_id, sender_role, is_sent_by_me, message_created_at, text_plain, is_tip, tip_amount_mills, source, source_event_type, source_idempotency_key, source_journal_id, source_received_at, retain_until)
         select 'onlyfans', $1::bigint, $2, case when g <= 3000 then $3 else 'conv-' || (g % 40) end, ($4::int + 2000000 + g)::text, 'fan', false,
                now() - (g || ' seconds')::interval, 'dm ' || g, false, 0, 'webhook', 'messages.received', 'known-spread-' || $1::bigint || '-' || g, 1, now(), now() + interval '100 years'
         from generate_series(1, 15000) g`,
        [pageId, account, FAN, base],
      );
      await testDb.pool.query(
        `with threads as (
           insert into page_dm_threads (platform_account_id, platform_conversation_id)
           select $1::bigint, case when n = 0 then $2 else 'conv-' || n end from generate_series(0, 39) n
           returning id, platform_conversation_id
         )
         insert into page_dm_messages (conversation_id, platform_account_id, platform_message_id, sender_role, created_at, content)
         select t.id, $1::bigint, ($3::int + 4000000 + row_number() over ())::text, 'fan', now(), ''
         from threads t cross join generate_series(1, 250) g`,
        [pageId, FAN, base],
      );
    }
    await testDb.pool.query("analyze message_archive, dm_message_archive, page_dm_messages, page_dm_threads, pages");

    const input = {
      pageId: page.id,
      platform: "onlyfans",
      conversationRef: FAN,
      messageRefs: ["1000001", "1000002", "3000001", "1", "2", "3", "4", "5", "6", "7"],
    };
    const plan = await explainAiKnownMessagesQuery(testDb.db, input);
    // Each message store is probed by its unique key with the named ids in the
    // index condition; none is scanned by conversation or by account. (The
    // thread row itself comes from a table of a few dozen rows here.)
    expect(plan).toContain("message_archive_account_id_platform_message_ref_key");
    expect(plan).toContain("dm_message_archive_platform_account_message_uniq");
    expect(plan).toContain("page_dm_messages_conversation_message_uniq");
    expect(plan.match(/Index Cond: .*= ANY \('\{1000001,/g)).toHaveLength(3);
    for (const table of ["message_archive", "dm_message_archive", "page_dm_messages"]) {
      expect(plan, table).not.toMatch(new RegExp(`Seq Scan on ${table}\\b`));
    }
    expect(Object.fromEntries(await lookupAiKnownMessages(testDb.db, input))).toMatchObject({
      "1000001": "present", "3000001": "present", "1": "absent",
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
