import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { clientFanCardResponseSchema, type ClientFanCardResponse } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, createOnlyFansPage, upsertTransaction } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { assignPageToUser, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { armNoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// The fan's card across pages (Chat Memory week 2, week-2.md §1–2): asked on
// ari-1 by a chatter who works only ari-1, it shows the fan's lora-1 alias and
// money; Hub suggests another account the team gave the same alias, and an
// account with the same username on OnlyFans; a chatter's «Да» joins them, a
// «Нет» keeps the suggestion away, and only a suggested account can be decided.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const VERSION = "chat-extension/0.9.0";
let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let token = "";
const pages: Record<string, number> = {};
const fans: Record<string, number> = {};

async function fan(key: string, platform: string, ref: string, username: string) {
  const result = await testDb!.pool.query<{ id: string }>(
    "insert into fans (platform, platform_user_id, username, first_seen_at) values ($1, $2, $3, now() - interval '1 day' * $4) returning id",
    [platform, ref, username, Object.keys(fans).length],
  );
  fans[key] = Number(result.rows[0]!.id);
}

async function onPage(fanKey: string, pageLabel: string, alias: string | null, spentMills: number) {
  await testDb!.pool.query(
    "insert into page_fans (fan_id, platform_account_id, page_alias, is_subscriber) values ($1, $2, $3, true)",
    [fans[fanKey], pages[pageLabel], alias],
  );
  if (spentMills > 0) {
    await testDb!.pool.query(
      `insert into fan_spend_lifetime (platform_account_id, fan_id, gross_amount_mills, creator_net_amount_mills, last_transaction_at, updated_at)
       values ($1, $2, $3, $3, now(), now())`,
      [pages[pageLabel], fans[fanKey], spentMills],
    );
  }
}

const get = async (fanRef: string) => {
  const response = await server!.inject({
    method: "GET",
    url: `/api/v1/client/pages/ari-1/fans/${fanRef}/card`,
    headers: { authorization: `Bearer ${token}`, "x-client-version": VERSION },
  });
  expect(response.statusCode, response.body).toBe(200);
  return clientFanCardResponseSchema.parse(response.json());
};

const decide = (otherPlatform: string, otherFanRef: string, decision: "same" | "different") => server!.inject({
  method: "POST",
  url: "/api/v1/client/pages/ari-1/fans/7000000001/links",
  headers: { authorization: `Bearer ${token}`, "x-client-version": VERSION },
  payload: { otherPlatform, otherFanRef, decision },
});

const suggested = (card: ClientFanCardResponse) => card.suggestions.map((one) => [one.platform, one.fanRef, one.reason]);

describe("the fan's card across pages", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "vanya", role: "chatter" }, { source: "cli" });
    const vanya = await fixtureUserId(app, "vanya");
    await setUserPassword(app, { userId: vanya, password: "vanya-secret" }, { source: "cli" });
    const lora = await createModel(app.db, { slug: "lora", name: "Lora" });
    const ari = await createModel(app.db, { slug: "ari", name: "Ari" });
    for (const [label, model, create] of [
      ["lora-1", lora, createFanslyPage], ["lora-2", lora, createFanslyPage], ["ari-1", ari, createFanslyPage], ["lora-of", lora, createOnlyFansPage],
    ] as const) {
      pages[label] = (await create(app.db, { modelId: model!.id, label }))!.id;
    }
    await assignPageToUser(app, { userId: vanya, pageLabel: "ari-1" }, { source: "cli" });

    await fan("rick", "fansly", "7000000001", "rickyboy");
    await fan("rickNew", "fansly", "7000000002", "rick_again");
    await fan("rickOf", "onlyfans", "7000000003", "RickyBoy");
    await fan("stranger", "fansly", "7000000004", "someone");
    await onPage("rick", "lora-1", "❌Rick/USA/40", 50_000);
    await onPage("rick", "ari-1", null, 0);
    await onPage("rickNew", "lora-2", "Rick/USA/40", 20_000);
    await onPage("rickOf", "lora-of", null, 5_000);
    await onPage("stranger", "lora-2", "User/Country", 1_000);

    server = await buildApiServer(app);
    await server.ready();
    const signIn = await server.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens/password",
      headers: { "x-client-version": VERSION },
      payload: { username: "vanya", password: "vanya-secret", label: "Firefox", mode: "active", client: "chat-extension" },
    });
    expect(signIn.statusCode, signIn.body).toBe(200);
    token = signIn.json<{ token: string }>().token;
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("writes a custom paid by a suggested tip and marks it delivered by a suggested media message", async (context) => {
    if (!testDb || !server) return context.skip();
    const tipAt = new Date(Date.now() - 2 * 86_400_000);
    await upsertTransaction(app.db, {
      platformAccountId: pages["ari-1"]!, source: "fansly:rest", fanId: fans.rick!, transactionId: "custom-tip-1", rawType: "7001",
      canonicalType: "tip", transactionState: "posted", rawStatus: "ok", grossAmountMills: 120_000n,
      sourceDestinationAmountMills: 120_000n, creatorNetAmountMills: 96_000n, occurredAt: tipAt,
    });
    await testDb.pool.query(
      `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id, last_message_at, is_visible)
       values ($1, $2, '8800000001', '7000000001', now(), true)`,
      [pages["ari-1"], fans.rick],
    );
    await testDb.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain, media_metadata)
       values ($1, 'fansly', '8800000001', '9800000001', 'model', true, now() - interval '1 hour', 'here it is babe', '[{"type":"video"}]'::jsonb)`,
      [pages["ari-1"]],
    );
    const post = (url: string, payload: object) => server!.inject({
      method: "POST", url, headers: { authorization: `Bearer ${token}`, "x-client-version": VERSION }, payload,
    });
    const card = await get("7000000001");
    expect(card.customPayments.map((payment) => payment.amountMills)).toEqual([120_000]);
    const paymentRef = card.customPayments[0]!.paymentRef;
    expect((await post("/api/v1/client/pages/ari-1/fans/7000000001/customs", { description: "5 мин в душе", paymentRef: "999999" })).statusCode).toBe(409);

    const created = await post("/api/v1/client/pages/ari-1/fans/7000000001/customs", { description: "5 мин в душе", priceMills: 120_000, paymentRef });
    expect(created.statusCode, created.body).toBe(200);
    const custom = created.json().card.customs[0];
    expect(custom).toMatchObject({ description: "5 мин в душе", state: "paid", paymentMills: 120_000, granted: true, createdBy: "vanya" });
    expect(custom.deliveryCandidates.map((message: { messageRef: string }) => message.messageRef)).toEqual(["9800000001"]);
    // The tip is taken: it is no longer offered.
    expect(created.json().card.customPayments).toEqual([]);

    const url = `/api/v1/client/pages/ari-1/fans/7000000001/customs/${custom.id}`;
    expect((await post(url, { action: "delivered", messageRef: "9800000002" })).statusCode).toBe(409);
    const delivered = await post(url, { action: "delivered", messageRef: "9800000001" });
    expect(delivered.json()).toMatchObject({ changed: true });
    expect(delivered.json().card.customs[0]).toMatchObject({ state: "delivered", deliveredMessageRef: "9800000001" });
    // Delivered is final.
    expect((await post(url, { action: "cancel" })).json()).toMatchObject({ changed: false });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("shows another page's alias and money, suggests the same person, and takes the chatter's decision", async (context) => {
    if (!testDb || !server) return context.skip();
    const trap = await armNoOutboundTrap(testDb);
    try {
      const card = await get("7000000001");
      expect(card.known).toBe(true);
      // lora-1 is not Vanya's page: its alias with the mark and its money, no text of it.
      expect(card.pages.map((page) => [page.pageLabel, page.granted, page.alias, page.spentMills])).toEqual([
        ["lora-1", false, "❌Rick/USA/40", 50_000],
        ["ari-1", true, null, 0],
      ]);
      expect(suggested(card)).toEqual([
        ["fansly", "7000000002", "same_alias"],
        ["onlyfans", "7000000003", "same_username"],
      ]);
      expect(card.suggestions[0]).toMatchObject({ shared: "Rick/USA/40", sharedOn: "lora-2" });

      // Only a suggested account can be decided.
      const stranger = await decide("fansly", "7000000004", "same");
      expect(stranger.statusCode, stranger.body).toBe(409);

      const linked = await decide("fansly", "7000000002", "same");
      expect(linked.statusCode, linked.body).toBe(200);
      expect(linked.json()).toMatchObject({ decision: "same", recorded: true });
      const joined = await get("7000000001");
      expect(joined.accounts.map((account) => [account.fanRef, account.linkedBy])).toEqual([["7000000001", null], ["7000000002", "vanya"]]);
      expect(joined.pages.map((page) => page.pageLabel)).toEqual(["lora-1", "lora-2", "ari-1"]);
      expect(suggested(joined)).toEqual([["onlyfans", "7000000003", "same_username"]]);

      // «Нет» keeps it away; a repeat reads the first decision back.
      expect((await decide("onlyfans", "7000000003", "different")).json()).toMatchObject({ decision: "different", recorded: true });
      expect((await decide("onlyfans", "7000000003", "same")).json()).toMatchObject({ decision: "different", recorded: false });
      expect(suggested(await get("7000000001"))).toEqual([]);

      // Facts: only of the pages the caller works (week-2.md §2: no text of another page), the newest first.
      expect((await get("7000000001")).facts).toEqual([]);
      const insertFact = async (pageLabel: string, text: string, messageRef: string, minutesAgo: number) => Number((await testDb!.pool.query<{ id: string }>(
        `insert into fan_facts (fan_id, page_id, platform, conversation_ref, kind, text, message_ref, message_at, source)
         values ($1, $2, 'fansly', '8100000001', 'about', $3, $4, now() - interval '1 minute' * $5, 'ai') returning id`,
        [fans.rick, pages[pageLabel], text, messageRef, minutesAgo],
      )).rows[0]!.id);
      const onLora = await insertFact("lora-1", "Работает дальнобойщиком", "9200000001", 60);
      const onAri = await insertFact("ari-1", "Просит звать его Bear", "9200000002", 5);
      expect((await get("7000000001")).facts.map((fact) => [fact.text, fact.pageLabel, fact.granted, fact.quote])).toEqual([
        ["Просит звать его Bear", "ari-1", true, null],
      ]);
      // The fact quotes its archived message, found by the archive's own key.
      await testDb!.pool.query(
        `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain, media_metadata)
         values ($1, 'fansly', '8100000001', '9200000002', 'fan', false, '2026-10-20T10:00:00Z', $2, '[]'::jsonb)`,
        [pages["ari-1"], `call me   Bear ${"x".repeat(400)}`],
      );
      const quote = (await get("7000000001")).facts[0]!.quote!;
      expect(quote).toMatchObject({ from: "fan", at: "2026-10-20T10:00:00.000Z", media: false });
      expect(quote.text.startsWith("call me Bear x")).toBe(true);
      expect([...quote.text]).toHaveLength(280);
      expect(quote.text.endsWith("…")).toBe(true);
      const change = (factId: number, body: object) => server!.inject({
        method: "POST",
        url: `/api/v1/client/pages/ari-1/fans/7000000001/facts/${factId}`,
        headers: { authorization: `Bearer ${token}`, "x-client-version": VERSION },
        payload: body,
      });
      expect((await change(onLora, { action: "delete" })).statusCode).toBe(409);
      const corrected = await change(onAri, { action: "correct", text: "Просит звать его Big Bear" });
      expect(corrected.statusCode, corrected.body).toBe(200);
      expect(corrected.json().card.facts.map((fact: { text: string; source: string; author: string | null }) => [fact.text, fact.source, fact.author]))
        .toEqual([["Просит звать его Big Bear", "chatter", "vanya"]]);
      // The old fact is no longer active: changing it again changes nothing.
      expect((await change(onAri, { action: "delete" })).json()).toMatchObject({ changed: false });

      // An unknown fan is an empty card, not an error.
      expect(await get("7999999999")).toMatchObject({ known: false, accounts: [], pages: [], suggestions: [], facts: [], customs: [], customPayments: [] });
      // A fan only another page has reads as unknown on ari-1 (review 2026-10-25), and nothing can be decided on him.
      expect(await get("7000000004")).toMatchObject({ known: false, accounts: [], pages: [], facts: [] });
      const foreign = await server!.inject({
        method: "POST",
        url: "/api/v1/client/pages/ari-1/fans/7000000004/links",
        headers: { authorization: `Bearer ${token}`, "x-client-version": VERSION },
        payload: { otherPlatform: "fansly", otherFanRef: "7000000002", decision: "same" },
      });
      expect(foreign.statusCode, foreign.body).toBe(409);
      await trap.assertNoOutbound();
    } finally {
      await trap.restore();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  describe("in the owner's console", () => {
    const login = async (username: string, password: string) => {
      const response = await server!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password } });
      expect(response.statusCode, response.body).toBe(200);
      const header = response.headers["set-cookie"];
      return String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    };
    const card = (pageLabel: string, fanRef: string, cookie: string) =>
      server!.inject({ method: "GET", url: `/api/v1/pages/${pageLabel}/fans/${fanRef}/card`, headers: { cookie } });
    const batch = (cookie: string, payload: Record<string, unknown>) =>
      server!.inject({ method: "POST", url: "/api/v2/spenders:batch", headers: { cookie }, payload });
    let owner = "";
    let lead = "";

    beforeAll(async () => {
      if (!testDb || !server) return;
      await createUserAccount(app, { username: "boss", role: "owner", password: "boss-secret" }, { source: "cli" });
      await createUserAccount(app, { username: "leadari", role: "team_lead", password: "lead-secret" }, { source: "cli" });
      await assignPageToUser(app, { userId: await fixtureUserId(app, "leadari"), pageLabel: "ari-1" }, { source: "cli" });
      owner = await login("boss", "boss-secret");
      lead = await login("leadari", "lead-secret");
      await fan("zed", "fansly", "7000000011", "zedhead");
      await fan("zedNew", "fansly", "7000000012", "zed_new");
      await onPage("zed", "lora-1", "Zed/USA/30", 70_000);
      await onPage("zed", "ari-1", null, 3_000);
      await onPage("zedNew", "lora-2", "Zed/USA/30", 9_000);
      await testDb.pool.query(
        `insert into fan_facts (fan_id, page_id, platform, conversation_ref, kind, text, message_ref, message_at, source)
         values ($1, $2, 'fansly', '8100000011', 'about', 'С lora-1', '9200000011', now(), 'ai'),
                ($1, $3, 'fansly', '8100000012', 'about', 'С ari-1', '9200000012', now(), 'ai')`,
        [fans.zed, pages["lora-1"], pages["ari-1"]],
      );
    }, 60_000);

    it("reads the whole card for the owner, and for a lead only what the lead's pages show", async (context) => {
      if (!testDb || !server) return context.skip();
      const trap = await armNoOutboundTrap(testDb);
      try {
        const full = clientFanCardResponseSchema.parse((await card("ari-1", "7000000011", owner)).json());
        expect(full.pages.map((page) => [page.pageLabel, page.spentMills])).toEqual([["lora-1", 70_000], ["ari-1", 3_000]]);
        expect(full.suggestions.map((one) => [one.fanRef, one.sharedOn])).toEqual([["7000000012", "lora-2"]]);
        expect(full.facts.map((fact) => fact.text).sort()).toEqual(["С ari-1", "С lora-1"]);

        const cut = clientFanCardResponseSchema.parse((await card("ari-1", "7000000011", lead)).json());
        // No money or alias of lora-1, no account seen only on lora-2, no fact of lora-1.
        expect(cut.pages.map((page) => [page.pageLabel, page.spentMills])).toEqual([["ari-1", 3_000]]);
        expect(cut.suggestions).toEqual([]);
        expect(cut.facts.map((fact) => fact.text)).toEqual(["С ari-1"]);
        expect(JSON.stringify(cut)).not.toContain("lora-");
        await trap.assertNoOutbound();
      } finally {
        await trap.restore();
      }
    }, INTEGRATION_TEST_TIMEOUT_MS);

    it("refuses a page the lead does not reach, a chatter's session and a device token", async (context) => {
      if (!testDb || !server) return context.skip();
      expect((await card("lora-1", "7000000011", lead)).statusCode).toBe(403);
      expect((await card("nosuchpage", "7000000011", owner)).statusCode).toBe(404);
      expect((await card("ari-1", "7000000011", await login("vanya", "vanya-secret"))).statusCode).toBe(403);
      const device = await server.inject({
        method: "GET",
        url: "/api/v1/pages/ari-1/fans/7000000011/card",
        headers: { authorization: `Bearer ${token}`, "x-client-version": VERSION },
      });
      expect(device.statusCode).toBe(403);
      expect((await server.inject({ method: "GET", url: "/api/v1/pages/ari-1/fans/7000000011/card" })).statusCode).toBe(401);
    }, INTEGRATION_TEST_TIMEOUT_MS);

    it("names a fan's pages and money in a wide batch, inside the viewer's pages only", async (context) => {
      if (!testDb || !server) return context.skip();
      const fansAsked = [{ platform: "fansly", platformUserId: "7000000011" }, { platform: "fansly", platformUserId: "7999999999" }];
      const wide = await batch(owner, { scope: "agency", platform: "fansly", period: "30d", fans: fansAsked });
      expect(wide.statusCode, wide.body).toBe(200);
      const [found, missing] = wide.json().items;
      expect(found.pages).toEqual([
        { pageLabel: "lora-1", creatorNetAmountMills: 70_000 },
        { pageLabel: "ari-1", creatorNetAmountMills: 3_000 },
      ]);
      expect(found.subscription).toBeNull();
      expect(missing).not.toHaveProperty("pages");

      const onePage = await batch(owner, { scope: "page", pageLabel: "ari-1", period: "30d", fans: fansAsked });
      expect(onePage.json().items[0]).not.toHaveProperty("pages");
      expect(onePage.json().items[0].subscription).not.toBeNull();

      // The lead's whole scope is one page: lora-1's money is not there in any shape.
      const leads = await batch(lead, { scope: "agency", platform: "fansly", period: "30d", fans: fansAsked });
      expect(leads.statusCode, leads.body).toBe(200);
      expect(leads.json().items[0]).not.toHaveProperty("pages");
      expect(leads.body).not.toContain("lora-1");
    }, INTEGRATION_TEST_TIMEOUT_MS);

    it("says what a deleted fan spent on this page", async (context) => {
      if (!testDb || !server) return context.skip();
      await fan("gone", "fansly", "7000000021", "goneguy");
      await fan("goneBroke", "fansly", "7000000022", "brokeguy");
      await onPage("gone", "ari-1", null, 41_000);
      await onPage("goneBroke", "ari-1", null, 0);
      await testDb.pool.query("update fans set deleted_detected_at = now() where id = any($1::bigint[])", [[fans.gone, fans.goneBroke]]);
      const response = await server.inject({ method: "GET", url: "/api/v1/pages/ari-1/deleted-fans?limit=50&offset=0", headers: { cookie: lead } });
      expect(response.statusCode, response.body).toBe(200);
      const spent = Object.fromEntries(response.json().items.map((item: { platformUserId: string; totalCreatorNetMills: number }) => [item.platformUserId, item.totalCreatorNetMills]));
      expect(spent).toEqual({ "7000000021": 41_000, "7000000022": 0 });
    }, INTEGRATION_TEST_TIMEOUT_MS);
  });
});
