import { afterAll, beforeAll, describe, expect, it } from "vitest";
import argon2 from "argon2";

import { publicationContentSchema, routeSchemas } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, createOnlyFansPage, insertPersonLogin, insertPersonRow, type Database } from "@agency_hub_core/db";

import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { createUserAccount, type HumanAuthPrincipal } from "../apps/runtime/src/services/auth.ts";
import { recordCustomOrder } from "../apps/runtime/src/services/custom-orders/index.ts";
import { createPublicationDraft } from "../apps/runtime/src/services/publications.ts";
import { absentValue, fieldObject, type RealmObjectKind } from "../apps/runtime/src/services/sandbox/objects.ts";
import { SANDBOX_OWNER_OPERATIONS } from "../apps/runtime/src/services/sandbox/owner-operations.ts";
import { seedSandbox } from "../apps/runtime/src/services/sandbox/seed.ts";
import { refreshSaleHomes } from "../apps/runtime/src/services/sale-homes.ts";
import { handinActorOf } from "../apps/runtime/src/services/shift-handins.ts";
import { confirmShiftReport, handInShiftReport, runShiftReportBoardPass } from "../apps/runtime/src/services/shift-report-board.ts";
import { syncShiftRowsSince } from "../apps/runtime/src/services/shift-rows.ts";
import { askTeamQuestion } from "../apps/runtime/src/services/team-questions.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// The wall by object (services/sandbox/objects.ts), proven on the contract itself and GENERATED from it: both realms
// hold an object of every kind a request can name (a page, a model, a login, a person, a shift, a sale, a claim, a
// report's candidate and proposal, a «мимо площадки» line, a sighting, a question, an order, a publication). Then every
// operation is called with every field the wall classifies — optional parameters and body fields included — set to an
// object of the OTHER realm:
//   - as the test owner, every operation of its table (SANDBOX_OWNER_OPERATIONS);
//   - as the test team lead and a test chatter, every operation their role may call by its declaration;
//   - as the live owner, every operation, with test objects.
// The answer must be EXACTLY the answer to the same request naming an object that does not exist (a GET's status and
// body, clock fields aside; a write's status), and never a 5xx: nothing tells «there, but of the other realm» from «not
// there». The ordinary use (every field naming an object of the caller's own realm) is proven by the routes' own tests.

const DAY = 86_400_000;
const HOUR = 3_600_000;
const OWNER_PASSWORD = "owner-secret-1";
const SANDBOX_PASSWORDS = {
  SANDBOX_PASSWORD_T_OWNER: "sandbox-owner-1",
  SANDBOX_PASSWORD_T_LEAD: "sandbox-lead-1",
  SANDBOX_PASSWORD_T_CHAT_1: "sandbox-chat-1",
  SANDBOX_PASSWORD_T_CHAT_2: "sandbox-chat-2",
};
const CLOCK_KEYS = new Set(["serverNow", "generatedAt", "now", "asOf", "computedAt", "checkedAt", "fetchedAt", "readAt", "requestId", "savedAt"]);
const HUMAN_KINDS = new Set(["any", "any-session", "session"]);
/**
 * POST operations whose success on a value that names nothing changes nothing: a read, and a batch over sales that
 * keeps the ones that exist (a missing sale is nothing kept, no row written).
 */
const POST_READS = new Set(["spenderBatch", "saleNobodyKeep"]);

type Server = Awaited<ReturnType<typeof buildApiServer>>;
type Zod = { _zod: { def: Record<string, unknown> & { type: string } } };
type RouteSchema = { auth?: { kind: string }; params?: Zod; querystring?: Zod; body?: Zod };
type Row = Record<string, unknown>;

let testDb: StartedTestDatabase | null = null;
let server: Server | null = null;
const cookies: Record<string, string> = {};
/** One object of each kind per realm, as a request names it. */
const objects = {} as Record<RealmObjectKind, { live: string; test: string }>;
const now = new Date();

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

const dayOf = (at: number) => new Date(at + 3 * HOUR).toISOString().slice(0, 10);

/** A value the schema accepts for a field that names nothing of a realm. */
function plainValue(name: string, schema: Zod): unknown {
  const def = schema._zod.def;
  const pattern = ((def.checks ?? []) as Zod[]).map((check) => String((check._zod.def as { pattern?: RegExp }).pattern?.source ?? "")).join(" ");
  if (def.type === "enum") return Object.values(def.entries as Record<string, string>)[0];
  if (def.type === "literal") return (def.values as unknown[])[0];
  if (def.type === "boolean") return false;
  if (def.type === "array") return [];
  if (def.type === "union") return plainValue(name, unwrap((def.options as Zod[])[0]!).schema);
  if (def.type === "number") return 1;
  if (def.type === "object") return sample(schema, null) ?? {};
  if (def.type !== "string") return undefined;
  if (def.format === "uuid" || pattern.includes("[0-9a-fA-F]{8}")) return "00000000-0000-0000-0000-000000000000";
  if (def.format === "date" || pattern.startsWith("^\\d{4}-\\d{2}-\\d{2}$")) return name === "to" ? dayOf(now.getTime()) : dayOf(now.getTime() - 2 * DAY);
  if (def.format === "datetime" || pattern.includes("T\\d{2}")) return name === "to" ? new Date(now.getTime() + 2 * HOUR).toISOString() : new Date(now.getTime() - 2 * DAY).toISOString();
  if (pattern.includes("(0[1-9]|1[0-2])")) return dayOf(now.getTime()).slice(0, 7);
  if (pattern.includes("[1-9]")) return "1";
  return "x";
}

/** The required fields of a shape, plus the one field under test (optional or not) set to `target`. */
function sample(schema: Zod | undefined, target: { field: string; value: string } | null): Record<string, unknown> | undefined {
  if (!schema) return undefined;
  let { schema: object } = unwrap(schema);
  if (object._zod.def.type === "union") object = unwrap((object._zod.def.options as Zod[])[0]!).schema;
  if (object._zod.def.type !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(object._zod.def.shape as Record<string, Zod>)) {
    const { schema: inner, optional } = unwrap(field);
    if (target !== null && name === target.field) {
      const asNumber = (inner._zod.def.type === "array" ? unwrap(inner._zod.def.element as Zod).schema : inner)._zod.def.type === "number";
      const value = asNumber ? Number(target.value) : target.value;
      out[name] = inner._zod.def.type === "array" ? [value] : value;
      continue;
    }
    if (optional) continue;
    const value = plainValue(name, inner);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function fieldsOf(schema: Zod | undefined): string[] {
  if (!schema) return [];
  let { schema: object } = unwrap(schema);
  if (object._zod.def.type === "union") object = unwrap((object._zod.def.options as Zod[])[0]!).schema;
  return object._zod.def.type === "object" ? Object.keys(object._zod.def.shape as Record<string, Zod>) : [];
}

interface Probe { key: string; method: string; url: string; body?: Record<string, unknown>; field: string; kind: RealmObjectKind }

/**
 * Every operation's every classified field, as two requests: naming `realm`'s object of its kind, and naming nothing
 * (the value no object has).
 */
function probes(table: Server["routePolicyTable"], realm: "live" | "test", open: (key: string, auth: string) => boolean): Array<[Probe, Probe]> {
  const out: Array<[Probe, Probe]> = [];
  for (const row of table) {
    if (!row.url.startsWith("/api/")) continue;
    const schema = (routeSchemas as unknown as Record<string, RouteSchema>)[row.routeKey];
    if (!schema || !open(row.routeKey, schema.auth?.kind ?? "")) continue;
    for (const [where, part] of [["params", schema.params], ["query", schema.querystring], ["body", schema.body]] as const) {
      for (const field of fieldsOf(part)) {
        const kind = fieldObject(row.routeKey, field);
        if (kind === undefined || kind === "none" || kind === "nested") continue;
        const build = (value: string): Probe => {
          const target = { field, value };
          const params = sample(schema.params, where === "params" ? target : null) ?? {};
          let url = row.url.replace(/:([A-Za-z]+)/g, (_, name: string) => encodeURIComponent(String(params[name] ?? "1")));
          const query = sample(schema.querystring, where === "query" ? target : null);
          if (query && Object.keys(query).length > 0) {
            url += `?${new URLSearchParams(Object.entries(query).flatMap(([key, one]) =>
              (Array.isArray(one) ? one : [one]).map((item) => [key, String(item)]))).toString()}`;
          }
          const body = row.method === "GET" ? undefined : sample(schema.body, where === "body" ? target : null) ?? {};
          return { key: row.routeKey, method: row.method, url, ...(body === undefined ? {} : { body }), field: `${where}.${field}`, kind };
        };
        out.push([build(objects[kind][realm]), build(String(absentValue(kind, objects[kind][realm])))]);
      }
    }
  }
  return out;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !CLOCK_KEYS.has(key)).map(([key, inner]) => [key, normalize(inner)]));
  }
  return value;
}

async function call(probe: Probe, cookie: string) {
  return server!.inject({
    method: probe.method as "GET",
    url: probe.url,
    headers: { cookie, ...(probe.body === undefined ? {} : { "content-type": "application/json" }) },
    ...(probe.body === undefined ? {} : { payload: probe.body }),
  });
}

async function login(username: string, password: string) {
  const response = await server!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password } });
  expect(response.statusCode, `${username}: ${response.body}`).toBe(200);
  const header = response.headers["set-cookie"];
  return String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
}

function principalOf(user: { id: number; username: string; role: string }, pageIds: number[], test: boolean): HumanAuthPrincipal {
  return {
    authMethod: "session",
    user: { id: user.id, username: user.username, role: user.role, assignedPages: [], mustChangePassword: false },
    assignedPageIds: pageIds,
    ...(test ? { sandbox: { test: true, testPageIds: pageIds, livePageIds: null } } : {}),
  } as unknown as HumanAuthPrincipal;
}

async function one(db: Database, query: ReturnType<typeof sql>): Promise<string> {
  const [row] = (await db.execute<Row>(query)).rows;
  if (row === undefined) throw new Error("fixture: no row");
  return String(Object.values(row)[0]);
}

/** A closed shift of the login handed in on the board, past the check, confirmed. */
async function countReport(app: ReturnType<typeof createTestAppContext>, principal: HumanAuthPrincipal) {
  const db = app.db as Database;
  const shiftId = Number(await one(db, sql`select id from shifts where user_id = ${principal.user.id} and state = 'closed' order by id limit 1`));
  const actor = handinActorOf(principal);
  await handInShiftReport(app, actor, { shiftId }, now);
  await runShiftReportBoardPass(app, new Date(now.getTime() + 11 * 60_000));
  const candidateId = Number(await one(db, sql`select c.id from shift_handin_candidates c join shift_handins h on h.id = c.handin_id
    where h.shift_id = ${shiftId} order by c.id desc limit 1`));
  await confirmShiftReport(app, actor, { shiftId, candidateId }, { now: new Date(now.getTime() + 12 * 60_000), dayPaid: async () => null });
  return shiftId;
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  const app = createTestAppContext(testDb);
  const db = app.db as Database;

  // The live agency: an owner, a model with two pages, a chatter who worked yesterday with sales.
  const owner = await createUserAccount(app, { username: "dima", role: "owner", password: OWNER_PASSWORD }, { source: "cli" });
  const ownerPerson = await insertPersonRow(db, {
    code: "dima", displayName: "Owner", kind: "human", role: "owner", state: "working", leftOn: null, telegramUserId: null,
    telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
  });
  await insertPersonLogin(db, { personId: ownerPerson.id, userId: owner.id, linkedByUserId: null });
  const model = await createModel(db, { slug: "lana", name: "Lana" });
  const page = await createFanslyPage(db, { modelId: model.id, label: "live-1" });
  const liveOnlyfans = await createOnlyFansPage(db, { modelId: model.id, label: "live-of" });
  const chatter = await createUserAccount(app, { username: "anton", role: "chatter" }, { source: "cli" });
  await db.execute(sql`update users set password_hash = ${await argon2.hash("chatter-secret-1", { type: argon2.argon2id })} where id = ${chatter.id}`);
  const person = await insertPersonRow(db, {
    code: "live-chatter", displayName: "Anton", kind: "human", role: "chatter", state: "working", leftOn: null, telegramUserId: null,
    telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
  });
  await insertPersonLogin(db, { personId: person.id, userId: chatter.id, linkedByUserId: null });
  await db.execute(sql`insert into user_page_assignments (user_id, platform_account_id) values (${chatter.id}, ${page.id})`);
  await db.execute(sql`insert into person_working_pages (person_id, page_id, position) values (${person.id}, ${page.id}, 0)`);
  await db.execute(sql`insert into person_rights (person_id, "right", granted_at) values (${person.id}, 'submits_shift', ${new Date(now.getTime() - 30 * DAY).toISOString()}::timestamptz)`);
  const start = now.getTime() - DAY - 4 * HOUR;
  await db.execute(sql`insert into chatter_activity_minutes (user_id, page_id, minute, input)
    select ${chatter.id}, ${page.id}, m, true from generate_series(date_trunc('minute', ${new Date(start).toISOString()}::timestamptz),
      date_trunc('minute', ${new Date(start + 3 * HOUR).toISOString()}::timestamptz), interval '1 minute') m`);
  const fanId = await one(db, sql`insert into fans (platform, platform_user_id, username) values ('fansly', '100000000000000001', 'live_fan') returning id`);
  await db.execute(sql`insert into page_fans (fan_id, platform_account_id) values (${fanId}, ${page.id})`);
  for (let index = 0; index < 70; index += 1) {
    await db.execute(sql`insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, conversation_ref, user_id,
      source, priced, with_media, observed_at) values ('fansly', ${page.id}, ${String(500000 + index)}, '100000000000000001',
      '100000000000000001', ${chatter.id}, 'fansly-extension', false, false, ${new Date(start + (index + 1) * 2 * 60_000).toISOString()}::timestamptz)`);
  }
  await db.execute(sql`insert into transactions (platform_account_id, fan_id, transaction_id, raw_type, canonical_type, transaction_state,
    raw_status, gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, is_active)
    values (${page.id}, ${fanId}, 'live-tip', 'tip', 'tip'::transaction_type, 'posted', 'posted', 20000, 20000, 16000,
      ${new Date(start + HOUR).toISOString()}::timestamptz, 'fansly:rest', true)`);
  await recordCustomOrder(app, {
    pageId: page.id, fanId: Number(fanId), buyer: null, conversationRef: null, card: { task: "Live order" }, deadlineOn: dayOf(now.getTime() + 5 * DAY),
    acceptedByUserId: chatter.id, origin: "workboard", state: "paid", actor: { door: "workboard", userId: chatter.id }, now: new Date(now.getTime() - 2 * DAY),
    createdAt: new Date(now.getTime() - 2 * DAY),
  });
  // On the OnlyFans page: a Fansly subscriber post needs a file of its own, an OnlyFans one may be text alone.
  await createPublicationDraft(db, {
    pageId: liveOnlyfans.id, author: { kind: "human", userId: owner.id }, idempotencyKey: null, now,
    body: publicationContentSchema.parse({ kind: "subscriber_post", text: "Live post", media: [], publishAt: new Date(now.getTime() + 2 * DAY).toISOString() }),
  });

  // The test team: every scenario, on the same clock.
  await seedSandbox(app, { scenarios: ["shift", "customs", "matters", "publications"], env: SANDBOX_PASSWORDS, now: new Date(now.getTime() - 12 * HOUR), printCheckerKey: true });
  await db.execute(sql`insert into person_rights (person_id, "right", granted_at)
    select id, 'submits_shift', ${new Date(now.getTime() - 30 * DAY).toISOString()}::timestamptz from people where is_test and role = 'chatter'
    on conflict do nothing`);
  await syncShiftRowsSince(db, { from: new Date(now.getTime() - 3 * DAY), now: new Date(now.getTime() - 60_000) });
  await refreshSaleHomes(db, { from: new Date(now.getTime() - 3 * DAY), to: new Date(now.getTime() - 60_000), now: new Date(now.getTime() - 60_000) });

  const testPages = (await db.execute<{ id: string }>(sql`select p.id from pages p join models m on m.id = p.model_id where m.is_test order by p.id`)).rows.map((row) => Number(row.id));
  const tChat2 = await one(db, sql`select id from users where username = 't-chat-2'`);
  const tChat1 = await one(db, sql`select id from users where username = 't-chat-1'`);
  // Both realms hand a report in and have it counted; both ask a question.
  const liveShift = await countReport(app, principalOf({ id: chatter.id, username: "anton", role: "chatter" }, [page.id], false));
  const testShift = await countReport(app, principalOf({ id: Number(tChat2), username: "t-chat-2", role: "chatter" }, testPages, true));
  const liveQuestion = (await askTeamQuestion(app, principalOf({ id: chatter.id, username: "anton", role: "chatter" }, [page.id], false),
    { pageLabel: "live-1", kind: "custom_price", text: "Сколько за кастом?", door: "workboard" }, now)).question.id;
  const testQuestion = (await askTeamQuestion(app, principalOf({ id: Number(tChat1), username: "t-chat-1", role: "chatter" }, testPages, true),
    { pageLabel: "test-1", kind: "custom_price", text: "Сколько за кастом?", door: "workboard" }, now)).question.id;

  // The rows the board and the owner's word name, one per realm: a claim, a proposal, a «мимо площадки» line, a sighting.
  const keyId = await one(db, sql`select id from agent_keys order by id limit 1`);
  const realmRows = async (realm: "live" | "test", shiftId: number) => {
    const handin = await one(db, sql`select id from shift_handins where shift_id = ${shiftId}`);
    const user = await one(db, sql`select user_id from shift_handins where id = ${handin}`);
    const candidate = await one(db, sql`select id from shift_handin_candidates where handin_id = ${handin} order by id desc limit 1`);
    const pages = realm === "live" ? [page.id] : testPages;
    // A sale of the realm nobody claimed yet (one open claim per sale).
    const sale = await one(db, sql`select t.id from transactions t where t.platform_account_id = any(${sql.param(pages)}::bigint[])
      and not exists (select 1 from sale_claims c where c.transaction_id = t.id) order by t.id limit 1`);
    const pageId = await one(db, sql`select platform_account_id from transactions where id = ${sale}`);
    const claim = await one(db, sql`insert into sale_claims (transaction_id, page_id, kind, claimed_at, state, escalated_why, escalated_at)
      values (${sale}, ${pageId}, 'imported', now(), 'owner', 'imported', now()) returning id`);
    const proposal = await one(db, sql`insert into shift_handin_proposals (candidate_id, handin_id, transaction_id, kind, note, why, agent_key_id)
      values (${candidate}, ${handin}, ${sale}, 'note', 'заметка', 'проверка', ${keyId}) returning id`);
    const line = await one(db, sql`insert into off_platform_sales (handin_id, user_id, amount_mills, from_whom, what_for)
      values (${handin}, ${user}, 10000, 'фан', 'кастом') returning id`);
    const sighting = await one(db, sql`insert into sale_sightings (page_id, platform_ref, kind, occurred_at, net_mills)
      values (${pageId}, ${`sighting-${realm}`}, 'tip', now() - interval '1 day', 5000) returning id`);
    return { handin, candidate, sale, claim, proposal, line, sighting, user };
  };
  const liveRows = await realmRows("live", liveShift);
  const testRows = await realmRows("test", testShift);
  const pick = async (query: (test: boolean) => ReturnType<typeof sql>) => ({ live: await one(db, query(false)), test: await one(db, query(true)) });
  Object.assign(objects, {
    page: { live: String(page.id), test: String(testPages[0]) },
    pageLabel: { live: "live-1", test: "test-1" },
    model: await pick((test) => sql`select id from models where is_test = ${test} order by id limit 1`),
    modelSlug: await pick((test) => sql`select slug from models where is_test = ${test} order by id limit 1`),
    login: { live: String(chatter.id), test: tChat1 },
    personCode: { live: "live-chatter", test: "t-chat-1" },
    shift: { live: String(liveShift), test: String(testShift) },
    sale: { live: liveRows.sale, test: testRows.sale },
    claim: { live: liveRows.claim, test: testRows.claim },
    offPlatformLine: { live: liveRows.line, test: testRows.line },
    candidate: { live: liveRows.candidate, test: testRows.candidate },
    proposal: { live: liveRows.proposal, test: testRows.proposal },
    sighting: { live: liveRows.sighting, test: testRows.sighting },
    question: { live: String(liveQuestion), test: String(testQuestion) },
    order: await pick((test) => sql`select 'K-' || o.id from custom_orders o join pages p on p.id = o.page_id join models m on m.id = p.model_id
      where m.is_test = ${test} order by o.id limit 1`),
    publication: await pick((test) => sql`select pu.id from publications pu join pages p on p.id = pu.page_id join models m on m.id = p.model_id
      where m.is_test = ${test} order by pu.id limit 1`),
  } satisfies Record<RealmObjectKind, { live: string; test: string }>);

  server = await buildApiServer(createTestAppContext(testDb));
  cookies.dima = await login("dima", OWNER_PASSWORD);
  cookies["t-owner"] = await login("t-owner", SANDBOX_PASSWORDS.SANDBOX_PASSWORD_T_OWNER);
  cookies["t-lead"] = await login("t-lead", SANDBOX_PASSWORDS.SANDBOX_PASSWORD_T_LEAD);
  cookies["t-chat-1"] = await login("t-chat-1", SANDBOX_PASSWORDS.SANDBOX_PASSWORD_T_CHAT_1);
}, 600_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

/** The probes whose answer differs from the answer for a missing object (or is a 5xx): the holes of the wall. */
async function holes(viewer: string, list: ReadonlyArray<[Probe, Probe]>): Promise<string[]> {
  const out: string[] = [];
  const answer = async (probe: Probe) => {
    const response = await call(probe, cookies[viewer]!);
    let body: unknown = response.body;
    try { body = normalize(JSON.parse(response.body)); } catch { /* not JSON */ }
    return { status: response.statusCode, text: probe.method === "GET" ? `${response.statusCode} ${JSON.stringify(body)}` : String(response.statusCode) };
  };
  for (const [named, missing] of list) {
    // The missing object first: a write that created something must not make the second answer differ.
    const absent = await answer(missing);
    const other = await answer(named);
    if (other.status >= 500 || other.text !== absent.text) {
      out.push(`${viewer} ${named.key} ${named.field}=${named.kind}: ${other.text.slice(0, 200)} ≠ missing ${absent.text.slice(0, 120)}`);
    }
    // A write never succeeds on a hidden object: the value that names nothing is refused by the service as unknown,
    // never created or bound under it (a field naming the object an operation CREATES is `none` in objects.ts).
    if (named.method !== "GET" && !POST_READS.has(named.key) && other.status < 300) {
      out.push(`${viewer} ${named.key} ${named.field}=${named.kind}: a write succeeded on a hidden object (${other.status})`);
    }
  }
  return out;
}

describe("the wall by object, generated from the contract", () => {
  it("the cases found on production: a live dispute by its claim, a live chatter's reports by the login, are answered as missing to the test owner", async (context) => {
    if (!server) return context.skip();
    const get = (url: string) => server!.inject({ method: "GET", url, headers: { cookie: cookies["t-owner"]! } });
    const claim = await get(`/api/v1/sale-disputes/claim/${objects.claim.live}`);
    expect(claim.statusCode, claim.body).toBe(404);
    expect(claim.body).toBe((await get(`/api/v1/sale-disputes/claim/${Number.MAX_SAFE_INTEGER}`)).body);
    const decide = await server.inject({
      method: "POST", url: "/api/v1/sale-disputes/decide", headers: { cookie: cookies["t-owner"]!, "content-type": "application/json" },
      payload: { claimId: Number(objects.claim.live), outcome: "rule" },
    });
    expect(decide.statusCode, decide.body).toBeGreaterThanOrEqual(400);
    expect(decide.statusCode).toBeLessThan(500);
    const decisions = await testDb!.pool.query("select count(*)::int as n from sale_owner_decisions where transaction_id = $1", [objects.sale.live]);
    expect(decisions.rows[0]!.n).toBe(0);
    const window = `from=${dayOf(now.getTime() - 5 * DAY)}&to=${dayOf(now.getTime())}`;
    const reports = await get(`/api/v1/shift-reports?${window}&userId=${objects.login.live}`);
    expect(reports.body).toBe((await get(`/api/v1/shift-reports?${window}&userId=${Number.MAX_SAFE_INTEGER}`)).body);
    expect(reports.body).not.toContain(`"shiftId":${objects.shift.live}`);
    // The test chatter's reports by the login stay open to the test owner.
    const own = await get(`/api/v1/shift-reports?${window}&userId=${objects.login.test}`);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.body).toContain(`${objects.shift.test}`);
  });

  it("the test owner, the test lead and a test chatter: every field naming a live object is refused", async (context) => {
    if (!server) return context.skip();
    const table = server.routePolicyTable;
    const found = [
      ...await holes("t-owner", probes(table, "live", (key) => SANDBOX_OWNER_OPERATIONS.has(key))),
      ...await holes("t-lead", probes(table, "live", (_key, auth) => HUMAN_KINDS.has(auth))),
      ...await holes("t-chat-1", probes(table, "live", (_key, auth) => HUMAN_KINDS.has(auth))),
    ];
    expect(probes(table, "live", (key) => SANDBOX_OWNER_OPERATIONS.has(key)).length).toBeGreaterThan(40);
    expect(found).toEqual([]);
  }, 600_000);

  it("the live owner: every field naming a test object is refused", async (context) => {
    if (!server) return context.skip();
    const list = probes(server.routePolicyTable, "test", (_key, auth) => auth === "owner-session" || HUMAN_KINDS.has(auth));
    expect(list.length).toBeGreaterThan(100);
    expect(await holes("dima", list)).toEqual([]);
  }, 600_000);

  it("the test owner invites a test chatter with a test page and a test team lead leading the test model; a live page or model is refused", async (context) => {
    if (!server) return context.skip();
    const create = (payload: object) => server!.inject({
      method: "POST", url: "/api/v1/admin/people", headers: { cookie: cookies["t-owner"]!, "content-type": "application/json" }, payload,
    });
    const chatter = await create({
      code: "t-new-chatter", displayName: "Тест: новый чаттер", role: "chatter", state: "invited", workingPageLabels: ["test-1"],
      invite: { username: "t-new-chatter", role: "chatter", pageLabels: ["test-1"], expiresInHours: 72 },
    });
    expect(chatter.statusCode, chatter.body).toBe(200);
    const lead = await create({
      code: "t-new-lead", displayName: "Тест: новый тимлид", role: "team_lead", state: "invited", workingPageLabels: ["test-1"],
      leadModelSlugs: [objects.modelSlug.test], invite: { username: "t-new-lead", role: "team_lead", pageLabels: ["test-1"], expiresInHours: 72 },
    });
    expect(lead.statusCode, lead.body).toBe(200);
    const born = await testDb!.pool.query("select code, is_test from people where code in ('t-new-chatter', 't-new-lead') order by code");
    expect(born.rows).toEqual([{ code: "t-new-chatter", is_test: true }, { code: "t-new-lead", is_test: true }]);
    const leads = await testDb!.pool.query(`select count(*)::int as n from team_roles r join people p on p.id = r.person_id
      where p.code = 't-new-lead' and r.kind = 'lead' and r.revoked_at is null`);
    expect(leads.rows[0]!.n).toBe(1);
    expect((await create({ code: "t-x1", displayName: "x", role: "chatter", state: "invited", workingPageLabels: ["live-1"] })).statusCode).toBe(404);
    expect((await create({ code: "t-x2", displayName: "x", role: "team_lead", state: "invited", leadModelSlugs: [objects.modelSlug.live] })).statusCode).toBe(404);
  });
});
