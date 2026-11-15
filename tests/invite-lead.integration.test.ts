import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { workboardTodayResponseSchema } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, type Database } from "@agency_hub_core/db";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// A team lead invited with «Ведёт команды» (products package W): the `lead` records are written with the person, in one
// step, so the lead's first «Сегодня» names their team at once — no second step on the card. «Ведёт команды» is a team
// lead's only, and a model that does not exist leaves nothing behind.

const PASSWORD = "invite-lead-secret-1";

let testDb: StartedTestDatabase | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let ownerCookie = "";

async function login(username: string, password: string) {
  const response = await server!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password } });
  expect(response.statusCode, response.body).toBe(200);
  const header = response.headers["set-cookie"];
  return String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
}

const create = (payload: object) => server!.inject({ method: "POST", url: "/api/v1/admin/people", headers: { cookie: ownerCookie }, payload });

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  const app = createTestAppContext(testDb);
  const db = app.db as Database;
  await createUserAccount(app, { username: "olga", role: "owner", password: PASSWORD }, { source: "cli" });
  const alfa = await createModel(db, { slug: "alfa", name: "Alfa" });
  await createModel(db, { slug: "bravo", name: "Bravo" });
  await createFanslyPage(db, { modelId: alfa.id, label: "alfa-1" });
  server = await buildApiServer(createTestAppContext(testDb));
  ownerCookie = await login("olga", PASSWORD);
}, 120_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

describe("inviting a team lead with «Ведёт команды»", () => {
  it("writes the lead records with the person: the lead's first «Сегодня» names the team", async (context) => {
    if (!testDb) return context.skip();
    const invited = await create({
      code: "mira", displayName: "Mira", role: "team_lead", state: "invited", workingPageLabels: ["alfa-1"], leadModelSlugs: ["alfa"],
      invite: { username: "mira", role: "team_lead", pageLabels: ["alfa-1"], expiresInHours: 72 },
    });
    expect(invited.statusCode, invited.body).toBe(200);
    const token = (invited.json() as { invite: { link: { token: string } } }).invite.link.token;
    const redeemed = await server!.inject({ method: "POST", url: "/api/v1/auth/links/redeem", payload: { token, password: "mira-new-password-1" } });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const cookie = await login("mira", "mira-new-password-1");
    const today = await server!.inject({ method: "GET", url: "/api/v1/workboard/today", headers: { cookie } });
    expect(today.statusCode, today.body).toBe(200);
    const team = workboardTodayResponseSchema.parse(today.json()).team;
    expect(team?.teams.map((one) => one.name)).toEqual(["Alfa"]);
    expect(team?.firstDay).toBe(true);
  });

  it("is a team lead's only, and an unknown model leaves nothing behind", async (context) => {
    if (!testDb) return context.skip();
    const chatter = await create({ code: "nick", displayName: "Nick", role: "chatter", state: "set_up", leadModelSlugs: ["alfa"] });
    expect(chatter.statusCode, chatter.body).toBe(400);
    const unknown = await create({ code: "tom", displayName: "Tom", role: "team_lead", state: "set_up", leadModelSlugs: ["nope"] });
    expect(unknown.statusCode, unknown.body).toBe(404);
    const left = await testDb.pool.query("select count(*)::int as n from people where code in ('nick', 'tom')");
    expect(left.rows[0]!.n).toBe(0);
  });
});
