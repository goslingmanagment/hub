import { afterAll, beforeAll, describe, expect, it } from "vitest";
import argon2 from "argon2";
import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";

import { routeSchemas } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, insertPersonLogin, insertPersonRow, type Database } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { assignPageToUser, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { recordCustomOrder } from "../apps/runtime/src/services/custom-orders/index.ts";
import { refreshSaleHomes } from "../apps/runtime/src/services/sale-homes.ts";
import { syncShiftRowsSince } from "../apps/runtime/src/services/shift-rows.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Teams (products package T): EVERY read of the contract, walked as three viewers on one database — a chatter of team
// A, a chatter who LEADS team A by the records (`team_roles`), and the owner:
//   - the chatter and the lead get nothing of team B (its page, model, people) anywhere in any answer, and no money of
//     people (pay terms, payouts, accruals, Telegram, devices, keys) except their own `account*` reads;
//   - the lead and the chatter read team A's shifts (each other's too: the team only adds), the lead opens a teammate's
//     review;
//   - the owner's answers are the same before and after the team records exist (byte-equal but for clock fields).
// A new read operation is walked by itself: the list comes from the server's route table.

const DAY_MS = 86_400_000;
const PASSWORD = "teams-secret-1";

type Server = Awaited<ReturnType<typeof buildApiServer>>;
type Zod = { _zod: { def: Record<string, unknown> & { type: string } } };

let testDb: StartedTestDatabase | null = null;
let server: Server | null = null;
const cookies: Record<string, string> = {};
const ids = { modelA: 0, modelB: 0, pageA: 0, pageB: 0, chatterA: 0, leadA: 0, chatterB: 0, personLeadA: 0, shiftA: 0, transactionB: 0 };
/** Words of team B: a non-owner's answer naming one of them leaks. */
const teamBWords = ["bravo-1", "bravo", "Bravo", "boris", "Boris", "boris-b"];
/** Fields of people's money and contacts: never in anyone else's answer (an `account*` read is the person's own). */
const FORBIDDEN_KEYS = new Set([
  "payTerms", "shareBasisPoints", "fixPerShiftMills", "payoutDetails", "payouts", "accruals", "accrualMills", "payMills", "rate",
  "telegram", "telegramUserId", "telegramHandle", "devices", "deviceTokens", "agentKeys", "lastSeenAt", "spendMicros", "costMicros",
  // The ledger-fed pay of a person («Мои деньги», `accountPay`: the person's own only).
  "accruedMills", "paidMills", "unpaidMills", "balanceMills", "owedMills", "payoutMills", "lastPayout", "oldestUnpaidDate",
]);
/**
 * Why a read refuses a team-A chatter (anna) or a team-A lead (lena) on this fixture; null — it must not. A refusal is
 * a finding only when this says nothing: no non-200 answer is skipped silently.
 */
function expectedRefusal(_who: string, status: number, key: string): string | null {
  if (status === 403) {
    if (/^(agent|client)[A-Z]/u.test(key)) return "the agent plane and the extension's device routes: not a web session's";
    if (/^(page|ofapi|overview|sync|ops|archive|voiceNote|aiPersona|aiRecap)[A-Z]/u.test(key)) return "the console's reads: the owner's, Workboard keeps its own";
    if (["models", "healthSync", "crossPageTransactions", "modelRevenueDaily"].includes(key)) return "the console's reads: the owner's";
    if (["saleDispute", "saleDisputeOfClaim", "shiftReportClaimable", "teamNewcomers"].includes(key)) return "the owner's or a decider's, by role";
    if (["reportsList", "reportGet"].includes(key)) return "agents' reports: the owner's and team leads'";
  }
  const SAMPLE: Record<string, string> = {
    "204 authStaticReports": "nothing to report",
    "400 authSso": "a sign-in hand-off needs its own parameters",
    "400 authSsoBegin": "a sign-in hand-off needs its own parameters",
    "400 authSsoAccept": "a sign-in hand-off needs its own parameters",
    "400 customOrder": "the sampled order code is not one",
    "400 fansSearch": "the sampled search names no scope",
    "400 spenders": "the sampled search names no scope",
    "400 spenderDetail": "the sampled search names no scope",
    "400 spenderSeries": "the sampled search names no scope",
    "400 saleChain": "the sampled sale names nothing",
    "404 crossPageFanDetail": "the sampled fan does not exist",
    "404 crossPageFanTransactions": "the sampled fan does not exist",
    "404 learnPage": "the sampled slug does not exist",
    "404 publicVaultUploadFile": "the sampled upload does not exist",
    "404 teamShiftReview": "the sampled moment is not inside a shift",
    "503 accountReports": "no ledger in this test",
  };
  return SAMPLE[`${status} ${key}`] ?? null;
}

/** A sale chain's links to a person's pay (`saleChain`): present for everyone, their sum only for whom it is. */
const PAY_LINK_KEYS = new Set(["accrual", "payout"]);

const today = new Date();
const dayOf = (at: number) => new Date(at + 3 * 3_600_000).toISOString().slice(0, 10);
// On a whole minute, as every time the fixture writes: the normaliser below tells the data's moments from the clock's
// by that (a window counted back from the request's own now carries its seconds).
const shiftStart = Math.floor((today.getTime() - DAY_MS - 4 * 3_600_000) / 60_000) * 60_000;

function unwrap(schema: Zod): { schema: Zod; optional: boolean } {
  let current = schema;
  let optional = false;
  for (;;) {
    const def = current._zod.def;
    if (def.type === "optional" || def.type === "default" || def.type === "catch") optional = true;
    if (["optional", "default", "catch", "nullable"].includes(def.type)) { current = def.innerType as Zod; continue; }
    if (def.type === "pipe") { current = def.in as Zod; continue; }
    return { schema: current, optional };
  }
}

/** A value for a field from its schema; ids name team B wherever a field names a subject (the cut must hold there). */
function valueFor(name: string, schema: Zod): unknown {
  const def = schema._zod.def;
  const pattern = ((def.checks ?? []) as Zod[]).map((check) => String((check._zod.def as { pattern?: RegExp }).pattern?.source ?? "")).join(" ");
  if (def.type === "enum") return Object.values(def.entries as Record<string, string>)[0];
  if (def.type === "literal") return (def.values as unknown[])[0];
  if (def.type === "boolean") return false;
  if (def.type === "array") return [];
  if (def.type === "union") return valueFor(name, unwrap((def.options as Zod[])[0]!).schema);
  if (def.type === "number") {
    if (name === "pageId") return ids.pageB;
    if (name === "userId") return ids.chatterB;
    if (name === "modelId") return ids.modelB;
    if (name === "transactionId") return ids.transactionB || 1;
    return 1;
  }
  if (def.type !== "string") return undefined;
  if (def.format === "uuid" || pattern.includes("[0-9a-fA-F]{8}")) return "00000000-0000-0000-0000-000000000000";
  if (def.format === "date" || pattern.startsWith("^\\d{4}-\\d{2}-\\d{2}$")) return name === "to" ? dayOf(today.getTime()) : dayOf(today.getTime() - 2 * DAY_MS);
  if (def.format === "datetime" || pattern.includes("T\\d{2}")) {
    if (name === "at") return new Date(shiftStart + 60 * 60_000).toISOString();
    // Whole minutes, as the fixture's moments: an answer that echoes them back keeps them as data (`normalize`).
    const minute = Math.floor(today.getTime() / 60_000) * 60_000;
    return name === "to" ? new Date(minute + 2 * 3_600_000).toISOString() : new Date(minute - 2 * DAY_MS).toISOString();
  }
  if (pattern.includes("(0[1-9]|1[0-2])")) return dayOf(today.getTime()).slice(0, 7);
  if (name === "pageLabel") return "bravo-1";
  if (name === "modelSlug" || name === "slug") return "bravo";
  if (name === "code" || name === "person" || name === "personCode") return "boris-b";
  if (pattern.includes("[1-9]")) return "1";
  return "x";
}

function sampleObject(schema: Zod | undefined): Record<string, unknown> | undefined {
  if (!schema) return undefined;
  let { schema: object } = unwrap(schema);
  if (object._zod.def.type === "union") object = unwrap((object._zod.def.options as Zod[])[0]!).schema;
  if (object._zod.def.type !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(object._zod.def.shape as Record<string, Zod>)) {
    const { schema: inner, optional } = unwrap(field);
    if (optional) continue;
    const value = valueFor(name, inner);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

interface Read { url: string; key: string }

function readsOf(table: Server["routePolicyTable"]): Read[] {
  const reads: Read[] = [];
  for (const row of table) {
    if (row.method !== "GET" || !row.url.startsWith("/api/") || row.routeKey === "adminDbStats") continue;
    const schema = (routeSchemas as unknown as Record<string, { params?: Zod; querystring?: Zod }>)[row.routeKey]!;
    const params = sampleObject(schema.params) ?? {};
    let url = row.url.replace(/:([A-Za-z]+)/g, (_, name: string) => encodeURIComponent(String(params[name] ?? "1")));
    const query = sampleObject(schema.querystring);
    if (query && Object.keys(query).length > 0) url += `?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)])).toString()}`;
    reads.push({ url, key: row.routeKey });
  }
  return reads;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const CLOCK_KEYS = new Set(["serverNow", "generatedAt", "now", "asOf", "computedAt", "checkedAt", "fetchedAt", "readAt", "answeredAt", "lastActiveAt", "lastUsedAt", "updatedAt", "requestId", "latencyMs", "rowEstimate", "totalBytes", "indexBytes"]);
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !CLOCK_KEYS.has(key)).map(([key, inner]) => [key, normalize(inner)]));
  }
  if (typeof value === "string" && ISO.test(value)) {
    // A moment of this run, or a window counted back from it by whole hours (`from` = now − 24 h): the clock, not data.
    // The data's moments are whole minutes (the fixture writes them so); the clock's carry its seconds. Without that
    // rule a data minute that happens to sit a whole number of hours back from the reading moment was taken for the
    // clock in one read and not in the next, and a read looked as if it moved by itself.
    const at = Date.parse(value);
    if (at > Date.now() - 10 * 60_000) return "<now>";
    if (at % 60_000 === 0) return value;
    const back = (Date.now() - at) % 3_600_000;
    if (back < 120_000 || back > 3_600_000 - 120_000) return "<clock>";
  }
  return value;
}

async function get(url: string, who: string) {
  return server!.inject({ method: "GET", url, headers: { cookie: cookies[who]! } });
}

/** The forbidden fields that carry something (a key present with only nulls or empty lists carries nothing). */
function forbiddenIn(value: unknown, path = ""): string[] {
  const carries = (inner: unknown): boolean => {
    if (inner === null || inner === undefined || inner === false) return false;
    if (Array.isArray(inner)) return inner.length > 0;
    if (typeof inner === "object") return Object.values(inner as Record<string, unknown>).some(carries);
    return true;
  };
  if (Array.isArray(value)) return value.flatMap((inner, index) => forbiddenIn(inner, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) => [
    ...(FORBIDDEN_KEYS.has(key) && carries(inner) ? [`${path}.${key}`] : []),
    ...(PAY_LINK_KEYS.has(key) && inner !== null && typeof inner === "object" && (inner as { amountMills?: unknown }).amountMills != null ? [`${path}.${key}.amountMills`] : []),
    ...forbiddenIn(inner, `${path}.${key}`),
  ]);
}

async function person(db: Database, code: string, name: string, userId: number, pageId: number, telegram: number | null) {
  const row = await insertPersonRow(db, {
    code, displayName: name, kind: "human", role: "chatter", state: "working", leftOn: null, telegramUserId: telegram,
    telegramHandle: null, reportTag: null, onboarding: [], note: "owner's note", importNotes: [], origin: "owner", createdByUserId: null,
  });
  await insertPersonLogin(db, { personId: row.id, userId, linkedByUserId: null });
  await db.execute(sql`insert into person_working_pages (person_id, page_id, position) values (${row.id}, ${pageId}, 0)`);
  await db.execute(sql`insert into person_pay_terms (person_id, model_id, valid_from, share_basis_points, fix_per_shift_mills)
    select ${row.id}, model_id, '2026-01-01', 2500, 10000 from pages where id = ${pageId}`);
  return row.id;
}

async function login(username: string) {
  const response = await server!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: PASSWORD } });
  expect(response.statusCode, response.body).toBe(200);
  const header = response.headers["set-cookie"];
  return String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
}

async function work(db: Database, userId: number, pageId: number, fanRef: string, suffix: string) {
  await db.execute(sql`insert into chatter_activity_minutes (user_id, page_id, minute, input)
    select ${userId}, ${pageId}, m, true from generate_series(date_trunc('minute', ${new Date(shiftStart).toISOString()}::timestamptz),
      date_trunc('minute', ${new Date(shiftStart + 3 * 3_600_000).toISOString()}::timestamptz), interval '1 minute') m`);
  const [fan] = (await db.execute<{ id: string }>(sql`insert into fans (platform, platform_user_id, username, display_name)
    values ('fansly', ${fanRef}, ${`fan_${suffix}`}, ${`Fan ${suffix}`}) returning id`)).rows;
  await db.execute(sql`insert into page_fans (fan_id, platform_account_id) values (${fan!.id}, ${pageId})`);
  // Messages make the minutes a shift (CHATTER_SHIFT_MIN_MESSAGES: without them it is a look-in).
  for (let index = 0; index < 60; index += 1) {
    await db.execute(sql`insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, conversation_ref, user_id,
      source, priced, with_media, observed_at) values ('fansly', ${pageId}, ${String(500_000 + suffix.charCodeAt(0) * 1000 + index)}, ${fanRef}, ${fanRef}, ${userId},
      'fansly-extension', false, false, ${new Date(shiftStart + (index + 1) * 3 * 60_000).toISOString()}::timestamptz)`);
  }
  const [sale] = (await db.execute<{ id: string }>(sql`insert into transactions (platform_account_id, fan_id, transaction_id, raw_type, canonical_type,
    transaction_state, raw_status, gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, is_active)
    values (${pageId}, ${fan!.id}, ${`t-${suffix}`}, 'tip', 'tip'::transaction_type, 'posted', 'posted', 20000, 20000, 16000,
      ${new Date(shiftStart + 60 * 60_000).toISOString()}::timestamptz, 'fansly:rest', true) returning id`)).rows;
  return Number(sale!.id);
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  const app = createTestAppContext(testDb);
  const db = app.db as Database;
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const owner = await createUserAccount(app, { username: "olga", role: "owner", password: PASSWORD }, { source: "cli" });
  const modelA = await createModel(db, { slug: "alfa", name: "Alfa" });
  const modelB = await createModel(db, { slug: "bravo", name: "Bravo" });
  ids.modelA = modelA.id;
  ids.modelB = modelB.id;
  ids.pageA = (await createFanslyPage(db, { modelId: modelA.id, label: "alfa-1" })).id;
  ids.pageB = (await createFanslyPage(db, { modelId: modelB.id, label: "bravo-1" })).id;
  for (const [name, page] of [["anna", "alfa-1"], ["lena", "alfa-1"], ["boris", "bravo-1"]] as const) {
    const user = await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
    await db.execute(sql`update users set password_hash = ${hash} where id = ${user.id}`);
    await assignPageToUser(app, { userId: user.id, pageLabel: page }, { source: "cli" });
    if (name === "anna") ids.chatterA = user.id;
    if (name === "lena") ids.leadA = user.id;
    if (name === "boris") ids.chatterB = user.id;
  }
  await person(db, "anna-a", "Anna", ids.chatterA, ids.pageA, null);
  ids.personLeadA = await person(db, "lena-a", "Lena", ids.leadA, ids.pageA, null);
  await person(db, "boris-b", "Boris", ids.chatterB, ids.pageB, 777001);
  const ownerPerson = await insertPersonRow(db, {
    code: "olga", displayName: "Olga", kind: "human", role: "owner", state: "working", leftOn: null, telegramUserId: null,
    telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
  });
  await insertPersonLogin(db, { personId: ownerPerson.id, userId: owner.id, linkedByUserId: null });
  await work(db, ids.chatterA, ids.pageA, "200000000000000001", "a");
  await work(db, ids.leadA, ids.pageA, "200000000000000002", "l");
  ids.transactionB = await work(db, ids.chatterB, ids.pageB, "200000000000000003", "b");
  const now = new Date(today.getTime() - 60_000);
  await syncShiftRowsSince(db, { from: new Date(today.getTime() - 3 * DAY_MS), now });
  await refreshSaleHomes(db, { from: new Date(today.getTime() - 3 * DAY_MS), to: now, now });
  server = await buildApiServer(createTestAppContext(testDb));
  for (const name of ["olga", "anna", "lena"]) cookies[name] = await login(name);
}, 300_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

describe("teams: who sees whom (package T)", () => {
  it("walks every read as a chatter, a lead and the owner: nothing of team B, no money of people, the owner unchanged", async (context) => {
    if (!server || !testDb) return context.skip();
    const reads = readsOf(server.routePolicyTable);
    expect(reads.length).toBeGreaterThan(250);

    const ownerAnswers = async () => {
      const out = new Map<string, string>();
      for (const read of reads) {
        const response = await get(read.url, "olga");
        out.set(read.url, `${response.statusCode} ${JSON.stringify(normalize(safeJson(response.body)))}`);
      }
      return out;
    };
    // Twice before the records: a read whose answer moves by itself (the clock, a cache the first read fills) proves
    // nothing about the records and is set aside by name.
    const ownerFirst = await ownerAnswers();
    const ownerBefore = await ownerAnswers();
    const unstable = new Set([...ownerBefore].filter(([url, value]) => ownerFirst.get(url) !== value).map(([url]) => url));

    // The team records: Lena leads team A (a chatter who leads her team stays a chatter).
    await testDb.pool.query("insert into team_roles (person_id, model_id, kind) values ($1, $2, 'lead')", [ids.personLeadA, ids.modelA]);

    const leaks: string[] = [];
    const money: string[] = [];
    const refused: Record<string, string[]> = { anna: [], lena: [] };
    let walked = 0;
    for (const who of ["anna", "lena"]) {
      for (const read of reads) {
        const response = await get(read.url, who);
        if (response.statusCode !== 200) {
          // A refusal is said, never skipped: a console read refuses a chatter and a lead by its declaration (403); every
          // other refusal is named in `expectedRefusal` with why.
          const auth = (routeSchemas as unknown as Record<string, { auth?: { kind: string } }>)[read.key]?.auth?.kind;
          if (!(response.statusCode === 403 && auth === "owner-session") && expectedRefusal(who, response.statusCode, read.key) === null) {
            refused[who]!.push(`${response.statusCode} ${read.key}`);
          }
          continue;
        }
        walked += 1;
        const idKeys: Array<[string, number]> = [["pageId", ids.pageB], ["userId", ids.chatterB], ["modelId", ids.modelB]];
        const named = teamBWords.filter((word) => response.body.includes(`"${word}"`))
          .concat(idKeys.filter(([key, id]) => new RegExp(`"${key}":${id}[,}]`).test(response.body)).map(([key]) => `<team B ${key}>`));
        if (named.length > 0) leaks.push(`${who} ${read.key}: ${named.join(", ")}`);
        if (!read.key.startsWith("account")) {
          const found = forbiddenIn(safeJson(response.body));
          if (found.length > 0) money.push(`${who} ${read.key}: ${found.slice(0, 3).join(", ")}`);
        }
      }
    }
    expect(walked).toBeGreaterThan(5);
    expect(refused).toEqual({ anna: [], lena: [] });
    expect(leaks).toEqual([]);
    expect(money).toEqual([]);

    const ownerChanged: string[] = [];
    // `teamRoles` IS the records, «Сегодня» names each team's lead (`workboardToday`), and the customs board's header
    // names who leads each model's customs by them (`customOrdersBoard`, services/custom-orders/leaders.ts): the reads
    // whose answers change with them by design.
    const RECORDS = new Set(["teamRoles", "workboardToday", "customOrdersBoard"]);
    for (const read of reads.filter((one) => !RECORDS.has(one.key) && !unstable.has(one.url))) {
      const response = await get(read.url, "olga");
      const after = `${response.statusCode} ${JSON.stringify(normalize(safeJson(response.body)))}`;
      if (ownerBefore.get(read.url) !== after) {
        ownerChanged.push(`${read.key} at ${answerDiff(ownerBefore.get(read.url) ?? "", after).join(", ")}`);
      }
    }
    expect(ownerChanged, ownerChanged.join("; ")).toEqual([]);
    // Only these may move by themselves between two of the owner's reads, by name: the live operations' minute
    // («Сейчас»), the OnlyFans API credits and spend counted to the second, and an observation payload read by a fresh
    // id. Every team read is among the proven ones.
    const MOVING = new Set(["opsLive", "adminOfapiCreditsSummary", "adminOfapiSpendComparison", "agentObservationPayload"]);
    const moved = reads.filter((read) => unstable.has(read.url) && !MOVING.has(read.key))
      .map((read) => `${read.key} at ${answerDiff(ownerFirst.get(read.url) ?? "", ownerBefore.get(read.url) ?? "").join(", ")}`);
    expect(moved, moved.join("; ")).toEqual([]);
  }, 600_000);

  it("the team reads open for team A: both see its shifts, the lead opens a teammate's review, a chatter reads the team's people", async (context) => {
    if (!server || !testDb) return context.skip();
    const window = `from=${encodeURIComponent(new Date(today.getTime() - 2 * DAY_MS).toISOString())}&to=${encodeURIComponent(today.toISOString())}`;
    for (const who of ["anna", "lena"]) {
      const shifts = await get(`/api/v1/team/shifts?${window}`, who);
      expect(shifts.statusCode, shifts.body).toBe(200);
      const userIds = new Set((shifts.json() as { shifts: Array<{ userId: number }> }).shifts.map((shift) => shift.userId));
      expect([...userIds].sort(), shifts.body.slice(0, 600)).toEqual([ids.chatterA, ids.leadA].sort());
    }
    const review = await get(`/api/v1/team/shift-review?userId=${ids.chatterA}&at=${encodeURIComponent(new Date(shiftStart + 60 * 60_000).toISOString())}`, "lena");
    expect(review.statusCode, review.body).toBe(200);
    const people = await get("/api/v1/team/people", "anna");
    expect(people.statusCode).toBe(200);
    expect((people.json() as { people: Array<{ code: string }> }).people.map((one) => one.code).sort()).toEqual(["anna-a", "lena-a"]);
    const me = await get("/api/v1/auth/me", "lena");
    expect((me.json() as { teams?: { lead: number[] } }).teams?.lead).toEqual([ids.modelA]);
  });

  it("the lead grants «видит команду» on team A only; the chatter cannot grant", async (context) => {
    if (!server || !testDb) return context.skip();
    const grant = (who: string, modelId: number) => server!.inject({
      method: "POST", url: "/api/v1/team/roles", headers: { cookie: cookies[who]!, "content-type": "application/json" },
      payload: { personCode: "boris-b", modelId, kind: "view", granted: true },
    });
    expect((await grant("anna", ids.modelA)).statusCode).toBe(403);
    expect((await grant("lena", ids.modelB)).statusCode).toBe(403);
    const ok = await grant("lena", ids.modelA);
    expect(ok.statusCode, ok.body).toBe(200);
    const lead = await server.inject({
      method: "POST", url: "/api/v1/team/roles", headers: { cookie: cookies.lena!, "content-type": "application/json" },
      payload: { personCode: "anna-a", modelId: ids.modelA, kind: "lead", granted: true },
    });
    expect(lead.statusCode).toBe(403);
    await testDb.pool.query("update team_roles set revoked_at = now() where kind = 'view'");
  });
  it("a shift review's notes name no shift of another team: «no shift» to a chatter and a lead, the shift to the owner", async (context) => {
    if (!server || !testDb) return context.skip();
    const at = encodeURIComponent(new Date(shiftStart + 60 * 60_000).toISOString());
    const notes = async (userId: number, who: string) => {
      const response = await get(`/api/v1/team/review-notes?userId=${userId}&at=${at}`, who);
      expect(response.statusCode, response.body).toBe(200);
      return (response.json() as { shiftId: number | null }).shiftId;
    };
    // The probe: was Boris (team B) on shift at that time? Nobody of team A may learn it, by reading or by writing.
    expect(await notes(ids.chatterB, "anna")).toBeNull();
    expect(await notes(ids.chatterB, "lena")).toBeNull();
    const write = await server.inject({
      method: "POST", url: "/api/v1/team/review-notes", headers: { cookie: cookies.lena! },
      payload: { userId: ids.chatterB, at: new Date(shiftStart + 60 * 60_000).toISOString(), text: "probe" },
    });
    expect(write.statusCode, write.body).toBe(404);
    // The team's own shifts and the owner's every shift stay as they were.
    expect(await notes(ids.chatterA, "anna")).not.toBeNull();
    expect(await notes(ids.chatterA, "lena")).not.toBeNull();
    expect(await notes(ids.chatterB, "olga")).not.toBeNull();
  });

  it("«видит команду» of another model opens its custom orders to read, never to write", async (context) => {
    if (!server || !testDb) return context.skip();
    // Anna works team A and is given «видит команду» of team B: she reads B's board, she works none of it.
    const anna = (await testDb.pool.query<{ id: string }>("select id from people where code = 'anna-a'")).rows[0]!.id;
    await testDb.pool.query("insert into team_roles (person_id, model_id, kind) values ($1, $2, 'view')", [anna, ids.modelB]);
    const id = await recordCustomOrder(createTestAppContext(testDb), {
      pageId: ids.pageB, fanId: null, buyer: "buyer_b", conversationRef: null, card: { task: "Заказ команды B" }, deadlineOn: null,
      acceptedByUserId: ids.chatterB, origin: "workboard", state: "shot", actor: { door: "system" },
    });
    const code = `K-${id}`;
    const send = (method: "GET" | "POST", url: string, payload?: object) =>
      server!.inject({ method, url, headers: { cookie: cookies.anna!, ...(payload ? { "content-type": "application/json" } : {}) }, ...(payload ? { payload } : {}) });
    try {
      const board = await send("GET", "/api/v1/custom-orders");
      expect(board.statusCode, board.body).toBe(200);
      expect((board.json() as { orders: Array<{ code: string }> }).orders.map((one) => one.code)).toContain(code);
      const detail = await send("GET", `/api/v1/custom-orders/${code}`);
      expect(detail.statusCode, detail.body).toBe(200);
      expect((detail.json() as { actions: string[] }).actions).toEqual([]);
      for (const body of [{ action: "given" }, { action: "payment", transactionRef: String(ids.transactionB || 1) }]) {
        const refused = await send("POST", `/api/v1/custom-orders/${code}`, body);
        expect(refused.statusCode, `${body.action}: ${refused.body}`).toBe(409);
        expect(refused.json()).toMatchObject({ reason: "not_allowed" });
      }
      const recorded = await send("POST", "/api/v1/custom-orders", { pageLabel: "bravo-1", card: { task: "чужая страница" } });
      expect([403, 404], recorded.body).toContain(recorded.statusCode);
      // Her own team's page: she records there as before.
      const own = await send("POST", "/api/v1/custom-orders", { pageLabel: "alfa-1", card: { task: "своя страница" } });
      expect(own.statusCode, own.body).toBe(200);
    } finally {
      await testDb.pool.query("update team_roles set revoked_at = now() where person_id = $1 and model_id = $2 and kind = 'view'", [anna, ids.modelB]);
    }
  });
});

/** Where two answers («<status> <json>») differ: the JSON paths, each with both values, at most five. */
function answerDiff(left: string, right: string): string[] {
  const split = (answer: string) => [answer.slice(0, 3), safeJson(answer.slice(4))] as const;
  const [leftStatus, leftBody] = split(left);
  const [rightStatus, rightBody] = split(right);
  if (leftStatus !== rightStatus) return [`status ${leftStatus} → ${rightStatus}`];
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, path: string) => {
    if (out.length >= 5) return;
    if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
      for (const key of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) {
        walk((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], Array.isArray(a) ? `${path}[${key}]` : `${path}.${key}`);
      }
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path || "$"} ${JSON.stringify(a)?.slice(0, 80)} → ${JSON.stringify(b)?.slice(0, 80)}`);
  };
  walk(leftBody, rightBody, "");
  return out;
}

function safeJson(body: string): unknown {
  try { return JSON.parse(body); } catch { return body; }
}
