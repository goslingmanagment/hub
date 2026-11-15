import { appendFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import argon2 from "argon2";
import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";

import { routeSchemas } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, createOnlyFansPage, insertPersonLogin, insertPersonRow, type Database } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { assignPageToUser, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { issueAgentKey } from "../apps/runtime/src/services/agent-keys.ts";
import { SANDBOX_OWNER_OPERATIONS } from "../apps/runtime/src/services/sandbox/owner-operations.ts";
import { SANDBOX_MODEL, seedSandbox } from "../apps/runtime/src/services/sandbox/seed.ts";
import { refreshSaleHomes } from "../apps/runtime/src/services/sale-homes.ts";
import { syncShiftRowsSince } from "../apps/runtime/src/services/shift-rows.ts";
import { runCustomOrderChecks } from "../apps/runtime/src/services/custom-orders/checks.ts";
import { issueChatterDeviceToken } from "./helpers/device-credentials.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// The wall of the test realm (apps/runtime/src/services/sandbox/realm.ts), proven on the contract itself:
//
// 1. every READ of the contract (every GET, and the agent plane's POST reads), called as the live owner, a live
//    chatter and keys shaped like the ledger's, Gengar's and the /OS people mirror's, answers the SAME before the test
//    team is seeded, after it is seeded, after its `shift`, `customs` and `matters` scenarios and the ordinary jobs
//    ran, and after its people worked (signed in, beat, read). Only clock fields are set aside (`VOLATILE_KEYS`, and
//    timestamps of the run's own minutes), by name;
// 2. `t-owner` (the owner of the test team) is refused every operation not on SANDBOX_OWNER_OPERATIONS with 403, and
//    what it may read names nothing live.
//
// A read that answers 4xx/5xx both times is equal but proves little; the test prints how many there are (the report
// of the PR names them).

const DAY_MS = 86_400_000;
const OWNER_PASSWORD = "owner-secret-1";
const CHATTER_PASSWORD = "chatter-secret-1";
const SANDBOX_PASSWORDS = {
  SANDBOX_PASSWORD_T_OWNER: "sandbox-owner-1",
  SANDBOX_PASSWORD_T_LEAD: "sandbox-lead-1",
  SANDBOX_PASSWORD_T_CHAT_1: "sandbox-chat-1",
  SANDBOX_PASSWORD_T_CHAT_2: "sandbox-chat-2",
};

/**
 * Reads whose answer is a measurement of the database itself, not data: the tables by size (any row anywhere moves
 * them). Called and listed as not proven.
 */
const MEASUREMENTS = new Set(["adminDbStats"]);

/** Agent POST operations that only read. */
const POST_READS = new Set(["agentSearchMessages", "agentResolve", "agentTeamSales", "agentSaleContext", "agentFanWatch", "agentKeyIntrospect"]);

/** Clock fields: the moment of the answer, never data. */
const VOLATILE_KEYS = new Set([
  "serverNow", "generatedAt", "now", "asOf", "computedAt", "checkedAt", "fetchedAt", "readAt", "answeredAt", "sentAt",
  "lastActiveAt", "lastUsedAt", "lastSeenAt", "updatedAt", "requestId", "etag", "cursor", "nextCursor",
  // The database's own latency and sizes («Система»): measurements, not data.
  "latencyMs", "rowEstimate", "totalBytes", "indexBytes",
  // The agent plane's own counters of THIS run's calls: its request budget, its audit sequence, a key's last call.
  "budgets", "auditRef", "lastCall",
  // «Система → Состояние»'s one honest line about the test team (it exists by design once the team is seeded).
  "sandbox",
]);

type Server = Awaited<ReturnType<typeof buildApiServer>>;

let testDb: StartedTestDatabase | null = null;
let server: Server | null = null;
let runStartedAt = 0;

interface Caller { name: string; headers: Record<string, string> }
const callers: Caller[] = [];
let tOwnerCookie = "";
const live = { pageLabel: "live-1", pageId: 0, modelSlug: "lana", personCode: "live-chatter", chatterUserId: 0, shiftId: 0, transactionId: 0 };
const liveWords: string[] = [];

function cookieOf(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") throw new Error("Expected set-cookie");
  return value.split(";")[0]!;
}

async function login(username: string, password: string): Promise<string> {
  const response = await server!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password } });
  expect(response.statusCode, `login ${username}: ${response.body}`).toBe(200);
  return cookieOf(response);
}

// ── a request for every route, from its own schemas ─────────────────────────

type Zod = { _zod: { def: Record<string, unknown> & { type: string } } };

function unwrap(schema: Zod): { schema: Zod; optional: boolean } {
  let current = schema;
  let optional = false;
  for (;;) {
    const def = current._zod.def;
    if (def.type === "optional" || def.type === "default" || def.type === "catch") optional = true;
    if (["optional", "default", "catch", "nullable"].includes(def.type)) {
      current = def.innerType as Zod;
      continue;
    }
    if (def.type === "pipe") {
      current = def.in as Zod;
      continue;
    }
    return { schema: current, optional };
  }
}

const today = new Date();
const dayOf = (at: number) => new Date(at + 3 * 3_600_000).toISOString().slice(0, 10);

function valueFor(name: string, schema: Zod): unknown {
  const def = schema._zod.def;
  const checks = ((def.checks ?? []) as Zod[]).map((check) => String((check._zod.def as { pattern?: RegExp }).pattern?.source ?? ""));
  const pattern = checks.join(" ");
  const base = today.getTime();
  if (def.type === "enum") return Object.values(def.entries as Record<string, string>)[0];
  if (def.type === "literal") return (def.values as unknown[])[0];
  if (def.type === "boolean") return false;
  if (def.type === "array") return [];
  if (def.type === "union") return valueFor(name, unwrap((def.options as Zod[])[0]!).schema);
  if (def.type === "number") {
    if (name === "pageId") return live.pageId;
    if (name === "userId") return live.chatterUserId;
    if (name === "shiftId") return live.shiftId || 1;
    if (name === "transactionId") return live.transactionId || 1;
    return 1;
  }
  if (def.type !== "string") return undefined;
  if (def.format === "uuid" || pattern.includes("[0-9a-fA-F]{8}")) return "00000000-0000-0000-0000-000000000000";
  if (def.format === "date" || pattern.startsWith("^\\d{4}-\\d{2}-\\d{2}$")) {
    return name === "to" ? dayOf(base) : dayOf(base - 2 * DAY_MS);
  }
  if (def.format === "datetime" || pattern.includes("T\\d{2}")) {
    return name === "to" ? new Date(base + 2 * 3_600_000).toISOString() : new Date(base - 2 * DAY_MS).toISOString();
  }
  if (pattern.includes("(0[1-9]|1[0-2])")) return dayOf(base).slice(0, 7);
  if (name === "pageLabel") return live.pageLabel;
  if (name === "modelSlug" || name === "slug") return live.modelSlug;
  if (name === "code" || name === "person") return live.personCode;
  if (pattern.includes("[1-9]")) return "1";
  return "x";
}

function sampleObject(schema: Zod | undefined): Record<string, unknown> | undefined {
  if (!schema) return undefined;
  let { schema: object } = unwrap(schema);
  // A union of shapes (a standard period or a custom window): its first shape.
  if (object._zod.def.type === "union") object = unwrap((object._zod.def.options as Zod[])[0]!).schema;
  if (object._zod.def.type !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(object._zod.def.shape as Record<string, Zod>)) {
    const { schema: inner, optional } = unwrap(field);
    if (optional) continue;
    const value = valueFor(name, inner);
    if (value !== undefined) out[name] = value;
  }
  // A scope that names its subject (spenders: a page, a model) gets the live one.
  const shape = object._zod.def.shape as Record<string, Zod>;
  if (out.scope === "page" && "pageLabel" in shape) out.pageLabel = live.pageLabel;
  if (out.scope === "model" && "modelSlug" in shape) out.modelSlug = live.modelSlug;
  return out;
}

interface Read { method: "GET" | "POST"; url: string; key: string; body?: Record<string, unknown> }

function readsOf(table: Server["routePolicyTable"]): Read[] {
  const reads: Read[] = [];
  for (const row of table) {
    if (row.method !== "GET" && !(row.method === "POST" && POST_READS.has(row.routeKey))) continue;
    if (!row.url.startsWith("/api/") || MEASUREMENTS.has(row.routeKey)) continue;
    const schema = (routeSchemas as unknown as Record<string, { params?: Zod; querystring?: Zod; body?: Zod }>)[row.routeKey]!;
    const params = sampleObject(schema.params) ?? {};
    let url = row.url.replace(/:([A-Za-z]+)/g, (_, name: string) => encodeURIComponent(String(params[name] ?? "1")));
    const query = sampleObject(schema.querystring);
    if (query && Object.keys(query).length > 0) {
      url += `?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)])).toString()}`;
    }
    reads.push({ method: row.method as Read["method"], url, key: row.routeKey, ...(row.method === "POST" ? { body: sampleObject(schema.body) ?? {} } : {}) });
  }
  return reads;
}

// ── comparing answers ───────────────────────────────────────────────────────

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_KEYS.has(key)) continue;
      out[key] = normalize(inner);
    }
    return out;
  }
  // A moment of this run (an answer's own clock, or a window counted back from it by whole hours): set aside.
  if (typeof value === "string" && ISO.test(value)) {
    const at = Date.parse(value);
    if (at >= runStartedAt - 1_000) return "<now>";
    const back = (Date.now() - at) % 3_600_000;
    if (back < 120_000 || back > 3_600_000 - 120_000) return "<clock>";
  }
  return value;
}

async function answer(read: Read, caller: Caller): Promise<string> {
  const response = await server!.inject({
    method: read.method,
    url: read.url,
    headers: { ...caller.headers, ...(read.method === "POST" ? { "content-type": "application/json" } : {}) },
    ...(read.body === undefined ? {} : { payload: read.body }),
  });
  let body: unknown = response.body;
  try { body = normalize(JSON.parse(response.body)); } catch { /* not JSON: compared as it is */ }
  return `${response.statusCode} ${JSON.stringify(body)}`;
}

async function snapshot(reads: readonly Read[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const caller of callers) {
    for (const read of reads) out.set(`${caller.name} ${read.method} ${read.url}`, await answer(read, caller));
  }
  return out;
}

/** The reads whose answers differ (their keys; with SANDBOX_WALL_DIFF_FILE set, both answers are written there). */
function differences(before: Map<string, string>, after: Map<string, string>, stage: string): string[] {
  const out: string[] = [];
  const full: Array<{ key: string; before: string; after: string | undefined }> = [];
  for (const [key, value] of before) {
    const other = after.get(key);
    if (other === value) continue;
    out.push(key);
    full.push({ key, before: value, after: other });
  }
  const file = process.env.SANDBOX_WALL_DIFF_FILE;
  if (file && full.length > 0) appendFileSync(file, `${JSON.stringify({ stage, full })}\n`);
  return out;
}

// ── the live agency ─────────────────────────────────────────────────────────

async function seedLive(app: ReturnType<typeof createTestAppContext>) {
  const db = app.db as Database;
  const owner = await createUserAccount(app, { username: "dima", role: "owner", password: OWNER_PASSWORD }, { source: "cli" });
  const ownerPerson = await insertPersonRow(db, {
    code: "dima", displayName: "Owner", kind: "human", role: "owner", state: "working", leftOn: null, telegramUserId: null,
    telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
  });
  await insertPersonLogin(db, { personId: ownerPerson.id, userId: owner.id, linkedByUserId: null });
  const model = await createModel(db, { slug: live.modelSlug, name: "Lana" });
  const fansly = await createFanslyPage(db, { modelId: model.id, label: live.pageLabel });
  const onlyfans = await createOnlyFansPage(db, { modelId: model.id, label: "live-of" });
  live.pageId = fansly.id;
  const chatter = await createUserAccount(app, { username: "anton", role: "chatter" }, { source: "cli" });
  await db.execute(sql`update users set password_hash = ${await argon2.hash(CHATTER_PASSWORD, { type: argon2.argon2id })} where id = ${chatter.id}`);
  live.chatterUserId = chatter.id;
  const chatterPerson = await insertPersonRow(db, {
    code: live.personCode, displayName: "Anton", kind: "human", role: "chatter", state: "working", leftOn: null, telegramUserId: 4242,
    telegramHandle: null, reportTag: "#anton", onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
  });
  await insertPersonLogin(db, { personId: chatterPerson.id, userId: chatter.id, linkedByUserId: null });
  await db.execute(sql`insert into person_working_pages (person_id, page_id, position) values (${chatterPerson.id}, ${fansly.id}, 0), (${chatterPerson.id}, ${onlyfans.id}, 1)`);
  const issued = await issueChatterDeviceToken(app, { username: "anton", pageLabel: live.pageLabel }, { source: "cli" });
  await assignPageToUser(app, { userId: chatter.id, pageLabel: "live-of" }, { source: "cli" });

  // A live shift of yesterday with sales: activity, messages with authors, a tip and a PPV.
  const start = today.getTime() - DAY_MS - 4 * 3_600_000;
  await db.execute(sql`insert into chatter_activity_minutes (user_id, page_id, minute, input)
    select ${chatter.id}, ${fansly.id}, m, true from generate_series(date_trunc('minute', ${new Date(start).toISOString()}::timestamptz),
      date_trunc('minute', ${new Date(start + 3 * 3_600_000).toISOString()}::timestamptz), interval '1 minute') m`);
  const [fan] = (await db.execute<{ id: string }>(sql`insert into fans (platform, platform_user_id, username, display_name)
    values ('fansly', '100000000000000001', 'live_fan', 'Live Fan') returning id`)).rows;
  await db.execute(sql`insert into page_fans (fan_id, platform_account_id) values (${fan!.id}, ${fansly.id})`);
  for (let index = 0; index < 70; index += 1) {
    await db.execute(sql`insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, conversation_ref, user_id,
      source, priced, with_media, observed_at) values ('fansly', ${fansly.id}, ${String(500000 + index)}, '100000000000000001',
      '100000000000000001', ${chatter.id}, 'fansly-extension', false, false, ${new Date(start + (index + 1) * 2 * 60_000).toISOString()}::timestamptz)`);
  }
  for (const [index, kind] of (["tip", "message_purchase", "subscription"] as const).entries()) {
    await db.execute(sql`insert into transactions (platform_account_id, fan_id, transaction_id, raw_type, canonical_type, transaction_state,
      raw_status, gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, is_active)
      values (${fansly.id}, ${fan!.id}, ${`live-${index}`}, ${kind}, ${kind}::transaction_type, 'posted', 'posted', ${20_000 + index * 1000},
        ${20_000 + index * 1000}, ${16_000 + index * 800}, ${new Date(start + (60 + index * 30) * 60_000).toISOString()}::timestamptz, 'fansly:rest', true)`);
  }
  await syncShiftRowsSince(db, { from: new Date(today.getTime() - 3 * DAY_MS), now: new Date(today.getTime() - 60_000) });
  await refreshSaleHomes(db, { from: new Date(today.getTime() - 3 * DAY_MS), to: new Date(today.getTime() - 60_000), now: new Date(today.getTime() - 60_000) });
  const [shift] = (await db.execute<{ id: string }>(sql`select id from shifts order by id limit 1`)).rows;
  live.shiftId = Number(shift?.id ?? 0);
  const [transaction] = (await db.execute<{ id: string }>(sql`select id from transactions order by id limit 1`)).rows;
  live.transactionId = Number(transaction!.id);
  await db.execute(sql`insert into matters (reason_key, kind, source, title, page_ids, owner_role, opened_at, last_seen_at, updated_at)
    values ('sale.live:1', 'sale.live', 'server', 'Live matter', array[${fansly.id}]::bigint[], 'owner', now() - interval '1 day',
      now() - interval '1 day', now() - interval '1 day')`);

  // The agents: keys shaped like production's ledger, Gengar and the /OS people mirror.
  const keys: Array<{ code: string; capabilities: string[] }> = [
    { code: "ledger", capabilities: ["read:money", "read:datasets", "read:team", "read:pay_terms"] },
    { code: "gengar", capabilities: ["read:messages", "read:money", "read:observations_envelope", "read:datasets", "read:team", "read:content", "write:matters", "write:customs", "write:shift_reports"] },
    { code: "people-mirror", capabilities: ["read:team"] },
  ];
  for (const key of keys) {
    await insertPersonRow(db, {
      code: key.code, displayName: key.code, kind: "agent", role: "agent", state: "working", leftOn: null, telegramUserId: null,
      telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
    });
    const { token } = await issueAgentKey(app, {
      name: `${key.code}-key`, agentCode: key.code, capabilities: key.capabilities as never, pageLabels: [live.pageLabel, "live-of"], expiresInDays: 30,
    }, { source: "cli", actorUserId: owner.id });
    callers.push({ name: key.code, headers: { authorization: `Bearer ${token}` } });
  }
  callers.unshift({ name: "chatter", headers: { authorization: `Bearer ${issued.key}` } });
  liveWords.push("live-1", "live-of", "anton", "dima", live.personCode, "Lana", "Live matter", "live_fan");
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  const app = createTestAppContext(testDb);
  await seedLive(app);
  server = await buildApiServer(createTestAppContext(testDb));
  callers.unshift({ name: "owner", headers: { cookie: await login("dima", OWNER_PASSWORD) } });
  runStartedAt = Date.now();
}, 300_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

describe("the wall of the test realm", () => {
  it("every read answers live principals the same before and after the test team is seeded and works", async (context) => {
    if (!server || !testDb) return context.skip();
    const app = createTestAppContext(testDb);
    const reads = readsOf(server.routePolicyTable);
    expect(reads.length).toBeGreaterThan(250);

    const before = await snapshot(reads);

    await seedSandbox(app, { scenarios: [], env: SANDBOX_PASSWORDS });
    const seeded = await snapshot(reads);
    expect(differences(before, seeded, "seeded")).toEqual([]);

    const now = new Date();
    await seedSandbox(app, { scenarios: ["shift", "customs", "matters"], env: SANDBOX_PASSWORDS, now });
    await syncShiftRowsSince(app.db, { from: new Date(now.getTime() - 3 * DAY_MS), now });
    await refreshSaleHomes(app.db, { from: new Date(now.getTime() - 3 * DAY_MS), to: now, now });
    await runCustomOrderChecks(app, now);
    const scenarios = await snapshot(reads);
    expect(differences(before, scenarios, "scenarios")).toEqual([]);

    // The test team works: its owner and a chatter sign in and read; the chatter's extension beats.
    tOwnerCookie = await login("t-owner", SANDBOX_PASSWORDS.SANDBOX_PASSWORD_T_OWNER);
    const chat = await login("t-chat-1", SANDBOX_PASSWORDS.SANDBOX_PASSWORD_T_CHAT_1);
    for (const read of reads.filter((one) => SANDBOX_OWNER_OPERATIONS.has(one.key))) {
      await answer(read, { name: "t-owner", headers: { cookie: tOwnerCookie } });
      await answer(read, { name: "t-chat-1", headers: { cookie: chat } });
    }
    const worked = await snapshot(reads);
    expect(differences(before, worked, "worked")).toEqual([]);

    const statuses = new Map<string, number>();
    for (const value of before.values()) {
      const status = value.slice(0, 3);
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
    }
    // How much of it proves anything: an answer that is a refusal both times is equal but shows no data.
    const summary = process.env.SANDBOX_WALL_SUMMARY_FILE;
    if (summary) {
      const notProven = [...before].filter(([, value]) => !value.startsWith("200")).map(([key, value]) => `${key} ${value.slice(0, 3)}`);
      appendFileSync(summary, `${JSON.stringify({ compared: before.size, statuses: Object.fromEntries(statuses), notProven })}\n`);
    }
  }, 900_000);

  it("a live owner cannot open a test page", async (context) => {
    if (!server || !testDb) return context.skip();
    await seedSandbox(createTestAppContext(testDb), { scenarios: [], env: SANDBOX_PASSWORDS });
    const owner = callers.find((caller) => caller.name === "owner")!;
    const response = await server.inject({ method: "GET", url: "/api/v1/pages/test-1/subscribers", headers: owner.headers });
    expect(response.statusCode).toBe(403);
  });

  it("the test owner is refused every operation off its table, and what it reads names nothing live", async (context) => {
    if (!server || !testDb) return context.skip();
    await seedSandbox(createTestAppContext(testDb), { scenarios: [], env: SANDBOX_PASSWORDS });
    if (tOwnerCookie === "") tOwnerCookie = await login("t-owner", SANDBOX_PASSWORDS.SANDBOX_PASSWORD_T_OWNER);
    const refused: string[] = [];
    const leaked: string[] = [];
    for (const row of server.routePolicyTable) {
      if (!row.url.startsWith("/api/") || !row.auth) continue;
      // No principal is resolved for these: signing in itself, webhooks, the monitoring token's routes.
      if (row.auth.kind === "public" || row.auth.kind === "hmac") continue;
      const url = row.url.replace(/:([A-Za-z]+)/g, "1");
      const response = await server.inject({
        method: row.method as "GET", url, headers: { cookie: tOwnerCookie },
        ...(row.method === "GET" ? {} : { payload: {} }),
      });
      if (SANDBOX_OWNER_OPERATIONS.has(row.routeKey)) {
        if (row.method === "GET" && response.statusCode === 200 && liveWords.some((word) => response.body.includes(`"${word}"`))) {
          leaked.push(`${row.method} ${row.url}: ${response.body.slice(0, 300)}`);
        }
        continue;
      }
      if (response.statusCode !== 403) refused.push(`${row.method} ${row.url} (${row.routeKey}) answered ${response.statusCode}`);
    }
    expect(refused).toEqual([]);
    expect(leaked).toEqual([]);
  }, 300_000);

  it("Workboard «Сегодня» and «Новички»: the test owner's name the test team alone, a live owner's nothing of it", async (context) => {
    if (!server || !testDb) return context.skip();
    if (tOwnerCookie === "") tOwnerCookie = await login("t-owner", SANDBOX_PASSWORDS.SANDBOX_PASSWORD_T_OWNER);
    const get = (url: string, cookie: string) => server!.inject({ method: "GET", url, headers: { cookie } });
    const today = await get("/api/v1/workboard/today", tOwnerCookie);
    expect(today.statusCode, today.body).toBe(200);
    expect((today.json() as { team: { teams: Array<{ name: string }> } | null }).team?.teams.map((one) => one.name)).toEqual([SANDBOX_MODEL.name]);
    for (const url of ["/api/v1/workboard/today", "/api/v1/account/shifts", "/api/v1/team/newcomers"]) {
      const answer = await get(url, tOwnerCookie);
      expect(answer.statusCode, `${url}: ${answer.body}`).toBe(200);
      expect(liveWords.filter((word) => answer.body.includes(`"${word}"`)), url).toEqual([]);
    }
    const ownerCookie = callers.find((one) => one.name === "owner")!.headers.cookie!;
    for (const url of ["/api/v1/workboard/today", "/api/v1/team/newcomers"]) {
      const live = await get(url, ownerCookie);
      expect(live.statusCode, live.body).toBe(200);
      expect(live.body.includes(`"${SANDBOX_MODEL.name}"`), url).toBe(false);
    }
  });

  it("the test owner's decisions and team records reach the test realm only: a live sale, page or person is 404", async (context) => {
    if (!server || !testDb) return context.skip();
    await seedSandbox(createTestAppContext(testDb), { scenarios: [], env: SANDBOX_PASSWORDS });
    if (tOwnerCookie === "") tOwnerCookie = await login("t-owner", SANDBOX_PASSWORDS.SANDBOX_PASSWORD_T_OWNER);
    const call = async (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) => (await server!.inject({
      method, url, headers: { cookie: tOwnerCookie, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
      ...(payload === undefined ? {} : { payload }),
    })).statusCode;
    const [liveModel] = (await testDb.pool.query("select id from models where slug = $1", [live.modelSlug])).rows as Array<{ id: string }>;
    const statuses = {
      dispute: await call("GET", `/api/v1/sale-disputes/${live.transactionId}`),
      decide: await call("POST", "/api/v1/sale-disputes/decide", { transactionId: live.transactionId, outcome: "nobody", note: null }),
      offPlatformOnLivePage: await call("POST", "/api/v1/off-platform/1/decide", { decision: "confirm", pageLabel: live.pageLabel }),
      teamRoleOfLivePerson: await call("POST", "/api/v1/team/roles", { personCode: live.personCode, modelId: Number(liveModel!.id), kind: "view", granted: true }),
      reviewNoteOnLiveShift: await call("POST", "/api/v1/team/review-notes", {
        userId: live.chatterUserId, at: new Date(today.getTime() - DAY_MS - 3 * 3_600_000).toISOString(), text: "x",
      }),
    };
    expect(statuses).toEqual({ dispute: 404, decide: 404, offPlatformOnLivePage: 404, teamRoleOfLivePerson: 404, reviewNoteOnLiveShift: 404 });
    const pending = await server.inject({ method: "GET", url: "/api/v1/off-platform", headers: { cookie: tOwnerCookie } });
    expect(pending.statusCode).toBe(200);
    expect(liveWords.some((word) => pending.body.includes(`"${word}"`))).toBe(false);
    const roles = await server.inject({ method: "GET", url: "/api/v1/team/roles", headers: { cookie: tOwnerCookie } });
    expect(roles.statusCode).toBe(200);
    expect(liveWords.some((word) => roles.body.includes(`"${word}"`))).toBe(false);
  }, 300_000);

  // Workboard's own reads and writes of the test owner (products packages W): «Список продаж» and a sale's chain, the
  // questions to whoever decides. Each keeps to its realm by id as by list, and a test realm's money asks no ledger.
  it("keeps the sales list, a sale's chain and the questions to their realm, both ways", async (context) => {
    if (!server || !testDb) return context.skip();
    const app = createTestAppContext(testDb);
    const now = new Date();
    await seedSandbox(app, { scenarios: ["shift"], env: SANDBOX_PASSWORDS, now });
    await syncShiftRowsSince(app.db, { from: new Date(now.getTime() - 3 * DAY_MS), now });
    await refreshSaleHomes(app.db, { from: new Date(now.getTime() - 3 * DAY_MS), to: now, now });
    if (tOwnerCookie === "") tOwnerCookie = await login("t-owner", SANDBOX_PASSWORDS.SANDBOX_PASSWORD_T_OWNER);
    const tChat = await login("t-chat-1", SANDBOX_PASSWORDS.SANDBOX_PASSWORD_T_CHAT_1);
    const owner = callers.find((caller) => caller.name === "owner")!.headers.cookie!;
    const as = (cookie: string, method: "GET" | "POST", url: string, payload?: Record<string, unknown>) => server!.inject({
      method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }),
    });
    const namesLive = (body: string) => liveWords.some((word) => body.includes(`"${word}"`));

    // The sales list of the last days: the test owner's names nothing live, the live owner's nothing of the test team.
    const window = `from=${dayOf(now.getTime() - 3 * DAY_MS)}&to=${dayOf(now.getTime())}`;
    const tList = await as(tOwnerCookie, "GET", `/api/v1/team/sales/list?${window}`);
    expect(tList.statusCode, tList.body).toBe(200);
    expect(namesLive(tList.body)).toBe(false);
    const [testSale] = (await testDb.pool.query(`select t.id from transactions t join pages p on p.id = t.platform_account_id
      join models m on m.id = p.model_id where m.is_test order by t.id limit 1`)).rows as Array<{ id: string }>;
    const listed = (tList.json() as { sales: Array<{ transactionId: number; report: { words: string } }> }).sales;
    if (testSale !== undefined) {
      expect(listed.map((sale) => sale.transactionId)).toContain(Number(testSale.id));
      // No ledger for the test team: never «неизвестно», never a post.
      expect(listed.every((sale) => !sale.report.words.startsWith("неизвестно: ledger"))).toBe(true);
    }
    const liveList = await as(owner, "GET", `/api/v1/team/sales/list?${window}`);
    expect(liveList.statusCode).toBe(200);
    if (testSale !== undefined) expect((liveList.json() as { sales: Array<{ transactionId: number }> }).sales.map((sale) => sale.transactionId)).not.toContain(Number(testSale.id));

    // A sale's chain: of its own realm only, the test one without the ledger.
    expect((await as(tOwnerCookie, "GET", `/api/v1/sales/chain?saleId=${live.transactionId}`)).statusCode).toBe(404);
    if (testSale !== undefined) {
      expect((await as(owner, "GET", `/api/v1/sales/chain?saleId=${testSale.id}`)).statusCode).toBe(404);
      const chain = await as(tOwnerCookie, "GET", `/api/v1/sales/chain?saleId=${testSale.id}`);
      expect(chain.statusCode, chain.body).toBe(200);
      expect(namesLive(chain.body)).toBe(false);
      for (const person of (chain.json() as { people: Array<{ accrual: { words: string }; payout: { words: string } }> }).people) {
        expect([person.accrual.words, person.payout.words]).toEqual(["в тестовой команде денег нет", "в тестовой команде денег нет"]);
      }
    }

    // A live chatter's question: the test owner neither lists, opens nor answers it.
    const [liveQuestion] = (await testDb.pool.query(`insert into team_questions (asker_user_id, page_id, kind, text)
      values ($1, $2, 'late', 'опоздаю на час') returning id`, [live.chatterUserId, live.pageId])).rows as Array<{ id: string }>;
    const tQuestions = await as(tOwnerCookie, "GET", "/api/v1/team/questions");
    expect(tQuestions.statusCode).toBe(200);
    expect((tQuestions.json() as { questions: Array<{ id: number }> }).questions.map((one) => one.id)).not.toContain(Number(liveQuestion!.id));
    expect((await as(tOwnerCookie, "GET", `/api/v1/team/questions?id=${liveQuestion!.id}`)).statusCode).toBe(404);
    expect((await as(tOwnerCookie, "POST", `/api/v1/team/questions/${liveQuestion!.id}/answer`, { answer: "yes" })).statusCode).toBe(404);
    // The test owner cannot ask on a live page.
    expect((await as(tOwnerCookie, "POST", "/api/v1/team/questions", { pageLabel: live.pageLabel, kind: "late", text: "x" })).statusCode).not.toBe(200);

    // A test chatter's question is decided inside the test realm: the live owner neither sees nor answers it.
    const [testPage] = (await testDb.pool.query(`select p.label from person_working_pages w
      join person_logins l on l.person_id = w.person_id join users u on u.id = l.user_id join pages p on p.id = w.page_id
      where u.username = 't-chat-1' order by w.position limit 1`)).rows as Array<{ label: string }>;
    expect(testPage).toBeDefined();
    const asked = await as(tChat, "POST", "/api/v1/team/questions", { pageLabel: testPage!.label, kind: "swap", text: "возьму смену" });
    expect(asked.statusCode, asked.body).toBe(200);
    const question = (asked.json() as { question: { id: number } }).question;
    const [matter] = (await testDb.pool.query("select owner_user_id::text, owner_role from matters where reason_key = $1 and state = 'open'", [`question.asked:${question.id}`])).rows as Array<{ owner_user_id: string | null; owner_role: string | null }>;
    expect(matter).toBeDefined();
    if (matter!.owner_user_id !== null) {
      // A decider by name is a test person's login.
      const [decider] = (await testDb.pool.query("select u.username from users u where u.id = $1", [matter!.owner_user_id])).rows as Array<{ username: string }>;
      expect(decider!.username.startsWith("t-")).toBe(true);
    }
    const liveOwnerList = await as(owner, "GET", "/api/v1/team/questions");
    expect((liveOwnerList.json() as { questions: Array<{ id: number }> }).questions.map((one) => one.id)).not.toContain(question.id);
    expect((await as(owner, "GET", `/api/v1/team/questions?id=${question.id}`)).statusCode).toBe(404);
    expect((await as(owner, "POST", `/api/v1/team/questions/${question.id}/answer`, { answer: "no" })).statusCode).toBe(404);
    const answered = await as(tOwnerCookie, "POST", `/api/v1/team/questions/${question.id}/answer`, { answer: "yes", text: "да" });
    expect(answered.statusCode, answered.body).toBe(200);
    expect(namesLive(answered.body)).toBe(false);
  }, 300_000);
  it("the customs board's header names whoever leads customs by the one rule, per model of the viewer's realm, both ways", async (context) => {
    if (!server || !testDb) return context.skip();
    await seedSandbox(createTestAppContext(testDb), { scenarios: [], env: SANDBOX_PASSWORDS });
    // A live person who «ведёт кастомы» (the right, mirrored as a customs record on the live model).
    const [person] = (await testDb.pool.query("select id from people where code = $1", [live.personCode])).rows as Array<{ id: string }>;
    await testDb.pool.query("insert into person_rights (person_id, \"right\") values ($1, 'customs_lead') on conflict do nothing", [person!.id]);
    await testDb.pool.query(
      "insert into team_roles (person_id, model_id, kind) select $1, id, 'customs' from models where slug = $2 on conflict do nothing",
      [person!.id, live.modelSlug],
    );
    const board = async (cookie: string) => {
      const answer = await server!.inject({ method: "GET", url: "/api/v1/custom-orders", headers: { cookie } });
      expect(answer.statusCode, answer.body).toBe(200);
      return answer.json() as { leads: Array<{ model: string; check: string | null; shoot: string | null }> };
    };
    // The test team lead: the test model alone, led by the test team's own people — never the live «Anton».
    const tLead = await login("t-lead", SANDBOX_PASSWORDS.SANDBOX_PASSWORD_T_LEAD);
    const theirs = await board(tLead);
    expect(theirs.leads.map((lead) => lead.model)).toEqual([SANDBOX_MODEL.name]);
    expect(JSON.stringify(theirs.leads).includes("Anton")).toBe(false);
    // The live owner: the live model, its live customs lead; nothing of the test realm.
    const ownerCookie = callers.find((one) => one.name === "owner")!.headers.cookie!;
    const ours = await board(ownerCookie);
    expect(ours.leads.map((lead) => lead.model)).not.toContain(SANDBOX_MODEL.name);
    expect(ours.leads.find((lead) => lead.model === "Lana")).toMatchObject({ shoot: "Anton" });
  }, 300_000);
});
