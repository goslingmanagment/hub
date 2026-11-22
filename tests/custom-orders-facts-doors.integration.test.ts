import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { agentCustomOrderResponseSchema, agentCustomOrdersResponseSchema, customOrderDetailResponseSchema } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { recordCustomOrder } from "../apps/runtime/src/services/custom-orders/index.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Customs facts (slice 2): what an agent names for an order is a sale or a message Hub holds, and Hub checks it — the
// sale is the order's fan's (any account of the person), on a page of the order's model among the key's pages, held by
// no other order, not reversed, not taken off by a person; a key without read:money links nothing, and a create never
// fails because of a sale. «Отдан» by a message: a priced one bought, none while a file carries the order's code,
// another account of the same person counts. An undo of what an agent applied is remembered until a person applies it
// again by hand; a revision of a given order takes «отдан» off it. Every name and number here is invented.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const AUDIT = { source: "cli" } as const;
const BOSS_PASSWORD = "boss-secret";
/** The reader: write:customs with the sales and the messages. */
const READER = `${AGENT_KEY_TOKEN_PREFIX}customs-reader-00`;
/** A key that only writes the shooting (production has one): it gains nothing new. */
const SHOOTER = `${AGENT_KEY_TOKEN_PREFIX}customs-shooter-0`;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let cookie = "";
let bossId = 0;
const pages: Record<string, number> = {};
const fans: Record<string, number> = {};
const sales: Record<string, number> = {};
const orders: Record<string, number> = {};

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const agent = (url: string, payload: Record<string, unknown>, token = READER) =>
  server!.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload });
const act = (code: string, payload: Record<string, unknown>) =>
  server!.inject({ method: "POST", url: `/api/v1/custom-orders/${code}`, headers: { cookie }, payload });
const code = (key: string) => `K-${orders[key]}`;
const rejections = async (orderId: number) =>
  (await testDb!.pool.query("select kind, ref from custom_order_rejections where order_id = $1 order by kind, ref", [orderId])).rows;

describe("custom orders: what an agent names, checked; undo remembered", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
    await createUserAccount(app, { username: "boss", role: "owner", password: BOSS_PASSWORD }, AUDIT);
    bossId = await fixtureUserId(app, "boss");
    const vela = await createModel(app.db, { slug: "vela", name: "Vela" });
    const orsa = await createModel(app.db, { slug: "orsa", name: "Orsa" });
    for (const label of ["vela-1", "vela-2", "vela-3"]) pages[label] = (await createFanslyPage(app.db, { modelId: vela!.id, label }))!.id;
    pages["orsa-1"] = (await createFanslyPage(app.db, { modelId: orsa!.id, label: "orsa-1" }))!.id;

    /** A fan with a chat on the page. */
    const fan = async (key: string, pageLabel: string, ref: string, conv: string) => {
      fans[key] = Number((await q("insert into fans (platform, platform_user_id, username) values ('fansly', $1, $2) returning id", [ref, `fan_${key}`])).rows[0].id);
      await q("insert into page_fans (fan_id, platform_account_id, is_subscriber) values ($1, $2, true)", [fans[key], pages[pageLabel]]);
      await q(`insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id, partner_username, last_message_at)
               values ($1, $2, $3, $4, $5, now())`, [pages[pageLabel], fans[key], conv, ref, `fan_${key}`]);
    };
    await fan("a", "vela-1", "7400000101", "conv-a");
    // The same person's second account, on the model's other page.
    await fan("a2", "vela-2", "7400000102", "conv-a2");
    await fan("b", "vela-1", "7400000103", "conv-b");
    const [low, high] = [fans.a!, fans.a2!].sort((x, y) => x - y);
    await q("insert into fan_links (fan_id, other_fan_id, decision, reason_kind, decided_by_user_id) values ($1, $2, 'same', 'same_alias', $3)", [low, high, bossId]);

    const sale = async (key: string, pageLabel: string, fanKey: string, kind = "tip", minutes = 120) => {
      sales[key] = Number((await q(
        `insert into transactions (platform_account_id, fan_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
           gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, currency)
         values ($1, $2, $3, $4, $5::transaction_type, 'posted', 'ok', 10000, 10000, 8000, $6, 'fansly:rest', 'USD') returning id`,
        [pages[pageLabel], fans[fanKey], `tx-${key}`, kind, kind, minutesAgo(minutes)],
      )).rows[0].id);
    };
    await sale("ok", "vela-1", "a");
    await sale("otherAccount", "vela-2", "a2");
    await sale("foreign", "vela-1", "b");
    await sale("otherModel", "orsa-1", "a");
    await sale("outsideKey", "vela-3", "a");
    await sale("held", "vela-1", "a");
    await sale("reversed", "vela-1", "a");
    await sale("post", "vela-1", "a", "post_purchase");
    await sale("undo", "vela-1", "a", "tip", 100);
    // The platform took one back: its chargeback is a row of its own.
    await q(`insert into transactions (platform_account_id, fan_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
               gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, currency)
             values ($1, $2, 'tx-reversed:chargeback', 'chargeback', 'chargeback', 'posted', 'ok', 10000, 10000, 8000, $3, 'fansly:rest', 'USD')`,
    [pages["vela-1"], fans.a, minutesAgo(30)]);

    const record = async (key: string, extra: { paymentTransactionId?: number } = {}) => {
      orders[key] = await recordCustomOrder(app, {
        pageId: pages["vela-1"]!, fanId: fans.a!, buyer: null, conversationRef: null, card: { task: `Ролик ${key}` }, deadlineOn: null,
        acceptedByUserId: bossId, origin: "agent", actor: { door: "system" }, createdAt: new Date(Date.now() - 180 * 60_000), ...extra,
      });
    };
    await record("holder", { paymentTransactionId: sales.held! });
    for (const key of ["undo", "otherAccount", "priced", "named"]) await record(key);

    /** A page's message to the fan's chat: with media, free or priced. */
    const message = (pageLabel: string, conv: string, ref: string, priceMills: number | null) => q(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain,
         media_metadata, message_type, is_tip, tip_amount_mills, price_mills)
       values ($1, 'fansly', $2, $3, 'model', true, $4, '', '[{"id": "1"}]'::jsonb, 1, false, 0, $5)`,
      [pages[pageLabel], conv, ref, minutesAgo(60), priceMills]);
    await message("vela-1", "conv-a", "9600000001", null);
    await message("vela-2", "conv-a2", "9600000002", null);
    await message("vela-1", "conv-a", "9600000003", 20_000);
    await message("vela-1", "conv-a", "9600000004", null);
    // The order's finished file in the vault of the model's other page, named by its code.
    await q(`insert into creator_raw_media (page_id, platform, media_ref, filename, source_kind, first_origin, first_observed_at, last_observed_at,
               content_hash, source_event_id, source_observation_id, source_account_seq)
             values ($1, 'fansly', 'media-1', $2, 'vault_media', 'vault', now(), now(), $3, 1, 1, 1)`,
    [pages["vela-2"], `video_K-${orders.named}_custom.mp4`, "0".repeat(64)]);

    for (const [token, capabilities] of [[READER, ["write:customs", "read:money", "read:messages"]], [SHOOTER, ["write:customs"]]] as const) {
      await insertAgentKey(app.db, {
        name: token === READER ? "reader" : "shooter",
        keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
        keyDigest: sha256Hex(token),
        capabilities: [...capabilities] as never,
        pageIds: [pages["vela-1"]!, pages["vela-2"]!, pages["orsa-1"]!],
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        createdBy: bossId,
      });
    }
    server = await buildApiServer(app);
    await server.ready();
    const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "boss", password: BOSS_PASSWORD } });
    expect(login.statusCode, login.body).toBe(200);
    const header = login.headers["set-cookie"];
    cookie = (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("links a named sale only when it holds, and records the order whatever its sales", async (context) => {
    if (!testDb || !server) return context.skip();
    const named = [
      { saleRef: String(sales.ok) },
      // The same person's other account, on the model's other page, by the platform's id.
      { pageLabel: "vela-2", transactionRef: "tx-otherAccount" },
      { saleRef: String(sales.foreign) },
      { saleRef: String(sales.otherModel) },
      { saleRef: String(sales.outsideKey) },
      { saleRef: String(sales.held) },
      { saleRef: String(sales.reversed) },
      { saleRef: String(sales.post) },
    ];
    const created = await agent("/api/v1/agent/custom-orders", {
      pageLabel: "vela-1", fan: "7400000101", card: { task: "Ролик с оплатой" }, priceMills: 30_000, sales: named, another: true,
    });
    expect(created.statusCode, created.body).toBe(200);
    const answer = agentCustomOrderResponseSchema.parse(created.json());
    expect(answer.outcome).toBe("created");
    expect(answer.sales!.map((one) => [one.result, one.reason])).toEqual([
      ["linked", null],
      ["linked", null],
      ["refused", "other_fan"],
      ["refused", "other_model"],
      // A page outside the key's: the same as no sale.
      ["refused", "not_found"],
      ["refused", "taken"],
      ["refused", "reversed"],
      ["refused", "wrong_kind"],
    ]);
    expect(answer.sales![4]!.saleRef).toBeNull();
    // The reader's key reads the facts: two sales of $10 against a price of $30.
    expect(answer.order).toMatchObject({ state: "paid", payments: 2, priceMills: 30_000, facts: { paid: { value: "part" } } });

    // A key that only writes the shooting: the order is recorded, no sale is linked, the wire has no facts.
    const shooter = await agent("/api/v1/agent/custom-orders", {
      pageLabel: "vela-1", fan: "7400000101", card: { task: "Ролик без прав на деньги" }, sales: [{ saleRef: String(sales.undo) }], another: true,
    }, SHOOTER);
    expect(shooter.statusCode, shooter.body).toBe(200);
    const recorded = agentCustomOrderResponseSchema.parse(shooter.json());
    expect(recorded).toMatchObject({ outcome: "created", order: { state: "recorded", payments: 0 } });
    expect(recorded.sales!.map((one) => [one.result, one.reason, one.saleRef])).toEqual([["refused", "capability_missing", null]]);
    expect(recorded.order.facts).toBeUndefined();
    const step = await agent(`/api/v1/agent/custom-orders/${recorded.order.code}`, { action: "payment", sale: { saleRef: String(sales.undo) } }, SHOOTER);
    expect(step.statusCode, step.body).toBe(403);
    expect((await agent(`/api/v1/agent/custom-orders/${recorded.order.code}`, { action: "given", messageRef: "9600000001" }, SHOOTER)).statusCode).toBe(403);
    const live = await server!.inject({ method: "GET", url: "/api/v1/agent/custom-orders?state=live", headers: { authorization: `Bearer ${SHOOTER}` } });
    expect(agentCustomOrdersResponseSchema.parse(live.json()).orders.every((order) => order.facts === undefined)).toBe(true);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("takes the agent's «отдан» only by a message the order's fan received: bought, with no file named by the code", async (context) => {
    if (!testDb || !server) return context.skip();
    // Sent to the same person's other account, on the model's other page: it is the order's fan.
    const other = await agent(`/api/v1/agent/custom-orders/${code("otherAccount")}`, { action: "given", messageRef: "9600000002" });
    expect(other.statusCode, other.body).toBe(200);
    expect(agentCustomOrderResponseSchema.parse(other.json()).order).toMatchObject({ state: "given", givenMessageRef: "9600000002" });
    // Priced and not bought.
    const priced = await agent(`/api/v1/agent/custom-orders/${code("priced")}`, { action: "given", messageRef: "9600000003" });
    expect(priced.statusCode, priced.body).toBe(409);
    expect(priced.json()).toMatchObject({ reason: "not_bought" });
    // A vault file carries the order's code: Hub's own rule decides its delivery.
    const named = await agent(`/api/v1/agent/custom-orders/${code("named")}`, { action: "given", messageRef: "9600000004" });
    expect(named.statusCode, named.body).toBe(409);
    expect(named.json()).toMatchObject({ reason: "code_named_file" });
    const states = await testDb.pool.query("select id, state from custom_orders where id = any($1::bigint[]) order by id", [[orders.priced, orders.named]]);
    expect(states.rows.map((row) => row.state)).toEqual(["recorded", "recorded"]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("remembers a person's undo of what the agent applied until the person applies it again, and a revision takes «отдан» off", async (context) => {
    if (!testDb || !server) return context.skip();
    const order = code("undo");
    const id = orders.undo!;
    const sale = { saleRef: String(sales.undo) };
    expect((await agent(`/api/v1/agent/custom-orders/${order}`, { action: "payment", sale })).statusCode).toBe(200);
    // The owner takes the agent's payment off: remembered, and the agent cannot link it again.
    expect((await act(order, { action: "unpay", transactionRef: String(sales.undo) })).statusCode).toBe(200);
    expect(await rejections(id)).toEqual([{ kind: "payment", ref: String(sales.undo) }]);
    const again = await agent(`/api/v1/agent/custom-orders/${order}`, { action: "payment", sale });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json()).toMatchObject({ reason: "rejected" });
    // The owner links it himself: the memory goes.
    const relinked = await act(order, { action: "payment", transactionRef: String(sales.undo) });
    expect(relinked.statusCode, relinked.body).toBe(200);
    expect(await rejections(id)).toEqual([]);

    expect((await act(order, { action: "at_model" })).statusCode).toBe(200);
    expect((await act(order, { action: "shot" })).statusCode).toBe(200);
    expect((await agent(`/api/v1/agent/custom-orders/${order}`, { action: "given", messageRef: "9600000001" })).statusCode).toBe(200);
    // «Не отдан»: «снят» again, the message remembered off the order.
    const ungiven = customOrderDetailResponseSchema.parse((await act(order, { action: "ungive" })).json());
    expect(ungiven.order).toMatchObject({ state: "shot", givenAt: null, givenMessageRef: null });
    expect(await rejections(id)).toEqual([{ kind: "given", ref: "9600000001" }]);
    const regiven = await agent(`/api/v1/agent/custom-orders/${order}`, { action: "given", messageRef: "9600000001" });
    expect(regiven.statusCode, regiven.body).toBe(409);
    expect(regiven.json()).toMatchObject({ reason: "rejected" });
    // The owner marks it by that message himself: the memory goes.
    const given = customOrderDetailResponseSchema.parse((await act(order, { action: "given", messageRef: "9600000001" })).json());
    expect(given.order).toMatchObject({ state: "given", givenMessageRef: "9600000001" });
    expect(await rejections(id)).toEqual([]);

    // The fan wants it redone: «правка», and «отдан» is off the order.
    const revision = customOrderDetailResponseSchema.parse((await act(order, { action: "revision", note: "другой ракурс" })).json());
    expect(revision.order).toMatchObject({ state: "revision", givenAt: null, givenMessageRef: null, facts: { given: { value: "no" } } });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses the agent's «отдан» by a message priced in its media offer that the fan has not bought", async (context) => {
    if (!testDb || !server) return context.skip();
    const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
    const id = await recordCustomOrder(app, {
      pageId: pages["vela-1"]!, fanId: fans.a!, buyer: null, conversationRef: null, card: { task: "Ролик за PPV" }, deadlineOn: null,
      acceptedByUserId: bossId, origin: "agent", actor: { door: "system" }, createdAt: new Date(Date.now() - 180 * 60_000),
    });
    // A Fansly PPV: the message itself carries no price, its media offer does.
    await q(`insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain,
               media_metadata, message_type, is_tip, tip_amount_mills, price_mills)
             values ($1, 'fansly', 'conv-a', '9600000005', 'model', true, $2, '', '[{"id": "1"}]'::jsonb, 1, false, 0, null)`,
    [pages["vela-1"], minutesAgo(50)]);
    await q(`insert into message_media_offers (page_id, platform, message_ref, offer_ordinal, media_offer_ref, conversation_ref, fan_platform_user_id,
               message_created_at, price_mills, purchase_state, first_observed_at, last_observed_at, content_hash, source_event_id,
               source_observation_id, source_account_seq)
             values ($1, 'fansly', '9600000005', 0, '9700000005', 'conv-a', '7400000999', $2, 30000, 'unknown', now(), now(), $3, 1, 1, 1)`,
    [pages["vela-1"], minutesAgo(50), "1".repeat(64)]);
    const given = await agent(`/api/v1/agent/custom-orders/K-${id}`, { action: "given", messageRef: "9600000005" });
    expect(given.statusCode, given.body).toBe(409);
    expect(given.json()).toMatchObject({ reason: "not_bought" });
    expect((await testDb.pool.query("select state from custom_orders where id = $1", [id])).rows[0].state).toBe("recorded");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("links the bought purchase of the message the agent names with «отдан», in the same step — and on a repeat of a mark set without it", async (context) => {
    if (!testDb || !server) return context.skip();
    const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
    const order = async (task: string) => recordCustomOrder(app, {
      pageId: pages["vela-1"]!, fanId: fans.a!, buyer: null, conversationRef: null, card: { task }, deadlineOn: null,
      acceptedByUserId: bossId, origin: "agent", actor: { door: "system" }, createdAt: new Date(Date.now() - 180 * 60_000),
    });
    /** A PPV to fan A priced in its one offer, and his purchase of that offer after it. Answers the message and the purchase. */
    const boughtPpv = async (messageRef: string, offerRef: string) => {
      await q(`insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain,
                 media_metadata, message_type, is_tip, tip_amount_mills, price_mills)
               values ($1, 'fansly', 'conv-a', $2, 'model', true, $3, '', '[{"id": "1"}]'::jsonb, 1, false, 0, null)`,
      [pages["vela-1"], messageRef, minutesAgo(60)]);
      await q(`insert into message_media_offers (page_id, platform, message_ref, offer_ordinal, media_offer_ref, conversation_ref, fan_platform_user_id,
                 message_created_at, price_mills, purchase_state, first_observed_at, last_observed_at, content_hash, source_event_id,
                 source_observation_id, source_account_seq)
               values ($1, 'fansly', $2, 0, $3, 'conv-a', '7400000999', $4, 25000, 'unknown', now(), now(), $5, 1, 1, 1)`,
      [pages["vela-1"], messageRef, offerRef, minutesAgo(60), "2".repeat(64)]);
      return Number((await q(
        `insert into transactions (platform_account_id, fan_id, transaction_id, correlation_id, raw_type, canonical_type, transaction_state, raw_status,
           gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, currency)
         values ($1, $2, $3, $4, 'message_purchase', 'message_purchase', 'posted', 'ok', 25000, 25000, 20000, $5, 'fansly:rest', 'USD') returning id`,
        [pages["vela-1"], fans.a, `tx-buy-${messageRef}`, offerRef, minutesAgo(40)],
      )).rows[0].id);
    };
    const payments = async (id: number) => (await q("select transaction_id from custom_order_payments where order_id = $1", [id])).rows.map((row) => Number(row.transaction_id));

    // The agent's «отдан»: the mark and the purchase together.
    const fresh = await order("Ролик за купленный PPV");
    const purchase = await boughtPpv("9600000006", "9700000006");
    const given = await agent(`/api/v1/agent/custom-orders/K-${fresh}`, { action: "given", messageRef: "9600000006" });
    expect(given.statusCode, given.body).toBe(200);
    expect(agentCustomOrderResponseSchema.parse(given.json()).order).toMatchObject({ state: "given", givenMessageRef: "9600000006" });
    expect(await payments(fresh)).toEqual([purchase]);

    // An order given by that message before the purchase was linked (as production's): naming it again links it.
    const before = await order("Ролик, отданный без оплаты");
    const late = await boughtPpv("9600000007", "9700000007");
    await testDb.pool.query("update custom_orders set state = 'given', given_message_ref = '9600000007', given_at = now() where id = $1", [before]);
    const again = await agent(`/api/v1/agent/custom-orders/K-${before}`, { action: "given", messageRef: "9600000007" });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ outcome: "changed" });
    expect(await payments(before)).toEqual([late]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses a person's change of the fan when the order's payment is another fan's; the same person's other account takes it", async (context) => {
    if (!testDb || !server) return context.skip();
    const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
    const sale = Number((await q(
      `insert into transactions (platform_account_id, fan_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
         gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, currency)
       values ($1, $2, 'tx-fanchange', 'tip', 'tip', 'posted', 'ok', 30000, 30000, 24000, $3, 'fansly:rest', 'USD') returning id`,
      [pages["vela-1"], fans.a, minutesAgo(90)],
    )).rows[0].id);
    const id = await recordCustomOrder(app, {
      pageId: pages["vela-1"]!, fanId: fans.a!, buyer: null, conversationRef: null, card: { task: "Ролик с оплатой фана A" }, deadlineOn: null,
      acceptedByUserId: bossId, origin: "workboard", paymentTransactionId: sale, actor: { door: "workboard", userId: bossId },
      createdAt: new Date(Date.now() - 180 * 60_000),
    });
    const other = await act(`K-${id}`, { action: "fan", pageLabel: "vela-1", fan: "7400000103" });
    expect(other.statusCode, other.body).toBe(409);
    expect(other.json()).toMatchObject({ reason: "evidence_other_fan" });
    expect(Number((await q("select fan_id from custom_orders where id = $1", [id])).rows[0].fan_id)).toBe(fans.a);
    // His own other account on the model's other page: the evidence is his.
    const same = await act(`K-${id}`, { action: "fan", pageLabel: "vela-2", fan: "7400000102" });
    expect(same.statusCode, same.body).toBe(200);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("links a finding's sale to an order only when it is the order's fan's, and leaves the finding open otherwise", async (context) => {
    if (!testDb || !server) return context.skip();
    const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
    const id = await recordCustomOrder(app, {
      pageId: pages["vela-1"]!, fanId: fans.a!, buyer: null, conversationRef: null, card: { task: "Ролик по находке" }, deadlineOn: null,
      acceptedByUserId: bossId, origin: "agent", actor: { door: "system" }, createdAt: new Date(Date.now() - 180 * 60_000),
    });
    const tip = async (key: string, fanKey: string) => Number((await q(
      `insert into transactions (platform_account_id, fan_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
         gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, currency)
       values ($1, $2, $3, 'tip', 'tip', 'posted', 'ok', 40000, 40000, 32000, $4, 'fansly:rest', 'USD') returning id`,
      [pages["vela-1"], fans[fanKey], `tx-${key}`, minutesAgo(90)],
    )).rows[0].id);
    const finding = async (sale: number, fanKey: string) => Number((await q(
      `insert into custom_findings (source, ref, page_id, fan_id, amount_mills, quote, happened_at)
       values ('sale', $1, $2, $3, 40000, 'for the custom', $4) returning id`,
      [String(sale), pages["vela-1"], fans[fanKey], minutesAgo(90)],
    )).rows[0].id);
    const link = (findingId: number) => server!.inject({
      method: "POST", url: `/api/v1/custom-orders/findings/${findingId}`, headers: { cookie }, payload: { action: "link", code: `K-${id}` },
    });
    const payments = async () => (await q("select transaction_id from custom_order_payments where order_id = $1", [id])).rows.map((row) => Number(row.transaction_id));

    // Another fan's money never pays this fan's order: refused, nothing linked, the finding still waits.
    const foreignSale = await tip("findingForeign", "b");
    const foreign = await finding(foreignSale, "b");
    const refused = await link(foreign);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ reason: "other_fan" });
    expect(await payments()).toEqual([]);
    expect((await q("select status from custom_findings where id = $1", [foreign])).rows[0].status).toBe("open");

    // The order's own fan's sale: it pays the order, and the finding is linked.
    const ownSale = await tip("findingOwn", "a");
    const own = await finding(ownSale, "a");
    const linked = await link(own);
    expect(linked.statusCode, linked.body).toBe(200);
    expect(linked.json()).toMatchObject({ finding: { status: "linked", orderCode: `K-${id}` } });
    expect(await payments()).toEqual([ownSale]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
