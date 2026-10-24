import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { clientWinBackResponseSchema, type ClientWinBackResponse } from "@agency_hub_core/contracts";
import { createModel, createOnlyFansPage, listWinBackResults, upsertTransaction } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { assignPageToUser, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { armNoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Win back (Chat Memory week 3, week-3.md §2–3): the list takes an ending
// subscription, a new subscriber nobody wrote to and a silent payer, most paid
// first, and leaves out a fan someone is talking to; a pick is journaled and
// takes the fan off the list for a week; its result counts from the chatter's
// next message — a reply within 72 hours, a purchase within 7 days.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const VERSION = "chat-extension/0.9.0";
let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let token = "";
let pageId = 0;
let vanya = 0;
const fans: Record<string, number> = {};

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);

async function fan(ref: string, spentMills: number) {
  const id = Number((await q("insert into fans (platform, platform_user_id, username, first_seen_at) values ('onlyfans', $1, $2, now() - interval '60 days') returning id", [ref, `fan${ref}`])).rows[0].id);
  await q("insert into page_fans (fan_id, platform_account_id) values ($1, $2)", [id, pageId]);
  if (spentMills > 0) {
    await q(`insert into fan_spend_lifetime (platform_account_id, fan_id, gross_amount_mills, creator_net_amount_mills, last_transaction_at, updated_at)
             values ($1, $2, $3, $3, now() - interval '30 days', now())`, [pageId, id, spentMills]);
  }
  fans[ref] = id;
  return id;
}

async function thread(ref: string, fanWroteDaysAgo: number) {
  await q(`insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id, last_message_at, last_fan_message_at, is_visible)
           values ($1, $2, $3, $3, now() - interval '1 day' * $4, now() - interval '1 day' * $4, true)`, [pageId, fans[ref], ref, fanWroteDaysAgo]);
}

async function subscription(ref: string, input: { startedDaysAgo: number; endsInDays: number | null; autoRenew: boolean }) {
  await q(`insert into page_subscriptions (platform_subscription_id, platform_account_id, fan_id, raw_status, canonical_status, price_mills,
             renew_price_mills, is_current, auto_renew, source_created_at, ends_at)
           values ($1, $2, $3, 1, 'active', 10000, 10000, true, $4, now() - interval '1 day' * $5,
             case when $6::int is null then null else now() + interval '1 day' * $6 end)`,
    [`sub-${ref}`, pageId, fans[ref], input.autoRenew, input.startedDaysAgo, input.endsInDays]);
}

const read = async () => {
  const response = await server!.inject({
    method: "GET", url: "/api/v1/client/pages/lora-of/win-back", headers: { authorization: `Bearer ${token}`, "x-client-version": VERSION },
  });
  expect(response.statusCode, response.body).toBe(200);
  return clientWinBackResponseSchema.parse(response.json());
};
const listed = (list: ClientWinBackResponse) => list.items.map((item) => [item.fanRef, item.reason]);

describe("win back", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "vanya", role: "chatter" }, { source: "cli" });
    vanya = await fixtureUserId(app, "vanya");
    await setUserPassword(app, { userId: vanya, password: "vanya-secret" }, { source: "cli" });
    const model = await createModel(app.db, { slug: "lora", name: "Lora" });
    pageId = (await createOnlyFansPage(app.db, { modelId: model!.id, label: "lora-of" }))!.id;
    await assignPageToUser(app, { userId: vanya, pageLabel: "lora-of" }, { source: "cli" });

    await fan("6001", 100_000); await thread("6001", 20);
    await fan("6002", 50_000); await thread("6002", 2); await subscription("6002", { startedDaysAgo: 60, endsInDays: 1, autoRenew: false });
    await fan("6003", 0); await subscription("6003", { startedDaysAgo: 2, endsInDays: 28, autoRenew: true });
    await fan("6004", 80_000); await thread("6004", 1);
    await fan("6005", 300_000); await thread("6005", 30);
    // Someone is talking to 6005 right now.
    await q(`insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at)
             values ('onlyfans', $1, '9500000001', '6005', $2, 'chatspace-extension', false, false, now() - interval '5 minutes')`, [pageId, vanya]);

    server = await buildApiServer(app);
    await server.ready();
    const signIn = await server.inject({
      method: "POST", url: "/api/v1/auth/device-tokens/password", headers: { "x-client-version": VERSION },
      payload: { username: "vanya", password: "vanya-secret", label: "Firefox", mode: "active", client: "chat-extension" },
    });
    token = signIn.json<{ token: string }>().token;
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("lists who to win back, records a pick, and counts its result from the chatter's next message", async (context) => {
    if (!testDb || !server) return context.skip();
    const trap = await armNoOutboundTrap(testDb);
    try {
      const list = await read();
      expect(listed(list)).toEqual([["6001", "silent"], ["6002", "expiring"], ["6003", "new_unattended"]]);
      expect(list.approaches.map((approach) => approach.label)).toEqual(["Деталь из памяти", "Бесплатное фото", "Мягкий PPV"]);

      const pick = (fanRef: string, approachId: number) => server!.inject({
        method: "POST", url: "/api/v1/client/pages/lora-of/win-back/attempts",
        headers: { authorization: `Bearer ${token}`, "x-client-version": VERSION }, payload: { fanRef, approachId },
      });
      expect((await pick("6004", list.approaches[0]!.id)).statusCode).toBe(409);
      const picked = await pick("6001", list.approaches[0]!.id);
      expect(picked.statusCode, picked.body).toBe(200);
      // The fan leaves the list for a week; the pick is journaled under the chatter.
      expect(listed(picked.json().list)).toEqual([["6002", "expiring"], ["6003", "new_unattended"]]);
      expect((await q("select actor_principal_id::text as actor from observations where kind = 'client.winback_attempt.v1'")).rows).toEqual([{ actor: String(vanya) }]);

      // Eight days ago the chatter wrote to 6001 after the pick; he answered the next day and bought.
      await q("update winback_attempts set picked_at = now() - interval '8 days'");
      await q(`insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at)
               values ('onlyfans', $1, '9500000002', '6001', $2, 'chatspace-extension', false, false, now() - interval '8 days' + interval '10 minutes')`, [pageId, vanya]);
      await q(`insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain)
               values ($1, 'onlyfans', '6001', '9500000003', 'fan', false, now() - interval '7 days', 'missed you')`, [pageId]);
      await upsertTransaction(app.db, {
        platformAccountId: pageId, source: "ofapi:webhook", fanId: fans["6001"]!, transactionId: "wb-1", rawType: "tip",
        canonicalType: "tip", transactionState: "posted", rawStatus: "ok", grossAmountMills: 25_000n,
        sourceDestinationAmountMills: 25_000n, creatorNetAmountMills: 20_000n, occurredAt: new Date(Date.now() - 6 * 86_400_000),
      });
      const rows = await listWinBackResults(app.db, { from: new Date(Date.now() - 30 * 86_400_000), to: new Date(), now: new Date(), pages: [pageId] });
      expect(rows).toEqual([expect.objectContaining({
        approachLabel: "Деталь из памяти", username: "vanya", attempts: 1, sent: 1, matured72h: 1, replied72h: 1, matured7d: 1, bought7d: 1, matured30d: 0,
      })]);
      await trap.assertNoOutbound();
    } finally {
      await trap.restore();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
