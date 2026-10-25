import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFanslyPage, createModel, listBroadcasts, listEmptyHours, listGreetings, upsertTransaction } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// «Покрытие» (Chat Memory week 6, week-6.md §В–Г). Empty hours: an hour is
// empty when fans wrote and no chatter minute fell in it; counting starts at
// the page's first minute in the extension; a mass message answers nobody; a
// fan who waited over an hour brings their 30-day net. Greetings: a message
// within 2 minutes of the subscription is the automatic welcome; the greeting
// is the first personal one from 2 minutes to 24 hours; a burst is no greeting
// but a broadcast.

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let ari = 0;
let lora = 0;
let lilly = 0;
const MIN = 60_000;
const HOUR = 60 * MIN;
const now = new Date();
const h0 = new Date(Math.floor(now.getTime() / HOUR) * HOUR - 3 * HOUR);
const at = (minutesAfterH0: number) => new Date(h0.getTime() + minutesAfterH0 * MIN);

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
// On a clock hour, so the five sends of the burst share one.
const t0 = new Date(Math.floor(now.getTime() / HOUR) * HOUR - 3 * 24 * HOUR);
const after = (minutes: number) => new Date(t0.getTime() + minutes * MIN);

async function send(conv: string, ref: string, minutesAfterT0: number, input: { fromFan: boolean; text: string; type?: number; priceMills?: number }) {
  await q(`insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain,
             media_metadata, price_mills, message_type)
           values ($1, 'fansly', $2, $3, $4, $5, $6, $7, '[]'::jsonb, $8, $9)`,
    [lilly, conv, ref, input.fromFan ? "fan" : "model", !input.fromFan, after(minutesAfterT0), input.text, input.priceMills ?? null, input.type ?? 1]);
}

async function subscriber(platformUserId: string, conv: string, minutesAfterT0: number): Promise<number> {
  const fanId = Number((await q("insert into fans (platform, platform_user_id, username) values ('fansly', $1, $1) returning id", [platformUserId])).rows[0].id);
  await q("insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id) values ($1, $2, $3)", [lilly, fanId, conv]);
  await q(`insert into page_subscriptions (platform_subscription_id, platform_account_id, fan_id, raw_status, canonical_status, price_mills,
             renew_price_mills, source_created_at)
           values ($1, $2, $3, 3, 'active', 9990, 9990, $4)`, [`sub-${platformUserId}`, lilly, fanId, after(minutesAfterT0)]);
  return fanId;
}

async function message(pageId: number, conv: string, ref: string, minutesAfterH0: number, input: { fromFan: boolean; type?: number }) {
  await q(`insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain,
             media_metadata, message_type)
           values ($1, 'fansly', $2, $3, $4, $5, $6, 'hi', '[]'::jsonb, $7)`,
    [pageId, conv, ref, input.fromFan ? "fan" : "model", !input.fromFan, at(minutesAfterH0), input.type ?? 1]);
}

describe("empty hours of a page", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "vanya", role: "chatter" }, { source: "cli" });
    const vanya = await fixtureUserId(app, "vanya");
    const model = await createModel(app.db, { slug: "ari", name: "Ari" });
    ari = (await createFanslyPage(app.db, { modelId: model!.id, label: "ari-1" }))!.id;
    lora = (await createFanslyPage(app.db, { modelId: model!.id, label: "lora-1" }))!.id;
    lilly = (await createFanslyPage(app.db, { modelId: model!.id, label: "lilly-1" }))!.id;
    const fanB = Number((await q("insert into fans (platform, platform_user_id, username) values ('fansly', '7000000002', 'bob') returning id")).rows[0].id);
    await q("insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id) values ($1, $2, '8800000002')", [ari, fanB]);

    // Ваня worked ten minutes into the first hour; the next hour nobody did.
    await q("insert into chatter_activity_minutes (user_id, page_id, minute) values ($1, $2, $3)", [vanya, ari, at(10)]);
    // Before the page's first minute in the extension: not counted.
    await message(ari, "8800000003", "9000000001", -60, { fromFan: true });
    // The worked hour: not empty.
    await message(ari, "8800000001", "9000000002", 20, { fromFan: true });
    // The empty hour: A is answered in 25 minutes; B gets a mass message, then a personal reply 70 minutes later.
    await message(ari, "8800000001", "9000000003", 65, { fromFan: true });
    await message(ari, "8800000001", "9000000004", 90, { fromFan: false });
    await message(ari, "8800000002", "9000000005", 70, { fromFan: true });
    await message(ari, "8800000002", "9000000006", 75, { fromFan: false, type: 2 });
    await message(ari, "8800000002", "9000000007", 140, { fromFan: false });
    await upsertTransaction(app.db, {
      platformAccountId: ari, source: "fansly:rest", fanId: fanB, transactionId: "coverage-tip", rawType: "7001",
      canonicalType: "tip", transactionState: "posted", rawStatus: "ok", grossAmountMills: 25_000n,
      sourceDestinationAmountMills: 25_000n, creatorNetAmountMills: 20_000n, occurredAt: at(0),
    });
    // A page nobody has worked on in the extension.
    await message(lora, "8800000009", "9000000009", 65, { fromFan: true });

    // F1: the automatic welcome, a personal greeting 10 minutes after subscribing, a reply 20 minutes later, a tip in two days.
    const f1 = await subscriber("7000000011", "8800000011", 0);
    await send("8800000011", "9100000001", 0.1, { fromFan: false, text: "welcome" });
    await send("8800000011", "9100000002", 10, { fromFan: false, text: "hey you, glad you're here" });
    await send("8800000011", "9100000003", 30, { fromFan: true, text: "hi" });
    await upsertTransaction(app.db, {
      platformAccountId: lilly, source: "fansly:rest", fanId: f1, transactionId: "coverage-greeted-tip", rawType: "7001",
      canonicalType: "tip", transactionState: "posted", rawStatus: "ok", grossAmountMills: 5_000n,
      sourceDestinationAmountMills: 5_000n, creatorNetAmountMills: 4_000n, occurredAt: after(2 * 24 * 60),
    });
    // F2: only the welcome; then one text to five chats within an hour (a broadcast, no greeting) and a personal message after 24 hours.
    await subscriber("7000000012", "8800000012", 1);
    await send("8800000012", "9100000011", 1.05, { fromFan: false, text: "welcome" });
    for (const [index, conv] of ["8800000012", "8800000021", "8800000022", "8800000023", "8800000024"].entries()) {
      await send(conv, `91000000${20 + index}`, 180 + index, { fromFan: false, text: "who wants a surprise?" });
    }
    await send("8800000021", "9100000031", 240, { fromFan: true, text: "me" });
    await send("8800000012", "9100000041", 25 * 60, { fromFan: false, text: "still there?" });
    // A priced Fansly mass message F1 bought.
    await send("8800000011", "9100000051", 300, { fromFan: false, text: "new set", type: 2, priceMills: 10_000 });
    await q(`insert into message_media_offers (page_id, platform, message_ref, offer_ordinal, media_offer_ref, conversation_ref, fan_platform_user_id,
               message_created_at, offer_type, mime_type, duration_ms, price_mills, purchase_state, first_observed_at, last_observed_at,
               content_hash, source_event_id, source_observation_id, source_account_seq)
             values ($1, 'fansly', '9100000051', 0, 'offer-cast', '8800000011', '7000000011', $2, 1, 'video/mp4', 1000, 10000, 'purchased',
               now(), now(), $3, 1, 1, 1)`, [lilly, after(300), "b".repeat(64)]);
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("counts empty hours from the first shift, who wrote in them and who waited", async (context) => {
    if (!testDb) return context.skip();
    const rows = await listEmptyHours(app.db, { from: new Date(h0.getTime() - 2 * HOUR), to: now, pages: [ari, lora] });
    const emptyByHour = Array.from({ length: 24 }, () => 0);
    emptyByHour[(new Date(h0.getTime() + HOUR).getUTCHours() + 3) % 24] = 1;
    expect(rows).toEqual([
      {
        pageId: ari, pageLabel: "ari-1", platform: "fansly", shiftsSince: at(10),
        hoursWithFans: 2, emptyHours: 1, emptyByHour, fans: 2, payers: 1, waitedOverHour: 1, waitedNetMills: 20_000,
      },
      {
        pageId: lora, pageLabel: "lora-1", platform: "fansly", shiftsSince: null,
        hoursWithFans: 0, emptyHours: 0, emptyByHour: Array.from({ length: 24 }, () => 0), fans: 0, payers: 0, waitedOverHour: 0, waitedNetMills: 0,
      },
    ]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("tells the automatic welcome from a personal greeting and counts who replied and bought", async (context) => {
    if (!testDb) return context.skip();
    const input = { from: new Date(t0.getTime() - HOUR), to: now, pages: [lilly], burstMinFans: 5 };
    expect(await listGreetings(app.db, input)).toEqual([{
      pageId: lilly, pageLabel: "lilly-1", platform: "fansly",
      newSubscribers: 2, autoWelcomed: 2, greeted: 1, greetingMedianSeconds: 600, repliedWithinHour: 1,
      boughtGreeted: 1, boughtNotGreeted: 0, recent: 2,
    }]);
    expect(await listBroadcasts(app.db, input)).toEqual([
      {
        pageId: lilly, pageLabel: "lilly-1", platform: "fansly", sentAt: after(300), preview: "new set", priceMills: 10_000, files: 0,
        massMessage: true, deliveries: 1, replied: 0, bought: 1, ppvBought: 1,
      },
      {
        pageId: lilly, pageLabel: "lilly-1", platform: "fansly", sentAt: after(180), preview: "who wants a surprise?", priceMills: null, files: 0,
        massMessage: false, deliveries: 5, replied: 1, bought: 0, ppvBought: 0,
      },
    ]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
