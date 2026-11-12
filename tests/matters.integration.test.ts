import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  agentMatterResponseSchema,
  clientMattersResponseSchema,
  mattersListResponseSchema,
  mattersWaitingResponseSchema,
} from "@agency_hub_core/contracts";
import {
  closeMatter,
  createFanslyPage,
  createModel,
  insertAgentKey,
  listMatterChecks,
  listObjectEvents,
  openMatter,
  openNotificationIncident,
  recoverAndResolveNotificationIncident,
  type MatterOpenInput,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, assignPageToUser, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { runMattersMirror } from "../apps/runtime/src/services/matters-mirror.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Дела (ecosystem plan, package D): one matter per reason key — opening it
// again updates it, closing a closed one changes nothing, a closed key that
// comes back reopens its row; each door reads only what is its own (a chatter
// their own matters, nobody but the owner a matter with money); an agent key
// writes only its own kinds; the mirror turns the sources of «Ждут вас» into
// matters, closes what went away, and a source that did not answer is «не
// проверено», never a zero.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const AUDIT = { source: "cli" } as const;
const PASSWORDS = { boss: "boss-secret", lead: "lead-secret", alice: "alice-secret", bob: "bob-secret" } as const;
const AGENT = `${AGENT_KEY_TOKEN_PREFIX}matters-gengar-0000`;
const READER = `${AGENT_KEY_TOKEN_PREFIX}matters-reader-0000`;
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
const agent = (url: string, payload: Record<string, unknown>, token = AGENT) =>
  server!.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload });

function matter(key: string, over: Partial<MatterOpenInput> = {}): MatterOpenInput {
  return {
    key, kind: key.slice(0, key.indexOf(":")), source: "agent", title: `Дело ${key}`, object: null, pageIds: [],
    owner: { role: "owner" }, money: false, evidence: {}, link: null, ...over,
  };
}
const SYSTEM = { door: "system" } as const;

describe("matters", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: PASSWORDS.boss }, AUDIT);
    await createUserAccount(app, { username: "lead", role: "team_lead", password: PASSWORDS.lead }, AUDIT);
    for (const name of ["alice", "bob"] as const) {
      await createUserAccount(app, { username: name, role: "chatter" }, AUDIT);
      await setUserPassword(app, { userId: await fixtureUserId(app, name), password: PASSWORDS[name] }, AUDIT);
    }
    for (const name of ["boss", "lead", "alice", "bob"]) users[name] = await fixtureUserId(app, name);
    const model = await createModel(app.db, { slug: "lora", name: "Lora" });
    for (const label of ["lora-1", "lora-2"]) pages[label] = (await createFanslyPage(app.db, { modelId: model!.id, label }))!.id;
    await assignPageToUser(app, { userId: users.lead!, pageLabel: "lora-1" }, AUDIT);
    await assignPageToUser(app, { userId: users.alice!, pageLabel: "lora-1" }, AUDIT);
    for (const [token, capabilities] of [[AGENT, ["write:matters"]], [READER, ["read:messages"]]] as const) {
      await insertAgentKey(app.db, {
        name: token === AGENT ? "gengar" : "reader",
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
    for (const name of ["boss", "lead", "alice", "bob"] as const) cookies[name] = await loginCookie(name);
    for (const name of ["boss", "alice"] as const) tokens[name] = (await issueDeviceTokenForUserId(app, { userId: users[name]!, label: `${name} client` })).token;
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("one matter per key: opening again updates it, closing a closed one changes nothing, the key reopens its row", async (context) => {
    if (!testDb) return context.skip();
    const first = await openMatter(app.db, matter("note.test:one", { evidence: { a: 1, b: [1, 2] } }), SYSTEM);
    expect(first.transition).toBe("opened");
    // The same finding, its keys in another order: nothing changes but its last confirmation.
    const again = await openMatter(app.db, matter("note.test:one", { evidence: { b: [1, 2], a: 1 } }), SYSTEM);
    expect(again).toMatchObject({ transition: "unchanged", matter: { id: first.matter.id } });
    const changed = await openMatter(app.db, matter("note.test:one", { evidence: { a: 2, b: [1, 2] } }), SYSTEM);
    expect(changed).toMatchObject({ transition: "updated", matter: { id: first.matter.id, evidence: { a: 2 } } });
    expect((await testDb.pool.query("select count(*)::int as n from matters where reason_key = 'note.test:one'")).rows[0].n).toBe(1);

    const closed = await closeMatter(app.db, { key: "note.test:one", how: "resolved" }, SYSTEM);
    expect(closed).toMatchObject({ transition: "closed", matter: { state: "closed", closedHow: "resolved" } });
    const closedAgain = await closeMatter(app.db, { key: "note.test:one", how: "withdrawn" }, SYSTEM);
    expect(closedAgain).toMatchObject({ transition: "unchanged", matter: { closedHow: "resolved" } });
    expect((await closeMatter(app.db, { key: "note.test:never", how: "resolved" }, SYSTEM)).transition).toBe("absent");

    const reopened = await openMatter(app.db, matter("note.test:one", { evidence: { a: 2, b: [1, 2] } }), SYSTEM);
    expect(reopened).toMatchObject({ transition: "reopened", matter: { id: first.matter.id, state: "open", closedHow: null } });
    const events = await listObjectEvents(app.db, { objectType: "matter", objectId: String(first.matter.id) });
    expect(events.map((event) => event.event)).toEqual(["matter.opened", "matter.updated", "matter.closed", "matter.reopened"]);
    expect(events[1]!.changes).toEqual({ fields: ["evidence"] });

    // One writer per key: the server's matter is not the agent's.
    await openMatter(app.db, matter("note.test:server", { source: "server" }), SYSTEM);
    await expect(openMatter(app.db, matter("note.test:server"), SYSTEM)).rejects.toThrow(/written by server/);
  });

  it("reads: a chatter only their own, a team lead also their role's on their pages, the owner every one; money only the owner", async (context) => {
    if (!testDb) return context.skip();
    await openMatter(app.db, matter("rights.test:alice", { owner: { userId: users.alice! } }), SYSTEM);
    await openMatter(app.db, matter("rights.test:alice-money", { owner: { userId: users.alice! }, money: true, evidence: { netMills: 25_000 } }), SYSTEM);
    await openMatter(app.db, matter("rights.test:bob", { owner: { userId: users.bob! } }), SYSTEM);
    await openMatter(app.db, matter("rights.test:lead-1", { owner: { role: "team_lead" }, pageIds: [pages["lora-1"]!] }), SYSTEM);
    await openMatter(app.db, matter("rights.test:lead-2", { owner: { role: "team_lead" }, pageIds: [pages["lora-2"]!] }), SYSTEM);
    await openMatter(app.db, matter("rights.test:lead-money", { owner: { role: "team_lead" }, money: true }), SYSTEM);
    await openMatter(app.db, matter("rights.test:chatters", { owner: { role: "chatter" }, pageIds: [pages["lora-1"]!] }), SYSTEM);
    await openMatter(app.db, matter("rights.test:owner-money", { money: true, evidence: { totalMills: 1000 } }), SYSTEM);

    const keys = async (who: string) => {
      const response = await asSession(who, "/api/v1/matters?kind=rights.test");
      expect(response.statusCode, response.body).toBe(200);
      return mattersListResponseSchema.parse(response.json()).matters.map((one) => one.key).sort();
    };
    expect(await keys("alice")).toEqual(["rights.test:alice"]);
    expect(await keys("bob")).toEqual(["rights.test:bob"]);
    expect(await keys("lead")).toEqual(["rights.test:lead-1"]);
    expect(await keys("boss")).toHaveLength(8);

    // The extension's narrow door: the person's own, never money, never evidence.
    const own = await server!.inject({ method: "GET", url: "/api/v1/client/matters", headers: { authorization: `Bearer ${tokens.alice}` } });
    expect(own.statusCode, own.body).toBe(200);
    const mine = clientMattersResponseSchema.parse(own.json());
    expect(mine.matters.map((one) => one.title)).toEqual(["Дело rights.test:alice"]);
    expect(mine.count).toBe(1);
    expect(JSON.stringify(own.json())).not.toContain("evidence");
    const ownerOwn = clientMattersResponseSchema.parse((await server!.inject({
      method: "GET", url: "/api/v1/client/matters", headers: { authorization: `Bearer ${tokens.boss}` },
    })).json());
    expect(ownerOwn.matters.some((one) => one.title.includes("money"))).toBe(false);

    // «Ждут вас» is the dashboard's: a chatter's session is refused.
    expect((await asSession("alice", "/api/v1/matters/waiting")).statusCode).toBe(403);
  });

  it("an agent key writes its own kinds by key, on its pages, for living people; the server's kinds stay the server's", async (context) => {
    if (!testDb) return context.skip();
    const body = {
      key: "reminder.team:alice-1", kind: "reminder.team", title: "Напомнить про отчёт", owner: { user: "alice" },
      pageLabels: ["lora-1"], evidence: { at: "2026-11-12T12:00:00Z" }, onBehalfOf: "boss",
    };
    const opened = await agent("/api/v1/agent/matters", body);
    expect(opened.statusCode, opened.body).toBe(200);
    expect(agentMatterResponseSchema.parse(opened.json())).toMatchObject({ transition: "opened", matter: { state: "open" } });
    expect(agentMatterResponseSchema.parse((await agent("/api/v1/agent/matters", body)).json()).transition).toBe("unchanged");

    expect((await agent("/api/v1/agent/matters", { ...body, key: "send.held:x", kind: "send.held" })).json()).toMatchObject({ reason: "matter_not_agents" });
    expect((await agent("/api/v1/agent/matters", { ...body, owner: { user: "nobody" } })).json()).toMatchObject({ reason: "person_unknown" });
    expect((await agent("/api/v1/agent/matters", { ...body, key: "reminder.team:alice-2", pageLabels: ["lora-2"] })).statusCode).toBe(404);
    expect((await agent("/api/v1/agent/matters", { ...body, key: "other.kind:alice-3" })).statusCode).toBe(400);
    expect((await agent("/api/v1/agent/matters", body, READER)).statusCode).toBe(403);

    const comment = await agent("/api/v1/agent/matters/comment", { key: body.key, text: "Сказал: сдаст вечером" });
    expect(comment.statusCode, comment.body).toBe(200);
    const closed = await agent("/api/v1/agent/matters/close", { key: body.key, how: "resolved", note: "сдал" });
    expect(agentMatterResponseSchema.parse(closed.json())).toMatchObject({ transition: "closed", matter: { closedHow: "resolved" } });
    expect(agentMatterResponseSchema.parse((await agent("/api/v1/agent/matters/close", { key: body.key, how: "resolved" })).json()).transition).toBe("unchanged");
    expect((await agent("/api/v1/agent/matters/close", { key: "reminder.team:never", how: "resolved" })).statusCode).toBe(404);
    expect((await agent("/api/v1/agent/matters/close", { key: "note.test:server", how: "resolved" })).json()).toMatchObject({ reason: "matter_not_agents" });

    const events = await listObjectEvents(app.db, { objectType: "matter", objectId: String(opened.json().matter.id) });
    expect(events.map((event) => [event.event, event.door, event.onBehalfOfUserId])).toEqual([
      ["matter.opened", "api", users.boss], ["matter.comment", "api", null], ["matter.closed", "api", null],
    ]);
  });

  it("the mirror: what waits opens, what went away closes, a source without an answer is «не проверено»", async (context) => {
    if (!testDb) return context.skip();
    const incident = await openNotificationIncident(app.db, {
      incidentKey: "db_disk_usage:global", kind: "db_disk_usage", platformAccountId: null, errorSummary: "92% used",
    });
    const start = new Date();
    const first = await runMattersMirror(app, { now: start });
    // Every source in Hub's own database answers (OnlyFans' history requests too, as not applicable while its API is off).
    expect([...first.answered].sort()).toEqual([
      "custom.paid_not_delivered", "extension.critical", "history.request", "incident.open", "page.login_needed",
      "publication.draft", "publication.unknown", "send.held",
    ]);
    // The ledger is not connected here: its kinds did not answer.
    expect(first.failed).toEqual(expect.arrayContaining(["ledger.sale_question", "ledger.report_post", "ledger.paid_day_changed"]));
    expect(first.mismatched).toEqual([]);

    const waiting = async (who: string) => {
      const response = await asSession(who, "/api/v1/matters/waiting");
      expect(response.statusCode, response.body).toBe(200);
      return mattersWaitingResponseSchema.parse(response.json());
    };
    const owner = await waiting("boss");
    expect(owner.active).toBe(false);
    expect(owner.groups.find((group) => group.id === "system")).toMatchObject({ count: 1, checked: true, tone: "bad", to: "/workboard/decisions#system" });
    // The ledger is not connected, and the checks of package K never ran here (their pass is runMatterChecks):
    // «не проверено», never a zero.
    expect(owner.groups.filter((group) => !group.checked).map((group) => [group.id, group.count])).toEqual([
      ["questions", 0], ["reports", 0], ["people", 0], ["ledger", 0],
    ]);
    expect(owner.failed).toEqual(["questions", "reports", "people", "ledger"]);
    expect(owner.total).toBe(owner.groups.reduce((sum, group) => sum + group.count, 0));
    // A team lead's «Ждут вас»: their own and their role's on their pages, by the list's groups — the role's matter on
    // lora-1 of the rights test in «Другие дела»; customs and held sends answered and are empty; nothing failed.
    const lead = await waiting("lead");
    expect(lead.groups.map((group) => [group.id, group.count])).toEqual([["other", 1]]);
    expect(lead).toMatchObject({ total: 1, failed: [] });

    const checks = new Map((await listMatterChecks(app.db)).map((check) => [check.kind, check]));
    expect(checks.get("incident.open")).toMatchObject({ legacyCount: 1, matterCount: 1, mismatchSince: null, error: null });
    expect(checks.get("ledger.sale_question")?.error).toContain("not connected");

    // The incident recovers: a minute later its matter closes, cause gone.
    await recoverAndResolveNotificationIncident(app.db, { incidentKey: incident.incident.incidentKey, recoveredAt: new Date(start.getTime() + 30_000) });
    await runMattersMirror(app, { now: new Date(start.getTime() + 61_000) });
    const gone = await testDb.pool.query("select state, closed_how from matters where reason_key = $1", [`incident.open:${incident.incident.id}`]);
    expect(gone.rows[0]).toEqual({ state: "closed", closed_how: "cause_gone" });
  });
});
