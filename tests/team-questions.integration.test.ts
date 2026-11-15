import { afterAll, beforeAll, describe, expect, it } from "vitest";
import argon2 from "argon2";
import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";

import { teamQuestionWriteResponseSchema, teamQuestionsResponseSchema } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, insertPersonLogin, insertPersonRow, type Database } from "@agency_hub_core/db";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { assignPageToUser, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Вопросы тому, кто решает (products plan §4.6), access rights: a chatter asks on a page of their team, the team's lead
// decides it (the owner when the lead asks), nobody else answers it or reads it, a chatter of another team neither asks
// on that page nor sees the question; the decider's matter closes on the answer and the asker's opens, then closes when
// read.

const PASSWORD = "questions-secret-1";

let testDb: StartedTestDatabase | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
const ids = { anna: 0, lena: 0, boris: 0 };

async function person(db: Database, code: string, name: string, userId: number, pageId: number) {
  const row = await insertPersonRow(db, {
    code, displayName: name, kind: "human", role: "chatter", state: "working", leftOn: null, telegramUserId: null,
    telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
  });
  await insertPersonLogin(db, { personId: row.id, userId, linkedByUserId: null });
  await db.execute(sql`insert into person_working_pages (person_id, page_id, position) values (${row.id}, ${pageId}, 0)`);
  return row.id;
}

async function login(username: string) {
  const response = await server!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: PASSWORD } });
  expect(response.statusCode, response.body).toBe(200);
  const header = response.headers["set-cookie"];
  return String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
}

const as = (who: string, method: "GET" | "POST", url: string, payload?: object) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });

async function openMatters(kind: string): Promise<Array<{ owner_user_id: string | null; owner_role: string | null; reason_key: string }>> {
  const result = await testDb!.pool.query("select owner_user_id::text, owner_role, reason_key from matters where kind = $1 and state = 'open' order by id", [kind]);
  return result.rows;
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  const app = createTestAppContext(testDb);
  const db = app.db as Database;
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await createUserAccount(app, { username: "olga", role: "owner", password: PASSWORD }, { source: "cli" });
  const modelA = await createModel(db, { slug: "alfa", name: "Alfa" });
  const modelB = await createModel(db, { slug: "bravo", name: "Bravo" });
  const pageA = (await createFanslyPage(db, { modelId: modelA.id, label: "alfa-1" })).id;
  const pageB = (await createFanslyPage(db, { modelId: modelB.id, label: "bravo-1" })).id;
  const people: Record<string, number> = {};
  for (const [name, page, pageId] of [["anna", "alfa-1", pageA], ["lena", "alfa-1", pageA], ["boris", "bravo-1", pageB]] as const) {
    const user = await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
    await db.execute(sql`update users set password_hash = ${hash} where id = ${user.id}`);
    await assignPageToUser(app, { userId: user.id, pageLabel: page }, { source: "cli" });
    ids[name] = user.id;
    people[name] = await person(db, `${name}-x`, name, user.id, pageId);
  }
  // Lena leads team Alfa (a chatter who leads her team stays a chatter).
  await db.execute(sql`insert into team_roles (person_id, model_id, kind) values (${people.lena!}, ${modelA.id}, 'lead')`);
  server = await buildApiServer(createTestAppContext(testDb));
  for (const name of ["olga", "anna", "lena", "boris"]) cookies[name] = await login(name);
}, 120_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

describe("questions to whoever decides", () => {
  it("goes to the team's lead, comes back to the asker, and nobody else answers or reads it", async (context) => {
    if (!server || !testDb) return context.skip();
    const asked = await as("anna", "POST", "/api/v1/team/questions", { pageLabel: "alfa-1", kind: "discount_over_50", text: "60 % на пак?", fanName: "Fan A" });
    expect(asked.statusCode, asked.body).toBe(200);
    const question = teamQuestionWriteResponseSchema.parse(asked.json()).question;
    expect(question).toMatchObject({ decider: { kind: "team_lead", name: "lena" }, state: "open", mine: true, canAnswer: false });
    // A team lead's role matter of the page: it waits for the lead of the model now (the records), not a stored login.
    expect(await openMatters("question.asked")).toEqual([{ owner_user_id: null, owner_role: "team_lead", reason_key: `question.asked:${question.id}` }]);

    // Another team: no asking on Alfa's page, no reading Anna's question, no answering it.
    expect((await as("boris", "POST", "/api/v1/team/questions", { pageLabel: "alfa-1", kind: "late", text: "опоздаю" })).statusCode).toBe(403);
    expect((await as("boris", "GET", `/api/v1/team/questions?id=${question.id}`)).statusCode).toBe(404);
    expect(teamQuestionsResponseSchema.parse((await as("boris", "GET", "/api/v1/team/questions")).json()).questions).toEqual([]);
    expect((await as("boris", "POST", `/api/v1/team/questions/${question.id}/answer`, { answer: "yes" })).statusCode).toBe(404);
    // The asker does not answer their own question.
    expect((await as("anna", "POST", `/api/v1/team/questions/${question.id}/answer`, { answer: "yes" })).statusCode).toBe(403);

    // The lead sees it to answer, and answers.
    const leads = teamQuestionsResponseSchema.parse((await as("lena", "GET", "/api/v1/team/questions")).json()).questions;
    expect(leads.map((one) => [one.id, one.canAnswer])).toEqual([[question.id, true]]);
    const answered = await as("lena", "POST", `/api/v1/team/questions/${question.id}/answer`, { answer: "no", text: "не больше 50" });
    expect(answered.statusCode, answered.body).toBe(200);
    expect(await openMatters("question.asked")).toEqual([]);
    expect(await openMatters("question.answered")).toEqual([{ owner_user_id: String(ids.anna), owner_role: null, reason_key: `question.answered:${question.id}` }]);
    expect((await as("lena", "POST", `/api/v1/team/questions/${question.id}/answer`, { answer: "yes" })).statusCode).toBe(409);

    // The asker reads the answer; only they mark it read.
    const mine = teamQuestionsResponseSchema.parse((await as("anna", "GET", `/api/v1/team/questions?id=${question.id}`)).json()).questions[0]!;
    expect(mine).toMatchObject({ state: "answered", answer: "no", answerText: "не больше 50", answeredBy: "lena", seen: false });
    expect((await as("lena", "POST", `/api/v1/team/questions/${question.id}/close`, { how: "seen" })).statusCode).toBe(403);
    expect((await as("anna", "POST", `/api/v1/team/questions/${question.id}/close`, { how: "seen" })).statusCode).toBe(200);
    expect(await openMatters("question.answered")).toEqual([]);
  });

  it("goes to the owner when the lead asks, and the owner answers any", async (context) => {
    if (!server || !testDb) return context.skip();
    const asked = await as("lena", "POST", "/api/v1/team/questions", { pageLabel: "alfa-1", kind: "swap", text: "возьму смену в четверг" });
    expect(asked.statusCode, asked.body).toBe(200);
    const question = teamQuestionWriteResponseSchema.parse(asked.json()).question;
    expect(question.decider.kind).toBe("owner");
    expect(await openMatters("question.asked")).toEqual([{ owner_user_id: null, owner_role: "owner", reason_key: `question.asked:${question.id}` }]);
    // A colleague of the team does not read a question that is not theirs.
    expect((await as("anna", "GET", `/api/v1/team/questions?id=${question.id}`)).statusCode).toBe(404);
    expect((await as("olga", "POST", `/api/v1/team/questions/${question.id}/answer`, { answer: "yes" })).statusCode).toBe(200);
  });
});
