import { afterAll, beforeAll, describe, expect, it } from "vitest";
import argon2 from "argon2";
import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";

import { teamQuestionWriteResponseSchema, teamSwapsResponseSchema } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, insertPersonLogin, insertPersonRow, listPersonScheduleSlotRows, type Database } from "@agency_hub_core/db";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { assignPageToUser, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { registrySlots } from "../apps/runtime/src/services/sale-homes.ts";
import { slotRuns } from "../apps/runtime/src/services/sale-rule.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// «Подмена» (products package W, 0422): a swap is a question; its «Можно» writes, in the answer's transaction, the
// registry's one-day lines (the covering person's on top of their own, the absent person's «off»), which the sale rule's
// slots read; the decider takes it back before the day (the lines are marked, never deleted). The standing schedule (the
// person's card, the agents' people door) never shows a swap. A covering person of another team is refused, and so is
// anyone but the decider answering. «Предложить сетку» (kind `schedule`) is the owner's to answer.

const PASSWORD = "swaps-secret-1";
const DAY_MS = 86_400_000;

let testDb: StartedTestDatabase | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let db: Database;
const cookies: Record<string, string> = {};
const people: Record<string, number> = {};
let pageA = 0;

const moscowDay = (at: number) => new Date(at + 3 * 3_600_000).toISOString().slice(0, 10);
const day = moscowDay(Date.now() + 2 * DAY_MS);
const at = (date: string, time: string) => Date.parse(`${date}T${time}:00+03:00`);

async function login(username: string) {
  const response = await server!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: PASSWORD } });
  expect(response.statusCode, response.body).toBe(200);
  const header = response.headers["set-cookie"];
  return String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
}

const as = (who: string, method: "GET" | "POST", url: string, payload?: object) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });

async function runs(name: string, when: number, pageId = pageA) {
  const slots = await registrySlots(db).slotsFor({ from: new Date(when - DAY_MS), to: new Date(when + DAY_MS) });
  const userId = (await testDb!.pool.query("select user_id from person_logins where person_id = $1", [people[name]])).rows[0]!.user_id as string;
  return slotRuns(slots, { personId: Number(userId), pageId, at: when });
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  const app = createTestAppContext(testDb);
  db = app.db as Database;
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await createUserAccount(app, { username: "olga", role: "owner", password: PASSWORD }, { source: "cli" });
  const modelA = await createModel(db, { slug: "alfa", name: "Alfa" });
  const modelB = await createModel(db, { slug: "bravo", name: "Bravo" });
  pageA = (await createFanslyPage(db, { modelId: modelA.id, label: "alfa-1" })).id;
  const pageB = (await createFanslyPage(db, { modelId: modelB.id, label: "bravo-1" })).id;
  // Kim is the model's content manager and Nina a newcomer not working yet: both work alfa-1, neither covers a shift.
  const roles: Record<string, { role: "chatter" | "content_manager"; state: "working" | "set_up" }> = {
    kim: { role: "content_manager", state: "working" }, nina: { role: "chatter", state: "set_up" },
  };
  for (const [name, label, pageId] of [["anna", "alfa-1", pageA], ["carl", "alfa-1", pageA], ["lena", "alfa-1", pageA], ["boris", "bravo-1", pageB], ["kim", "alfa-1", pageA], ["nina", "alfa-1", pageA]] as const) {
    const user = await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
    await db.execute(sql`update users set password_hash = ${hash} where id = ${user.id}`);
    await assignPageToUser(app, { userId: user.id, pageLabel: label }, { source: "cli" });
    const row = await insertPersonRow(db, {
      code: name, displayName: name, kind: "human", role: roles[name]?.role ?? "chatter", state: roles[name]?.state ?? "working", leftOn: null, telegramUserId: null,
      telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
    });
    await insertPersonLogin(db, { personId: row.id, userId: user.id, linkedByUserId: null });
    await db.execute(sql`insert into person_working_pages (person_id, page_id, position) values (${row.id}, ${pageId}, 0)`);
    people[name] = row.id;
  }
  // Anna's standing slot: 16:00–00:00 every day; Carl's 08:00–16:00. Lena leads team Alfa.
  await db.execute(sql`insert into person_schedule_slots (person_id, page_id, start_minute, end_minute, valid_from) values
    (${people.anna!}, null, 960, 0, '2026-01-01'), (${people.carl!}, null, 480, 960, '2026-01-01')`);
  await db.execute(sql`insert into team_roles (person_id, model_id, kind) values (${people.lena!}, ${modelA.id}, 'lead')`);
  server = await buildApiServer(createTestAppContext(testDb));
  for (const name of ["olga", "anna", "carl", "lena", "boris"]) cookies[name] = await login(name);
}, 120_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

describe("«Подмена»: a question whose «Можно» writes the day's lines", () => {
  it("writes the lines on «Можно», the rule reads them, the standing schedule does not change, the decider takes it back", async (context) => {
    if (!testDb) return context.skip();
    const swap = { date: day, pageLabels: ["alfa-1"], start: "16:00", end: "00:00", coverPersonCode: "carl" };
    // A covering person of another team is refused.
    const wrong = await as("anna", "POST", "/api/v1/team/questions", { pageLabel: "alfa-1", kind: "swap", text: "Не выйду", swap: { ...swap, coverPersonCode: "boris" } });
    expect(wrong.statusCode, wrong.body).toBe(400);
    // The model's content manager and a newcomer not working yet work alfa-1 too, and are not the chat team at work.
    for (const code of ["kim", "nina"]) {
      const refused = await as("anna", "POST", "/api/v1/team/questions", { pageLabel: "alfa-1", kind: "swap", text: "Не выйду", swap: { ...swap, coverPersonCode: code } });
      expect(refused.statusCode, `${code}: ${refused.body}`).toBe(400);
    }

    const asked = await as("anna", "POST", "/api/v1/team/questions", { pageLabel: "alfa-1", kind: "swap", text: "Не выйду, Карл выйдет", swap });
    expect(asked.statusCode, asked.body).toBe(200);
    const question = teamQuestionWriteResponseSchema.parse(asked.json()).question;
    expect(question.decider).toMatchObject({ kind: "team_lead" });
    expect(question.swap).toMatchObject({ date: day, start: "16:00", end: "00:00", absent: { code: "anna" }, cover: { code: "carl" }, approved: false });

    // The covering person reads the question (they are named in it) and does not decide it.
    expect((await as("carl", "POST", `/api/v1/team/questions/${question.id}/answer`, { answer: "yes" })).statusCode).toBe(403);
    expect((await as("anna", "POST", `/api/v1/team/questions/${question.id}/answer`, { answer: "yes" })).statusCode).toBe(403);
    // Before «Можно»: the standing schedule alone.
    expect(await runs("anna", at(day, "18:00"))).toBe(true);
    expect(await runs("carl", at(day, "18:00"))).toBe(false);

    const yes = await as("lena", "POST", `/api/v1/team/questions/${question.id}/answer`, { answer: "yes" });
    expect(yes.statusCode, yes.body).toBe(200);
    const lines = await testDb.pool.query("select person_id::int, kind, valid_from::text, valid_to::text from person_schedule_slots where question_id = $1 order by kind", [question.id]);
    expect(lines.rows).toEqual([
      { person_id: people.carl, kind: "cover", valid_from: day, valid_to: day },
      { person_id: people.anna, kind: "off", valid_from: day, valid_to: day },
    ]);
    // The rule's slots: the swap's day is Carl's on alfa-1, not Anna's; the day before and after are untouched.
    expect(await runs("anna", at(day, "18:00"))).toBe(false);
    expect(await runs("carl", at(day, "18:00"))).toBe(true);
    expect(await runs("carl", at(day, "10:00"))).toBe(true);
    for (const other of [moscowDay(Date.parse(`${day}T12:00:00+03:00`) - DAY_MS), moscowDay(Date.parse(`${day}T12:00:00+03:00`) + DAY_MS)]) {
      expect(await runs("anna", at(other, "18:00"))).toBe(true);
      expect(await runs("carl", at(other, "18:00"))).toBe(false);
    }
    // The standing schedule (the person's card, the agents' people door) has no swap in it.
    expect((await listPersonScheduleSlotRows(db, [people.anna!, people.carl!])).map((one) => one.kind)).toEqual([null, null]);
    // «График»: the team sees it; another team does not.
    expect(teamSwapsResponseSchema.parse((await as("anna", "GET", "/api/v1/team/swaps")).json()).swaps.map((one) => one.questionId)).toEqual([question.id]);
    expect(teamSwapsResponseSchema.parse((await as("boris", "GET", "/api/v1/team/swaps")).json()).swaps).toEqual([]);

    // The asker does not take it back; the decider does, before the day. The lines stay, marked.
    expect((await as("anna", "POST", `/api/v1/team/questions/${question.id}/swap/revoke`)).statusCode).toBe(403);
    const back = await as("lena", "POST", `/api/v1/team/questions/${question.id}/swap/revoke`);
    expect(back.statusCode, back.body).toBe(200);
    expect(teamQuestionWriteResponseSchema.parse(back.json()).question.swap).toMatchObject({ approved: false, revoked: true });
    const kept = await testDb.pool.query("select count(*)::int as n from person_schedule_slots where question_id = $1 and revoked_at is not null", [question.id]);
    expect(kept.rows[0]!.n).toBe(2);
    expect(await runs("anna", at(day, "18:00"))).toBe(true);
    expect(await runs("carl", at(day, "18:00"))).toBe(false);
    expect(teamSwapsResponseSchema.parse((await as("anna", "GET", "/api/v1/team/swaps")).json()).swaps).toEqual([]);
  });

  it("refuses «Можно» once the swap's hours began (Moscow): it would re-decide whose its junction's sales were", async (context) => {
    if (!testDb) return context.skip();
    const asked = await as("anna", "POST", "/api/v1/team/questions", {
      pageLabel: "alfa-1", kind: "swap", text: "Не выйду", swap: { date: day, pageLabels: ["alfa-1"], start: "00:00", end: "08:00", coverPersonCode: "carl" },
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const id = teamQuestionWriteResponseSchema.parse(asked.json()).question.id;
    // Its day comes: today, from midnight.
    await testDb.pool.query("update team_questions set swap = jsonb_set(swap, '{date}', to_jsonb($2::text)) where id = $1", [id, moscowDay(Date.now())]);
    const late = await as("lena", "POST", `/api/v1/team/questions/${id}/answer`, { answer: "yes" });
    expect(late.statusCode, late.body).toBe(409);
    expect((late.json() as { reason?: string }).reason).toBe("swap_started");
    const lines = await testDb.pool.query("select count(*)::int as n from person_schedule_slots where question_id = $1", [id]);
    expect(lines.rows[0]!.n).toBe(0);
    // «Нельзя» still answers it.
    expect((await as("lena", "POST", `/api/v1/team/questions/${id}/answer`, { answer: "no" })).statusCode).toBe(200);
  });

  it("lets no swap stand twice over the same hours: refused at asking and at «Можно»; taken back, the hours are free", async (context) => {
    if (!testDb) return context.skip();
    const later = moscowDay(Date.now() + 3 * DAY_MS);
    const swap = { date: later, pageLabels: ["alfa-1"], start: "12:00", end: "20:00", coverPersonCode: "carl" };
    const ask = (who: string, body: object) => as(who, "POST", "/api/v1/team/questions", { pageLabel: "alfa-1", kind: "swap", text: "Не выйду", swap: body });
    const first = await ask("anna", swap);
    expect(first.statusCode, first.body).toBe(200);
    const id = teamQuestionWriteResponseSchema.parse(first.json()).question.id;

    // The same hours asked again while the first waits: refused, in words a person reads.
    const again = await ask("anna", { ...swap, start: "18:00", end: "22:00" });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json()).toMatchObject({ reason: "swap_asked", message: "Подмену на эти часы уже спросили, ждёт ответа" });

    // Two open asks made before this check (or a race): a copy of the first, then «Можно» to both — the second is refused.
    const copy = await testDb.pool.query(`insert into team_questions (asker_user_id, page_id, model_id, kind, text, decider_user_id, door, asked_at, swap)
      select asker_user_id, page_id, model_id, kind, text, decider_user_id, door, asked_at, swap from team_questions where id = $1 returning id`, [id]);
    const twin = Number(copy.rows[0]!.id);
    expect((await as("lena", "POST", `/api/v1/team/questions/${id}/answer`, { answer: "yes" })).statusCode).toBe(200);
    const second = await as("lena", "POST", `/api/v1/team/questions/${twin}/answer`, { answer: "yes" });
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json()).toMatchObject({ reason: "swap_taken", message: "На эти часы подмена уже стоит" });
    const twinLines = await testDb.pool.query("select count(*)::int as n from person_schedule_slots where question_id = $1", [twin]);
    expect(twinLines.rows[0]!.n).toBe(0);
    expect((await testDb.pool.query("select state from team_questions where id = $1", [twin])).rows[0]!.state).toBe("open");

    // Standing now: the same hours, or a part of them, are refused; other hours of that day are not.
    const standing = await ask("anna", { ...swap, start: "19:00", end: "21:00" });
    expect(standing.statusCode, standing.body).toBe(409);
    expect(standing.json()).toMatchObject({ reason: "swap_taken", message: "На эти часы подмена уже стоит" });
    // Whoever covers must be at work in those hours: Anna is off 12:00–20:00, so she covers nobody then.
    const offCover = await ask("carl", { ...swap, start: "14:00", end: "18:00", coverPersonCode: "anna" });
    expect(offCover.statusCode, offCover.body).toBe(409);
    expect(offCover.json()).toMatchObject({ reason: "swap_cover_off", message: "anna сам не выходит в эти часы" });

    // Taken back, the hours are free again.
    expect((await as("lena", "POST", `/api/v1/team/questions/${id}/swap/revoke`)).statusCode).toBe(200);
    expect((await as("anna", "POST", `/api/v1/team/questions/${twin}/close`, { how: "withdraw" })).statusCode).toBe(200);
    const free = await ask("anna", swap);
    expect(free.statusCode, free.body).toBe(200);
  });

  it("sends a lead's «Предложить сетку» to the owner", async (context) => {
    if (!testDb) return context.skip();
    const asked = await as("lena", "POST", "/api/v1/team/questions", { pageLabel: "alfa-1", kind: "schedule", text: "Анна с понедельника 18:00–02:00" });
    expect(asked.statusCode, asked.body).toBe(200);
    expect(teamQuestionWriteResponseSchema.parse(asked.json()).question.decider).toMatchObject({ kind: "owner" });
  });
});
