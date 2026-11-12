import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { agentCustomOrderResponseSchema, customOrderDetailResponseSchema, customOrdersBoardResponseSchema } from "@agency_hub_core/contracts";
import { addCustomOrderMessage, createFanslyPage, createModel, insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, assignPageToUser, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { applyCustomOrdersImport, customOrdersImportArgsSchema, planCustomOrdersImport } from "../apps/runtime/src/services/custom-orders/import.ts";
import { recordCustomOrder, settleCustomOrders } from "../apps/runtime/src/services/custom-orders/index.ts";
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

    // fan_one has alice's open order on lora-1: one more is said in so many words.
    const created = await agent("/api/v1/agent/custom-orders", {
      pageLabel: "lora-1", fan: "https://fansly.com/fan_one/posts", acceptedBy: "alice", card, telegramRef: "https://t.me/c/2600000002/6/200", another: true,
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
    // The daily routine repeats every message it sees: the first delivery again changes nothing — the order stays «правка».
    const redelivered = agentCustomOrderResponseSchema.parse((await agent(`/api/v1/agent/custom-orders/${order.code}`, {
      action: "delivery", message: { telegramRef: "tg:2600000001/3/300", excerpt: "6-08 стриптиз.mov" }, part: "video",
    })).json());
    expect(redelivered).toMatchObject({ outcome: "unchanged", order: { state: "revision", openRevisions: 1 } });

    // The reader's reads and reports (both answered 500 once: their audit lines broke the audit's own shapes).
    const listed = await server!.inject({ method: "GET", url: `/api/v1/agent/custom-orders?code=${order.code}`, headers: { authorization: `Bearer ${WRITER}` } });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().orders.map((one: { code: string }) => one.code)).toEqual([order.code]);
    const cards = await agent("/api/v1/agent/custom-orders/cards", { cards: [{ telegramRef: "tg:2600000001/3/400" }, { telegramRef: "tg:2600000002/6/200" }], complete: true });
    expect(cards.statusCode, cards.body).toBe(200);
    expect(cards.json()).toMatchObject({ matched: [{ telegramRef: "tg:2600000002/6/200", code: order.code }], opened: 1 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  /** A fresh order of lora-1 at the model, no Telegram card yet: a video, and photos when the card names how many. */
  async function atModel(task: string, wantsPhotos?: number): Promise<string> {
    const id = await recordCustomOrder(app, {
      pageId: pages["lora-1"]!, fanId: null, buyer: null, conversationRef: null, card: { task, ...(wantsPhotos ? { wantsPhotos } : {}) }, deadlineOn: null,
      acceptedByUserId: users.alice!, origin: "extension", actor: { door: "extension", userId: users.alice! },
    });
    expect((await act("carol", `K-${id}`, { action: "at_model" })).statusCode).toBe(200);
    return `K-${id}`;
  }
  const step = async (code: string, payload: Record<string, unknown>) => {
    const response = await agent(`/api/v1/agent/custom-orders/${code}`, payload);
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as {
      order: { state: string; stateNote: string | null; partsDone: string[]; openRevisions: number; messages: Array<Record<string, unknown>> }; outcome: string; event?: unknown;
    };
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
    // The reader's «исправлено» fixes its own request. The board's one is a request too and is still open: «правка» is
    // about it now, until the whole new version comes.
    await step(code, { action: "revision", message: { telegramRef: "tg:2600000001/3/505" }, ordinal: 0, text: "короче" });
    const done = await step(code, { action: "revision_done", telegramRef: "tg:2600000001/3/505", ordinal: 0 });
    expect(done.order).toMatchObject({ state: "revision", openRevisions: 1, stateNote: "фан просит другое начало" });
    expect((await step(code, { action: "delivery", message: { telegramRef: "tg:2600000001/3/506" }, part: "video", complete: true })).order)
      .toMatchObject({ state: "shot", openRevisions: 0 });
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

  // The readiness of an order is by its current round, per part (review round 2). ContentOps links a delivery per
  // part, each marked whole; the daily routine repeats what it sees in the model's group.
  const contentops = (kind: "delivery" | "retraction", n: number) => `contentops:${kind}:7d0c6a52-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;
  const group = (message: number) => `tg:2600000001/3/${message}`;

  it("answers two revision requests only when both parts came again: the video's new version alone is not «снят»", async (context) => {
    if (!testDb || !server) return context.skip();
    const code = await atModel("Ролик и фото, две правки", 5);
    expect((await step(code, { action: "delivery", message: { telegramRef: group(1001) }, part: "video" })).order).toMatchObject({ state: "partly", partsDone: ["video"] });
    expect((await step(code, { action: "delivery", message: { telegramRef: group(1002) }, part: "photos" })).order.state).toBe("shot");
    // Two requests in one message of the group: «исправить видео», «заменить фото».
    await step(code, { action: "revision", message: { telegramRef: group(1003) }, ordinal: 1, text: "исправить звук в видео" });
    expect((await step(code, { action: "revision", message: { telegramRef: group(1003) }, ordinal: 2, text: "заменить фото" })).order).toMatchObject({ state: "revision", openRevisions: 2 });
    // ContentOps' ordinary linking of the new video: its part, whole. The photos were not replaced.
    const video = await step(code, { action: "delivery", eventRef: contentops("delivery", 1), message: { excerpt: "CUS-11 · видео", author: "ContentOps" }, part: "video", complete: true });
    expect(video.order).toMatchObject({ state: "revision", openRevisions: 2, partsDone: ["video"] });
    const photos = await step(code, { action: "delivery", eventRef: contentops("delivery", 2), message: { excerpt: "CUS-11 · фото", author: "ContentOps" }, part: "photos", complete: true });
    expect(photos.order).toMatchObject({ state: "shot", openRevisions: 0, partsDone: ["video", "photos"] });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("fixes a request about one part with that part alone: the video's new version leaves «заменить фото» open", async (context) => {
    if (!testDb || !server) return context.skip();
    const code = await atModel("Ролик и фото, правка по частям", 5);
    await step(code, { action: "delivery", message: { telegramRef: group(1401) }, part: "video" });
    expect((await step(code, { action: "delivery", message: { telegramRef: group(1402) }, part: "photos" })).order.state).toBe("shot");
    // The request names its part: «заменить фото» sends back the photos only, the video stays ready.
    const photosAsked = await step(code, { action: "revision", message: { telegramRef: group(1403) }, ordinal: 1, text: "заменить фото", part: "photos" });
    expect(photosAsked.order).toMatchObject({ state: "revision", openRevisions: 1, partsDone: ["video"] });
    const bothAsked = await step(code, { action: "revision", message: { telegramRef: group(1403) }, ordinal: 2, text: "исправить звук в видео", part: "video" });
    expect(bothAsked.order).toMatchObject({ state: "revision", openRevisions: 2, partsDone: [] });
    // The new video fixes the video's request and nothing else; «правка» is about the photos now.
    const video = await step(code, { action: "delivery", eventRef: contentops("delivery", 21), message: { excerpt: "CUS-14 · видео", author: "ContentOps" }, part: "video", complete: true });
    expect(video.order).toMatchObject({ state: "revision", openRevisions: 1, partsDone: ["video"], stateNote: "заменить фото" });
    expect(video.order.messages.filter((message) => message.kind === "revision").map((message) => [message.part, message.doneAt === null]))
      .toEqual([["photos", true], ["video", false]]);
    const photos = await step(code, { action: "delivery", eventRef: contentops("delivery", 22), message: { excerpt: "CUS-14 · фото", author: "ContentOps" }, part: "photos", complete: true });
    expect(photos.order).toMatchObject({ state: "shot", openRevisions: 0, partsDone: ["video", "photos"] });

    // The same on the board: the lead's «Правка» about the photos is a request of its own, and the video stays ready.
    const board = await act("carol", code, { action: "revision", note: "фото темные", part: "photos" });
    expect(board.statusCode, board.body).toBe(200);
    const asked = customOrderDetailResponseSchema.parse(board.json());
    expect(asked.order).toMatchObject({ state: "revision", openRevisions: 1, partsDone: ["video"], stateNote: "фото темные" });
    expect(asked.messages.at(-1)).toMatchObject({ kind: "revision", part: "photos", telegramRef: null, eventRef: expect.stringMatching(/^workboard:revision:\d+$/), excerpt: "фото темные", doneAt: null });
    const lighter = await step(code, { action: "delivery", eventRef: contentops("delivery", 23), message: { excerpt: "CUS-14 · фото", author: "ContentOps" }, part: "photos", complete: true });
    expect(lighter.order).toMatchObject({ state: "shot", openRevisions: 0, partsDone: ["video", "photos"] });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("returns to «правка» when the replacement is taken back: the delivery sent for revision does not count", async (context) => {
    if (!testDb || !server) return context.skip();
    const code = await atModel("Ролик, замену отозвали");
    expect((await step(code, { action: "delivery", message: { telegramRef: group(1101) }, part: "video" })).order.state).toBe("shot");
    expect((await step(code, { action: "revision", message: { telegramRef: group(1102) }, text: "переснять начало" })).order).toMatchObject({ state: "revision", openRevisions: 1 });
    const replacement = await step(code, { action: "delivery", eventRef: contentops("delivery", 11), message: { excerpt: "CUS-12 · видео", author: "ContentOps" }, part: "video", complete: true });
    expect(replacement.order).toMatchObject({ state: "shot", openRevisions: 0, partsDone: ["video"] });
    // It was another order's file: the order waits for its revision again, the request it had answered is open.
    const back = await step(code, { action: "retract", eventRef: contentops("retraction", 12), retracts: contentops("delivery", 11), reason: "это файл другого заказа" });
    expect(back.order).toMatchObject({ state: "revision", stateNote: "переснять начало", openRevisions: 1, partsDone: [] });
    expect(back.order.messages.find((message) => message.kind === "revision")?.doneAt).toBeNull();
    // The real replacement answers it again.
    const again = await step(code, { action: "delivery", eventRef: contentops("delivery", 13), message: { excerpt: "CUS-13 · видео", author: "ContentOps" }, part: "video", complete: true });
    expect(again.order).toMatchObject({ state: "shot", openRevisions: 0, partsDone: ["video"] });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("answers a revision of the whole order part by part: «снят» only when every part came after it", async (context) => {
    if (!testDb || !server) return context.skip();
    const code = await atModel("Ролик и фото, правка всего заказа", 5);
    await step(code, { action: "delivery", message: { telegramRef: group(1201) }, part: "video" });
    expect((await step(code, { action: "delivery", message: { telegramRef: group(1202) }, part: "photos" })).order.state).toBe("shot");
    expect((await step(code, { action: "revision", message: { telegramRef: group(1203) }, text: "другой свет, переснять всё" })).order).toMatchObject({ state: "revision", openRevisions: 1 });
    const video = await step(code, { action: "delivery", message: { telegramRef: group(1204) }, part: "video", complete: true });
    expect(video.order).toMatchObject({ state: "revision", openRevisions: 1, partsDone: ["video"] });
    const photos = await step(code, { action: "delivery", message: { telegramRef: group(1205) }, part: "photos", complete: true });
    expect(photos.order).toMatchObject({ state: "shot", openRevisions: 0, partsDone: ["video", "photos"] });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("takes an old message of the model's group as old, whenever the routine reports it: it answers no later request", async (context) => {
    if (!testDb || !server) return context.skip();
    const code = await atModel("Ролик, рутина повторяет старое");
    const at = (hour: number) => `2026-11-10T${String(hour).padStart(2, "0")}:00:00+03:00`;
    const first = { action: "delivery", message: { telegramRef: group(1301), at: at(10), excerpt: "6-08 первый.mov" }, part: "video" };
    expect((await step(code, first)).order.state).toBe("shot");
    expect((await step(code, { action: "revision", message: { telegramRef: group(1303), at: at(12) }, text: "без музыки" })).order.state).toBe("revision");
    // The routine repeats every message it sees: the delivery it reported before…
    expect(await step(code, first)).toMatchObject({ outcome: "unchanged", order: { state: "revision", openRevisions: 1 } });
    // …and one it had missed, sent before the request (11:00): kept, and it answers nothing.
    const missed = await step(code, { action: "delivery", message: { telegramRef: group(1302), at: at(11), excerpt: "6-08 второй дубль.mov" }, part: "video", complete: true });
    expect(missed).toMatchObject({ outcome: "changed", event: { ref: group(1302), result: "stored" }, order: { state: "revision", openRevisions: 1, partsDone: [] } });
    // The new version, sent after the request, does.
    const fixed = await step(code, { action: "delivery", message: { telegramRef: group(1304), at: at(13), excerpt: "6-08 без музыки.mov" }, part: "video", complete: true });
    expect(fixed.order).toMatchObject({ state: "shot", openRevisions: 0, partsDone: ["video"] });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("takes a state by a message once: the routine's repeat of an old refusal, «снят» or «частично» changes nothing", async (context) => {
    if (!testDb || !server) return context.skip();
    // The model refused by a message; the lead sent the order to the model again; the next day the routine reports
    // the same message once more.
    const refusedOnce = await atModel("Ролик, отказ и снова к модели");
    const refusal = { action: "refused", ref: group(1501), reason: "не снимаю такое" };
    expect((await step(refusedOnce, refusal)).order.state).toBe("refused");
    expect((await act("carol", refusedOnce, { action: "at_model" })).statusCode).toBe(200);
    expect(await step(refusedOnce, refusal)).toMatchObject({ outcome: "unchanged", order: { state: "at_model" } });
    // A new refusal, by another message, is a refusal.
    expect((await step(refusedOnce, { ...refusal, ref: group(1502) })).order.state).toBe("refused");

    // «Снят» by a message, then a revision: the old «снят» again does not close the request.
    const shotOnce = await atModel("Ролик, снят и правка");
    const shot = { action: "shot", ref: group(1511) };
    expect((await step(shotOnce, shot)).order.state).toBe("shot");
    expect((await step(shotOnce, { action: "revision", message: { telegramRef: group(1512) }, text: "переснять конец" })).order.state).toBe("revision");
    expect(await step(shotOnce, shot)).toMatchObject({ outcome: "unchanged", order: { state: "revision", openRevisions: 1 } });

    // «Сдан частично» by a message; the order moved on: its repeat is nothing new, not a step the state refuses.
    const partlyOnce = await atModel("Ролик, частично и снят");
    const partly = { action: "partly", ref: group(1521), note: "первая половина" };
    expect((await step(partlyOnce, partly)).order.state).toBe("partly");
    expect((await step(partlyOnce, { action: "delivery", message: { telegramRef: group(1522) }, part: "video", complete: true })).order.state).toBe("shot");
    expect(await step(partlyOnce, partly)).toMatchObject({ outcome: "unchanged", order: { state: "shot" } });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps «снят» a person set by hand when a delivery is taken back afterwards: the retraction is a line of the history", async (context) => {
    if (!testDb || !server) return context.skip();
    const history = async (code: string) => customOrderDetailResponseSchema.parse((await get("boss", `/api/v1/custom-orders/${code}`)).json()).history.map((item) => item.event);
    // The lead sets «Снят» herself; ContentOps links a file to the order later and then takes the link back.
    const byHand = await atModel("Ролик, снят рукой");
    expect((await act("carol", byHand, { action: "shot" })).statusCode).toBe(200);
    await step(byHand, { action: "delivery", eventRef: contentops("delivery", 31), message: { excerpt: "CUS-15 · видео", author: "ContentOps" }, part: "video", complete: true });
    const back = await step(byHand, { action: "retract", eventRef: contentops("retraction", 32), retracts: contentops("delivery", 31), reason: "это файл другого заказа" });
    expect(back).toMatchObject({ outcome: "changed", order: { state: "shot", partsDone: ["video"] } });
    expect(await history(byHand)).toContain("custom_order.retracted");

    // The same after a revision she answered by hand: the delivery that was sent back does not count, her word does.
    const afterRevision = await atModel("Ролик, правка и снят рукой");
    await step(afterRevision, { action: "delivery", message: { telegramRef: group(1601) }, part: "video" });
    await step(afterRevision, { action: "revision", message: { telegramRef: group(1602) }, text: "без музыки" });
    expect((await act("carol", afterRevision, { action: "shot" })).statusCode).toBe(200);
    await step(afterRevision, { action: "delivery", eventRef: contentops("delivery", 33), message: { excerpt: "CUS-16 · видео", author: "ContentOps" }, part: "video", complete: true });
    const stays = await step(afterRevision, { action: "retract", eventRef: contentops("retraction", 34), retracts: contentops("delivery", 33), reason: "не тот файл" });
    expect(stays.order).toMatchObject({ state: "shot", openRevisions: 0, partsDone: ["video"] });
    // A request after her word opens a new round all the same.
    expect((await step(afterRevision, { action: "revision", message: { telegramRef: group(1603) }, text: "фан просит другое начало" })).order)
      .toMatchObject({ state: "revision", openRevisions: 1, partsDone: [] });

    // The reader's «снят» by a message is no person's hand: a delivery taken back after it still takes the part.
    const byReader = await atModel("Ролик, снят читателем");
    expect((await step(byReader, { action: "shot", ref: group(1611) })).order.state).toBe("shot");
    await step(byReader, { action: "delivery", eventRef: contentops("delivery", 35), message: { excerpt: "CUS-17 · видео", author: "ContentOps" }, part: "video", complete: true });
    const gone = await step(byReader, { action: "retract", eventRef: contentops("retraction", 36), retracts: contentops("delivery", 35), reason: "не тот файл" });
    expect(gone.order).toMatchObject({ state: "at_model", partsDone: [] });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("puts an order where its kept messages say when they were stored without a step, never one a person moved after them", async (context) => {
    if (!testDb || !server) return context.skip();
    /** As the import leaves an order: «у модели», a delivery message of the model's group kept, no step taken by it. */
    const imported = async (task: string, message: number) => {
      const id = await recordCustomOrder(app, {
        pageId: pages["lora-1"]!, fanId: null, buyer: null, conversationRef: null, card: { task }, deadlineOn: null, acceptedByUserId: null,
        origin: "import", state: "at_model", actor: { door: "system" },
      });
      await addCustomOrderMessage(app.db, {
        orderId: id, telegramRef: group(message), ordinal: 0, kind: "delivery", part: null, postedAt: new Date(Date.now() - 7 * 86_400_000),
        author: "Модель", excerpt: "6-08 готово.mov", at: new Date(Date.now() - 3_600_000),
      });
      return id;
    };
    const stuck = await imported("Ролик, сдача лежит с переноса", 1701);
    const moved = await imported("Ролик, после переноса его вела ведущая", 1702);
    // The routine's repeat of the kept message can no longer apply it: the order stays «у модели».
    expect(await step(`K-${stuck}`, { action: "delivery", message: { telegramRef: group(1701) }, part: "video" }))
      .toMatchObject({ outcome: "unchanged", order: { state: "at_model", partsDone: [] } });
    // The lead looked at the other one and said «частично» herself, after the message: her step stays.
    expect((await act("carol", `K-${moved}`, { action: "partly", note: "нет второй половины" })).statusCode).toBe(200);

    const orderIds = [stuck, moved];
    const state = async (id: number) => (await testDb!.pool.query("select state, parts_done from custom_orders where id = $1", [id])).rows[0];
    // The dry run says what each holds and what its messages say, and writes nothing.
    expect(await settleCustomOrders(app, { apply: false, orderIds })).toEqual([
      { code: `K-${stuck}`, state: "at_model", byMessages: "shot", partsDone: [], partsByMessages: ["video"], outcome: "differs" },
      { code: `K-${moved}`, state: "partly", byMessages: "shot", partsDone: [], partsByMessages: ["video"], outcome: "by_hand" },
    ]);
    expect(await state(stuck)).toEqual({ state: "at_model", parts_done: [] });
    // Applied: the stuck one is «снят» with a line in its history; the one a person moved is left.
    expect((await settleCustomOrders(app, { apply: true, orderIds })).map((row) => [row.code, row.outcome]))
      .toEqual([[`K-${stuck}`, "settled"], [`K-${moved}`, "by_hand"]]);
    expect(await state(stuck)).toEqual({ state: "shot", parts_done: ["video"] });
    expect(await state(moved)).toEqual({ state: "partly", parts_done: [] });
    const detail = customOrderDetailResponseSchema.parse((await get("boss", `/api/v1/custom-orders/K-${stuck}`)).json());
    expect(detail.history.at(-1)).toMatchObject({ event: "custom_order.settled", door: "system", changes: { from: "at_model", to: "shot" } });
    // Once more: nothing left to settle.
    expect((await settleCustomOrders(app, { apply: true, orderIds })).filter((row) => row.outcome !== "by_hand")).toEqual([]);
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

  it("records no second open order of a fan on a page through an agent unless it says another", async (context) => {
    if (!testDb || !server) return context.skip();
    const fanId = Number((await testDb.pool.query<{ id: string }>(
      "insert into fans (platform, platform_user_id, username) values ('fansly', '7400000011', 'fan_eleven') returning id",
    )).rows[0]!.id);
    await testDb.pool.query("insert into page_fans (fan_id, platform_account_id, is_subscriber) values ($1, $2, true)", [fanId, pages["lora-1"]]);
    const first = agentCustomOrderResponseSchema.parse((await agent("/api/v1/agent/custom-orders", { pageLabel: "lora-1", fan: "fan_eleven", card: { task: "Первый" } })).json());
    // Gengar's `/tz` and the daily routine: the same fan's custom again, no card that would tell it — the open order is the answer.
    const second = await agent("/api/v1/agent/custom-orders", { pageLabel: "lora-1", fan: "@fan_eleven", card: { task: "Второй" } });
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json()).toMatchObject({ reason: "open_orders", message: expect.stringContaining(first.order.code) });
    const another = await agent("/api/v1/agent/custom-orders", { pageLabel: "lora-1", fan: "fan_eleven", card: { task: "Второй" }, another: true });
    expect(another.statusCode, another.body).toBe(200);
    expect(agentCustomOrderResponseSchema.parse(another.json()).outcome).toBe("created");
    const count = await testDb.pool.query("select count(*)::int as n from custom_orders where fan_id = $1", [fanId]);
    expect(count.rows[0].n).toBe(2);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("makes a repeat of the import a no-op: every order it stored is found again, a cardless one too", async (context) => {
    if (!testDb || !server) return context.skip();
    const fanId = Number((await testDb.pool.query<{ id: string }>(
      "insert into fans (platform, platform_user_id, username) values ('fansly', '7400000012', 'fan_twelve') returning id",
    )).rows[0]!.id);
    await testDb.pool.query("insert into page_fans (fan_id, platform_account_id, is_subscriber) values ($1, $2, true)", [fanId, pages["lora-1"]]);
    const args = customOrdersImportArgsSchema.parse({
      version: 1, cardsSince: "2026-01-01", modelGroupChats: ["2600000001"],
      contentops: [{ model: "lora", orders: [{
        id: "tg-2600000003-3-900", buyer: "fan_twelve", account: "lora-1", state: "waiting",
        card: { ref: "tg:2600000003/3/900", posted_at: "2026-11-10T10:00:00Z", text: "📦 Описание заказа\n🎥 Описание задания: Импорт с карточкой" },
      }] }],
      // Gengar's board: an order with no card yet.
      board: { open: [{ fan: "fan_twelve", page: "lora-1", card: null, status: "no_card", usd: 50, duration: "3 минуты" }], done: [] },
    });
    const plan = await planCustomOrdersImport(app, args);
    expect(plan.orders).toHaveLength(2);
    const created = await applyCustomOrdersImport(app, plan);
    expect(created).toHaveLength(2);
    // `--apply` once more with the same file: nothing new.
    const again = await planCustomOrdersImport(app, args);
    expect(again.orders).toEqual([]);
    expect(again.existing.map((one) => one.code).sort()).toEqual([...created].sort());
    expect(await applyCustomOrdersImport(app, again)).toEqual([]);
    const count = await testDb.pool.query("select count(*)::int as n from custom_orders where fan_id = $1", [fanId]);
    expect(count.rows[0].n).toBe(2);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("erases the fan's words with the fan: the messages' excerpts and authors and their copies in the history", async (context) => {
    if (!testDb || !server) return context.skip();
    const fanId = Number((await testDb.pool.query<{ id: string }>(
      "insert into fans (platform, platform_user_id, username) values ('fansly', '7400000009', 'fan_nine') returning id",
    )).rows[0]!.id);
    await testDb.pool.query("insert into page_fans (fan_id, platform_account_id, is_subscriber) values ($1, $2, true)", [fanId, pages["lora-1"]]);
    const id = await recordCustomOrder(app, {
      pageId: pages["lora-1"]!, fanId, buyer: null, conversationRef: null, deadlineOn: null,
      card: { task: "Ролик для Тома, скажи «Том, привет»", notes: "Том просил чёрное", price: "100$", duration: "5 минут" },
      acceptedByUserId: users.alice!, origin: "extension", actor: { door: "extension", userId: users.alice! },
    });
    // An order the fan matched no fan of the page for: the card's buyer string names him.
    const byName = await recordCustomOrder(app, {
      pageId: pages["lora-1"]!, fanId: null, buyer: "Том (fan_nine)", conversationRef: null, deadlineOn: null,
      card: { task: "Ещё ролик для Тома", price: "50$" }, acceptedByUserId: null, origin: "import", actor: { door: "system" },
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
    // (The video was sent back by the revision: no part is ready.)
    expect(detail.order).toMatchObject({ state: "revision", fanErased: true, stateNote: null, partsDone: [] });
    // The card keeps what the order is (its price, its length), not the fan's words.
    expect(detail.order.card).toEqual({ price: "100$", duration: "5 минут" });
    const named = customOrderDetailResponseSchema.parse((await get("boss", `/api/v1/custom-orders/K-${byName}`)).json());
    expect(named.order).toMatchObject({ buyer: null, fanErased: true, card: { price: "50$" } });
    expect(JSON.stringify(named)).not.toContain("Том");
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
