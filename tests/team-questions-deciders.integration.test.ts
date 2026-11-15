import { afterAll, beforeAll, describe, expect, it } from "vitest";
import argon2 from "argon2";
import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";

import { mattersListResponseSchema, teamPeopleResponseSchema, teamQuestionWriteResponseSchema, teamQuestionsResponseSchema } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, insertPersonLogin, insertPersonRow, type Database } from "@agency_hub_core/db";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { assignPageToUser, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { runTeamQuestionsTick } from "../apps/runtime/src/services/team-questions-tick.ts";

// Questions to whoever decides, after the third review (products package W):
//   1. whoever COVERS an approved swap is told («Ждут вас») and reads the question; told again when it is taken back;
//   2. the decider is the rule's at the moment of reading and answering (`deciderOf`), the stored one is history: a lead
//      whose record was taken back no longer approves, the new lead sees and answers the open question;
//   3. a person invited and not signed in yet (no password) leads nothing: their team's questions stay the owner's.

const PASSWORD = "deciders-secret-1";
const DAY_MS = 86_400_000;

let testDb: StartedTestDatabase | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
const persons: Record<string, number> = {};
const models: Record<string, number> = {};

const day = new Date(Date.now() + 3 * 3_600_000 + 2 * DAY_MS).toISOString().slice(0, 10);

async function login(username: string) {
  const response = await server!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: PASSWORD } });
  expect(response.statusCode, response.body).toBe(200);
  const header = response.headers["set-cookie"];
  return String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
}

const as = (who: string, method: "GET" | "POST", url: string, payload?: object) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  const app = createTestAppContext(testDb);
  const db = app.db as Database;
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await createUserAccount(app, { username: "olga", role: "owner", password: PASSWORD }, { source: "cli" });
  for (const slug of ["alfa", "bravo"]) {
    const model = await createModel(db, { slug, name: slug === "alfa" ? "Alfa" : "Bravo" });
    models[slug] = model.id;
    await createFanslyPage(db, { modelId: model.id, label: `${slug}-1` });
  }
  const pageOf = async (label: string) => Number((await testDb!.pool.query("select id from pages where label = $1", [label])).rows[0]!.id);
  // Mira is invited to lead Bravo and has not signed in yet: a login with no password.
  for (const [name, label, signedIn] of [["anna", "alfa-1", true], ["carl", "alfa-1", true], ["lena", "alfa-1", true], ["lev", "alfa-1", true], ["boris", "bravo-1", true], ["mira", "bravo-1", false]] as const) {
    const user = await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
    if (signedIn) await db.execute(sql`update users set password_hash = ${hash} where id = ${user.id}`);
    if (name === "mira") await db.execute(sql`update users set role = 'team_lead' where id = ${user.id}`);
    await assignPageToUser(app, { userId: user.id, pageLabel: label }, { source: "cli" });
    const row = await insertPersonRow(db, {
      code: name, displayName: name, kind: "human", role: name === "mira" ? "team_lead" : "chatter", state: name === "mira" ? "invited" : "working",
      leftOn: null, telegramUserId: null, telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
    });
    await insertPersonLogin(db, { personId: row.id, userId: user.id, linkedByUserId: null });
    await db.execute(sql`insert into person_working_pages (person_id, page_id, position) values (${row.id}, ${await pageOf(label)}, 0)`);
    persons[name] = row.id;
  }
  await db.execute(sql`insert into person_schedule_slots (person_id, page_id, start_minute, end_minute, valid_from) values (${persons.anna!}, null, 720, 1200, '2026-01-01')`);
  await db.execute(sql`insert into team_roles (person_id, model_id, kind) values (${persons.lena!}, ${models.alfa!}, 'lead'), (${persons.mira!}, ${models.bravo!}, 'lead')`);
  server = await buildApiServer(createTestAppContext(testDb));
  for (const name of ["olga", "anna", "carl", "lena", "lev", "boris"]) cookies[name] = await login(name);
}, 120_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

async function askSwap() {
  const asked = await as("anna", "POST", "/api/v1/team/questions", {
    pageLabel: "alfa-1", kind: "swap", text: "Не выйду", swap: { date: day, pageLabels: ["alfa-1"], start: "12:00", end: "20:00", coverPersonCode: "carl" },
  });
  expect(asked.statusCode, asked.body).toBe(200);
  return teamQuestionWriteResponseSchema.parse(asked.json()).question.id;
}

describe("questions after the third review", () => {
  it("tells whoever covers an approved swap, lets them read it, and tells them when it is taken back", async (context) => {
    if (!testDb) return context.skip();
    const id = await askSwap();
    expect((await as("lena", "POST", `/api/v1/team/questions/${id}/answer`, { answer: "yes" })).statusCode).toBe(200);
    const carlMatters = mattersListResponseSchema.parse((await as("carl", "GET", "/api/v1/matters?state=open")).json()).matters.filter((one) => one.mine);
    expect(carlMatters.map((one) => one.kind)).toContain("question.cover");
    expect(carlMatters.find((one) => one.kind === "question.cover")!.title).toContain("anna");
    const read = await as("carl", "GET", `/api/v1/team/questions?id=${id}`);
    expect(read.statusCode, read.body).toBe(200);
    expect(teamQuestionsResponseSchema.parse(read.json()).questions[0]!.canAnswer).toBe(false);

    expect((await as("lena", "POST", `/api/v1/team/questions/${id}/swap/revoke`)).statusCode).toBe(200);
    const after = mattersListResponseSchema.parse((await as("carl", "GET", "/api/v1/matters?state=open")).json()).matters.filter((one) => one.mine && one.kind === "question.cover");
    expect(after.map((one) => one.title.includes("отменена"))).toEqual([true]);
  });

  it("asks the rule again: a lead whose record was taken back no longer decides, the new lead sees and answers", async (context) => {
    if (!testDb) return context.skip();
    const id = await askSwap();
    await testDb.pool.query("update team_roles set revoked_at = now() where person_id = $1 and kind = 'lead'", [persons.lena]);
    await testDb.pool.query("insert into team_roles (person_id, model_id, kind) values ($1, $2, 'lead')", [persons.lev, models.alfa]);
    const lena = await as("lena", "POST", `/api/v1/team/questions/${id}/answer`, { answer: "yes" });
    expect([403, 404]).toContain(lena.statusCode);
    const lines = await testDb.pool.query("select count(*)::int as n from person_schedule_slots where question_id = $1", [id]);
    expect(lines.rows[0]!.n).toBe(0);
    const levList = teamQuestionsResponseSchema.parse((await as("lev", "GET", "/api/v1/team/questions")).json()).questions;
    expect(levList.find((one) => one.id === id)?.canAnswer).toBe(true);
    expect(levList.find((one) => one.id === id)?.decider).toMatchObject({ kind: "team_lead", name: "lev" });
    const levMatters = mattersListResponseSchema.parse((await as("lev", "GET", "/api/v1/matters?state=open")).json()).matters;
    expect(levMatters.some((one) => one.mine && one.kind === "question.asked")).toBe(true);
    expect((await as("lev", "POST", `/api/v1/team/questions/${id}/answer`, { answer: "no" })).statusCode).toBe(200);
  });

  it("lets nobody invited and not signed in yet decide: Bravo's questions stay the owner's", async (context) => {
    if (!testDb) return context.skip();
    const asked = await as("boris", "POST", "/api/v1/team/questions", { pageLabel: "bravo-1", kind: "late", text: "Опоздаю на час" });
    expect(asked.statusCode, asked.body).toBe(200);
    expect(teamQuestionWriteResponseSchema.parse(asked.json()).question.decider).toMatchObject({ kind: "owner" });
    const owner = teamQuestionsResponseSchema.parse((await as("olga", "GET", "/api/v1/team/questions")).json()).questions;
    expect(owner.find((one) => one.text === "Опоздаю на час")?.canAnswer).toBe(true);
  });

  it("gives a chatter colleagues without their logins' names or rights; a lead keeps the names (the card's «Чей вход»)", async (context) => {
    if (!testDb) return context.skip();
    await testDb.pool.query("insert into person_rights (person_id, \"right\") values ($1, 'submits_shift') on conflict do nothing", [persons.carl]);
    const chatter = teamPeopleResponseSchema.parse((await as("anna", "GET", "/api/v1/team/people")).json()).people;
    const carl = chatter.find((one) => one.code === "carl")!;
    expect(carl.logins.map((login) => login.username)).toEqual([""]);
    expect(carl.logins[0]!.userId).toBeGreaterThan(0);
    expect(chatter.every((one) => one.rights.length === 0)).toBe(true);
    const lead = teamPeopleResponseSchema.parse((await as("lev", "GET", "/api/v1/team/people")).json()).people;
    expect(lead.find((one) => one.code === "carl")!.logins.map((login) => login.username)).toEqual(["carl"]);
  });

  it("gives a team's first lead the questions asked before they signed in: the tick re-addresses the open matter", async (context) => {
    if (!testDb) return context.skip();
    const app = createTestAppContext(testDb);
    const db = app.db as Database;
    const charlie = await createModel(db, { slug: "charlie", name: "Charlie" });
    await createFanslyPage(db, { modelId: charlie.id, label: "charlie-1" });
    const user = await createUserAccount(app, { username: "dina", role: "chatter" }, { source: "cli" });
    await db.execute(sql`update users set password_hash = ${await argon2.hash(PASSWORD, { type: argon2.argon2id })} where id = ${user.id}`);
    await assignPageToUser(app, { userId: user.id, pageLabel: "charlie-1" }, { source: "cli" });
    const row = await insertPersonRow(db, {
      code: "dina", displayName: "dina", kind: "human", role: "chatter", state: "working", leftOn: null, telegramUserId: null, telegramHandle: null,
      reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
    });
    await insertPersonLogin(db, { personId: row.id, userId: user.id, linkedByUserId: null });
    await testDb.pool.query("insert into person_working_pages (person_id, page_id, position) select $1, id, 0 from pages where label = 'charlie-1'", [row.id]);
    cookies.dina = await login("dina");

    // Charlie has no lead: the question is the owner's.
    const asked = await as("dina", "POST", "/api/v1/team/questions", { pageLabel: "charlie-1", kind: "late", text: "Опоздаю на полчаса" });
    expect(asked.statusCode, asked.body).toBe(200);
    const id = teamQuestionWriteResponseSchema.parse(asked.json()).question.id;

    // The owner invites Charlie's first lead with the team; the lead sets a password.
    const invited = await as("olga", "POST", "/api/v1/admin/people", {
      code: "rita", displayName: "rita", role: "team_lead", state: "invited", workingPageLabels: ["charlie-1"], leadModelSlugs: ["charlie"],
      invite: { username: "rita", role: "team_lead", pageLabels: ["charlie-1"], expiresInHours: 72 },
    });
    expect(invited.statusCode, invited.body).toBe(200);
    const token = (invited.json() as { invite: { link: { token: string } } }).invite.link.token;
    const redeemed = await server!.inject({ method: "POST", url: "/api/v1/auth/links/redeem", payload: { token, password: PASSWORD } });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    cookies.rita = await login("rita");

    await runTeamQuestionsTick(app);
    const ritaMatters = mattersListResponseSchema.parse((await as("rita", "GET", "/api/v1/matters?state=open")).json()).matters;
    expect(ritaMatters.filter((one) => one.mine && one.kind === "question.asked").map((one) => one.object?.id)).toEqual([String(id)]);
    const ritaList = teamQuestionsResponseSchema.parse((await as("rita", "GET", "/api/v1/team/questions")).json()).questions;
    expect(ritaList.find((one) => one.id === id)?.canAnswer).toBe(true);
    // Re-addressed, not opened twice; the owner still sees the question in the common list.
    const rows = await testDb.pool.query("select count(*)::int as n from matters where reason_key = $1", [`question.asked:${id}`]);
    expect(rows.rows[0]!.n).toBe(1);
    const owner = teamQuestionsResponseSchema.parse((await as("olga", "GET", "/api/v1/team/questions")).json()).questions;
    expect(owner.some((one) => one.id === id)).toBe(true);
  });
});
