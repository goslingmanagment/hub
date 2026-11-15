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
  for (const [name, label, pageId] of [["anna", "alfa-1", pageA], ["carl", "alfa-1", pageA], ["lena", "alfa-1", pageA], ["boris", "bravo-1", pageB]] as const) {
    const user = await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
    await db.execute(sql`update users set password_hash = ${hash} where id = ${user.id}`);
    await assignPageToUser(app, { userId: user.id, pageLabel: label }, { source: "cli" });
    const row = await insertPersonRow(db, {
      code: name, displayName: name, kind: "human", role: "chatter", state: "working", leftOn: null, telegramUserId: null,
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

    const asked = await as("anna", "POST", "/api/v1/team/questions", { pageLabel: "alfa-1", kind: "swap", text: "Не выйду, Карл выйдет", swap });
    expect(asked.statusCode, asked.body).toBe(200);
    const question = teamQuestionWriteResponseSchema.parse(asked.json()).question;
    expect(question.decider).toMatchObject({ kind: "team_lead" });
    expect(question.swap).toMatchObject({ date: day, start: "16:00", end: "00:00", absent: { code: "anna" }, cover: { code: "carl" }, approved: false });

    // Nobody but the decider answers it: the covering person is neither asker nor decider, the question is not theirs.
    expect((await as("carl", "POST", `/api/v1/team/questions/${question.id}/answer`, { answer: "yes" })).statusCode).toBe(404);
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

  it("sends a lead's «Предложить сетку» to the owner", async (context) => {
    if (!testDb) return context.skip();
    const asked = await as("lena", "POST", "/api/v1/team/questions", { pageLabel: "alfa-1", kind: "schedule", text: "Анна с понедельника 18:00–02:00" });
    expect(asked.statusCode, asked.body).toBe(200);
    expect(teamQuestionWriteResponseSchema.parse(asked.json()).question.decider).toMatchObject({ kind: "owner" });
  });
});
