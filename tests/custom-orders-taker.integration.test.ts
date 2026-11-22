import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createFanslyPage, createModel, findCustomOrder, findCustomPageMessage, insertAgentKey, upsertTransaction } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { applyCustomStep, recordCustomOrder, type CustomTakerResult } from "../apps/runtime/src/services/custom-orders/index.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// K-113 (2026-11-22): an order was shown as the customs lead's to give although a chatter took it — its taker was
// written empty and nothing could set it after. The taker is a fact with a source now: a work card's author by Telegram
// id (never by a name, never the model's group copy), a sale whose one home is one chatter's whole, a person's choice.
// Evidence fills only an empty taker; a person's choice is theirs and nothing changes it again. And the agent's «отдан»
// by a message: bought is the custom's own priced offer, never any offer of the message; a mass message counts for
// nothing. Every name and number here is made up.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const AUDIT = { source: "cli" } as const;
const PASSWORD = "boss-secret";
const TG = { ivan: "987300001", masha: "987300002", nikita: "987300003" } as const;
const HASH = "d".repeat(64);
/** Gengar: write:customs with the chats. */
const KEY = `${AGENT_KEY_TOKEN_PREFIX}customs-taker-0000`;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let cookie = "";
const users: Record<string, number> = {};
const pages: Record<string, number> = {};
let fanId = 0;
let nextRef = 1;

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const taker = async (orderId: number) => (await findCustomOrder(app.db, orderId))!.acceptedByUserId;
const record = () => recordCustomOrder(app, {
  pageId: pages["vela-1"]!, fanId, buyer: null, conversationRef: null, card: { task: `Ролик ${nextRef++}` }, deadlineOn: null,
  acceptedByUserId: null, origin: "agent", actor: { door: "system" },
});
/** A step by the system's door with the taker's outcome reported. */
async function step(orderId: number, body: Parameters<typeof applyCustomStep>[1]["step"]): Promise<CustomTakerResult | undefined> {
  const report: { event: null; taker?: CustomTakerResult } = { event: null };
  await applyCustomStep(app, { orderId, step: body, actor: { door: "system" }, viewer: null, report });
  return report.taker;
}
const card = (cardKind: "work" | "model", author: string) => ({ action: "card" as const, telegramRef: `tg:2600000001/3/${nextRef++}`, cardKind, authorTelegramId: author });
const act = (code: string, payload: Record<string, unknown>) =>
  server!.inject({ method: "POST", url: `/api/v1/custom-orders/${code}`, headers: { cookie }, payload });

/** A sale of the fan on vela-1 and its home: one chatter's whole, or shared. */
async function sale(shares: Array<{ user: string; percent: number }>): Promise<number> {
  const name = `tx-${nextRef++}`;
  await upsertTransaction(app.db, {
    platformAccountId: pages["vela-1"]!, source: "fansly:rest", fanId, transactionId: name, rawType: "tip", canonicalType: "tip",
    transactionState: "posted", rawStatus: "ok", grossAmountMills: 50_000n, sourceDestinationAmountMills: 50_000n, creatorNetAmountMills: 40_000n,
    occurredAt: new Date(Date.now() - 3_600_000),
  });
  const id = Number((await q("select id from transactions where transaction_id = $1", [name])).rows[0].id);
  await q(`insert into sale_homes (transaction_id, page_id, occurred_at, net_mills, home, reason, shares, rule_version, computed_at)
           values ($1, $2, now() - interval '1 hour', 40000, 'shift', 'holder', $3::jsonb, 'test', now())`,
  [id, pages["vela-1"], JSON.stringify(shares.map((one) => ({ userId: users[one.user], workRef: null, shiftId: null, percent: one.percent, mills: 400 * one.percent })))]);
  return id;
}

/** A page's message to the fan with priced offers, each bought or not (its own mark). Answers its ref. */
async function message(offers: Array<{ price: number; purchased: boolean }>, messageType = 1): Promise<string> {
  const ref = String(9_700_000_000 + nextRef++);
  await q(`insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain,
             media_metadata, price_mills, message_type)
           values ($1, 'fansly', 'conv-a', $2, 'model', true, now() - interval '30 minutes', '', '[{"type":"video"}]'::jsonb, null, $3)`,
  [pages["vela-1"], ref, messageType]);
  for (const [ordinal, one] of offers.entries()) {
    await q(`insert into message_media_offers (page_id, platform, message_ref, offer_ordinal, media_offer_ref, bundle_ref, conversation_ref,
               fan_platform_user_id, message_created_at, price_mills, purchase_state, first_observed_at, last_observed_at, content_hash,
               source_event_id, source_observation_id, source_account_seq)
             values ($1, 'fansly', $2, $3, $4, null, 'conv-a', '7500000999', now() - interval '30 minutes', $5, $6, now(), now(), $7, 1, 1, 1)`,
    [pages["vela-1"], ref, ordinal, `offer-${ref}-${ordinal}`, one.price, one.purchased ? "purchased" : "unknown", HASH]);
  }
  return ref;
}

describe("custom orders: «принял» by construction", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: PASSWORD }, AUDIT);
    users.boss = await fixtureUserId(app, "boss");
    const model = await createModel(app.db, { slug: "vela", name: "Vela" });
    for (const label of ["vela-1", "vela-2"]) pages[label] = (await createFanslyPage(app.db, { modelId: model!.id, label }))!.id;
    // ivan and masha work vela-1; nikita works only vela-2. Two of them say «Ваня» of themselves: no name ever names one.
    for (const [name, page] of [["ivan", "vela-1"], ["masha", "vela-1"], ["nikita", "vela-2"]] as const) {
      await createUserAccount(app, { username: name, role: "chatter" }, AUDIT);
      users[name] = await fixtureUserId(app, name);
      await setUserPassword(app, { userId: users[name]!, password: PASSWORD }, AUDIT);
      const person = (await q("insert into people (code, display_name, role, state, telegram_user_id) values ($1, $2, 'chatter', 'working', $3) returning id",
        [name, name === "masha" ? "Маша" : "Ваня", TG[name]])).rows[0].id;
      await q("insert into person_logins (user_id, person_id) values ($1, $2)", [users[name], person]);
      await q("insert into person_working_pages (person_id, page_id, position) values ($1, $2, 0)", [person, pages[page]]);
    }
    fanId = Number((await q("insert into fans (platform, platform_user_id, username) values ('fansly', '7400000201', 'fan_taker') returning id")).rows[0].id);
    await q("insert into page_fans (fan_id, platform_account_id, is_subscriber) values ($1, $2, true)", [fanId, pages["vela-1"]]);
    await q(`insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id, partner_username, last_message_at)
             values ($1, $2, 'conv-a', '7400000201', 'fan_taker', now())`, [pages["vela-1"], fanId]);
    await insertAgentKey(app.db, {
      name: "gengar", keyPrefix: KEY.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(KEY),
      capabilities: ["write:customs", "read:messages"] as never, pageIds: [pages["vela-1"]!, pages["vela-2"]!],
      expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000), createdBy: users.boss!,
    });
    server = await buildApiServer(app);
    await server.ready();
    const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "boss", password: PASSWORD } });
    expect(login.statusCode, login.body).toBe(200);
    const header = login.headers["set-cookie"];
    cookie = (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("a work card's author by Telegram id names the taker; the model's group copy never; nobody off the page", async (context) => {
    if (!testDb) return context.skip();
    const order = await record();
    expect(await step(order, card("model", TG.ivan))).toBeUndefined();
    expect(await taker(order)).toBeNull();
    // nikita works another page of the model: he is nobody's taker here.
    expect(await step(order, card("work", TG.nikita))).toMatchObject({ result: "unchanged", reason: "taker_unknown" });
    expect(await taker(order)).toBeNull();
    expect(await step(order, card("work", TG.ivan))).toMatchObject({ result: "set", source: "card" });
    expect(await taker(order)).toBe(users.ivan);
    const events = await q("select changes from object_events where object_type = 'custom_order' and object_id = $1 and event = 'custom_order.accepted_by'", [String(order)]);
    expect(events.rows.map((row) => row.changes)).toEqual([expect.objectContaining({ from: null, to: users.ivan, source: "card" })]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("evidence fills only an empty taker; a person's choice replaces it and stands, their empty one too", async (context) => {
    if (!testDb || !server) return context.skip();
    const order = await record();
    await step(order, card("work", TG.ivan));
    // Another work card, another author: unchanged with its reason, never an overwrite.
    expect(await step(order, card("work", TG.masha))).toMatchObject({ result: "unchanged", reason: "taker_set" });
    expect(await taker(order)).toBe(users.ivan);
    // The owner corrects it on the board.
    const corrected = await act(`K-${order}`, { action: "accepted_by", acceptedBy: "masha" });
    expect(corrected.statusCode, corrected.body).toBe(200);
    expect(corrected.json().order).toMatchObject({ acceptedBy: "masha", acceptedByName: "Маша" });
    // An agent's evidence against a person's choice: refused, the person's stands.
    await expect(applyCustomStep(app, {
      orderId: order, step: { action: "accepted_by", taker: { userId: users.ivan!, login: "ivan", name: "Ваня", role: "chatter" }, by: "evidence", source: "agent" },
      actor: { door: "system" }, viewer: null,
    })).rejects.toMatchObject({ reason: "taker_set" });
    expect(await taker(order)).toBe(users.masha);
    // Nobody off the page, by the board either.
    expect((await act(`K-${order}`, { action: "accepted_by", acceptedBy: "nikita" })).json()).toMatchObject({ reason: "taker_unknown" });
    // A person who empties it meant it: no evidence fills it again.
    expect((await act(`K-${order}`, { action: "accepted_by", acceptedBy: null })).statusCode).toBe(200);
    expect(await step(order, card("work", TG.ivan))).toMatchObject({ result: "unchanged", reason: "person_set" });
    expect(await taker(order)).toBeNull();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a linked sale whose one home is one chatter's whole names the taker; a shared one names nobody", async (context) => {
    if (!testDb) return context.skip();
    const order = await record();
    const shared = await sale([{ user: "ivan", percent: 50 }, { user: "masha", percent: 50 }]);
    await step(order, { action: "payment", transactionId: shared });
    expect(await taker(order)).toBeNull();
    const whole = await sale([{ user: "masha", percent: 100 }]);
    expect(await step(order, { action: "payment", transactionId: whole })).toMatchObject({ result: "set", source: "sale" });
    expect(await taker(order)).toBe(users.masha);
    // A later sale wholly another chatter's changes nothing.
    const other = await sale([{ user: "ivan", percent: 100 }]);
    expect(await step(order, { action: "payment", transactionId: other })).toMatchObject({ result: "unchanged", reason: "taker_set" });
    expect(await taker(order)).toBe(users.masha);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("on a person's word the agent takes the board's step as that person, never more; the feed tells what changed", async (context) => {
    if (!testDb || !server) return context.skip();
    const agent = (url: string, payload: Record<string, unknown>) => server!.inject({ method: "POST", url, headers: { authorization: `Bearer ${KEY}` }, payload });
    const order = await record();
    await step(order, card("work", TG.ivan));
    const request = "https://t.me/c/2600000001/5/900";
    // The agent's own evidence never replaces a set taker…
    expect((await agent(`/api/v1/agent/custom-orders/K-${order}`, { action: "accepted_by", acceptedBy: "masha" })).json()).toMatchObject({ reason: "taker_set" });
    // …a chatter's word is no more than the chatter's own right on the board…
    const refused = await agent(`/api/v1/agent/custom-orders/K-${order}`, {
      action: "board", step: { action: "accepted_by", acceptedBy: "masha" }, onBehalfOf: "masha", requestRef: request,
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ reason: "not_allowed" });
    // …and the owner's word is his: the taker replaced, kept as his, the request in the history.
    const done = await agent(`/api/v1/agent/custom-orders/K-${order}`, {
      action: "board", step: { action: "accepted_by", acceptedBy: "masha" }, onBehalfOf: "boss", requestRef: request,
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ outcome: "changed", order: { acceptedBy: "masha" } });
    expect((await findCustomOrder(app.db, order))!.personFields).toContain("acceptedBy");
    const feed = await server.inject({ method: "GET", url: "/api/v1/agent/custom-orders/events?after=0", headers: { authorization: `Bearer ${KEY}` } });
    expect(feed.statusCode, feed.body).toBe(200);
    const mine = (feed.json() as { events: Array<{ code: string | null; event: string; onBehalfOf: { login: string } | null; changes: Record<string, unknown> }> })
      .events.filter((one) => one.code === `K-${order}` && one.event === "custom_order.accepted_by");
    expect(mine.at(-1)).toMatchObject({ onBehalfOf: { login: "boss" }, changes: { to: users.masha, source: "manual", requestRef: "tg:2600000001/5/900" } });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("the agent's «отдан» by a message: bought is the custom's own priced offer; a mass message is none", async (context) => {
    if (!testDb) return context.skip();
    const bought = async (ref: string) => (await findCustomPageMessage(app.db, { pageIds: [pages["vela-1"]!], messageRef: ref }))?.bought;
    // One priced offer: it is the custom's.
    expect(await bought(await message([{ price: 30_000, purchased: true }]))).toBe(true);
    expect(await bought(await message([{ price: 30_000, purchased: false }]))).toBe(false);
    // Two priced offers and only the cheaper bought: the custom's may be the other — not bought.
    expect(await bought(await message([{ price: 5_000, purchased: true }, { price: 30_000, purchased: false }]))).toBe(false);
    expect(await bought(await message([{ price: 5_000, purchased: true }, { price: 30_000, purchased: true }]))).toBe(true);
    // A mass message carries no custom.
    expect(await findCustomPageMessage(app.db, { pageIds: [pages["vela-1"]!], messageRef: await message([{ price: 30_000, purchased: true }], 2) })).toBeNull();
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
