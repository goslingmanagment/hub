import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { clientMattersResponseSchema, mattersListResponseSchema, mattersWaitingResponseSchema } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, openMatter, type MatterOpenInput } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { assignPageToUser, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { runMattersMirror } from "../apps/runtime/src/services/matters-mirror.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// «Ждут вас» is what waits for the viewer THEMSELF (ecosystem K follow-up): the
// owner reads every matter, but his list's number, the menu, the Home row and the
// extension's icon count only his user's matters, the owner's role and — while
// nobody holds it — the team lead's role. A team lead's and a chatter's counts
// are what they read. Once the custom orders are customs' home, the matters
// mirror opens nothing of the old per-order kind and closes what it had.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const AUDIT = { source: "cli" } as const;
const PASSWORDS = { boss: "boss-secret", lead: "lead-secret", alice: "alice-secret" } as const;
let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const users: Record<string, number> = {};
const pages: Record<string, number> = {};
const cookies: Record<string, string> = {};
const tokens: Record<string, string> = {};

async function loginCookie(username: keyof typeof PASSWORDS): Promise<string> {
  const login = await server!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: PASSWORDS[username] } });
  expect(login.statusCode, login.body).toBe(200);
  const header = login.headers["set-cookie"];
  return (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
}
const asSession = (who: string, url: string) => server!.inject({ method: "GET", url, headers: { cookie: cookies[who]! } });

function matter(key: string, over: Partial<MatterOpenInput>): MatterOpenInput {
  return {
    key, kind: key.slice(0, key.indexOf(":")), source: "agent", title: `Дело ${key}`, object: null, pageIds: [],
    owner: { role: "owner" }, money: false, evidence: {}, link: null, ...over,
  };
}
const SYSTEM = { door: "system" } as const;

/** The «Другие дела» row's count of a session's «Ждут вас»: every matter here is of a kind no old row counts. */
async function otherCount(who: string): Promise<number> {
  const response = await asSession(who, "/api/v1/matters/waiting");
  expect(response.statusCode, response.body).toBe(200);
  return mattersWaitingResponseSchema.parse(response.json()).rows.find((row) => row.id === "other")?.count ?? 0;
}
async function list(who: string) {
  const response = await asSession(who, "/api/v1/matters?kind=own.test");
  expect(response.statusCode, response.body).toBe(200);
  return mattersListResponseSchema.parse(response.json()).matters.map((one) => [one.key, one.mine] as const).sort();
}
async function clientCount(who: string): Promise<number> {
  const response = await server!.inject({ method: "GET", url: "/api/v1/client/matters", headers: { authorization: `Bearer ${tokens[who]!}` } });
  expect(response.statusCode, response.body).toBe(200);
  return clientMattersResponseSchema.parse(response.json()).count;
}

describe("«Ждут вас»: what waits for the viewer themself", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: PASSWORDS.boss }, AUDIT);
    await createUserAccount(app, { username: "alice", role: "chatter" }, AUDIT);
    await setUserPassword(app, { userId: await fixtureUserId(app, "alice"), password: PASSWORDS.alice }, AUDIT);
    await createUserAccount(app, { username: "carol", role: "chatter" }, AUDIT);
    for (const name of ["boss", "alice", "carol"]) users[name] = await fixtureUserId(app, name);
    const model = await createModel(app.db, { slug: "lora", name: "Lora" });
    for (const label of ["lora-1", "lora-2"]) pages[label] = (await createFanslyPage(app.db, { modelId: model!.id, label }))!.id;
    await assignPageToUser(app, { userId: users.alice!, pageLabel: "lora-1" }, AUDIT);

    await openMatter(app.db, matter("own.test:owner-role", { owner: { role: "owner" } }), SYSTEM);
    await openMatter(app.db, matter("own.test:boss", { owner: { userId: users.boss! } }), SYSTEM);
    // Another person's: the one who leads customs.
    await openMatter(app.db, matter("own.test:carol", { owner: { userId: users.carol! } }), SYSTEM);
    await openMatter(app.db, matter("own.test:alice", { owner: { userId: users.alice! } }), SYSTEM);
    await openMatter(app.db, matter("own.test:alice-money", { owner: { userId: users.alice! }, money: true }), SYSTEM);
    await openMatter(app.db, matter("own.test:team-lead", { owner: { role: "team_lead" }, pageIds: [pages["lora-1"]!] }), SYSTEM);

    server = await buildApiServer(app);
    await server.ready();
    for (const name of ["boss", "alice"] as const) cookies[name] = await loginCookie(name);
    for (const name of ["boss", "alice"] as const) tokens[name] = (await issueDeviceTokenForUserId(app, { userId: users[name]!, label: `${name} client` })).token;
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("the owner's count is his own, his role's and the team lead's while nobody holds that role; another person's is oversight", async (context) => {
    if (!testDb) return context.skip();
    // Nobody holds the team lead's role: the owner is the acting team lead.
    expect(await otherCount("boss")).toBe(3);
    // His number is the list's: the sum of the Home's chips (the groups), and these own matters are all in them.
    const answer = mattersWaitingResponseSchema.parse((await asSession("boss", "/api/v1/matters/waiting")).json());
    expect(answer.total).toBe(answer.groups.reduce((sum, group) => sum + group.count, 0));
    expect(answer.groups.find((group) => group.id === "other")?.count).toBe(3);
    expect(await clientCount("boss")).toBe(3);
    // He still reads every matter, each said whether it is his.
    expect(await list("boss")).toEqual([
      ["own.test:alice", false], ["own.test:alice-money", false], ["own.test:boss", true], ["own.test:carol", false],
      ["own.test:owner-role", true], ["own.test:team-lead", true],
    ]);
  });

  it("the customs count is the lead's line: the acting team lead's while nobody has «ведёт кастомы», nobody's once a person has it", async (context) => {
    if (!testDb) return context.skip();
    await testDb.pool.query("insert into custom_orders (page_id, state, origin) values ($1, 'paid', 'workboard')", [pages["lora-1"]]);
    const waiting = async () => mattersWaitingResponseSchema.parse((await asSession("boss", "/api/v1/matters/waiting")).json());
    Object.assign(app.config, { customOrdersReadEnabled: true });
    try {
      // Nobody leads customs and nobody holds the team lead's role: the owner's row, counted.
      const acting = await waiting();
      expect(acting.rows.find((row) => row.id === "customs")).toMatchObject({ count: 1, to: "/workboard/customs", matterIds: [] });
      expect(acting.decisions.customs).toBe(1);
      const withRow = acting.total;

      // A person leads customs: the count is nobody's — in no row and no number of the owner's.
      const person = await testDb.pool.query(
        "insert into people (code, display_name, kind, role, state, origin) values ('carol', 'Кэрол', 'human', 'chatter', 'working', 'owner') returning id",
      );
      await testDb.pool.query("insert into person_logins (user_id, person_id) values ($1, $2)", [users.carol, person.rows[0].id]);
      await testDb.pool.query("insert into person_rights (person_id, \"right\") values ($1, 'customs_lead')", [person.rows[0].id]);
      const led = await waiting();
      expect(led.rows.find((row) => row.id === "customs")).toBeUndefined();
      expect(led.decisions.customs).toBe(0);
      expect(led.total).toBe(withRow - 1);
      // The lead's matters are oversight for the owner, under the person's name.
      const lines = mattersListResponseSchema.parse((await asSession("boss", "/api/v1/matters?kind=own.test")).json()).matters;
      expect(lines.find((one) => one.key === "own.test:carol")?.owner).toMatchObject({ kind: "user", username: "carol", displayName: "Кэрол" });

      await testDb.pool.query("delete from person_rights where person_id = $1", [person.rows[0].id]);
      expect((await waiting()).rows.find((row) => row.id === "customs")).toMatchObject({ count: 1 });
    } finally {
      Object.assign(app.config, { customOrdersReadEnabled: false });
    }
  });

  it("once someone holds the team lead's role, its matters leave the owner's count; a team lead's and a chatter's counts are what they read", async (context) => {
    if (!testDb) return context.skip();
    const aliceBefore = await clientCount("alice");
    await createUserAccount(app, { username: "lead", role: "team_lead", password: PASSWORDS.lead }, AUDIT);
    users.lead = await fixtureUserId(app, "lead");
    await assignPageToUser(app, { userId: users.lead, pageLabel: "lora-1" }, AUDIT);
    cookies.lead = await loginCookie("lead");

    expect(await otherCount("boss")).toBe(2);
    expect(await clientCount("boss")).toBe(2);
    expect((await list("boss")).find(([key]) => key === "own.test:team-lead")).toEqual(["own.test:team-lead", false]);

    expect(await otherCount("lead")).toBe(1);
    // A team lead's answer is as before: the number is the sum of the rows.
    const lead = mattersWaitingResponseSchema.parse((await asSession("lead", "/api/v1/matters/waiting")).json());
    expect(lead.total).toBe(lead.rows.reduce((sum, row) => sum + (row.count ?? 0), 0));
    expect(await list("lead")).toEqual([["own.test:team-lead", true]]);
    expect(await list("alice")).toEqual([["own.test:alice", true]]);
    expect(await clientCount("alice")).toBe(1);
    expect(aliceBefore).toBe(1);
  });

  it("with the custom orders as customs' home, the mirror opens nothing of the old per-order kind and closes what it had", async (context) => {
    if (!testDb) return context.skip();
    await openMatter(app.db, {
      key: "custom.paid_not_delivered:CUS-0001", kind: "custom.paid_not_delivered", source: "server", title: "Кастом оплачен, не отдан: lora-1",
      object: null, pageIds: [pages["lora-1"]!], owner: { role: "team_lead" }, money: false, evidence: {}, link: null,
    }, SYSTEM);
    Object.assign(app.config, { customOrdersReadEnabled: true });
    try {
      await runMattersMirror(app, { now: new Date() });
      const rows = await testDb.pool.query("select state, closed_how from matters where kind = 'custom.paid_not_delivered'");
      expect(rows.rows).toEqual([{ state: "closed", closed_how: "cause_gone" }]);
    } finally {
      Object.assign(app.config, { customOrdersReadEnabled: false });
    }
  });
});
