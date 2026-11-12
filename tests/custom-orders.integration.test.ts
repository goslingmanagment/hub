import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { agentCustomOrderResponseSchema, customOrderDetailResponseSchema, customOrdersBoardResponseSchema } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, assignPageToUser, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { recordCustomOrder } from "../apps/runtime/src/services/custom-orders/index.ts";
import { executeErasure, planErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Заказ кастома (package I), the rights: a chatter sees no order of a page they
// do not work and cannot open or move one; a chatter takes only their own steps
// (a payment, «отдали», their own card and cancel), never the lead's — the lead
// (the narrow right «ведёт кастомы») takes them on every page; an agent key
// writes only with write:customs, only on its pages, and never overwrites a
// field a person edited.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const AUDIT = { source: "cli" } as const;
const PASSWORDS = { boss: "boss-secret", alice: "alice-secret", dave: "dave-secret", carol: "carol-secret" } as const;
const WRITER = `${AGENT_KEY_TOKEN_PREFIX}customs-writer-00`;
const OTHER = `${AGENT_KEY_TOKEN_PREFIX}customs-other-000`;
let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const users: Record<string, number> = {};
const pages: Record<string, number> = {};
const cookies: Record<string, string> = {};
const orders: Record<string, string> = {};

async function loginCookie(username: keyof typeof PASSWORDS): Promise<string> {
  const login = await server!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: PASSWORDS[username] } });
  expect(login.statusCode, login.body).toBe(200);
  const header = login.headers["set-cookie"];
  return (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
}
const get = (who: string, url: string) => server!.inject({ method: "GET", url, headers: { cookie: cookies[who]! } });
const act = (who: string, code: string, payload: Record<string, unknown>) =>
  server!.inject({ method: "POST", url: `/api/v1/custom-orders/${code}`, headers: { cookie: cookies[who]! }, payload });
const agent = (url: string, payload: Record<string, unknown>, token = WRITER) =>
  server!.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload });

describe("custom orders: who sees and moves what", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: PASSWORDS.boss }, AUDIT);
    for (const name of ["alice", "dave", "carol"] as const) {
      await createUserAccount(app, { username: name, role: "chatter" }, AUDIT);
      await setUserPassword(app, { userId: await fixtureUserId(app, name), password: PASSWORDS[name] }, AUDIT);
    }
    for (const name of ["boss", "alice", "dave", "carol"]) users[name] = await fixtureUserId(app, name);
    const model = await createModel(app.db, { slug: "lora", name: "Lora" });
    for (const label of ["lora-1", "lora-2"]) pages[label] = (await createFanslyPage(app.db, { modelId: model!.id, label }))!.id;
    // alice and dave work lora-1; carol works lora-1 too and «ведёт кастомы».
    for (const name of ["alice", "dave", "carol"]) await assignPageToUser(app, { userId: users[name]!, pageLabel: "lora-1" }, AUDIT);
    const person = (await testDb.pool.query<{ id: string }>(
      "insert into people (code, display_name, role, state) values ('carol', 'Carol', 'chatter', 'working') returning id",
    )).rows[0]!.id;
    await testDb.pool.query("insert into person_logins (user_id, person_id) values ($1, $2)", [users.carol, person]);
    await testDb.pool.query("insert into person_rights (person_id, \"right\") values ($1, 'customs_lead')", [person]);

    const fanOn = async (pageLabel: string, ref: string, username: string) => {
      const fanId = Number((await testDb!.pool.query<{ id: string }>(
        "insert into fans (platform, platform_user_id, username) values ('fansly', $1, $2) returning id", [ref, username],
      )).rows[0]!.id);
      await testDb!.pool.query("insert into page_fans (fan_id, platform_account_id, is_subscriber) values ($1, $2, true)", [fanId, pages[pageLabel]]);
      return fanId;
    };
    const record = async (key: string, pageLabel: string, fanId: number, acceptedBy: string) => {
      const id = await recordCustomOrder(app, {
        pageId: pages[pageLabel]!, fanId, buyer: null, conversationRef: null, card: { task: `Заказ ${key}`, price: "100$" },
        deadlineOn: null, acceptedByUserId: users[acceptedBy]!, origin: "extension", actor: { door: "extension", userId: users[acceptedBy]! },
      });
      orders[key] = `K-${id}`;
    };
    await record("alices", "lora-1", await fanOn("lora-1", "7400000001", "fan_one"), "alice");
    await record("daves", "lora-1", await fanOn("lora-1", "7400000002", "fan_two"), "dave");
    await record("elsewhere", "lora-2", await fanOn("lora-2", "7400000003", "fan_three"), "boss");

    for (const [token, capabilities] of [[WRITER, ["write:customs"]], [OTHER, ["write:matters"]]] as const) {
      await insertAgentKey(app.db, {
        name: token === WRITER ? "gengar" : "other",
        keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
        keyDigest: sha256Hex(token),
        capabilities: [...capabilities] as never,
        pageIds: [pages["lora-1"]!],
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        createdBy: users.boss!,
      });
    }
    server = await buildApiServer(app);
    await server.ready();
    for (const name of ["boss", "alice", "dave", "carol"] as const) cookies[name] = await loginCookie(name);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("gives a chatter no order of a page they do not work: not on the board, not by its code, not to move", async (context) => {
    if (!testDb || !server) return context.skip();
    const board = customOrdersBoardResponseSchema.parse((await get("alice", "/api/v1/custom-orders")).json());
    expect(board.orders.map((order) => order.code).sort()).toEqual([orders.alices, orders.daves].sort());
    expect(board.viewer).toEqual({ lead: false, owner: false });
    expect((await get("alice", `/api/v1/custom-orders/${orders.elsewhere}`)).statusCode).toBe(404);
    expect((await act("alice", orders.elsewhere!, { action: "cancel" })).statusCode).toBe(404);
    expect((await get("alice", "/api/v1/custom-orders?pageLabel=lora-2")).statusCode).toBe(404);
    // The owner and the lead see every page's.
    for (const who of ["boss", "carol"]) {
      const all = customOrdersBoardResponseSchema.parse((await get(who, "/api/v1/custom-orders")).json());
      expect(all.orders).toHaveLength(3);
      expect(all.viewer.lead).toBe(true);
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps the lead's steps the lead's: a chatter moves no order to the model, shot or closed, cancels only their own", async (context) => {
    if (!testDb || !server) return context.skip();
    const before = customOrderDetailResponseSchema.parse((await get("alice", `/api/v1/custom-orders/${orders.daves}`)).json());
    expect(before.actions).toEqual(["payment", "given"]);
    for (const payload of [{ action: "at_model" }, { action: "shot" }, { action: "refused", reason: "нет" }, { action: "cancel" }, { action: "edit", card: { task: "другое" } }]) {
      const refused = await act("alice", orders.daves!, payload);
      expect(refused.statusCode, JSON.stringify(payload)).toBe(409);
      expect(refused.json()).toMatchObject({ reason: "not_allowed" });
    }
    // Even on her own order the model's steps are not hers; cancelling it is.
    expect((await act("alice", orders.alices!, { action: "at_model" })).statusCode).toBe(409);
    expect(customOrderDetailResponseSchema.parse((await get("alice", `/api/v1/custom-orders/${orders.alices}`)).json()).actions)
      .toEqual(expect.arrayContaining(["edit", "fan", "payment", "given", "cancel"]));
    const state = (code: string) => testDb!.pool.query("select state from custom_orders where id = $1", [Number(code.slice(2))]).then((result) => result.rows[0].state);
    expect(await state(orders.daves!)).toBe("recorded");

    // The lead takes them — on a page she works and on one she does not; the history says who and through which door.
    const moved = await act("carol", orders.daves!, { action: "at_model", telegramRef: "https://t.me/c/2600000001/3/100" });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await act("carol", orders.elsewhere!, { action: "at_model" })).statusCode).toBe(200);
    const shot = customOrderDetailResponseSchema.parse((await act("carol", orders.daves!, { action: "shot" })).json());
    expect(shot.order.state).toBe("shot");
    expect(shot.order.telegramRefs).toEqual(["tg:2600000001/3/100"]);
    expect(shot.history.map((item) => [item.event, item.actor, item.door])).toEqual([
      ["custom_order.recorded", "dave", "extension"],
      ["custom_order.at_model", "Carol", "workboard"],
      ["custom_order.shot", "Carol", "workboard"],
    ]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("lets an agent key write only with write:customs, on its pages, and never over a person's edit", async (context) => {
    if (!testDb || !server) return context.skip();
    const card = { task: "1. Стриптиз, ~3 мин", price: "150$ чаевые", duration: "3 минуты" };
    expect((await agent("/api/v1/agent/custom-orders", { pageLabel: "lora-1", fan: "fan_one", card }, OTHER)).statusCode).toBe(403);
    expect((await agent(`/api/v1/agent/custom-orders/${orders.alices}`, { action: "shot", ref: "tg:2600000001/3/101" }, OTHER)).statusCode).toBe(403);
    expect((await agent("/api/v1/agent/custom-orders", { pageLabel: "lora-2", fan: "fan_three", card })).statusCode).toBe(404);
    expect((await agent(`/api/v1/agent/custom-orders/${orders.elsewhere}`, { action: "edit", card: { notes: "x" } })).statusCode).toBe(404);

    const created = await agent("/api/v1/agent/custom-orders", {
      pageLabel: "lora-1", fan: "https://fansly.com/fan_one/posts", acceptedBy: "alice", card, telegramRef: "https://t.me/c/2600000002/6/200",
    });
    expect(created.statusCode, created.body).toBe(200);
    const order = agentCustomOrderResponseSchema.parse(created.json()).order;
    expect(order).toMatchObject({ state: "recorded", acceptedBy: "alice", fan: { username: "fan_one" }, telegramRefs: ["tg:2600000002/6/200"] });
    // The same card again is the same order.
    const again = agentCustomOrderResponseSchema.parse((await agent("/api/v1/agent/custom-orders", { pageLabel: "lora-1", card, telegramRef: "tg:2600000002/6/200" })).json());
    expect(again).toMatchObject({ outcome: "unchanged", order: { id: order.id } });

    // A person edits the price; the agent's edit of it is refused, of another field goes through; a stale version is refused.
    expect((await act("alice", order.code, { action: "edit", card: { ...card, price: "200$ чаевые" } })).statusCode).toBe(200);
    const overwrite = await agent(`/api/v1/agent/custom-orders/${order.code}`, { action: "edit", card: { price: "150$" } });
    expect(overwrite.statusCode).toBe(409);
    expect(overwrite.json()).toMatchObject({ reason: "edited_by_person" });
    const notes = agentCustomOrderResponseSchema.parse((await agent(`/api/v1/agent/custom-orders/${order.code}`, { action: "edit", card: { notes: "Снимаешь вертикально." } })).json());
    expect(notes.order.card).toMatchObject({ price: "200$ чаевые", notes: "Снимаешь вертикально." });
    const stale = await agent(`/api/v1/agent/custom-orders/${order.code}`, { action: "edit", card: { urgency: "Высокая" }, ifVersion: 1 });
    expect(stale.json()).toMatchObject({ reason: "version_changed" });

    // The reader of the models' groups: a delivery of the video, then a revision request twice (once kept).
    expect((await act("carol", order.code, { action: "at_model" })).statusCode).toBe(200);
    const delivered = agentCustomOrderResponseSchema.parse((await agent(`/api/v1/agent/custom-orders/${order.code}`, {
      action: "delivery", message: { telegramRef: "tg:2600000001/3/300", excerpt: "6-08 стриптиз.mov" }, part: "video",
    })).json());
    expect(delivered.order).toMatchObject({ state: "shot", partsDone: ["video"] });
    const revision = { action: "revision", message: { telegramRef: "tg:2600000001/3/301" }, ordinal: 1, text: "без музыки" };
    expect(agentCustomOrderResponseSchema.parse((await agent(`/api/v1/agent/custom-orders/${order.code}`, revision)).json()).outcome).toBe("changed");
    const repeat = agentCustomOrderResponseSchema.parse((await agent(`/api/v1/agent/custom-orders/${order.code}`, revision)).json());
    expect(repeat).toMatchObject({ outcome: "unchanged", order: { state: "revision", openRevisions: 1 } });

    // The reader's reads and reports (both answered 500 once: their audit lines broke the audit's own shapes).
    const listed = await server!.inject({ method: "GET", url: `/api/v1/agent/custom-orders?code=${order.code}`, headers: { authorization: `Bearer ${WRITER}` } });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().orders.map((one: { code: string }) => one.code)).toEqual([order.code]);
    const cards = await agent("/api/v1/agent/custom-orders/cards", { cards: [{ telegramRef: "tg:2600000001/3/400" }, { telegramRef: "tg:2600000002/6/200" }], complete: true });
    expect(cards.statusCode, cards.body).toBe(200);
    expect(cards.json()).toMatchObject({ matched: [{ telegramRef: "tg:2600000002/6/200", code: order.code }], opened: 1 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  /** A fresh order of lora-1 at the model, no Telegram card yet. */
  async function atModel(task: string): Promise<string> {
    const id = await recordCustomOrder(app, {
      pageId: pages["lora-1"]!, fanId: null, buyer: null, conversationRef: null, card: { task }, deadlineOn: null,
      acceptedByUserId: users.alice!, origin: "extension", actor: { door: "extension", userId: users.alice! },
    });
    expect((await act("carol", `K-${id}`, { action: "at_model" })).statusCode).toBe(200);
    return `K-${id}`;
  }
  const step = async (code: string, payload: Record<string, unknown>) => {
    const response = await agent(`/api/v1/agent/custom-orders/${code}`, payload);
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { order: { state: string; partsDone: string[]; openRevisions: number; messages: Array<Record<string, unknown>> }; outcome: string; event?: unknown };
  };

  it("keeps a revision open until its own round is delivered whole: a part of the new version is not «снят»", async (context) => {
    if (!testDb || !server) return context.skip();
    const code = await atModel("Ролик с правкой");
    expect((await step(code, { action: "delivery", message: { telegramRef: "tg:2600000001/3/500" }, part: "video" })).order.state).toBe("shot");
    // The model's group asks for a fix; the model sends a first piece of the new version, not the whole of it.
    expect((await step(code, { action: "revision", message: { telegramRef: "tg:2600000001/3/501" }, ordinal: 1, text: "без музыки" })).order.state).toBe("revision");
    const piece = await step(code, { action: "delivery", message: { telegramRef: "tg:2600000001/3/502" }, part: "video", complete: false });
    expect(piece.order).toMatchObject({ state: "revision", openRevisions: 1 });
    // The whole new version answers the request: the order is shot again, nothing open.
    const whole = await step(code, { action: "delivery", message: { telegramRef: "tg:2600000001/3/503" }, part: "video", complete: true });
    expect(whole.order).toMatchObject({ state: "shot", openRevisions: 0 });

    // «Правка» on the board (no message of the model's group) is a requirement as well.
    expect((await act("carol", code, { action: "revision", note: "фан просит другое начало" })).statusCode).toBe(200);
    const boardPiece = await step(code, { action: "delivery", message: { telegramRef: "tg:2600000001/3/504" }, part: "video", complete: false });
    expect(boardPiece.order.state).toBe("revision");
    // The reader's «исправлено» closes the last open request: the parts are whole, so shot.
    await step(code, { action: "revision", message: { telegramRef: "tg:2600000001/3/505" }, ordinal: 0, text: "короче" });
    const done = await step(code, { action: "revision_done", telegramRef: "tg:2600000001/3/505", ordinal: 0 });
    expect(done.order).toMatchObject({ state: "revision", openRevisions: 0 });
    expect((await step(code, { action: "delivery", message: { telegramRef: "tg:2600000001/3/506" }, part: "video", complete: true })).order.state).toBe("shot");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps an event by the sender's own id: a delivery with no card, its repeat, a retraction, and says which event it stored", async (context) => {
    if (!testDb || !server) return context.skip();
    const code = await atModel("Ролик без карточки");
    const delivery = { action: "delivery", eventRef: "contentops:delivery:7d0c6a52-0000-4000-8000-000000000001", message: { excerpt: "CUS-1 · видео", author: "ContentOps" }, part: "video", complete: true };
    const stored = await step(code, delivery);
    expect(stored).toMatchObject({ outcome: "changed", event: { ref: delivery.eventRef, result: "stored" }, order: { state: "shot", partsDone: ["video"] } });
    expect(stored.order.messages).toEqual([expect.objectContaining({ kind: "delivery", eventRef: delivery.eventRef, telegramRef: null, complete: true, retractedAt: null })]);
    expect(await step(code, delivery)).toMatchObject({ outcome: "unchanged", event: { ref: delivery.eventRef, result: "already" } });

    // The old way, a note under a link the order has a delivery of: the hub keeps one message per link and says it kept none.
    await step(code, { action: "delivery", message: { telegramRef: "tg:2600000001/3/600" }, part: "video" });
    const lost = await step(code, { action: "message", kind: "note", message: { telegramRef: "tg:2600000001/3/600", excerpt: "отвязана" } });
    expect(lost).toMatchObject({ outcome: "unchanged", event: null });

    // A retraction is its own event: it takes the delivery back and the state follows the parts that stay.
    const retract = { action: "retract", eventRef: "contentops:retraction:7d0c6a52-0000-4000-8000-000000000002", retracts: delivery.eventRef, reason: "это другой заказ" };
    const back = await step(code, retract);
    expect(back).toMatchObject({ outcome: "changed", event: { ref: retract.eventRef, result: "stored" } });
    // The routine's own delivery of the video stays: the order is still whole.
    expect(back.order).toMatchObject({ state: "shot", partsDone: ["video"] });
    expect(back.order.messages.find((message) => message.eventRef === delivery.eventRef)?.retractedAt).toEqual(expect.any(String));
    expect(await step(code, retract)).toMatchObject({ outcome: "unchanged", event: { ref: retract.eventRef, result: "already" } });
    // The routine's delivery taken back by its link: nothing delivers the video now.
    const second = await step(code, { action: "retract", eventRef: "contentops:retraction:7d0c6a52-0000-4000-8000-000000000003", retracts: "https://t.me/c/2600000001/3/600", reason: "не тот ролик" });
    expect(second.order).toMatchObject({ state: "at_model", partsDone: [] });
    const unknown = await agent(`/api/v1/agent/custom-orders/${code}`, { action: "retract", eventRef: "contentops:retraction:x-4", retracts: "contentops:delivery:never", reason: "нет такой" });
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json()).toMatchObject({ reason: "unknown_event" });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("answers a card that carries an order's code with that order: one custom, one order", async (context) => {
    if (!testDb || !server) return context.skip();
    // Gengar's `/tz`: the order first, no card yet; its code goes into the card's title.
    const card = { task: "1. В белом", price: "120$" };
    const first = agentCustomOrderResponseSchema.parse((await agent("/api/v1/agent/custom-orders", { pageLabel: "lora-1", card })).json()).order;
    // The daily routine finds the posted card by its link: no order has the link, but the card names the code.
    const sourceText = `📦 Описание заказа ${first.code}\nДата: 12.11.2026\n🎥 Описание задания: 1. В белом\nОплата: 120$`;
    const found = await agent("/api/v1/agent/custom-orders", { pageLabel: "lora-1", card, telegramRef: "tg:2600000002/6/700", sourceText });
    expect(found.statusCode, found.body).toBe(200);
    expect(agentCustomOrderResponseSchema.parse(found.json())).toMatchObject({ outcome: "changed", order: { id: first.id, telegramRefs: ["tg:2600000002/6/700"] } });
    const again = await agent("/api/v1/agent/custom-orders", { pageLabel: "lora-1", card, telegramRef: "tg:2600000002/6/700", sourceText });
    expect(agentCustomOrderResponseSchema.parse(again.json())).toMatchObject({ outcome: "unchanged", order: { id: first.id } });
    const count = await testDb.pool.query("select count(*)::int as n from custom_orders where card ->> 'task' = '1. В белом'");
    expect(count.rows[0].n).toBe(1);
    // A code of an order this key does not see, or of no order: refused, never a second order and never a guess.
    for (const other of [orders.elsewhere!, "K-999999"]) {
      const refused = await agent("/api/v1/agent/custom-orders", { pageLabel: "lora-1", card, telegramRef: "tg:2600000002/6/701", sourceText: `📦 Описание заказа ${other}\n🎥 Описание задания: x` });
      expect(refused.statusCode, other).toBe(409);
      expect(refused.json()).toMatchObject({ reason: "code_unknown" });
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("erases the fan's words with the fan: the messages' excerpts and authors and their copies in the history", async (context) => {
    if (!testDb || !server) return context.skip();
    const fanId = Number((await testDb.pool.query<{ id: string }>(
      "insert into fans (platform, platform_user_id, username) values ('fansly', '7400000009', 'fan_nine') returning id",
    )).rows[0]!.id);
    await testDb.pool.query("insert into page_fans (fan_id, platform_account_id, is_subscriber) values ($1, $2, true)", [fanId, pages["lora-1"]]);
    const id = await recordCustomOrder(app, {
      pageId: pages["lora-1"]!, fanId, buyer: null, conversationRef: null, card: { task: "Ролик для фана" }, deadlineOn: null,
      acceptedByUserId: users.alice!, origin: "extension", actor: { door: "extension", userId: users.alice! },
    });
    const code = `K-${id}`;
    expect((await act("carol", code, { action: "at_model" })).statusCode).toBe(200);
    await step(code, { action: "delivery", message: { telegramRef: "tg:2600000001/3/800", author: "Модель", excerpt: "для Тома.mov" }, part: "video" });
    await step(code, { action: "revision", message: { telegramRef: "tg:2600000001/3/801", author: "Чаттер" }, text: "Том просит сказать его имя" });
    const erasureApp = { db: app.db, pool: testDb.pool, config: app.config, logger: app.logger } as never;
    const scope = { scopeType: "fan", platform: "fansly", fanRef: "7400000009" } as const;
    await executeErasure(erasureApp, scope, { initiatedBy: users.boss! });
    const detail = customOrderDetailResponseSchema.parse((await get("boss", `/api/v1/custom-orders/${code}`)).json());
    // The facts stay (the state, the times, which message did what); the words go, and their copies in the history.
    expect(detail.messages.map((message) => [message.kind, message.telegramRef, message.author, message.excerpt])).toEqual([
      ["delivery", "tg:2600000001/3/800", null, null],
      ["revision", "tg:2600000001/3/801", null, null],
    ]);
    const texts = JSON.stringify(detail.history.map((item) => item.changes));
    expect(texts).not.toContain("Том");
    expect(detail.history.map((item) => item.event)).toEqual(expect.arrayContaining(["custom_order.delivery", "custom_order.revision"]));
    expect(detail.order).toMatchObject({ state: "revision", fanErased: true, stateNote: null, partsDone: ["video"] });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps the order through the fan's erasure: its preview says anonymize, and the order stays without the fan", async (context) => {
    if (!testDb || !server) return context.skip();
    const erasureApp = { db: app.db, pool: testDb.pool, config: app.config, logger: app.logger } as never;
    const scope = { scopeType: "fan", platform: "fansly", fanRef: "7400000002" } as const;
    const plan = await planErasure(erasureApp, scope);
    expect(plan.targets).toContainEqual(expect.objectContaining({ target: "custom_orders", action: "anonymize", rows: 1 }));
    await executeErasure(erasureApp, scope, { initiatedBy: users.boss! });
    const order = customOrderDetailResponseSchema.parse((await get("boss", `/api/v1/custom-orders/${orders.daves}`)).json()).order;
    expect(order).toMatchObject({ fan: null, buyer: null, fanErased: true, state: "shot" });
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
