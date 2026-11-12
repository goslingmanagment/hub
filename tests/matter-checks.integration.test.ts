import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  clientActivityResponseSchema,
  clientMattersResponseSchema,
  mattersListResponseSchema,
  mattersWaitingResponseSchema,
} from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, insertAgentKey, listMatterChecks, openMatter, type MatterOpenInput } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, assignPageToUser, createUserAccount, setUserPassword, type HumanAuthPrincipal } from "../apps/runtime/src/services/auth.ts";
import { runMatterChecks } from "../apps/runtime/src/services/matter-checks.ts";
import { matterViewerOf } from "../apps/runtime/src/services/matters.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Проверки (ecosystem plan §6, package K): the people and access checks open
// the owner's matters from the registry and the logins, and never carry a pay
// term; the ledger's checks open only past their threshold and close when
// green; a ledger that refuses leaves its kinds «не проверено»; a dry run
// writes nothing. Rights: a chatter reads only their own matters and never one
// with money — on every door, the extension's count included; a team lead
// theirs and their role's on their pages; neither ever a check of package K.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const AUDIT = { source: "cli" } as const;
const PASSWORDS = { boss: "boss-secret", lead: "lead-secret", alice: "alice-secret" } as const;
const AGENT = `${AGENT_KEY_TOKEN_PREFIX}checks-agent-0000`;
/** A pay term's numbers that must never leave the owner's card. */
const SHARE_BP = 2_345;
const FIX_MILLS = 7_654_321;
let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const users: Record<string, number> = {};
const pages: Record<string, number> = {};
const cookies: Record<string, string> = {};
let aliceToken = "";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = new Date("2026-11-20T09:00:00.000Z");

async function loginCookie(username: keyof typeof PASSWORDS): Promise<string> {
  const login = await server!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: PASSWORDS[username] } });
  expect(login.statusCode, login.body).toBe(200);
  const header = login.headers["set-cookie"];
  return (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
}
const asSession = (who: string, url: string) => server!.inject({ method: "GET", url, headers: { cookie: cookies[who]! } });

async function person(code: string, input: { role: string; kind?: string; state?: string; logins?: number[]; pages?: string[] }): Promise<number> {
  const inserted = await testDb!.pool.query(
    `insert into people (code, display_name, kind, role, state, origin) values ($1, $2, $3, $4, $5, 'owner') returning id`,
    [code, `Имя ${code}`, input.kind ?? "human", input.role, input.state ?? "working"],
  );
  const id = Number(inserted.rows[0].id);
  for (const userId of input.logins ?? []) await testDb!.pool.query("insert into person_logins (user_id, person_id) values ($1, $2)", [userId, id]);
  for (const [position, label] of (input.pages ?? []).entries()) {
    await testDb!.pool.query("insert into person_working_pages (person_id, page_id, position) values ($1, $2, $3)", [id, pages[label], position]);
  }
  return id;
}

/** The ledger as Hub's payouts key reads it: its checks and its open decisions, or a refusal. */
function ledger(now: Date, options: { cardCoverGreen?: boolean; refuse?: boolean } = {}): typeof fetch {
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (options.refuse) return json({ error: "у ключа нет права" }, 403);
    if (url.pathname === "/v1/payouts/checks") {
      return json({
        ok: true, at: ago(0), generatedAt: ago(0),
        checks: [
          // A day and more red: the owner's matter, in the ledger's sentence.
          options.cardCoverGreen
            ? { key: "card_cover", name: "карты покрывают списания", ok: true, severity: "info", summary: "хватает", at: ago(0), failingSince: null }
            : { key: "card_cover", name: "карты покрывают списания", ok: false, severity: "warn", summary: "карта •0042: не хватает 114.60", at: ago(0), failingSince: ago(30 * HOUR) },
          // Urgent, an hour red: under its threshold.
          { key: "bybit_cash", name: "касса Bybit", ok: false, severity: "urgent", summary: "по книгам 1.00, по API 9.00", at: ago(0), failingSince: ago(HOUR) },
          // Urgent, three hours red: over it.
          { key: "copies", name: "копии базы", ok: false, severity: "urgent", summary: "копия старше суток", at: ago(0), failingSince: ago(3 * HOUR) },
          // Mirrored already as matters of their own: not a second line.
          { key: "pending_changes", name: "изменения за выплаченные дни ждут решения", ok: false, severity: "warn", summary: "1 ждёт", at: ago(0), failingSince: ago(40 * HOUR) },
          { key: "balanced", name: "проводки сходятся", ok: true, severity: "info", summary: "сходятся", at: ago(0), failingSince: null },
        ],
        weekColumns: { tabs: [{ model: "Lora", tab: "Алиса", person: "alice", tomorrow: "2026-11-21", lastColumn: "2026-11-20" }] },
      });
    }
    if (url.pathname === "/v1/decisions") {
      return json({
        decisions: [
          { id: 41, page_label: "lora-1", kind: "off_platform", status: "open", net_micros: 50_000_000, shares: [{ person: "alice", percent: 100 }], said_by: "alice", said_at: ago(9 * DAY), source_link: "https://t.me/c/1/2", created_at: ago(9 * DAY) },
          { id: 42, page_label: "lora-1", kind: "off_platform", status: "open", net_micros: null, shares: [], said_by: "alice", said_at: ago(2 * DAY), source_link: "", created_at: ago(2 * DAY) },
          { id: 43, page_label: "lora-1", kind: "owner", status: "open", net_micros: 1_000_000, shares: [{ person: "alice", percent: 100 }], said_by: "boss", said_at: ago(20 * DAY), source_link: "", created_at: ago(20 * DAY) },
        ],
      });
    }
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
}

const openKeys = async (prefix: string) =>
  (await testDb!.pool.query("select reason_key from matters where state = 'open' and reason_key like $1 order by reason_key", [`${prefix}%`])).rows.map((row) => row.reason_key as string);

describe("matter checks (package K)", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    Object.assign(app.config, { ledgerUrl: "https://ledger.test", ledgerPayoutsKey: "test-payouts-key" });
    await createUserAccount(app, { username: "boss", role: "owner", password: PASSWORDS.boss }, AUDIT);
    await createUserAccount(app, { username: "lead", role: "team_lead", password: PASSWORDS.lead }, AUDIT);
    await createUserAccount(app, { username: "alice", role: "chatter" }, AUDIT);
    await setUserPassword(app, { userId: await fixtureUserId(app, "alice"), password: PASSWORDS.alice }, AUDIT);
    for (const name of ["bob", "gone", "stray", "svc"]) await createUserAccount(app, { username: name, role: "chatter" }, AUDIT);
    for (const name of ["boss", "lead", "alice", "bob", "gone", "stray", "svc"]) users[name] = await fixtureUserId(app, name);
    const model = await createModel(app.db, { slug: "lora", name: "Lora" });
    for (const label of ["lora-1", "lora-2"]) pages[label] = (await createFanslyPage(app.db, { modelId: model!.id, label }))!.id;
    await assignPageToUser(app, { userId: users.lead!, pageLabel: "lora-1" }, AUDIT);
    await assignPageToUser(app, { userId: users.alice!, pageLabel: "lora-1" }, AUDIT);
    await assignPageToUser(app, { userId: users.bob!, pageLabel: "lora-2" }, AUDIT);

    // The registry: alice works lora-1 and lora-2 (no access to lora-2) with pay terms; bob works nothing and has no
    // terms; «gone» left with a living login; «stray» is a login of nobody; «svc» is a service login.
    await person("boss", { role: "owner", logins: [users.boss!] });
    const lead = await person("lead", { role: "team_lead", logins: [users.lead!], pages: ["lora-1"] });
    const alice = await person("alice", { role: "chatter", logins: [users.alice!], pages: ["lora-1", "lora-2"] });
    await person("bob", { role: "chatter", logins: [users.bob!] });
    await person("gone", { role: "chatter", state: "left", logins: [users.gone!] });
    await person("svc", { role: "service", kind: "service", logins: [users.svc!] });
    for (const id of [alice, lead]) {
      await testDb.pool.query(
        "insert into person_pay_terms (person_id, model_id, valid_from, share_basis_points, fix_per_shift_mills) values ($1, $2, '2026-11-01', $3, $4)",
        [id, model!.id, SHARE_BP, FIX_MILLS],
      );
    }
    await insertAgentKey(app.db, {
      name: "checks-agent", keyPrefix: AGENT.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(AGENT),
      capabilities: ["write:matters"] as never, pageIds: [pages["lora-1"]!], expiresAt: new Date(START.getTime() + 3 * DAY), createdBy: users.boss!,
    });

    server = await buildApiServer(app);
    await server.ready();
    for (const name of ["boss", "lead", "alice"] as const) cookies[name] = await loginCookie(name);
    aliceToken = (await issueDeviceTokenForUserId(app, { userId: users.alice!, label: "alice client" })).token;
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("a dry run reads everything and writes nothing", async (context) => {
    if (!testDb) return context.skip();
    const count = async () => (await testDb!.pool.query("select (select count(*) from matters)::int as m, (select count(*) from matter_checks)::int as c")).rows[0];
    const before = await count();
    const { dry } = await runMatterChecks(app, { now: START, fetchImpl: ledger(START), dryRun: true });
    expect(await count()).toEqual(before);
    expect(dry.find((kind) => kind.kind === "people.no_pay_terms")?.wouldOpen.map((item) => item.key)).toEqual(["people.no_pay_terms:bob"]);
    expect(dry.find((kind) => kind.kind === "ledger.check")?.waiting?.map((item) => item.key)).toEqual(["bybit_cash"]);
  });

  it("people and access: the known cases open, service logins never, a pay term never in a matter", async (context) => {
    if (!testDb) return context.skip();
    const { tally } = await runMatterChecks(app, { now: START, fetchImpl: ledger(START) });
    expect(tally.failed).toEqual([]);
    expect(await openKeys("people.")).toEqual([
      "people.access_idle:all",
      "people.agent_key_expiring:" + (await testDb.pool.query("select id from agent_keys where name = 'checks-agent'")).rows[0].id,
      "people.left_with_access:gone",
      "people.login_unlinked:" + users.stray,
      "people.no_pay_terms:bob",
      "people.no_working_page:bob",
      "people.page_without_access:alice",
    ].sort());
    const evidence = (await testDb.pool.query("select title, evidence::text as evidence from matters where kind like 'people.%'")).rows
      .map((row) => `${row.title as string} ${row.evidence as string}`).join("\n");
    for (const forbidden of [String(SHARE_BP), String(FIX_MILLS), "share", "fix", "basis", "rate"]) expect(evidence).not.toContain(forbidden);
    expect(evidence).not.toContain("svc");
    // Every people check is the owner's and carries no money flag: a pay term is only asked whether it exists.
    const owners = (await testDb.pool.query("select distinct owner_role, money from matters where kind like 'people.%'")).rows;
    expect(owners).toEqual([{ owner_role: "owner", money: false }]);
  });

  it("the ledger's: past their threshold, one per check key, the notice of the tabs, off-platform after N days; green closes; a refusal is «не проверено»", async (context) => {
    if (!testDb) return context.skip();
    expect(await openKeys("ledger.")).toEqual(["ledger.check:card_cover", "ledger.check:copies", "ledger.off_platform:41", "ledger.sheet_column:tomorrow"]);
    const money = (await testDb.pool.query("select reason_key, money from matters where kind in ('ledger.check', 'ledger.off_platform') and money = false")).rows;
    expect(money).toEqual([]);

    const later = new Date(START.getTime() + 16 * 60_000);
    await runMatterChecks(app, { now: later, fetchImpl: ledger(later, { cardCoverGreen: true }) });
    const closed = await testDb.pool.query("select state, closed_how from matters where reason_key = 'ledger.check:card_cover'");
    expect(closed.rows[0]).toEqual({ state: "closed", closed_how: "cause_gone" });

    const refused = new Date(START.getTime() + 32 * 60_000);
    const { tally } = await runMatterChecks(app, { now: refused, fetchImpl: ledger(refused, { refuse: true }) });
    expect([...tally.failed].sort()).toEqual(["ledger.check", "ledger.off_platform", "ledger.sheet_column"]);
    // Nothing the ledger said before is taken back by its silence.
    expect(await openKeys("ledger.check:")).toEqual(["ledger.check:copies"]);
    const checks = new Map((await listMatterChecks(app.db)).map((check) => [check.kind, check]));
    expect(checks.get("ledger.check")?.error).toContain("does not open");
    const owner = mattersWaitingResponseSchema.parse((await asSession("boss", "/api/v1/matters/waiting")).json());
    expect(owner.groups.find((group) => group.id === "ledger")).toMatchObject({ checked: false });
    expect(owner.failed).toContain("ledger");
    expect(owner.groups.find((group) => group.id === "people")).toMatchObject({ count: 6, checked: true });
  });

  it("rights: a chatter only their own and never money, on every door; a team lead theirs and their role's on their pages; no check reaches either", async (context) => {
    if (!testDb) return context.skip();
    const seed = (key: string, over: Partial<MatterOpenInput>): MatterOpenInput => ({
      key, kind: key.slice(0, key.indexOf(":")), source: "agent", title: `Дело ${key}`, object: null, pageIds: [],
      owner: { role: "owner" }, money: false, evidence: {}, link: null, ...over,
    });
    await openMatter(app.db, seed("k.rights:alice", { owner: { userId: users.alice! } }), { door: "system" });
    await openMatter(app.db, seed("k.rights:alice-money", { owner: { userId: users.alice! }, money: true }), { door: "system" });
    await openMatter(app.db, seed("k.rights:bob", { owner: { userId: users.bob! } }), { door: "system" });
    await openMatter(app.db, seed("k.rights:lead-1", { owner: { role: "team_lead" }, pageIds: [pages["lora-1"]!] }), { door: "system" });
    await openMatter(app.db, seed("k.rights:lead-2", { owner: { role: "team_lead" }, pageIds: [pages["lora-2"]!] }), { door: "system" });
    await openMatter(app.db, seed("k.rights:lead-money", { owner: { role: "team_lead" }, money: true }), { door: "system" });

    const keys = async (who: string) => {
      const response = await asSession(who, "/api/v1/matters");
      expect(response.statusCode, response.body).toBe(200);
      return mattersListResponseSchema.parse(response.json()).matters.map((one) => one.key).sort();
    };
    expect(await keys("alice")).toEqual(["k.rights:alice"]);
    expect(await keys("lead")).toEqual(["k.rights:lead-1"]);
    const all = await keys("boss");
    expect(all).toEqual(expect.arrayContaining(["k.rights:alice-money", "k.rights:lead-money", "people.no_pay_terms:bob", "ledger.check:copies"]));

    // The extension: the beat carries the person's count (their own, never money), as `clientMatters` counts it.
    const beat = await server!.inject({
      method: "POST", url: "/api/v1/client/activity", headers: { authorization: `Bearer ${aliceToken}` },
      payload: { instanceId: "alice-install-01", pages: [{ pageLabel: "lora-1", idleMs: 1000 }] },
    });
    expect(beat.statusCode, beat.body).toBe(200);
    expect(clientActivityResponseSchema.parse(beat.json()).matters).toBe(1);
    const client = clientMattersResponseSchema.parse((await server!.inject({
      method: "GET", url: "/api/v1/client/matters", headers: { authorization: `Bearer ${aliceToken}` },
    })).json());
    expect(client).toMatchObject({ count: 1, matters: [{ title: "Дело k.rights:alice" }] });

    // A team lead's «Ждут вас»: no group of people or of the ledger, ever — their own matters by the list's groups.
    // (Held sends are «не проверено» here: the mirror of package D never ran in this test. «Кастомы» is read from the
    // custom orders themselves, and none waits: no group.)
    const lead = mattersWaitingResponseSchema.parse((await asSession("lead", "/api/v1/matters/waiting")).json());
    expect(lead.groups.map((group) => [group.id, group.count, group.checked])).toEqual([["held", 0, false], ["other", 1, true]]);
    expect(lead).toMatchObject({ total: 1, failed: ["held"] });
    // A narrow session (from the extension) reads as a chatter whatever the person's role.
    const narrowOwner = { authMethod: "session", user: { id: users.boss!, role: "owner" }, assignedPageIds: [], narrowDeviceTokenId: 1 } as unknown as HumanAuthPrincipal;
    expect(matterViewerOf(narrowOwner).role).toBe("chatter");

    // The server's checks are never an agent's to write.
    const refused = await server!.inject({
      method: "POST", url: "/api/v1/agent/matters", headers: { authorization: `Bearer ${AGENT}` },
      payload: { key: "people.no_pay_terms:x", kind: "people.no_pay_terms", title: "x", owner: { role: "owner" } },
    });
    expect(refused.json()).toMatchObject({ reason: "matter_not_agents" });
  });
  it("an agent's open proposal about a person waits for the owner as one matter per person, closed once none is open", async (context) => {
    if (!testDb) return context.skip();
    const agentKeyId = (await testDb.pool.query("select id from agent_keys where name = 'checks-agent'")).rows[0].id;
    const bob = (await testDb.pool.query("select id from people where code = 'bob'")).rows[0].id;
    const propose = (target: { personId?: number; proposedCode?: string }, kind: string) => testDb!.pool.query(
      "insert into person_proposals (person_id, proposed_code, change, reason, agent_key_id) values ($1, $2, $3, 'test', $4) returning id",
      [target.personId ?? null, target.proposedCode ?? null, JSON.stringify({ kind }), agentKeyId]);
    const first = (await propose({ personId: bob }, "update")).rows[0].id;
    const second = (await propose({ personId: bob }, "update")).rows[0].id;
    const newbie = (await propose({ proposedCode: "newbie" }, "create")).rows[0].id;

    // A pass after the last one's period: the people checks are due again.
    const at = new Date(START.getTime() + 2 * HOUR);
    await runMatterChecks(app, { now: at, fetchImpl: ledger(at) });
    expect(await openKeys("people.proposal_open:")).toEqual(["people.proposal_open:bob", "people.proposal_open:newbie"]);
    const rows = (await testDb.pool.query(
      "select reason_key as key, title, link, owner_role, money from matters where kind = 'people.proposal_open' and state = 'open' order by reason_key")).rows;
    expect(rows).toEqual([
      { key: "people.proposal_open:bob", title: "Предложение агента о человеке: Имя bob (2)", link: "/workboard/people/bob", owner_role: "owner", money: false },
      { key: "people.proposal_open:newbie", title: "Агент предлагает нового человека: newbie", link: "/workboard/people", owner_role: "owner", money: false },
    ]);
    // «Ждут вас» of the owner counts it in the people's group.
    const waiting = mattersWaitingResponseSchema.parse((await asSession("boss", "/api/v1/matters/waiting")).json());
    expect(waiting.groups.find((group) => group.id === "people")?.count).toBeGreaterThanOrEqual(2);

    // One of bob's decided: still a matter; both decided and the new person's withdrawn: closed by the next pass.
    const decide = (id: number, state: string) => testDb!.pool.query(
      "update person_proposals set state = $2, decided_at = now() where id = $1", [id, state]);
    await decide(first, "rejected");
    const later = new Date(at.getTime() + 2 * HOUR);
    await runMatterChecks(app, { now: later, fetchImpl: ledger(later) });
    expect(await openKeys("people.proposal_open:")).toEqual(["people.proposal_open:bob", "people.proposal_open:newbie"]);
    await decide(second, "accepted");
    await decide(newbie, "withdrawn");
    const last = new Date(later.getTime() + 2 * HOUR);
    await runMatterChecks(app, { now: last, fetchImpl: ledger(last) });
    expect(await openKeys("people.proposal_open:")).toEqual([]);
  });
});
