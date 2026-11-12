import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { peopleMessagePressResponseSchema, peopleMessagesResponseSchema, peopleMessageSwitchResponseSchema } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, insertCustomOrder, openMatter, setConfigOverride } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { runPeopleMessages } from "../apps/runtime/src/services/people-messages/index.ts";
import type { PeopleTransport, PeopleTransportInput } from "../apps/runtime/src/services/people-messages/transport.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Сообщения людям (package S). A message to a living person leaves the server
// only with the bot token set AND its kind turned on, for an event after the
// kind was turned on, to a recipient with a Telegram id; anything else is held
// and nothing is ever sent later by itself. The same event never makes a second
// message, and a recipient gets at most the kind's cap a day. No test talks to
// Telegram: the pass gets a stub transport, and the API's own app has no token.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const MINUTE = 60_000;
/** 12:00 Moscow time: outside the people's night. */
const BASE = new Date("2026-11-12T09:00:00.000Z");
const at = (minutes: number) => new Date(BASE.getTime() + minutes * MINUTE);

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let pageId = 0;
let kateId = 0;
let denId = 0;
const cookies: Record<string, string> = {};

const calls: PeopleTransportInput[] = [];
let answer: Awaited<ReturnType<PeopleTransport>> = { status: "sent", messageId: 1 };
const stub: PeopleTransport = async (input) => {
  calls.push(input);
  return answer;
};

const asSession = (who: string, method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });

const cookieOf = (header: string | string[] | number | undefined) => String(Array.isArray(header) ? header[0] : header).split(";")[0]!;

/** The app as a deployed server with a bot token would be (a placeholder: the stub transport never uses it). */
const withToken = () => ({ ...app, config: { ...app.config, peopleTelegramBotToken: "placeholder-not-a-token" } });

let orderSeq = 0;
/** A custom order shot and not given, and its matter for the person (the checks' kind), opened at `openedAt`. */
async function shotNotGiven(userId: number, openedAt: Date) {
  orderSeq += 1;
  const orderId = await insertCustomOrder(app.db, {
    pageId, fanId: null, buyer: `buyer-${orderSeq}`, conversationRef: null, card: { task: "Танец" }, deadlineOn: null,
    state: "shot", acceptedByUserId: userId, origin: "workboard", contentopsRef: null, sourceText: null, at: openedAt,
  });
  await openMatter(app.db, {
    key: `custom.shot_not_given:K-${orderId}`, kind: "custom.shot_not_given", source: "server", title: `Кастом K-${orderId} снят, отдайте фану: mia-1`,
    object: { type: "custom_order", id: String(orderId) }, pageIds: [pageId], owner: { userId }, money: false,
    evidence: { code: `K-${orderId}` }, link: `/workboard/customs/K-${orderId}`,
  }, { door: "system" }, openedAt);
  return orderId;
}

async function rows() {
  const result = await testDb!.pool.query<{ kind: string; state: string; held_reason: string | null; recipient_user_id: string | null; text: string }>(
    "select kind, state, held_reason, recipient_user_id, text from people_messages order by id");
  return result.rows.map((row) => ({ kind: row.kind, state: row.state, reason: row.held_reason, userId: row.recipient_user_id === null ? null : Number(row.recipient_user_id), text: row.text }));
}

async function turnOn(kind: string, since: Date) {
  await setConfigOverride(app.db, { key: "peopleMessageKinds", value: JSON.stringify({ [kind]: since.toISOString() }), userId: null, groupId: crypto.randomUUID() });
}

describe("messages to people from the server: both locks, one attempt, one message per event", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    for (const username of ["kate", "den"]) await createUserAccount(app, { username, role: "chatter" }, { source: "cli" });
    await setUserPassword(app, { userId: await fixtureUserId(app, "kate"), password: "kate-password-for-tests" }, { source: "cli" });
    kateId = await fixtureUserId(app, "kate");
    denId = await fixtureUserId(app, "den");
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    pageId = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["boss", "kate"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      cookies[user] = cookieOf(login.headers["set-cookie"]);
    }
    // Kate has a Telegram id in the registry; Den has none.
    for (const [code, name, userId, telegram] of [["kate", "Катя", kateId, 1001], ["den", "Денис", denId, null]] as const) {
      const made = await asSession("boss", "POST", "/api/v1/admin/people", {
        code, displayName: name, role: "chatter", state: "working", workingPageLabels: ["mia-1"],
        logins: { add: [userId] }, ...(telegram === null ? {} : { telegram: { userId: telegram } }),
      });
      expect(made.statusCode, made.body).toBe(200);
    }
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("as merged: the owner's screen says nothing can leave, every kind off; a chatter cannot open it", async (context) => {
    if (!testDb) return context.skip();
    const screen = await asSession("boss", "GET", "/api/v1/system/people-messages");
    expect(screen.statusCode, screen.body).toBe(200);
    const body = peopleMessagesResponseSchema.parse(screen.json());
    expect(body.tokenSet).toBe(false);
    expect(body.sentence).toMatch(/^Отправка невозможна: нет токена/u);
    expect(body.kinds.map((kind) => kind.kind)).toHaveLength(7);
    expect(body.kinds.every((kind) => !kind.on)).toBe(true);
    expect((await asSession("kate", "GET", "/api/v1/system/people-messages")).statusCode).toBe(403);
    expect((await asSession("kate", "POST", "/api/v1/system/people-messages/kinds/custom.shot.give", { on: true })).statusCode).toBe(403);
    expect((await asSession("kate", "POST", "/api/v1/system/people-messages/press", { kind: "payout.text", person: "kate", text: "x" })).statusCode).toBe(403);
  });

  it("holds every message while the kind is off or there is no token; nothing reaches the transport", async (context) => {
    if (!testDb) return context.skip();
    await shotNotGiven(kateId, at(-60));
    await shotNotGiven(denId, at(-60));
    await runPeopleMessages(app, { now: at(0), transport: stub });
    await runPeopleMessages(withToken(), { now: at(1), transport: stub });
    expect(calls).toHaveLength(0);
    expect(await rows()).toEqual([
      expect.objectContaining({ kind: "custom.shot.give", state: "held", reason: "kind_off", userId: kateId }),
      expect.objectContaining({ kind: "custom.shot.give", state: "held", reason: "no_telegram", userId: denId }),
    ]);
    // The kind on but no token: still held.
    await turnOn("custom.shot.give", at(-120));
    await shotNotGiven(kateId, at(2));
    await runPeopleMessages(app, { now: at(3), transport: stub });
    expect(calls).toHaveLength(0);
    expect((await rows()).at(-1)).toMatchObject({ state: "held", reason: "no_token" });
  });

  it("a held message is never sent when the kind is turned on: only a new event sends, once", async (context) => {
    if (!testDb) return context.skip();
    await turnOn("custom.shot.give", at(10));
    const before = (await rows()).length;
    await runPeopleMessages(withToken(), { now: at(20), transport: stub });
    expect(calls).toHaveLength(0);
    expect(await rows()).toHaveLength(before);

    // A new event after the switch: one message, one attempt, to Kate's Telegram.
    await shotNotGiven(kateId, at(30));
    await runPeopleMessages(withToken(), { now: at(40), transport: stub });
    await runPeopleMessages(withToken(), { now: at(41), transport: stub });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ chatId: "1001", topicId: null });
    expect(calls[0]!.text).toMatch(/^Кастом K-\d+ снят, отдайте его фану\./u);
    expect((await rows()).at(-1)).toMatchObject({ state: "sent", reason: null, userId: kateId });

    // Den has no Telegram id: held, whatever the locks.
    await shotNotGiven(denId, at(42));
    await runPeopleMessages(withToken(), { now: at(43), transport: stub });
    expect(calls).toHaveLength(1);
    expect((await rows()).at(-1)).toMatchObject({ state: "held", reason: "no_telegram" });
  });

  it("caps a recipient's day and never repeats an attempt that did not answer", async (context) => {
    if (!testDb) return context.skip();
    // Kate's day already has three that went or would have gone (held with the kind off, held for no token, sent):
    // the cap of the kind is 3, so two more of the same day are held, and nothing reaches the transport.
    await shotNotGiven(kateId, at(50));
    await shotNotGiven(kateId, at(50));
    await runPeopleMessages(withToken(), { now: at(60), transport: stub });
    expect(calls).toHaveLength(1);
    expect((await rows()).slice(-2).map((row) => [row.state, row.reason])).toEqual([["held", "cap"], ["held", "cap"]]);

    // The next Moscow day, an attempt that does not answer is `unknown`, and the passes after it never repeat it.
    answer = { status: "unknown", error: "timed out" };
    const tomorrow = new Date(BASE.getTime() + 24 * 60 * MINUTE);
    await shotNotGiven(kateId, tomorrow);
    await runPeopleMessages(withToken(), { now: new Date(tomorrow.getTime() + MINUTE), transport: stub });
    await runPeopleMessages(withToken(), { now: new Date(tomorrow.getTime() + 2 * MINUTE), transport: stub });
    expect(calls).toHaveLength(2);
    expect((await rows()).at(-1)).toMatchObject({ state: "unknown" });
    answer = { status: "sent", messageId: 2 };
  });

  it("the owner's switch writes one kind with the sentence of what starts; the press without a token holds", async (context) => {
    if (!testDb) return context.skip();
    const turned = await asSession("boss", "POST", "/api/v1/system/people-messages/kinds/payout.text", { on: true });
    expect(turned.statusCode, turned.body).toBe(200);
    const switched = peopleMessageSwitchResponseSchema.parse(turned.json());
    expect(switched).toMatchObject({ kind: "payout.text", on: true, audit: { by: "boss" } });
    expect(switched.sentence).toMatch(/Пока нет токена бота/u);

    const pressed = await asSession("boss", "POST", "/api/v1/system/people-messages/press", { kind: "payout.text", person: "kate", text: "Выплата: текст для теста" });
    expect(pressed.statusCode, pressed.body).toBe(200);
    expect(peopleMessagePressResponseSchema.parse(pressed.json())).toMatchObject({ state: "held", reason: "no_token" });
    const again = await asSession("boss", "POST", "/api/v1/system/people-messages/press", { kind: "payout.text", person: "kate", text: "Выплата: текст для теста" });
    expect(peopleMessagePressResponseSchema.parse(again.json())).toMatchObject({ state: "duplicate", id: null });

    const screen = peopleMessagesResponseSchema.parse((await asSession("boss", "GET", "/api/v1/system/people-messages")).json());
    const payout = screen.kinds.find((kind) => kind.kind === "payout.text")!;
    expect(payout).toMatchObject({ on: true, lastSwitch: { on: true } });
    expect(payout.held[0]).toMatchObject({ text: "Выплата: текст для теста", reason: "no_token" });
    expect(calls).toHaveLength(2);
  });
});
