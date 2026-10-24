import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFanslyPage, createModel, readShiftNumbers, upsertTransaction } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { numbersOf } from "../apps/runtime/src/services/chatter-numbers.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// The numbers of a chatter's shift (Chat Memory week 5, week-5.md §1): only
// the chatter's authored messages count; a reply is the chatter's message to
// a fan who wrote after the page's last personal message; a mass message
// answers nobody; a fan whose last message is theirs at the end is waiting.

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let vanya = 0;
const MIN = 60_000;
const end = new Date(Date.now() - 5 * MIN);
const at = (minutesBeforeEnd: number) => new Date(end.getTime() - minutesBeforeEnd * MIN);

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);

async function message(ref: string, input: { minutesBeforeEnd: number; fromFan: boolean; type?: number; priceMills?: number; media?: boolean }) {
  await q(`insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain,
             media_metadata, price_mills, message_type)
           values ($1, 'fansly', '8800000001', $2, $3, $4, $5, 'hi', $6::jsonb, $7, $8)`,
    [pageId, ref, input.fromFan ? "fan" : "model", !input.fromFan, at(input.minutesBeforeEnd), input.media ? '[{"type":"video"}]' : "[]",
      input.priceMills ?? null, input.type ?? 1]);
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
    await authored("9000000003", { minutesBeforeEnd: 30, priced: true, composedWith: "reply" });
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
    // The fan wrote again; a mass message after it answers nobody: the fan is waiting at the end.
    await message("9000000004", { minutesBeforeEnd: 10, fromFan: true });
    await message("9000000005", { minutesBeforeEnd: 5, fromFan: false, type: 2 });
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("counts the chatter's messages, replies, PPV, payers and who waits at the end", async (context) => {
    if (!testDb) return context.skip();
    const row = await readShiftNumbers(app.db, { userId: vanya, pageIds: [pageId], from: at(60), to: end });
    expect(row).toEqual({
      messages: 2,
      ppvSent: 1,
      ppvBought: 1,
      boughtPrices: [25_000],
      fansWritten: 1,
      fansPaid: 1,
      replyDelays: [600],
      composed: { hand: 1, reply: 1, fix: 0, other: 0 },
      waitingAtEnd: 1,
    });
    const numbers = numbersOf([{ row, workedMinutes: 60, revenueMills: 20_000 }]);
    expect(numbers).toMatchObject({
      revenuePerHourMills: 20_000, ppvShare: 0.5, replies: 1, replyMedianSeconds: 600, repliesWithinHour: 1, ppvAveragePriceMills: 25_000,
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
