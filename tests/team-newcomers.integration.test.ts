import { afterAll, beforeAll, describe, expect, it } from "vitest";
import argon2 from "argon2";
import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";

import { teamNewcomersResponseSchema } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, insertPersonLogin, insertPersonRow, type Database } from "@agency_hub_core/db";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { assignPageToUser, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// «Команда → Новички» (products package W), who sees whom: a newcomer works models A and B; the lead of A reads the
// newcomer's first week on A's pages only — no page, time or number of a shift worked on B, and of their teams A alone.
// The owner reads both.

const PASSWORD = "newcomers-secret-1";
const HOUR_MS = 3_600_000;

let testDb: StartedTestDatabase | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
const onA = Math.floor((Date.now() - 50 * HOUR_MS) / HOUR_MS) * HOUR_MS;
const onB = Math.floor((Date.now() - 26 * HOUR_MS) / HOUR_MS) * HOUR_MS;

async function login(username: string) {
  const response = await server!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: PASSWORD } });
  expect(response.statusCode, response.body).toBe(200);
  const header = response.headers["set-cookie"];
  return String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
}

/** Three hours of work with 60 messages on a page: a shift. */
async function work(db: Database, userId: number, pageId: number, start: number, salt: number) {
  await db.execute(sql`insert into chatter_activity_minutes (user_id, page_id, minute, input)
    select ${userId}, ${pageId}, m, true from generate_series(date_trunc('minute', ${new Date(start).toISOString()}::timestamptz),
      date_trunc('minute', ${new Date(start + 3 * HOUR_MS).toISOString()}::timestamptz), interval '1 minute') m`);
  for (let index = 0; index < 60; index += 1) {
    await db.execute(sql`insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, conversation_ref, user_id,
      source, priced, with_media, observed_at) values ('fansly', ${pageId}, ${String(salt + index)}, ${`fan-${salt}`}, ${`fan-${salt}`}, ${userId},
      'fansly-extension', false, false, ${new Date(start + (index + 1) * 3 * 60_000).toISOString()}::timestamptz)`);
  }
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
  const users: Record<string, number> = {};
  const persons: Record<string, number> = {};
  for (const [name, pages] of [["nina", [pageA, pageB]], ["lena", [pageA]]] as const) {
    const user = await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
    await db.execute(sql`update users set password_hash = ${hash} where id = ${user.id}`);
    for (const label of pages.map((id) => (id === pageA ? "alfa-1" : "bravo-1"))) await assignPageToUser(app, { userId: user.id, pageLabel: label }, { source: "cli" });
    const row = await insertPersonRow(db, {
      code: name, displayName: name, kind: "human", role: "chatter", state: "working", leftOn: null, telegramUserId: null,
      telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
    });
    await insertPersonLogin(db, { personId: row.id, userId: user.id, linkedByUserId: null });
    for (const [index, pageId] of pages.entries()) {
      await db.execute(sql`insert into person_working_pages (person_id, page_id, position) values (${row.id}, ${pageId}, ${index})`);
    }
    users[name] = user.id;
    persons[name] = row.id;
  }
  // Nina's first week: a shift on A, then one on B. Lena leads team A.
  await work(db, users.nina!, pageA, onA, 700_000);
  await work(db, users.nina!, pageB, onB, 800_000);
  await db.execute(sql`insert into team_roles (person_id, model_id, kind) values (${persons.lena!}, ${modelA.id}, 'lead')`);
  server = await buildApiServer(createTestAppContext(testDb));
  for (const name of ["olga", "lena"]) cookies[name] = await login(name);
}, 120_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

describe("«Новички»: a newcomer of two teams", () => {
  it("shows the lead of A nothing of B: no page, time or number of B's shift, and of the teams A alone", async (context) => {
    if (!testDb) return context.skip();
    const read = await server!.inject({ method: "GET", url: "/api/v1/team/newcomers", headers: { cookie: cookies.lena! } });
    expect(read.statusCode, read.body).toBe(200);
    const nina = teamNewcomersResponseSchema.parse(read.json()).newcomers.find((one) => one.code === "nina");
    expect(nina, read.body).toBeDefined();
    expect(nina!.teams).toEqual(["Alfa"]);
    expect(nina!.shifts.map((shift) => shift.pages)).toEqual([["alfa-1"]]);
    expect(nina!.shifts.every((shift) => Date.parse(shift.startedAt) < onB)).toBe(true);
    expect(read.body.includes("bravo-1")).toBe(false);
    expect(read.body.includes("\"Bravo\"")).toBe(false);

    // The owner reads both.
    const owner = await server!.inject({ method: "GET", url: "/api/v1/team/newcomers", headers: { cookie: cookies.olga! } });
    const ownerNina = teamNewcomersResponseSchema.parse(owner.json()).newcomers.find((one) => one.code === "nina")!;
    expect(ownerNina.teams).toEqual(["Alfa", "Bravo"]);
    expect(ownerNina.shifts.map((shift) => shift.pages)).toEqual([["alfa-1"], ["bravo-1"]]);
  });
});
