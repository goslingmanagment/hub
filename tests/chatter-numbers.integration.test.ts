import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFanslyPage, createModel, listShiftReviewMessages, readShiftNumbers, upsertTransaction } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { numbersOf, readTeamChatterNumbers } from "../apps/runtime/src/services/chatter-numbers.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// The numbers of a chatter's shift (Chat Memory week 5, week-5.md §1): only
// the chatter's authored messages count; a reply is the chatter's message to
// a fan who wrote after the page's last personal message; a mass message
// (Fansly's, or one text to 5+ chats in an hour) answers nobody; a fan whose
// last message is theirs at the end is waiting; a PPV is priced in the archive.

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let vanya = 0;
const MIN = 60_000;
const end = new Date(Date.now() - 5 * MIN);
const at = (minutesBeforeEnd: number) => new Date(end.getTime() - minutesBeforeEnd * MIN);

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);

async function message(ref: string, input: {
  minutesBeforeEnd: number; fromFan: boolean; type?: number; priceMills?: number; media?: boolean; chat?: string; text?: string;
}) {
  await q(`insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain,
             media_metadata, price_mills, message_type)
           values ($1, 'fansly', $9, $2, $3, $4, $5, $10, $6::jsonb, $7, $8)`,
    [pageId, ref, input.fromFan ? "fan" : "model", !input.fromFan, at(input.minutesBeforeEnd), input.media ? '[{"type":"video"}]' : "[]",
      input.priceMills ?? null, input.type ?? 1, input.chat ?? "8800000001", input.text ?? "hi"]);
}

async function authored(ref: string, input: { minutesBeforeEnd: number; priced: boolean; composedWith: string }) {
  await q(`insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
           values ('fansly', $1, $2, '7000000001', $3, 'fansly-extension', $4, $4, $5, $6)`,
    [pageId, ref, vanya, input.priced, at(input.minutesBeforeEnd), input.composedWith]);
}

describe("the numbers of a chatter's shift", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "vanya", role: "chatter" }, { source: "cli" });
    vanya = await fixtureUserId(app, "vanya");
    const ari = await createModel(app.db, { slug: "ari", name: "Ari" });
    pageId = (await createFanslyPage(app.db, { modelId: ari!.id, label: "ari-1" }))!.id;
    const fanId = Number((await q("insert into fans (platform, platform_user_id, username) values ('fansly', '7000000001', 'rick') returning id")).rows[0].id);

    // The fan wrote 50 minutes before the end; Ваня answered 10 minutes later by hand, then sent a PPV with Reply.
    await message("9000000001", { minutesBeforeEnd: 50, fromFan: true });
    await message("9000000002", { minutesBeforeEnd: 40, fromFan: false });
    await authored("9000000002", { minutesBeforeEnd: 40, priced: false, composedWith: "hand" });
    await message("9000000003", { minutesBeforeEnd: 30, fromFan: false, priceMills: 25_000, media: true });
    // The extension cannot see a Fansly price: the archive's says it is a PPV.
    await authored("9000000003", { minutesBeforeEnd: 30, priced: false, composedWith: "reply" });
    await q(`insert into message_media_offers (page_id, platform, message_ref, offer_ordinal, media_offer_ref, conversation_ref, fan_platform_user_id,
               message_created_at, offer_type, mime_type, duration_ms, price_mills, purchase_state, first_observed_at, last_observed_at,
               content_hash, source_event_id, source_observation_id, source_account_seq)
             values ($1, 'fansly', '9000000003', 0, 'offer-1', '8800000001', '7000000001', $2, 1, 'video/mp4', 1000, 25000, 'purchased',
               now(), now(), $3, 1, 1, 1)`, [pageId, at(30), "a".repeat(64)]);
    await upsertTransaction(app.db, {
      platformAccountId: pageId, source: "fansly:rest", fanId, transactionId: "numbers-ppv", rawType: "7001",
      canonicalType: "message_purchase", transactionState: "posted", rawStatus: "ok", grossAmountMills: 25_000n,
      sourceDestinationAmountMills: 25_000n, creatorNetAmountMills: 20_000n, occurredAt: at(20),
    });
    // The fan wrote again; a Fansly mass message and one text to five chats after it answer nobody: the fan is waiting at the end.
    await message("9000000004", { minutesBeforeEnd: 10, fromFan: true });
    await message("9000000005", { minutesBeforeEnd: 5, fromFan: false, type: 2 });
    for (const [index, chat] of ["8800000001", "8800000002", "8800000003", "8800000004", "8800000005"].entries()) {
      await message(String(9000000010 + index), { minutesBeforeEnd: 4, fromFan: false, chat, text: "new set tonight" });
    }
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("counts the chatter's messages, replies, PPV, payers and who waits at the end", async (context) => {
    if (!testDb) return context.skip();
    const row = await readShiftNumbers(app.db, { userId: vanya, pageIds: [pageId], from: at(60), to: end, burstMinChats: 5, deletedUnseenSeconds: 60, broadcastOwnWords: 4 });
    expect(row).toEqual({
      messages: 2,
      ppvSent: 1,
      ppvBought: 1,
      boughtPrices: [25_000],
      writtenFans: [`${pageId}:7000000001`],
      paidFans: [`${pageId}:7000000001`],
      replyDelays: [600],
      composed: { hand: 1, reply: 1, fix: 0, other: 0 },
      waitingAtEnd: 1,
    });
    const numbers = numbersOf([{ row, workedMinutes: 60, revenueMills: 20_000 }]);
    expect(numbers).toMatchObject({
      revenuePerHourMills: 20_000, ppvShare: 0.5, replies: 1, replyMedianSeconds: 600, repliesWithinHour: 1, ppvAveragePriceMills: 25_000,
    });
    // The same fan written to in two shifts of the week is one fan.
    expect(numbersOf([{ row, workedMinutes: 60, revenueMills: null }, { row, workedMinutes: 60, revenueMills: null }]))
      .toMatchObject({ fansWritten: 1, fansPaid: 1, messages: 4 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("takes no reply from a mass message the chatter sent, even with an author", async (context) => {
    if (!testDb) return context.skip();
    const model = await createModel(app.db, { slug: "mass", name: "Mass" });
    const page = (await createFanslyPage(app.db, { modelId: model!.id, label: "mass-1" }))!.id;
    const archive = (ref: string, chat: string, fromFan: boolean, minutesBeforeEnd: number, text: string) => q(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain, media_metadata, message_type)
       values ($1, 'fansly', $2, $3, $4, $5, $6, $7, '[]'::jsonb, 1)`,
      [page, chat, ref, fromFan ? "fan" : "model", !fromFan, at(minutesBeforeEnd), text]);
    // The fan wrote; then Ваня sent one text to five chats within the hour from the extension — his chat among them.
    await archive("9300000001", "8900000001", true, 30, "hey");
    for (const [index, chat] of ["8900000001", "8900000002", "8900000003", "8900000004", "8900000005"].entries()) {
      await archive(String(9300000010 + index), chat, false, 20, "new set tonight");
      await q(`insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
               values ('fansly', $1, $2, $3, $4, 'fansly-extension', false, false, $5, 'hand')`,
        [page, String(9300000010 + index), String(7300000001 + index), vanya, at(20)]);
    }
    const row = await readShiftNumbers(app.db, { userId: vanya, pageIds: [page], from: at(60), to: end, burstMinChats: 5, deletedUnseenSeconds: 60, broadcastOwnWords: 4 });
    expect(row).toMatchObject({ messages: 5, replyDelays: [], waitingAtEnd: 1 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("takes a broadcast with names for a mass message, but not its message with a live answer", async (context) => {
    if (!testDb) return context.skip();
    // The audit of 2026-11-07: one PPV sent by Fix to dozens of fans, each text with the fan's name, answered the waiting
    // fans as personal messages. Owner, 2026-11-08: one file set at one price from one sender to 5+ chats within an hour
    // is a broadcast; a message with 4+ words of its own beyond the template is a live answer.
    const model = await createModel(app.db, { slug: "named", name: "Named" });
    const page = (await createFanslyPage(app.db, { modelId: model!.id, label: "named-1" }))!.id;
    const media = '[{"id": "4100000001", "type": "video/mp4"}, {"id": "4100000002", "type": "image/jpeg"}]';
    const archive = (ref: string, chat: string, fromFan: boolean, minutesBeforeEnd: number, text: string, files = "[]") => q(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain,
         media_metadata, price_mills, message_type)
       values ($1, 'fansly', $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 1)`,
      [page, chat, ref, fromFan ? "fan" : "model", !fromFan, at(minutesBeforeEnd), text, files, files === "[]" ? null : 20_000]);
    const sent = (ref: string, fan: string, minutesBeforeEnd: number) => q(
      `insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
       values ('fansly', $1, $2, $3, $4, 'fansly-extension', true, true, $5, 'fix')`, [page, ref, fan, vanya, at(minutesBeforeEnd)]);
    // Two fans wrote; then Ваня sent one set at $20 to five chats over 50 minutes, a name in each text. To the second fan
    // he wrote a live answer in it too.
    await archive("9700000001", "8970000001", true, 59, "hey you there?");
    await archive("9700000002", "8970000002", true, 58, "did you go to the gym today");
    const texts = [
      "happy halloween Mike 🎃 your favorite witch is here with a new look",
      "happy halloween Sam 🎃 yes leg day destroyed me, I can barely walk lol. your favorite witch is here with a new look",
      "happy halloween Tom your favorite witch is here with a whole new look",
      "Joe, happy halloween 🎃 your favorite witch is here, new look",
      "happy halloween Ben 🎃 your favorite little witch is here with a new look",
    ];
    for (const [index, text] of texts.entries()) {
      const ref = String(9700000010 + index);
      await archive(ref, String(8970000001 + index), false, 55 - index * 12, text, media);
      await sent(ref, String(7700000001 + index), 55 - index * 12);
    }
    const row = await readShiftNumbers(app.db, {
      userId: vanya, pageIds: [page], from: at(60), to: end, burstMinChats: 5, deletedUnseenSeconds: 60, broadcastOwnWords: 4,
    });
    // Only the live answer replied (the second fan waited 15 minutes); the first fan still waits.
    expect(row).toMatchObject({ messages: 5, ppvSent: 5, replyDelays: [15 * 60], waitingAtEnd: 1 });
    const review = await listShiftReviewMessages(app.db, {
      userId: vanya, pageIds: [page], workedPageIds: [page], from: at(60), to: end, horizonHours: 72, burstMinChats: 5, deletedUnseenSeconds: 60,
      broadcastOwnWords: 4,
    });
    expect(review.filter((message) => message.sent).map((message) => [message.ref, message.mass])).toEqual([
      ["9700000010", true], ["9700000011", false], ["9700000012", true], ["9700000013", true], ["9700000014", true],
    ]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("shows a lead one shift and its revenue on the lead's page, though the shift went through another page", async (context) => {
    if (!testDb) return context.skip();
    // Коля works page A, then page B (not the lead's), then A again — one shift. His report credits $40 on A, $10 on B.
    const model = await createModel(app.db, { slug: "split", name: "Split" });
    const [a, b] = [
      (await createFanslyPage(app.db, { modelId: model!.id, label: "split-a" }))!.id,
      (await createFanslyPage(app.db, { modelId: model!.id, label: "split-b" }))!.id,
    ];
    await createUserAccount(app, { username: "kolya", role: "chatter" }, { source: "cli" });
    const kolya = await fixtureUserId(app, "kolya");
    const start = new Date(Math.floor((Date.now() - 6 * 60 * MIN) / MIN) * MIN);
    const minutes = (page: number, fromMin: number, toMin: number) => q(
      `insert into chatter_activity_minutes (user_id, page_id, minute, input)
       select $1, $2, minute, true from generate_series($3::timestamptz, $4::timestamptz, interval '1 minute') minute`,
      [kolya, page, new Date(start.getTime() + fromMin * MIN), new Date(start.getTime() + toMin * MIN)]);
    await minutes(a, 0, 59);
    await minutes(b, 60, 119);
    await minutes(a, 120, 179);
    // Enough messages to be a shift.
    for (const [page, offset] of [[a, 0], [b, 60], [a, 120]] as const) {
      await q(`insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
               select 'fansly', $1, ($2::bigint + n)::text, '7400000001', $3, 'fansly-extension', false, false, $4::timestamptz + interval '1 minute' * n, 'hand'
               from generate_series(0, 29) n`, [page, 9400000000 + offset, kolya, new Date(start.getTime() + offset * MIN)]);
    }
    const report = Number((await q(
      `insert into shift_reports (user_id, started_at, ended_at, credited_net_mills) values ($1, $2, $3, 50000) returning id`,
      [kolya, start, new Date(start.getTime() + 180 * MIN)])).rows[0].id);
    const fanId = Number((await q("insert into fans (platform, platform_user_id, username) values ('fansly', '7400000001', 'split') returning id")).rows[0].id);
    for (const [name, page, net] of [["split-a", a, 40_000n], ["split-b", b, 10_000n]] as const) {
      await upsertTransaction(app.db, {
        platformAccountId: page, source: "fansly:rest", fanId, transactionId: name, rawType: "7001", canonicalType: "tip", transactionState: "posted",
        rawStatus: "ok", grossAmountMills: net, sourceDestinationAmountMills: net, creatorNetAmountMills: net, occurredAt: new Date(start.getTime() + 30 * MIN),
      });
      const id = (await q("select id from transactions where transaction_id = $1", [name])).rows[0].id;
      await q(`insert into shift_report_lines (report_id, transaction_id, page_id, mark, net_mills, credited_mills, occurred_at)
               values ($1, $2, $3, 'mine', $4, $4, $5)`, [report, id, page, Number(net), new Date(start.getTime() + 30 * MIN)]);
    }
    const lead = { authMethod: "session", user: { id: kolya, role: "owner" } } as never;
    const response = await readTeamChatterNumbers(app, lead, {
      from: new Date(start.getTime() - MIN).toISOString(), to: new Date().toISOString(), pageScope: [a],
    });
    const numbers = response.chatters.find((one) => one.username === "kolya")!;
    // One shift, however little of it the lead's page holds: a view of a page does not cut it in two.
    expect(numbers.shifts.map((shift) => shift.numbers.revenueMills)).toEqual([40_000]);
    expect(numbers.week.revenueMills).toBe(40_000);

    // One person asked: the same numbers, nobody else; the lead's pages still decide.
    const window = { from: new Date(start.getTime() - MIN).toISOString(), to: new Date().toISOString() };
    const one = await readTeamChatterNumbers(app, lead, { ...window, userId: kolya, pageScope: [a] });
    expect(one.chatters.map((chatter) => chatter.username)).toEqual(["kolya"]);
    expect(one.chatters[0]!.week.revenueMills).toBe(40_000);
    const offScope = await readTeamChatterNumbers(app, lead, { ...window, userId: kolya, pageScope: [pageId] });
    expect(offScope.chatters).toEqual([]);
    const someoneElse = await readTeamChatterNumbers(app, lead, { ...window, userId: vanya, pageScope: [a] });
    expect(someoneElse.chatters).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("takes a PPV whose offer is stuck at 'unknown' for bought by this chat's fan's purchase after it, not another fan's", async (context) => {
    if (!testDb) return context.skip();
    // One offer sent to two fans (offers are reused); the platform never moved it past 'unknown'. Fan A bought it after his
    // message; fan B bought the same offer before his — neither is a purchase of B's message.
    const model = await createModel(app.db, { slug: "stuck", name: "Stuck" });
    const page = (await createFanslyPage(app.db, { modelId: model!.id, label: "stuck-1" }))!.id;
    const fans = [["7500000001", "8950000001", "9500000001", 40], ["7500000002", "8950000002", "9500000002", 35]] as const;
    const fanIds: number[] = [];
    for (const [fanRef, chat, ref, minutesBeforeEnd] of fans) {
      const fanId = Number((await q("insert into fans (platform, platform_user_id, username) values ('fansly', $1, $1) returning id", [fanRef])).rows[0].id);
      fanIds.push(fanId);
      await q(`insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id) values ($1, $2, $3, $4)`,
        [page, fanId, chat, fanRef]);
      await q(`insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain,
                 media_metadata, price_mills, message_type)
               values ($1, 'fansly', $2, $3, 'model', true, $4, 'just for you', '[{"type":"video"}]'::jsonb, 30000, 1)`,
        [page, chat, ref, at(minutesBeforeEnd)]);
      await q(`insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
               values ('fansly', $1, $2, $3, $4, 'fansly-extension', false, true, $5, 'hand')`, [page, ref, fanRef, vanya, at(minutesBeforeEnd)]);
      await q(`insert into message_media_offers (page_id, platform, message_ref, offer_ordinal, media_offer_ref, conversation_ref, fan_platform_user_id,
                 message_created_at, offer_type, mime_type, duration_ms, price_mills, purchase_state, first_observed_at, last_observed_at,
                 content_hash, source_event_id, source_observation_id, source_account_seq)
               values ($1, 'fansly', $2, 0, 'offer-stuck', $3, $4, $5, 1, 'video/mp4', 1000, 30000, 'unknown', now(), now(), $6, 1, 1, 1)`,
        [page, ref, chat, fanRef, at(minutesBeforeEnd), "b".repeat(64)]);
    }
    for (const [name, fanId, minutesBeforeEnd] of [["stuck-a", fanIds[0]!, 20], ["stuck-b", fanIds[1]!, 50]] as const) {
      await upsertTransaction(app.db, {
        platformAccountId: page, source: "fansly:rest", fanId, transactionId: name, rawType: "7001", canonicalType: "message_purchase",
        transactionState: "posted", rawStatus: "ok", grossAmountMills: 30_000n, sourceDestinationAmountMills: 30_000n, creatorNetAmountMills: 24_000n,
        occurredAt: at(minutesBeforeEnd), correlationId: "offer-stuck",
      });
    }

    const row = await readShiftNumbers(app.db, { userId: vanya, pageIds: [page], from: at(45), to: end, burstMinChats: 5, deletedUnseenSeconds: 60, broadcastOwnWords: 4 });
    expect(row).toMatchObject({ ppvSent: 2, ppvBought: 1, boughtPrices: [30_000] });
    const review = await listShiftReviewMessages(app.db, {
      userId: vanya, pageIds: [page], workedPageIds: [], from: at(45), to: end, horizonHours: 72, burstMinChats: 5, deletedUnseenSeconds: 60, broadcastOwnWords: 4,
    });
    expect(review.map((message) => [message.ref, message.bought])).toEqual([["9500000001", true], ["9500000002", false]]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("counts a message deleted a minute or more after it was sent, and leaves out one deleted sooner", async (context) => {
    if (!testDb) return context.skip();
    // The audit of 2026-11-07: a fan who erased the chat a day later took their waits out of a closed shift; a send the
    // chatter recalled in 6 s counted as a reply. Owner, 2026-11-08: what the other side could see counts.
    const model = await createModel(app.db, { slug: "erased", name: "Erased" });
    const page = (await createFanslyPage(app.db, { modelId: model!.id, label: "erased-1" }))!.id;
    const archive = (ref: string, fromFan: boolean, minutesBeforeEnd: number, deletedAfterSeconds: number | null, stub = false) => q(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain,
         media_metadata, message_type, deleted_at, content_pending)
       values ($1, 'fansly', '8960000001', $2, $3, $4, $5, $6, '[]'::jsonb, 1, $7, $8)`,
      [page, ref, fromFan ? "fan" : "model", !fromFan, at(minutesBeforeEnd), stub ? "" : `text ${ref}`,
        deletedAfterSeconds === null ? null : new Date(at(minutesBeforeEnd).getTime() + deletedAfterSeconds * 1000), stub]);
    const sent = (ref: string, minutesBeforeEnd: number) => q(
      `insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
       values ('fansly', $1, $2, '7600000001', $3, 'fansly-extension', false, false, $4, 'hand')`, [page, ref, vanya, at(minutesBeforeEnd)]);
    // The fan wrote and deleted it half an hour later; Ваня sent a text and recalled it in 6 s, then answered.
    await archive("9600000001", true, 50, 30 * 60);
    await archive("9600000002", false, 45, 6);
    await sent("9600000002", 45);
    await archive("9600000003", false, 44, null);
    await sent("9600000003", 44);
    // The fan wrote and deleted it in 40 s; Ваня wrote again — no reply. Two deletions that came before their text: one
    // recalled in 5 s (most such stubs on production), one deleted 5 minutes later.
    await archive("9600000004", true, 30, 40);
    await archive("9600000005", false, 20, null);
    await sent("9600000005", 20);
    await archive("9600000006", false, 10, 5, true);
    await sent("9600000006", 10);
    await archive("9600000007", false, 8, 300, true);
    await sent("9600000007", 8);

    const row = await readShiftNumbers(app.db, { userId: vanya, pageIds: [page], from: at(60), to: end, burstMinChats: 5, deletedUnseenSeconds: 60, broadcastOwnWords: 4 });
    expect(row).toMatchObject({ messages: 3, replyDelays: [360], composed: { hand: 3, reply: 0, fix: 0, other: 0 }, waitingAtEnd: 0 });
    const review = await listShiftReviewMessages(app.db, {
      userId: vanya, pageIds: [page], workedPageIds: [page], from: at(60), to: end, horizonHours: 72, burstMinChats: 5, deletedUnseenSeconds: 60, broadcastOwnWords: 4,
    });
    expect(review.map((message) => [message.ref, message.deletedAt === null ? null : (message.deletedAt.getTime() - message.at.getTime()) / 1000]))
      .toEqual([["9600000001", 1800], ["9600000002", 6], ["9600000003", null], ["9600000004", 40], ["9600000005", null], ["9600000007", 300]]);
    expect(review[0]!.text).toBe("text 9600000001");
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
