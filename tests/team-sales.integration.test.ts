import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MASS_SEND_MIN_CHATS } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, createOnlyFansPage, listPpvFacts, upsertTransaction } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { byPriceOf } from "../apps/runtime/src/services/team-sales.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// «Продажи», A (week-6.md): a personal PPV is bought by Fansly's offer state or
// OnlyFans' purchase time; its net comes from the offer's sales or from the
// fan's purchase within 3 minutes; mass messages and bursts are not PPVs; the
// first PPV of a chat is the first priced personal message Hub holds there.

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let fansly = 0;
let onlyfans = 0;
let vanya = 0;
const MIN = 60_000;
const now = Date.now();
const at = (minutesAgo: number) => new Date(now - minutesAgo * MIN);

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);

async function sent(pageId: number, platform: string, ref: string, input: { conv: string; minutesAgo: number; priceMills: number; text?: string; type?: number }) {
  await q(`insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain,
             media_metadata, price_mills, message_type)
           values ($1, $2, $3, $4, 'model', true, $5, $6, '[{"type":"video"}]'::jsonb, $7, $8)`,
    [pageId, platform, input.conv, ref, at(input.minutesAgo), input.text ?? `ppv ${ref}`, input.priceMills, input.type ?? 1]);
}

async function authored(pageId: number, platform: string, ref: string, fanRef: string, minutesAgo: number) {
  await q(`insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
           values ($1, $2, $3, $4, $5, $6, true, true, $7, 'hand')`,
    [platform, pageId, ref, fanRef, vanya, platform === "fansly" ? "fansly-extension" : "chatspace-extension", at(minutesAgo)]);
}

describe("«Продажи»: PPV conversion", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "vanya", role: "chatter" }, { source: "cli" });
    vanya = await fixtureUserId(app, "vanya");
    const ari = await createModel(app.db, { slug: "ari", name: "Ari" });
    fansly = (await createFanslyPage(app.db, { modelId: ari!.id, label: "ari-1" }))!.id;
    onlyfans = (await createOnlyFansPage(app.db, { modelId: ari!.id, label: "ari-of" }))!.id;

    // Fansly: Ваня's $25 PPV bought ($20 net), then a $8 PPV without an author nobody bought.
    await sent(fansly, "fansly", "9000000001", { conv: "8800000001", minutesAgo: 120, priceMills: 25_000 });
    await authored(fansly, "fansly", "9000000001", "7000000001", 120);
    await q(`insert into message_media_offers (page_id, platform, message_ref, offer_ordinal, media_offer_ref, conversation_ref, fan_platform_user_id,
               message_created_at, offer_type, mime_type, duration_ms, price_mills, purchase_state, sales_net_mills, first_observed_at, last_observed_at,
               content_hash, source_event_id, source_observation_id, source_account_seq)
             values ($1, 'fansly', '9000000001', 0, 'offer-1', '8800000001', '7000000001', $2, 1, 'video/mp4', 1000, 25000, 'purchased', 20000,
               now(), now(), $3, 1, 1, 1)`, [fansly, at(120), "a".repeat(64)]);
    await sent(fansly, "fansly", "9000000002", { conv: "8800000001", minutesAgo: 60, priceMills: 8_000 });
    // A Fansly mass message and a burst of one text to five chats within the hour are not PPVs.
    await sent(fansly, "fansly", "9000000003", { conv: "8800000001", minutesAgo: 50, priceMills: 5_000, type: 2 });
    for (let chat = 0; chat < MASS_SEND_MIN_CHATS; chat += 1) {
      await sent(fansly, "fansly", `90000000${20 + chat}`, { conv: `88000000${10 + chat}`, minutesAgo: 30, priceMills: 12_000, text: "burst" });
    }

    // OnlyFans: Ваня's $15 PPV bought; the fan's purchase a minute later brought $12 net.
    const fanId = Number((await q("insert into fans (platform, platform_user_id, username) values ('onlyfans', '500001', 'tom') returning id")).rows[0].id);
    const thread = Number((await q(
      `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id, stored_message_count,
         message_coverage_status, last_message_at, oldest_stored_message_id, newest_stored_message_id)
       values ($1, $2, '500001', '500001', 1, 'complete', $3, '7000000100', '7000000100') returning id`, [onlyfans, fanId, at(90)])).rows[0].id);
    await sent(onlyfans, "onlyfans", "7000000100", { conv: "500001", minutesAgo: 90, priceMills: 15_000 });
    await authored(onlyfans, "onlyfans", "7000000100", "500001", 90);
    await q(`insert into page_dm_messages (conversation_id, platform_account_id, platform_message_id, sender_platform_user_id, sender_role, created_at,
               content, purchased_at)
             values ($1, $2, '7000000100', '1', 'creator', $3, 'ppv', $4)`, [thread, onlyfans, at(90), at(80)]);
    await upsertTransaction(app.db, {
      platformAccountId: onlyfans, source: "ofapi:webhook", fanId, transactionId: "sales-of-ppv", rawType: "message",
      canonicalType: "message_purchase", transactionState: "posted", rawStatus: "ok", grossAmountMills: 15_000n,
      sourceDestinationAmountMills: 15_000n, creatorNetAmountMills: 12_000n, occurredAt: at(79),
    });
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("finds each personal PPV with its author, purchase, net and whether it is the chat's first", async (context) => {
    if (!testDb) return context.skip();
    const rows = await listPpvFacts(app.db, { from: at(24 * 60), to: new Date(now + MIN), pages: "all", burstMinFans: MASS_SEND_MIN_CHATS });
    const facts = rows
      .map(({ pageLabel, priceMills, bought, netMills, firstPpv, username }) => ({ pageLabel, priceMills, bought, netMills, firstPpv, username }))
      .sort((a, b) => a.pageLabel.localeCompare(b.pageLabel) || b.priceMills - a.priceMills);
    expect(facts).toEqual([
      { pageLabel: "ari-1", priceMills: 25_000, bought: true, netMills: 20_000, firstPpv: true, username: "vanya" },
      { pageLabel: "ari-1", priceMills: 8_000, bought: false, netMills: 0, firstPpv: false, username: null },
      { pageLabel: "ari-of", priceMills: 15_000, bought: true, netMills: 12_000, firstPpv: true, username: "vanya" },
    ]);

    // $25 is the top of the $10–25 bucket; every bucket is listed, empty ones too.
    expect(byPriceOf(rows.filter((row) => row.userId === vanya))).toEqual([
      { bucket: "upTo10", sent: 0, bought: 0, netMills: 0 },
      { bucket: "10to25", sent: 2, bought: 2, netMills: 32_000 },
      { bucket: "25to50", sent: 0, bought: 0, netMills: 0 },
      { bucket: "50to100", sent: 0, bought: 0, netMills: 0 },
      { bucket: "over100", sent: 0, bought: 0, netMills: 0 },
    ]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
