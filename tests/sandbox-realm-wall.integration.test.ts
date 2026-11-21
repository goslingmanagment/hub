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
import { SIGHTING_UNMATCHED_KIND, syncCheckMatters } from "../apps/runtime/src/services/shift-handin-check.ts";
import { syncShiftRowsSince } from "../apps/runtime/src/services/shift-rows.ts";
import { runCustomOrderChecks } from "../apps/runtime/src/services/custom-orders/checks.ts";
import { issueChatterDeviceToken, issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// The wall of the test realm (apps/runtime/src/services/sandbox/realm.ts), proven on the contract itself:
//
// 1. every READ of the contract (every GET, and the agent plane's POST reads), called as the live owner, a live
//    chatter and keys shaped like the ledger's, Gengar's and the /OS people mirror's, answers the SAME before the test
//    team is seeded, after it is seeded with stand-ins of both live pages (0435), after its `shift`, `customs` and
//    `matters` scenarios and the ordinary jobs ran, and after its people worked (signed in, beat on the stand-ins,
//    reported the site's sales there, read). Only clock fields are set aside (`VOLATILE_KEYS`, and timestamps of the
//    run's own minutes), by name;
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

/** An answer as compared: its status, its body without the clock fields, and the moment it was taken. */
interface Answer { status: number; body: unknown; at: number }

function withoutClockFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutClockFields);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_KEYS.has(key)) continue;
      out[key] = withoutClockFields(inner);
    }
    return out;
  }
  return value;
}

/** A moment of this run as the answer taken at `at` names it: the run's own clock, or a window counted back from
 *  that answer's clock by whole hours. */
function clockOf(value: string, at: number): boolean {
  if (!ISO.test(value)) return false;
  const moment = Date.parse(value);
  if (moment >= runStartedAt - 1_000) return true;
  const back = (at - moment) % 3_600_000;
  return back < 120_000 || back > 3_600_000 - 120_000;
}

/** The same answer: equal values, or two moments each of which is its own answer's clock. Decided for the pair: one
 *  instant on a whole hour (a Moscow day's start) is never a clock in one answer and data in the other because the
 *  two were taken either side of a minute that is two from a whole hour. */
function same(left: unknown, right: unknown, leftAt: number, rightAt: number): boolean {
  if (left === right) return true;
  if (typeof left === "string" && typeof right === "string") return clockOf(left, leftAt) && clockOf(right, rightAt);
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => same(item, right[index], leftAt, rightAt));
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const keys = Object.keys(leftObject);
  return keys.length === Object.keys(rightObject).length
    && keys.every((key) => Object.hasOwn(rightObject, key) && same(leftObject[key], rightObject[key], leftAt, rightAt));
}

const shown = (value: Answer | undefined) => value === undefined ? undefined : `${value.status} ${JSON.stringify(value.body)}`;

async function answer(read: Read, caller: Caller): Promise<Answer> {
  const response = await server!.inject({
    method: read.method,
    url: read.url,
    headers: { ...caller.headers, ...(read.method === "POST" ? { "content-type": "application/json" } : {}) },
    ...(read.body === undefined ? {} : { payload: read.body }),
  });
  const at = Date.now();
  let body: unknown = response.body;
  try { body = withoutClockFields(JSON.parse(response.body)); } catch { /* not JSON: compared as it is */ }
  return { status: response.statusCode, body, at };
}

async function snapshot(reads: readonly Read[]): Promise<Map<string, Answer>> {
  const out = new Map<string, Answer>();
  for (const caller of callers) {
    for (const read of reads) out.set(`${caller.name} ${read.method} ${read.url}`, await answer(read, caller));
  }
  return out;
}

/** The reads whose answers differ (their keys; with SANDBOX_WALL_DIFF_FILE set, both answers are written there). */
function differences(before: Map<string, Answer>, after: Map<string, Answer>, stage: string): string[] {
  const out: string[] = [];
  const full: Array<{ key: string; before: string | undefined; after: string | undefined }> = [];
  for (const [key, value] of before) {
    const other = after.get(key);
    if (other !== undefined && other.status === value.status && same(value.body, other.body, value.at, other.at)) continue;
    out.push(key);
    full.push({ key, before: shown(value), after: shown(other) });
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

    const standIn = [live.pageLabel, "live-of"];
    await seedSandbox(app, { scenarios: [], env: SANDBOX_PASSWORDS, standIn });
    const seeded = await snapshot(reads);
    expect(differences(before, seeded, "seeded")).toEqual([]);

    const now = new Date();
    const scenarioSeed = await seedSandbox(app, { scenarios: ["shift", "customs", "matters", "publications"], env: SANDBOX_PASSWORDS, now, standIn });
    // The day of `shift` is on the stand-ins, none of it on the fixed OnlyFans test page.
    const shiftSales = (await testDb.pool.query(`select p.label, count(*)::int as n from transactions t join pages p on p.id = t.platform_account_id
      where t.source = 'sandbox' and p.label in ('test-${live.pageLabel}', 'test-live-of', 'test-of') group by p.label order by p.label`)).rows as Array<{ label: string; n: number }>;
    expect(shiftSales).toEqual([{ label: "test-live-1", n: 7 }, { label: "test-live-of", n: 2 }]);
    expect(scenarioSeed.scenarios.shift).toMatchObject({ sales: 9 });
    await syncShiftRowsSince(app.db, { from: new Date(now.getTime() - 3 * DAY_MS), now });
    await refreshSaleHomes(app.db, { from: new Date(now.getTime() - 3 * DAY_MS), to: now, now });
    await runCustomOrderChecks(app, now);
    const scenarios = await snapshot(reads);
    expect(differences(before, scenarios, "scenarios")).toEqual([]);

    // The test team works: its owner and a chatter sign in and read; the chatter's extension, on the live pages' real
    // accounts, beats on the stand-ins and reports the site's sales there.
    tOwnerCookie = await login("t-owner", SANDBOX_PASSWORDS.SANDBOX_PASSWORD_T_OWNER);
    const chat = await login("t-chat-1", SANDBOX_PASSWORDS.SANDBOX_PASSWORD_T_CHAT_1);
    for (const read of reads.filter((one) => SANDBOX_OWNER_OPERATIONS.has(one.key))) {
      await answer(read, { name: "t-owner", headers: { cookie: tOwnerCookie } });
      await answer(read, { name: "t-chat-1", headers: { cookie: chat } });
    }
    const [tChat] = (await testDb.pool.query("select id from users where username = 't-chat-1'")).rows as Array<{ id: string }>;
    const extension = { authorization: `Bearer ${(await issueDeviceTokenForUserId(app, { userId: Number(tChat!.id), label: "extension" })).token}` };
    const beat = await server.inject({ method: "POST", url: "/api/v1/client/activity", headers: extension, payload: {
      instanceId: "sandbox-wall-test", pages: [{ pageLabel: `test-${live.pageLabel}`, idleMs: 0 }, { pageLabel: "test-live-of", idleMs: 0 }],
    } });
    expect(beat.statusCode, beat.body).toBe(200);
    expect(beat.json()).toMatchObject({ recorded: 2 });
    const sighted = await server.inject({ method: "POST", url: "/api/v1/client/sale-sightings", headers: extension, payload: {
      pageLabel: `test-${live.pageLabel}`,
      rows: [{ platformRef: "777000000000000001", kind: "tip", occurredAt: new Date(now.getTime() - 60_000).toISOString(), grossMills: 10_000, netMills: 8_000, fanRef: "100000000000000777", fanName: "Фан с сайта" }],
    } });
    expect(sighted.statusCode, sighted.body).toBe(200);
    // Two days on, the sale still not in Hub: the check's matter is the test team's owner's, and the live pass goes on.
    await syncCheckMatters(app, new Date(now.getTime() + 2 * DAY_MS + 3_600_000));
    const [unmatched] = (await testDb.pool.query(`select u.username from matters m join users u on u.id = m.owner_user_id
      where m.kind = $1 and m.state = 'open'`, [SIGHTING_UNMATCHED_KIND])).rows as Array<{ username: string }>;
    expect(unmatched?.username).toBe("t-owner");
    const worked = await snapshot(reads);
    expect(differences(before, worked, "worked")).toEqual([]);

    const statuses = new Map<string, number>();
    for (const value of before.values()) {
      const status = String(value.status);
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
    }
    // How much of it proves anything: an answer that is a refusal both times is equal but shows no data.
    const summary = process.env.SANDBOX_WALL_SUMMARY_FILE;
    if (summary) {
      const notProven = [...before].filter(([, value]) => value.status !== 200).map(([key, value]) => `${key} ${value.status}`);
      appendFileSync(summary, `${JSON.stringify({ compared: before.size, statuses: Object.fromEntries(statuses), notProven })}\n`);
    }
  }, 900_000);

  // «Публикации» (products package C2): the test pages' posts are the test realm's alone, both ways; a platform is never asked.
  it("shows the test owner the test pages' publications and a live owner none, and asks no platform for them", async (context) => {
    if (!server || !testDb) return context.skip();
    await seedSandbox(createTestAppContext(testDb), { scenarios: ["publications"], env: SANDBOX_PASSWORDS, now: new Date(Date.now() - 60_000) });
    if (tOwnerCookie === "") tOwnerCookie = await login("t-owner", SANDBOX_PASSWORDS.SANDBOX_PASSWORD_T_OWNER);
    const get = (url: string, cookie: string) => server!.inject({ method: "GET", url, headers: { cookie } });
    const test = await get("/api/v1/admin/publications", tOwnerCookie);
    expect(test.statusCode, test.body).toBe(200);
    const statuses = new Set((test.json() as { publications: Array<{ pageLabel: string; status: string }> }).publications.map((one) => one.status));
    expect([...statuses].sort()).toEqual(["approved", "draft", "published", "unknown", "withdrawn"]);
    expect(liveWords.filter((word) => test.body.includes(`"${word}"`))).toEqual([]);
    const settings = await get("/api/v1/admin/publications/settings", tOwnerCookie);
    expect(settings.body).toContain('"test-1"');
    expect(liveWords.filter((word) => settings.body.includes(`"${word}"`))).toEqual([]);
    const ownerCookie = callers.find((one) => one.name === "owner")!.headers.cookie!;
    for (const url of ["/api/v1/admin/publications", "/api/v1/admin/publications/settings", "/api/v1/admin/publications/queue"]) {
      const live = await get(url, ownerCookie);
      expect(live.statusCode, live.body).toBe(200);
      expect(live.body.includes('"test-1"') || live.body.includes('"test-of"'), url).toBe(false);
    }
    const refresh = await server.inject({ method: "POST", url: "/api/v1/admin/publications/queue/refresh", headers: { cookie: tOwnerCookie }, payload: { pageLabel: "test-1" } });
    expect(refresh.statusCode).toBe(409);
    expect(refresh.json()).toMatchObject({ message: "тестовая страница: на площадку не отправляется" });
  }, 300_000);

  it("a live owner cannot open a test page", async (context) => {
    if (!server || !testDb) return context.skip();
    await seedSandbox(createTestAppContext(testDb), { scenarios: [], env: SANDBOX_PASSWORDS });
    const owner = callers.find((caller) => caller.name === "owner")!;
    const response = await server.inject({ method: "GET", url: "/api/v1/pages/test-1/subscribers", headers: owner.headers });
    // As a page that does not exist (sandbox/objects.ts): no «there, but not yours».
    expect(response.statusCode).toBe(404);
    const missing = await server.inject({ method: "GET", url: "/api/v1/pages/nowhere-page/subscribers", headers: owner.headers });
    expect(response.body.replace("test-1", "<page>")).toBe(missing.body.replace("nowhere-page", "<page>"));
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

  // «Мимо площадки» the test owner confirms on a test report keeps the page it was confirmed on (round 2, N6): the page
  // is found among the test realm's pages too, never only the live ones, and the next hand-in still counts it.
  it("keeps the page of «мимо площадки» the test owner confirms on a test team's report", async (context) => {
    if (!server || !testDb) return context.skip();
    await seedSandbox(createTestAppContext(testDb), { scenarios: [], env: SANDBOX_PASSWORDS });
    if (tOwnerCookie === "") tOwnerCookie = await login("t-owner", SANDBOX_PASSWORDS.SANDBOX_PASSWORD_T_OWNER);
    const chat2 = await login("t-chat-2", SANDBOX_PASSWORDS.SANDBOX_PASSWORD_T_CHAT_2);
    const shift = (await testDb.pool.query(
      "select s.id from shifts s join users u on u.id = s.user_id where u.username = 't-chat-2' and s.state = 'closed' order by s.started_at desc limit 1",
    )).rows[0] as { id: string } | undefined;
    if (shift === undefined) return context.skip();
    const shiftId = Number(shift.id);
    const as = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) => server!.inject({
      method, url, headers: { cookie: chat2, ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { payload }),
    });
    const handInAndConfirm = async () => {
      const phase = ((await as("GET", `/api/v1/shift-reports/${shiftId}`)).json().board as { phase: string } | null)?.phase;
      if (phase === "counted" || phase === "confirm") expect((await as("POST", `/api/v1/shift-reports/${shiftId}/reopen`)).statusCode).toBe(200);
      const handed = await as("POST", `/api/v1/shift-reports/${shiftId}/submit`);
      expect(handed.statusCode, handed.body).toBe(200);
      const board = handed.json().board as { phase: string; candidate: { id: number } | null; totals: { nowMills: number; count: number } };
      expect(board.phase).toBe("confirm");
      const confirmed = await as("POST", `/api/v1/shift-reports/${shiftId}/confirm`, { candidateId: board.candidate!.id });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
    };
    const added = await as("POST", `/api/v1/shift-reports/${shiftId}/off-platform`, { amountMills: 5_000, fromWhom: "фан", whatFor: "кастом" });
    expect(added.statusCode, added.body).toBe(200);
    await handInAndConfirm();
    const label = (await testDb.pool.query(
      "select v.pages -> 0 ->> 'pageLabel' as label from shift_handins h join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version where h.shift_id = $1", [shiftId],
    )).rows[0].label as string;
    const decided = await server.inject({
      method: "POST", url: `/api/v1/off-platform/${added.json().line.id}/decide`, headers: { cookie: tOwnerCookie, "content-type": "application/json" },
      payload: { decision: "confirm", pageLabel: label },
    });
    expect(decided.statusCode, decided.body).toBe(200);
    expect((await testDb.pool.query("select page_id from off_platform_sales where id = $1", [added.json().line.id])).rows[0].page_id).not.toBeNull();
    // «Исправить», «Сдать заново», «Подтверждаю»: the confirmed $5 still counts, on its page.
    await handInAndConfirm();
    const after = (await testDb.pool.query(
      "select v.off_platform from shift_handins h join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version where h.shift_id = $1", [shiftId],
    )).rows[0].off_platform as Array<{ id: number; pageLabel: string | null; state: string }>;
    expect(after.find((one) => one.id === added.json().line.id)).toMatchObject({ state: "confirmed", pageLabel: label });
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
