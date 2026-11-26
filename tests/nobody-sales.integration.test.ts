import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { saleNobodyResponseSchema, shiftReportResponseSchema, type AdminPersonCreateBody } from "@agency_hub_core/contracts";
import {
  assignUserToPage, createFanslyPage, createModel, ensureHandin, findHandinPersonOfUser, insertAgentKey, openMatter, setHandinMark, syncShiftRows,
} from "@agency_hub_core/db";
import { moscowDayOfMs, sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { createPerson } from "../apps/runtime/src/services/people/index.ts";
import { cancelSaleDecisionApplied, runSaleClaims } from "../apps/runtime/src/services/sale-claims.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { editingSession, handInAndConfirm } from "./helpers/shift-report-hand-in.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Wave 2 PR H8: nobody's sales are hidden from chatters and team leads across all 4 reads (before LIMIT/OFFSET);
// «Моё» on a nobody sale is the person's word and counts the whole net at once, no owner claim and no owner's weekly
// line (owner, 2026-11-26); another person's report holding it makes it a claim with that colleague, never paid to
// both; «Добавить продажу» matches strictly 1 sale within caller's granted pages and realm with byte-identical refusal on
// 0 / >1 / outside-grant / cross-realm; owner sees ALL open nobody sales regardless of week close with live solo-page
// suggestion; «Отдать <имя>» delivers to open draft, submitted report (system version), or next shift (cancel before
// next shift leaves nothing). Synthetic names, pages, fans and amounts only.

/** The newest handed-in version's line of a sale in a shift's report; undefined — none holds it. */
async function newestLine(shiftId: number, transactionId: number): Promise<{ amountMills: number; disputed: boolean } | undefined> {
  const row = await testDb!.pool.query<{ lines: Array<{ transactionId: number | null; amountMills: number; disputed: boolean }> }>(
    `select v.lines from shift_handins h join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version
     where h.shift_id = $1`,
    [shiftId],
  );
  return row.rows[0]?.lines.find((line) => line.transactionId === transactionId);
}

/** The sale's claims, oldest first. */
async function claimsOf(transactionId: number) {
  return (await testDb!.pool.query(
    "select claimant_user_id::int as claimant, side_user_id::int as side, state, escalated_why from sale_claims where transaction_id = $1 order by id",
    [transactionId],
  )).rows as Array<{ claimant: number; side: number | null; state: string; escalated_why: string | null }>;
}

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const AUDIT = { source: "cli" } as const;
const AGENT_KEY = `${AGENT_KEY_TOKEN_PREFIX}h8-nobody-sales-key`;
const ANNA_TG = 700_000_811;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
const users: Record<string, number> = {};
let soloPage = 0;
let sharedPage = 0;
let otherPage = 0;
let testPage = 0;
let fanAlpha = 0;
let fanBeta = 0;
let fanOther = 0;
let fanTest = 0;

const rawSession = (who: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });
const asSession = editingSession(rawSession);
const asAgent = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { authorization: `Bearer ${AGENT_KEY}` }, ...(payload ? { payload } : {}) });

async function insertFan(pageId: number, ref: string, username: string, displayName: string): Promise<number> {
  const row = await testDb!.pool.query<{ id: string }>(
    `insert into fans (platform, platform_user_id, username, display_name)
     values ('fansly', $1, $2, $3) returning id`,
    [ref, username, displayName],
  );
  const fanId = Number(row.rows[0]!.id);
  await testDb!.pool.query(
    `insert into page_fans (fan_id, platform_account_id, is_subscriber)
     values ($1, $2, true)`,
    [fanId, pageId],
  );
  return fanId;
}

async function insertSale(input: {
  pageId: number;
  fanId: number;
  ref: string;
  netMills: number;
  occurredAt: string;
  home: "nobody" | "shift" | "decide" | null;
  reason: string;
  shares?: Array<{ userId: number; workRef: string | null; shiftId: number | null; percent: number; mills: number }>;
}): Promise<number> {
  const tx = await testDb!.pool.query<{ id: string; occurred_at: Date }>(
    `insert into transactions (platform_account_id, fan_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
     values ($1, $2, $3, 'tip', 'tip', 'posted', 'ok', $4, $4, $5, 0, $6::timestamptz, 'fansly:rest', 'USD')
     returning id, occurred_at`,
    [input.pageId, input.fanId, input.ref, input.netMills, input.netMills, input.occurredAt],
  );
  const id = Number(tx.rows[0]!.id);
  if (input.home === null) return id;
  await testDb!.pool.query(
    `insert into sale_homes (transaction_id, page_id, occurred_at, net_mills, home, reason, shares, rule_version, computed_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, '2026-11-12.1', now())`,
    [id, input.pageId, tx.rows[0]!.occurred_at, input.netMills, input.home, input.reason, JSON.stringify(input.shares ?? [])],
  );
  return id;
}

async function insertShift(userId: number, pageLabel: string, startedAt: string, endedAt: string, state: "going" | "closed" = "closed"): Promise<number> {
  const reportDate = moscowDayOfMs(Date.parse(startedAt));
  const row = await testDb!.pool.query<{ id: string }>(
    `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages)
     values ($1, $2, $3::timestamptz, $4::timestamptz, 300, 120, $5::date, $6::jsonb) returning id`,
    [userId, state, startedAt, endedAt, reportDate, JSON.stringify([{ pageLabel, activeMinutes: 300, messages: 120, salesFrom: startedAt }])],
  );
  return Number(row.rows[0]!.id);
}

describe("H8: nobody sales are owner-only, solo page suggests its chatter, report-sale & delivery", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);

    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, AUDIT);
    await createUserAccount(app, { username: "lena", role: "team_lead", password: "lena-password-for-tests" }, AUDIT);
    await createUserAccount(app, { username: "anna", role: "chatter" }, AUDIT);
    await createUserAccount(app, { username: "bella", role: "chatter" }, AUDIT);
    await createUserAccount(app, { username: "cora", role: "chatter" }, AUDIT);
    for (const name of ["boss", "lena", "anna", "bella", "cora"]) {
      users[name] = await fixtureUserId(app, name);
      if (name !== "boss" && name !== "lena") await setUserPassword(app, { userId: users[name]!, password: `${name}-password-for-tests` }, AUDIT);
    }

    const modelSolo = await createModel(app.db, { slug: "solo", name: "Solo" });
    const modelShared = await createModel(app.db, { slug: "shared", name: "Shared" });
    const modelOther = await createModel(app.db, { slug: "other", name: "Other" });
    const modelTest = (await testDb.pool.query<{ id: string }>(
      "insert into models (slug, name, is_test) values ('sandbox', 'Sandbox', true) returning id",
    )).rows[0]!;
    soloPage = (await createFanslyPage(app.db, { modelId: modelSolo!.id, label: "solo-1" }))!.id;
    sharedPage = (await createFanslyPage(app.db, { modelId: modelShared!.id, label: "shared-1" }))!.id;
    otherPage = (await createFanslyPage(app.db, { modelId: modelOther!.id, label: "other-1" }))!.id;
    testPage = (await createFanslyPage(app.db, { modelId: Number(modelTest.id), label: "test-1" }))!.id;

    fanAlpha = await insertFan(soloPage, "901001", "fan_alpha", "Alpha Fan");
    fanBeta = await insertFan(sharedPage, "901002", "fan_beta", "Beta Fan");
    fanOther = await insertFan(otherPage, "901003", "fan_other", "Other Fan");
    fanTest = await insertFan(testPage, "901004", "fan_test", "Test Fan");

    // Page grants: anna & lena see solo-1 + shared-1; bella sees shared-1; cora sees solo-1 + shared-1.
    for (const pageId of [soloPage, sharedPage]) {
      await assignUserToPage(app.db, users.anna!, pageId);
      await assignUserToPage(app.db, users.lena!, pageId);
      await assignUserToPage(app.db, users.cora!, pageId);
    }
    await assignUserToPage(app.db, users.bella!, sharedPage);

    await insertAgentKey(testDb.db, {
      name: "h8-agent",
      keyPrefix: AGENT_KEY.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(AGENT_KEY),
      capabilities: ["write:shift_reports", "read:team", "read:money"] as never,
      pageIds: [soloPage, sharedPage],
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      createdBy: users.boss!,
    });

    server = await buildApiServer(app);
    await server.ready();

    for (const name of ["boss", "lena", "anna", "bella", "cora"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: name, password: `${name}-password-for-tests` } });
      expect(login.statusCode, name).toBe(200);
      cookies[name] = String(login.headers["set-cookie"]).split(";")[0]!;
    }

    // People registry:
    // - solo-1 has ONLY anna as working page (live single-chatter suggestion -> anna!)
    // - shared-1 has BOTH anna and bella (live suggestion -> null!)
    // - cora has no working pages (so she doesn't break solo-1 uniqueness)
    const register = (body: AdminPersonCreateBody) => createPerson(app, body, { source: "cli" }, new Date("2026-01-01T09:00:00Z"));
    await register({
      code: "anna", displayName: "Anna", role: "chatter", state: "working",
      rights: ["submits_shift"], logins: { add: [users.anna!] }, workingPageLabels: ["solo-1", "shared-1"],
      telegram: { userId: ANNA_TG },
    });
    await register({
      code: "bella", displayName: "Bella", role: "chatter", state: "working",
      rights: ["submits_shift"], logins: { add: [users.bella!] }, workingPageLabels: ["shared-1"],
    });
    await register({
      code: "cora", displayName: "Cora", role: "chatter", state: "working",
      rights: ["submits_shift"], logins: { add: [users.cora!] }, workingPageLabels: [],
    });
    await register({
      code: "lena", displayName: "Lena", role: "team_lead", state: "working",
      rights: [], logins: { add: [users.lena!] }, workingPageLabels: [],
    });
    // Backdate submits_shift so test shifts run with board on.
    await testDb.pool.query("update person_rights set granted_at = '2026-11-01T00:00:00Z' where \"right\" = 'submits_shift'");
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("hides shared-page nobody and fresh uncomputed post-rule sales from chatters and team leads across all 4 reads while owner sees all", async (context) => {
    if (!testDb) return context.skip();
    const now = Date.now();
    const shiftStart = new Date(now - 3 * 3_600_000).toISOString();
    const shiftEnd = new Date(now - 30 * 60_000).toISOString();
    const shiftAnna = await insertShift(users.anna!, "shared-1", shiftStart, shiftEnd);

    const visibleSale = await insertSale({
      pageId: sharedPage, fanId: fanBeta, ref: "h8-vis-1", netMills: 20_000,
      occurredAt: new Date(now - 2 * 3_600_000).toISOString(),
      home: "shift", reason: "holder",
      shares: [{ userId: users.anna!, workRef: null, shiftId: shiftAnna, percent: 100, mills: 20_000 }],
    });
    const hiddenNobody = await insertSale({
      pageId: sharedPage, fanId: fanBeta, ref: "h8-hid-1", netMills: 35_000,
      occurredAt: new Date(now - 90 * 60_000).toISOString(),
      home: "nobody", reason: "no_holder",
    });
    const freshUncomputed = await insertSale({
      pageId: sharedPage, fanId: fanBeta, ref: "h8-fresh-null", netMills: 18_000,
      occurredAt: new Date(now - 20 * 60_000).toISOString(),
      home: null, reason: "no_holder",
    });

    const today = moscowDayOfMs(now);
    const yesterday = moscowDayOfMs(now - 86_400_000);

    // 1. Team sales list & counts: hidden nobody AND fresh uncomputed post-rule sales hidden for chatter & team lead, visible for owner.
    for (const viewer of ["anna", "lena"] as const) {
      const listAll = await rawSession(viewer, "GET", `/api/v1/team/sales/list?from=${yesterday}&to=${today}&home=all`);
      expect(listAll.statusCode, listAll.body).toBe(200);
      const bodyAll = listAll.json() as { sales: Array<{ transactionId: number }>; counts: Record<string, number> };
      expect(bodyAll.sales.map((one) => one.transactionId)).toContain(visibleSale);
      expect(bodyAll.sales.map((one) => one.transactionId)).not.toContain(hiddenNobody);
      expect(bodyAll.sales.map((one) => one.transactionId)).not.toContain(freshUncomputed);
      expect(bodyAll.counts.nobody).toBe(0);

      const listNobody = await rawSession(viewer, "GET", `/api/v1/team/sales/list?from=${yesterday}&to=${today}&home=nobody`);
      expect(listNobody.statusCode).toBe(200);
      expect((listNobody.json() as { sales: unknown[] }).sales).toEqual([]);
    }
    const bossList = await rawSession("boss", "GET", `/api/v1/team/sales/list?from=${yesterday}&to=${today}&home=all`);
    expect(bossList.statusCode, bossList.body).toBe(200);
    const bossBody = bossList.json() as { sales: Array<{ transactionId: number }>; counts: Record<string, number> };
    expect(bossBody.sales.map((one) => one.transactionId)).toContain(hiddenNobody);
    expect(bossBody.sales.map((one) => one.transactionId)).toContain(freshUncomputed);
    expect(bossBody.counts.nobody).toBeGreaterThanOrEqual(1);

    // 2. Shift report draft on shared-1: nobody sale hidden from «Рядом» (near).
    const draft = await rawSession("anna", "GET", `/api/v1/shift-reports/${shiftAnna}`);
    expect(draft.statusCode, draft.body).toBe(200);
    const draftBody = shiftReportResponseSchema.parse(draft.json());
    expect(draftBody.view?.lines.map((line) => line.transactionId)).not.toContain(hiddenNobody);

    // 3. Add-sale claimable list: hidden nobody AND fresh uncomputed post-rule sales excluded; direct lineSet returns 404.
    const claimable = await rawSession("anna", "GET", `/api/v1/shift-reports/${shiftAnna}/claimable`);
    expect(claimable.statusCode, claimable.body).toBe(200);
    const claimableIds = (claimable.json() as { sales: Array<{ transactionId: number }> }).sales.map((s) => s.transactionId);
    expect(claimableIds).not.toContain(hiddenNobody);
    expect(claimableIds).not.toContain(freshUncomputed);

    const directClaim = await asSession("anna", "PUT", `/api/v1/shift-reports/${shiftAnna}/lines/${hiddenNobody}`, { statement: "mine", note: "пытаюсь добавить" });
    expect(directClaim.statusCode).toBe(404);

    // 4. Direct saleChain: 404 for chatter and team lead on both nobody and fresh uncomputed post-rule sales; 200 for owner.
    expect((await rawSession("anna", "GET", `/api/v1/sales/chain?saleId=${hiddenNobody}`)).statusCode).toBe(404);
    expect((await rawSession("lena", "GET", `/api/v1/sales/chain?saleId=${hiddenNobody}`)).statusCode).toBe(404);
    expect((await rawSession("anna", "GET", `/api/v1/sales/chain?saleId=${freshUncomputed}`)).statusCode).toBe(404);
    expect((await rawSession("lena", "GET", `/api/v1/sales/chain?saleId=${freshUncomputed}`)).statusCode).toBe(404);
    expect((await rawSession("boss", "GET", `/api/v1/sales/chain?saleId=${hiddenNobody}`)).statusCode).toBe(200);
    expect((await rawSession("boss", "GET", `/api/v1/sales/chain?saleId=${freshUncomputed}`)).statusCode).toBe(200);
  });

  it("shows all 24h sales of a solo page in the sole worker's shift report draft ($0 until claimed; owner_nobody stays hidden)", async (context) => {
    if (!testDb) return context.skip();
    const day = "2026-11-12";
    const shiftAnnaSolo = await insertShift(users.anna!, "solo-1", `${day}T12:00:00+03:00`, `${day}T18:00:00+03:00`, "closed");
    // Outside shift hours on the same Moscow day (passive sub / ppvWithoutAuthor -> nobody / no_holder).
    const outsideNobody = await insertSale({
      pageId: soloPage, fanId: fanAlpha, ref: "h8-solo-24h-outside", netMills: 25_000,
      occurredAt: `${day}T03:30:00+03:00`,
      home: "nobody", reason: "no_holder",
    });
    // Explicitly kept nobody by the owner -> must stay hidden.
    const ownerClosedNobody = await insertSale({
      pageId: soloPage, fanId: fanAlpha, ref: "h8-solo-24h-closed", netMills: 14_000,
      occurredAt: `${day}T04:00:00+03:00`,
      home: "nobody", reason: "no_holder",
    });
    expect((await rawSession("boss", "POST", "/api/v1/sale-nobody/keep", { transactionIds: [ownerClosedNobody] })).statusCode).toBe(200);

    // Sole worker (anna) sees outsideNobody in «Рядом» at $0 (stays nobody if untouched) and does NOT see ownerClosedNobody.
    const draft = shiftReportResponseSchema.parse((await rawSession("anna", "GET", `/api/v1/shift-reports/${shiftAnnaSolo}`)).json());
    const shownLine = draft.view?.lines.find((line) => line.transactionId === outsideNobody);
    expect(shownLine).toMatchObject({ group: "near", amountMills: 0, disputed: false });
    expect(draft.view?.lines.find((line) => line.transactionId === ownerClosedNobody)).toBeUndefined();

    // Non-solo chatter (cora) on the same page does NOT see outsideNobody in her draft.
    const shiftCoraSolo = await insertShift(users.cora!, "solo-1", `${day}T12:00:00+03:00`, `${day}T18:00:00+03:00`, "closed");
    const coraDraft = shiftReportResponseSchema.parse((await rawSession("cora", "GET", `/api/v1/shift-reports/${shiftCoraSolo}`)).json());
    expect(coraDraft.view?.lines.find((line) => line.transactionId === outsideNobody)).toBeUndefined();
  });

  it("supports «Добавить продажу» (human + agent doors) with identical 0/>1/cross-realm refusal; an exact match counts the whole net, no owner claim", async (context) => {
    if (!testDb) return context.skip();
    const now = Date.now();
    const shiftAnna = await insertShift(
      users.anna!, "solo-1",
      new Date(now - 5 * 3_600_000).toISOString(),
      new Date(now - 4 * 3_600_000).toISOString(),
    );
    // Two identical fan+amount sales (ambiguous >1), one unique sale for human door, one for agent door, one out-of-grant, one test-realm.
    await insertSale({ pageId: soloPage, fanId: fanAlpha, ref: "h8-dup-1", netMills: 15_000, occurredAt: new Date(now - 2 * 3_600_000).toISOString(), home: "nobody", reason: "no_holder" });
    await insertSale({ pageId: soloPage, fanId: fanAlpha, ref: "h8-dup-2", netMills: 15_000, occurredAt: new Date(now - 90 * 60_000).toISOString(), home: "nobody", reason: "no_holder" });
    const uniqueHuman = await insertSale({ pageId: sharedPage, fanId: fanAlpha, ref: "h8-rep-human", netMills: 42_000, occurredAt: new Date(now - 70 * 60_000).toISOString(), home: "nobody", reason: "no_holder" });
    const uniqueAgent = await insertSale({ pageId: sharedPage, fanId: fanBeta, ref: "h8-rep-agent", netMills: 53_000, occurredAt: new Date(now - 60 * 60_000).toISOString(), home: "nobody", reason: "no_holder" });
    await insertSale({ pageId: otherPage, fanId: fanOther, ref: "h8-other-grant", netMills: 61_000, occurredAt: new Date(now - 50 * 60_000).toISOString(), home: "nobody", reason: "no_holder" });
    await insertSale({ pageId: testPage, fanId: fanTest, ref: "h8-test-realm", netMills: 71_000, occurredAt: new Date(now - 40 * 60_000).toISOString(), home: "nobody", reason: "no_holder" });

    // 0 matches, >1 matches, out-of-grant, cross-realm: byte-identical 404 body with NO candidate list!
    const rZero = await rawSession("anna", "POST", `/api/v1/shift-reports/${shiftAnna}/report-sale`, { transactionRef: "h8-missing", note: "моя" });
    const rAmbig = await rawSession("anna", "POST", `/api/v1/shift-reports/${shiftAnna}/report-sale`, { fan: "fan_alpha", amountMills: 15_000, note: "моя" });
    const rOther = await rawSession("anna", "POST", `/api/v1/shift-reports/${shiftAnna}/report-sale`, { transactionRef: "h8-other-grant", note: "моя" });
    const rRealm = await rawSession("anna", "POST", `/api/v1/shift-reports/${shiftAnna}/report-sale`, { transactionRef: "h8-test-realm", note: "моя" });
    const kept = await insertSale({ pageId: soloPage, fanId: fanAlpha, ref: "fixture-kept", netMills: 1230,
      home: "nobody", reason: "no_holder", occurredAt: new Date(now).toISOString() });
    expect((await rawSession("boss", "POST", "/api/v1/sale-nobody/keep", { transactionIds: [kept] })).statusCode).toBe(200);
    const attempt = (ref: string) => rawSession("anna", "POST", `/api/v1/shift-reports/${shiftAnna}/report-sale`, { transactionRef: ref, note: "fixture" });
    const agreed = await insertSale({ pageId: soloPage, fanId: fanAlpha, ref: "fixture-colleague", netMills: 4321,
      home: "shift", reason: "agreed", occurredAt: new Date(now).toISOString() });
    for (const res of [rZero, rAmbig, rOther, rRealm, await attempt("fixture-kept"), await attempt("fixture-colleague")]) {
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(rZero.body);
      expect(res.json()).toMatchObject({ reason: "sale_not_matched" });
    }

    expect((await testDb.pool.query("select id from sale_claims where transaction_id = $1", [agreed])).rows).toEqual([]);
    // Exact 1 match via human door (transactionRef): the person's «моё», the whole net counted, nobody asked.
    const okHuman = await rawSession("anna", "POST", `/api/v1/shift-reports/${shiftAnna}/report-sale`, {
      transactionRef: "h8-rep-human", note: "общалась с фаном в чате",
    });
    expect(okHuman.statusCode, okHuman.body).toBe(200);
    expect(okHuman.json()).toMatchObject({ transactionId: uniqueHuman });

    const draft = shiftReportResponseSchema.parse((await rawSession("anna", "GET", `/api/v1/shift-reports/${shiftAnna}`)).json());
    const reportedLine = draft.view?.lines.find((line) => line.transactionId === uniqueHuman);
    expect(reportedLine).toMatchObject({ group: "mine", statement: "mine", amountMills: 42_000, disputed: false, claimedMills: null });
    expect(await claimsOf(uniqueHuman)).toEqual([]);

    // Exact 1 match via agent door (fan + amountMills).
    const okAgent = await asAgent("POST", "/api/v1/agent/shift-reports/report-sale", {
      shiftId: shiftAnna, fan: "@fan_beta", amountMills: 53_000, note: "купил по моей рассылке", telegramUserId: ANNA_TG,
    });
    expect(okAgent.statusCode, okAgent.body).toBe(200);
    expect(okAgent.json()).toMatchObject({ transactionId: uniqueAgent });
    expect(await claimsOf(uniqueAgent)).toEqual([]);

    // Handed in: the version counts both whole (what the ledger accrues), and the claims' pass opens nothing for the owner.
    await handInAndConfirm(asSession, "anna", shiftAnna);
    await runSaleClaims(app);
    expect(await newestLine(shiftAnna, uniqueHuman)).toMatchObject({ amountMills: 42_000, disputed: false });
    expect(await newestLine(shiftAnna, uniqueAgent)).toMatchObject({ amountMills: 53_000, disputed: false });
    expect(await claimsOf(uniqueHuman)).toEqual([]);
    expect(await claimsOf(uniqueAgent)).toEqual([]);
    expect((await testDb.pool.query("select id from matters where kind = 'sale.nobody_week' and state = 'open'")).rows).toEqual([]);

    // Her own handed-in line opens the chain to her; a team lead still cannot read it.
    expect((await rawSession("anna", "GET", `/api/v1/sales/chain?saleId=${uniqueHuman}`)).statusCode).toBe(200);
    expect((await rawSession("lena", "GET", `/api/v1/sales/chain?saleId=${uniqueHuman}`)).statusCode).toBe(404);
  });

  it("makes a second «моё» on a nobody sale another report counts a claim with that colleague, never paid to both", async (context) => {
    if (!testDb) return context.skip();
    const now = Date.now();
    const sale = await insertSale({ pageId: sharedPage, fanId: fanBeta, ref: "h8-two-reports", netMills: 30_000,
      occurredAt: new Date(now - 3 * 3_600_000).toISOString(), home: "nobody", reason: "no_holder" });
    const at = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
    const shiftAnna = await insertShift(users.anna!, "shared-1", at(8), at(7));
    const shiftBella = await insertShift(users.bella!, "shared-1", at(8), at(7));

    // Anna first: her word counts the whole net, nobody asked.
    expect((await rawSession("anna", "POST", `/api/v1/shift-reports/${shiftAnna}/report-sale`, { transactionRef: "h8-two-reports", note: "мой фан" })).statusCode).toBe(200);
    await handInAndConfirm(asSession, "anna", shiftAnna);
    await runSaleClaims(app);
    expect(await newestLine(shiftAnna, sale)).toMatchObject({ amountMills: 30_000, disputed: false });
    expect(await claimsOf(sale)).toEqual([]);

    // Bella says it is hers too: Anna's handed-in report holds it, so her line counts nothing in the draft and the hand-in
    // makes it a claim with Anna — the colleague, not the owner.
    expect((await rawSession("bella", "POST", `/api/v1/shift-reports/${shiftBella}/report-sale`, { transactionRef: "h8-two-reports", note: "тоже писала ему" })).statusCode).toBe(200);
    const bellaDraft = shiftReportResponseSchema.parse((await rawSession("bella", "GET", `/api/v1/shift-reports/${shiftBella}`)).json());
    expect(bellaDraft.view?.lines.find((line) => line.transactionId === sale)).toMatchObject({ statement: "mine", amountMills: 0, disputed: true, claimedMills: 30_000 });
    await handInAndConfirm(asSession, "bella", shiftBella);
    await runSaleClaims(app);
    // A take of a colleague's sale (owner, 2026-11-21): written to Bella at once, Anna told and free to say «Не согласен».
    expect(await claimsOf(sale)).toEqual([{ claimant: users.bella!, side: users.anna!, state: "agreed", escalated_why: null }]);
    // The two reports never count it twice: Anna's got its new version without it.
    expect(await newestLine(shiftAnna, sale)).toMatchObject({ amountMills: 0 });
    expect(await newestLine(shiftBella, sale)).toMatchObject({ amountMills: 30_000 });
  });

  it("opens no owner's line of unclaimed nobody sales, and closes one still open", async (context) => {
    if (!testDb) return context.skip();
    await insertSale({ pageId: sharedPage, fanId: fanBeta, ref: "h8-week-unclaimed", netMills: 12_000,
      occurredAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), home: "nobody", reason: "no_holder" });
    // One left open by the pass before the owner's word.
    await openMatter(app.db, {
      key: "sale.nobody_week:open", kind: "sale.nobody_week", source: "server", title: "Ничьи продажи: 1 на $12.00",
      object: null, pageIds: [], owner: { role: "owner" }, money: true, evidence: { count: 1 }, link: "/workboard/waiting?nobody=1#questions",
    }, { door: "system" });
    await runSaleClaims(app);
    expect((await testDb.pool.query("select state from matters where kind = 'sale.nobody_week'")).rows).toEqual([{ state: "closed" }]);
    // The owner's list itself stays.
    const list = saleNobodyResponseSchema.parse((await rawSession("boss", "GET", "/api/v1/sale-nobody")).json());
    expect(list.sales.length).toBeGreaterThan(0);
  });

  it("shows ALL open nobody sales to the owner regardless of week close with live single-chatter suggestion", async (context) => {
    if (!testDb) return context.skip();
    const oldAt = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const soloOld = await insertSale({ pageId: soloPage, fanId: fanAlpha, ref: "h8-solo-old", netMills: 28_000, occurredAt: oldAt, home: "nobody", reason: "no_holder" });
    const sharedOld = await insertSale({ pageId: sharedPage, fanId: fanBeta, ref: "h8-shared-old", netMills: 31_000, occurredAt: oldAt, home: "nobody", reason: "no_holder" });

    expect((await rawSession("anna", "GET", "/api/v1/sale-nobody")).statusCode).toBe(403);
    expect((await rawSession("lena", "GET", "/api/v1/sale-nobody")).statusCode).toBe(403);

    const res = await rawSession("boss", "GET", "/api/v1/sale-nobody");
    expect(res.statusCode, res.body).toBe(200);
    const body = saleNobodyResponseSchema.parse(res.json());
    const foundSolo = body.sales.find((sale) => sale.transactionId === soloOld);
    const foundShared = body.sales.find((sale) => sale.transactionId === sharedOld);
    expect(foundSolo?.suggestion).toMatchObject({ code: "anna", userId: users.anna! });
    expect(foundShared?.suggestion).toBeNull();
    expect(body.candidates.map((one) => one.code)).toEqual(expect.arrayContaining(["anna", "bella", "cora"]));
  });

  it("delivers «Отдать <имя>» into (a) open draft, (b) submitted report system version, or (c) next shift (and cancel drops it), with 409 on stale", async (context) => {
    if (!testDb) return context.skip();
    // Pick distinct synthetic days so each delivery case is completely isolated.
    const dayA = "2026-11-16";
    const dayB = "2026-11-17";
    const dayC = "2026-11-18";

    // (a) Open draft on dayA for bella.
    const shiftBellaOpen = await insertShift(users.bella!, "shared-1", `${dayA}T10:00:00+03:00`, `${dayA}T18:00:00+03:00`, "going");
    const saleA = await insertSale({ pageId: sharedPage, fanId: fanBeta, ref: "h8-deliv-a", netMills: 19_000, occurredAt: `${dayA}T08:00:00+03:00`, home: "nobody", reason: "no_holder" });

    const giveA = await rawSession("boss", "POST", "/api/v1/sale-nobody/give", { transactionId: saleA, userId: users.bella! });
    expect(giveA.statusCode, giveA.body).toBe(200);
    expect(giveA.json()).toMatchObject({ status: "draft", versions: [] });

    // Stale / duplicate give returns 409.
    const giveStale = await rawSession("boss", "POST", "/api/v1/sale-nobody/give", { transactionId: saleA, userId: users.anna! });
    expect(giveStale.statusCode).toBe(409);

    const bellaDraft = shiftReportResponseSchema.parse((await rawSession("bella", "GET", `/api/v1/shift-reports/${shiftBellaOpen}`)).json());
    const bellaLine = bellaDraft.view?.lines.find((line) => line.transactionId === saleA);
    expect(bellaLine).toMatchObject({ group: "mine", amountMills: 19_000, disputed: false });
    expect(bellaLine?.rule.words).toBe("отдано владельцем");
    const bellaBoardRow = bellaDraft.board?.columns.flatMap((col) => col.rows).find((row) => row.transactionId === saleA);
    expect(bellaBoardRow?.reasonWords).toBe("отдано владельцем");

    const decline = await asSession("bella", "PUT", `/api/v1/shift-reports/${shiftBellaOpen}/lines/${saleA}`, { statement: "not_mine" });
    expect(decline.statusCode, decline.body).toBe(200);
    const declined = shiftReportResponseSchema.parse((await rawSession("bella", "GET", `/api/v1/shift-reports/${shiftBellaOpen}`)).json());
    expect(declined.view?.lines.find((one) => one.transactionId === saleA)?.amountMills).toBe(0);
    // Declining an «Отдать» delivery opens an owner matter (`sale.delivery_declined`) and does NOT leak to later shifts.
    const decA = (giveA.json() as { decisionId: number }).decisionId;
    const declinedMatterKey = `sale.delivery_declined:${decA}:${users.bella!}`;
    expect((await testDb.pool.query("select state from matters where reason_key = $1", [declinedMatterKey])).rows).toEqual([{ state: "open" }]);
    const later = await insertShift(users.bella!, "shared-1", "2026-11-19T08:00:00Z", "2026-11-19T12:00:00Z");
    const next = shiftReportResponseSchema.parse((await rawSession("bella", "GET", `/api/v1/shift-reports/${later}`)).json());
    expect(next.view?.lines.some((one) => one.transactionId === saleA)).toBe(false);
    // Clearing `not_mine` in draft reverts the delivery back to `pending` and closes the owner matter.
    const undoDecline = await asSession("bella", "PUT", `/api/v1/shift-reports/${shiftBellaOpen}/lines/${saleA}`, { statement: null });
    expect(undoDecline.statusCode, undoDecline.body).toBe(200);
    expect((await testDb.pool.query("select state from sale_decision_deliveries where decision_id = $1 and recipient_user_id = $2", [decA, users.bella!])).rows).toEqual([{ state: "pending" }]);
    expect((await testDb.pool.query("select state from matters where reason_key = $1", [declinedMatterKey])).rows).toEqual([{ state: "closed" }]);
    const restored = shiftReportResponseSchema.parse((await rawSession("bella", "GET", `/api/v1/shift-reports/${shiftBellaOpen}`)).json());
    expect(restored.view?.lines.find((one) => one.transactionId === saleA)?.amountMills).toBe(19_000);
    // Re-decline so subsequent assertions match the original flow.
    expect((await asSession("bella", "PUT", `/api/v1/shift-reports/${shiftBellaOpen}/lines/${saleA}`, { statement: "not_mine" })).statusCode).toBe(200);

    // (b) Already handed-in report on dayB for anna (report does NOT initially hold saleB).
    const shiftAnnaSub = await insertShift(users.anna!, "solo-1", `${dayB}T10:00:00+03:00`, `${dayB}T18:00:00+03:00`, "closed");
    await handInAndConfirm(asSession, "anna", shiftAnnaSub);
    const saleB = await insertSale({ pageId: soloPage, fanId: fanAlpha, ref: "h8-deliv-b", netMills: 27_000, occurredAt: `${dayB}T09:00:00+03:00`, home: "nobody", reason: "no_holder" });

    const giveB = await rawSession("boss", "POST", "/api/v1/sale-nobody/give", { transactionId: saleB, userId: users.anna! });
    expect(giveB.statusCode, giveB.body).toBe(200);
    expect(giveB.json()).toMatchObject({ status: "delivered", versions: [{ shiftId: shiftAnnaSub, version: 2 }] });

    const versionRow = await testDb.pool.query<{ version: number; total_mills: string; lines: Array<{ transactionId: number; amountMills: number; settled?: string }> }>(
      `select v.version, v.total_mills, v.lines
       from shift_handins h join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version
       where h.shift_id = $1`,
      [shiftAnnaSub],
    );
    expect(versionRow.rows[0]?.version).toBe(2);
    expect(Number(versionRow.rows[0]?.total_mills)).toBe(27_000);
    expect(versionRow.rows[0]?.lines.find((line) => line.transactionId === saleB)).toMatchObject({
      amountMills: 27_000, settled: "owner",
    });

    // (c) No shift/report yet for cora on dayC: stays waiting (applied_at IS NULL), cancelled decision is NOT pulled, active one IS pulled into next shift.
    const saleC1 = await insertSale({ pageId: soloPage, fanId: fanAlpha, ref: "h8-deliv-c1", netMills: 33_000, occurredAt: `${dayC}T11:00:00+03:00`, home: "nobody", reason: "no_holder" });
    const saleC2 = await insertSale({ pageId: soloPage, fanId: fanAlpha, ref: "h8-deliv-c2", netMills: 44_000, occurredAt: `${dayC}T12:00:00+03:00`, home: "nobody", reason: "no_holder" });

    const giveC1 = await rawSession("boss", "POST", "/api/v1/sale-nobody/give", { transactionId: saleC1, userId: users.cora! });
    const giveC2 = await rawSession("boss", "POST", "/api/v1/sale-nobody/give", { transactionId: saleC2, userId: users.cora! });
    expect(giveC1.statusCode, giveC1.body).toBe(200);
    expect(giveC2.statusCode, giveC2.body).toBe(200);
    expect(giveC1.json()).toMatchObject({ status: "waiting_report", versions: [] });
    expect(giveC2.json()).toMatchObject({ status: "waiting_report", versions: [] });
    const decC2 = (giveC2.json() as { decisionId: number }).decisionId;

    // Owner sees both in waitingDecisions («ждёт отчёта»).
    const beforeNext = saleNobodyResponseSchema.parse((await rawSession("boss", "GET", "/api/v1/sale-nobody")).json());
    expect(beforeNext.waitingDecisions.map((one) => one.transactionId)).toEqual(expect.arrayContaining([saleC1, saleC2]));

    // Cancel saleC2 BEFORE cora starts her next shift.
    await cancelSaleDecisionApplied(app, {
      decisionId: decC2,
      note: "отменено до смены",
      by: { door: "workboard", actorUserId: users.boss!, agentKeyId: null, telegramMessageRef: null, telegramSenderId: null },
      check: async (decision) => {
        if (decision === null) throw new Error("missing decision");
        return decision;
      },
    }, new Date());

    // Now cora starts her next shift on 2026-11-19: saleC1 is pulled («отдано владельцем»), cancelled saleC2 is NOT!
    const shiftCoraNext = await insertShift(users.cora!, "solo-1", "2026-11-19T10:00:00+03:00", "2026-11-19T18:00:00+03:00", "closed");
    const coraDraft = shiftReportResponseSchema.parse((await rawSession("cora", "GET", `/api/v1/shift-reports/${shiftCoraNext}`)).json());
    const coraLines = coraDraft.view?.lines ?? [];
    expect(coraLines.find((line) => line.transactionId === saleC1)).toMatchObject({
      group: "mine", amountMills: 33_000, disputed: false,
    });
    expect(coraLines.find((line) => line.transactionId === saleC1)?.rule.words).toBe("отдано владельцем");
    expect(coraLines.find((line) => line.transactionId === saleC2)).toBeUndefined();

    // Hand in & confirm cora's shift: saleC1 leaves waitingDecisions and is NOT pulled again into a second shift!
    await handInAndConfirm(asSession, "cora", shiftCoraNext);
    const afterHandIn = saleNobodyResponseSchema.parse((await rawSession("boss", "GET", "/api/v1/sale-nobody")).json());
    expect(afterHandIn.waitingDecisions.map((one) => one.transactionId)).not.toContain(saleC1);

    const shiftCoraLater = await insertShift(users.cora!, "solo-1", "2026-11-20T10:00:00+03:00", "2026-11-20T18:00:00+03:00", "going");
    const laterDraft = shiftReportResponseSchema.parse((await rawSession("cora", "GET", `/api/v1/shift-reports/${shiftCoraLater}`)).json());
    expect(laterDraft.view?.lines.find((line) => line.transactionId === saleC1)).toBeUndefined();
  });
  it("leaves historical decisions out of new drafts and skips pre-board and frozen shifts for new deliveries", async (context) => {
    if (!testDb) return context.skip();
    const at = "2026-11-21T09:00:00Z";
    const fixture = (ref: string) => insertSale({ pageId: soloPage, fanId: fanAlpha, ref,
      occurredAt: at, netMills: 2345, home: "nobody", reason: "no_holder" });
    const old = await fixture("fixture-external-history");
    await testDb.pool.query(`insert into sale_owner_decisions (transaction_id, page_id, kind, shares, outcome, decided_at, source)
      values ($1, $2, 'split', $3, 'first', $4, 'dispute')`,
    [old, soloPage, JSON.stringify([{ userId: users.cora, percent: 100 }]), at]);
    for (const phase of ["checking", "confirm"]) {
      const frozen = await insertShift(users.cora!, "solo-1", at, "2026-11-21T15:00:00Z");
      await testDb.pool.query("insert into shift_handins (shift_id, user_id, report_date, phase) values ($1, $2, '2026-11-21', $3)",
        [frozen, users.cora, phase]);
    }
    const preBoard = await insertShift(users.cora!, "solo-1", "2026-10-25T09:00:00Z", "2026-10-25T17:00:00Z");
    const fresh = await fixture("fixture-new-delivery");
    const give = await rawSession("boss", "POST", "/api/v1/sale-nobody/give", { transactionId: fresh, userId: users.cora });
    expect(give.json()).toMatchObject({ status: "waiting_report" });
    const waiting = saleNobodyResponseSchema.parse((await rawSession("boss", "GET", "/api/v1/sale-nobody")).json());
    expect(waiting.waitingDecisions.map((one) => one.transactionId)).not.toContain(old);
    const wrong = await testDb.pool.query("select shift_id from sale_decision_deliveries where decision_id = $1", [give.json().decisionId]);
    expect(wrong.rows).toEqual([{ shift_id: null }]);
    const rows = async (shift: number) => shiftReportResponseSchema.parse((await rawSession("cora", "GET", `/api/v1/shift-reports/${shift}`)).json())
      .view?.lines.map((one) => one.transactionId) ?? [];
    expect(await rows(preBoard)).not.toContain(fresh);
    const landing = await insertShift(users.cora!, "solo-1", "2026-11-22T09:00:00Z", "2026-11-22T17:00:00Z");
    expect(await rows(landing)).toContain(fresh);
    expect(await rows(landing)).not.toContain(old);
  });

  for (const retiredState of ["dropped", "merged"] as const) {
    it(`settles pending deliveries after their pinned shift is ${retiredState}`, async (context) => {
      if (!testDb) return context.skip();
      const pool = testDb.pool;
      const day = retiredState === "merged" ? "2026-11-15" : "2026-11-13";
      const landingDay = retiredState === "merged" ? day : "2026-11-14";
      const user = users.cora!;
      const landing = await insertShift(user, "shared-1", `${landingDay}T06:00:00Z`, `${landingDay}T09:00:00Z`);
      const pinned = await insertShift(user, "solo-1", `${day}T12:00:00Z`, `${day}T15:00:00Z`);
      const sales: number[] = [];
      const decisions: number[] = [];
      for (const variant of ["current", "legacy"]) {
        const sale = await insertSale({ pageId: soloPage, fanId: fanAlpha, ref: `fixture-${retiredState}-${variant}`,
          occurredAt: `${day}T10:00:00Z`, netMills: 137, home: "nobody", reason: "no_holder" });
        const give = await rawSession("boss", "POST", "/api/v1/sale-nobody/give", { transactionId: sale, userId: user });
        expect(give.statusCode, give.body).toBe(200);
        sales.push(sale);
        decisions.push(give.json().decisionId as number);
      }
      const receipts = async () => (await pool.query(
        "select state, shift_id::int as shift from sale_decision_deliveries where decision_id = any($1) order by decision_id", [decisions],
      )).rows;
      expect(await receipts()).toEqual(decisions.map(() => ({ state: "pending", shift: pinned })));
      await syncShiftRows(app.db, {
        now: new Date(), endedAfter: new Date(day),
        plan: (rows) => {
          const before = rows.find((row) => row.id === pinned)!;
          return { open: [], update: [],
            merge: retiredState === "merged" ? [{ id: pinned, into: landing, before }] : [],
            drop: retiredState === "dropped" ? [{ id: pinned, before }] : [],
          };
        },
      });
      expect(await receipts()).toEqual(decisions.map(() => ({ state: "pending", shift: null })));
      // Simulate one reservation left behind by a writer predating the sync cleanup.
      await pool.query("update sale_decision_deliveries set shift_id = $1 where decision_id = $2", [pinned, decisions[1]]);
      const draft = shiftReportResponseSchema.parse((await rawSession("cora", "GET", `/api/v1/shift-reports/${landing}`)).json());
      for (const sale of sales) expect(draft.view?.lines.find((line) => line.transactionId === sale)?.amountMills).toBe(137);
      await handInAndConfirm(asSession, "cora", landing);
      expect(await receipts()).toEqual(decisions.map(() => ({ state: "applied", shift: landing })));
    });
  }

  it("filters stored and uncomputed nobody sales before both team shift responses and their sums", async (context) => {
    if (!testDb) return context.skip();
    const start = new Date(Date.now() - 30 * 3_600_000);
    const at = new Date(start.getTime() + 3_600_000).toISOString();
    await testDb.pool.query(`insert into chatter_activity_minutes (user_id, page_id, minute, input)
      select $1, $2, date_trunc('minute', $3::timestamptz) + n * interval '1 min', true from generate_series(0, 180) n`,
    [users.anna, soloPage, start]);
    await testDb.pool.query(`insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id,
      source, priced, with_media, observed_at) select 'fansly', $1, (10000 + n)::text, '10101', $2,
      'fansly-extension', false, false, $3::timestamptz + n * interval '3 min' from generate_series(0, 59) n`,
    [soloPage, users.anna, start]);
    const sale = (ref: string, amount: number, home: "nobody" | null, time = at) => insertSale({
      pageId: soloPage, fanId: fanAlpha, ref, netMills: amount, home, reason: "no_holder", occurredAt: time,
    });
    const stored = await sale("fixture-in-shift", 1111, "nobody");
    const fresh = await sale("fixture-before-refresh", 2222, null);
    await testDb.pool.query(`insert into sale_owner_decisions (transaction_id, page_id, kind, outcome, decided_at, source)
      values ($1, $2, 'nobody', 'nobody', now(), 'dispute')`, [fresh, soloPage]);
    const outsideTime = new Date(start.getTime() - 4 * 3_600_000).toISOString();
    await sale("fixture-outside", 3333, "nobody", outsideTime);
    const path = `/api/v1/team/shift-review?userId=${users.anna}&at=${encodeURIComponent(at)}`;
    for (const who of ["boss", "anna", "lena"]) {
      const review = await rawSession(who, "GET", path);
      expect(review.statusCode, review.body).toBe(200);
      const details = review.json();
      const refs = [...details.sales, ...details.beforeSales, ...details.laterSales].map((row) => row.saleRef);
      const page = details.shift.pages.find((row: { pageLabel: string }) => row.pageLabel === "solo-1");
      const sales = await rawSession(who, "GET", "/api/v1/team/shift-sales?days=3&pageLabel=solo-1");
      expect(sales.statusCode, sales.body).toBe(200);
      const outside = sales.json().outside;
      if (who === "boss") {
        expect(refs).toEqual(expect.arrayContaining([String(stored), String(fresh)]));
        expect(page.sales.netMills).toBeGreaterThanOrEqual(3333);
        expect(outside.sales).toContainEqual(expect.objectContaining({ netMills: 3333 }));
      } else {
        expect(refs).not.toContain(String(stored));
        expect(refs).not.toContain(String(fresh));
        expect(page.sales.netMills).toBe(0);
        for (const row of [outside, ...outside.daily, ...outside.pages]) expect(row.nobodyNetMills).toBe(0);
        expect(outside.sales).not.toContainEqual(expect.objectContaining({ netMills: 3333 }));
      }
    }
  });

  it("keeps just the displayed sales and rejects a stale selection atomically", async (context) => {
    if (!testDb) return context.skip();
    const make = (ref: string) => insertSale({ pageId: soloPage, fanId: fanAlpha, ref, netMills: 1000,
      occurredAt: new Date().toISOString(), home: "nobody", reason: "no_holder" });
    const shown = await make("fixture-shown");
    const unseen = await make("fixture-unseen");
    const keep = (body: Record<string, unknown>) => rawSession("boss", "POST", "/api/v1/sale-nobody/keep", body);
    expect((await keep({})).statusCode).toBe(400);
    expect((await keep({ transactionIds: Array.from({ length: 501 }, (_, i) => i + 1) })).statusCode).toBe(400);
    expect((await keep({ transactionIds: [shown] })).json().kept).toBe(1);
    expect((await keep({ transactionIds: [unseen, shown] })).statusCode).toBe(409);
    const contested = await make("fixture-challenged");
    await testDb.pool.query(`insert into sale_claims (transaction_id, page_id, kind, state, asked_of, question, claimed_at)
      values ($1, $2, 'question', 'owner', 'owner', 'Fixture question', now())`, [contested, soloPage]);
    expect((await keep({ transactionIds: [unseen, contested] })).statusCode).toBe(409);
    expect((await rawSession("boss", "POST", "/api/v1/sale-nobody/give", { transactionId: contested, userId: users.anna })).statusCode).toBe(409);
    expect((await testDb.pool.query("select id from sale_owner_decisions where transaction_id = $1", [unseen])).rows).toEqual([]);
  });

  it("surfaces nobody sales to chatters who personally messaged that fan in history, matches page_alias, and names waiting PPV senders", async (context) => {
    if (!testDb) return context.skip();
    const day = "2026-11-11";
    const fanAliasId = await insertFan(sharedPage, "901055", "lincoln92_", "");
    await testDb.pool.query(
      "update page_fans set page_alias = 'Theo/UK/' where fan_id = $1 and platform_account_id = $2",
      [fanAliasId, sharedPage],
    );
    // Anna personally messaged this fan 30 days ago (even well outside the 48h rule window!).
    await testDb.pool.query(
      `insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at)
       values ('fansly', $1, '777001', '901055', $2, 'fansly-extension', false, false, '2026-10-12T10:00:00Z')`,
      [sharedPage, users.anna],
    );
    // Earlier same-day off-shift nobody sale on shared-1 (NOT a solo page).
    const earlyNobody = await insertSale({
      pageId: sharedPage, fanId: fanAliasId, ref: "h8-alias-early", netMills: 40_000,
      occurredAt: `${day}T07:34:08+03:00`, home: "nobody", reason: "no_holder",
    });
    const shiftAnna = await insertShift(users.anna!, "shared-1", `${day}T18:00:00+03:00`, `${day}T23:50:00+03:00`, "closed");
    const shiftBella = await insertShift(users.bella!, "shared-1", `${day}T18:00:00+03:00`, `${day}T23:50:00+03:00`, "closed");

    // Anna (who personally messaged the fan 30d ago) sees the sale on her board at $0 with fan.alias = 'Theo/UK/' and fan.name = 'lincoln92_'.
    const annaDraft = shiftReportResponseSchema.parse((await rawSession("anna", "GET", `/api/v1/shift-reports/${shiftAnna}`)).json());
    const annaLine = annaDraft.view?.lines.find((line) => line.transactionId === earlyNobody);
    expect(annaLine).toMatchObject({ group: "near", amountMills: 0, disputed: false, fan: { alias: "Theo/UK/", name: "lincoln92_", username: "lincoln92_" } });
    // Her «моё» on it is her word: the whole net counts at once, nobody asked (owner, 2026-11-26).
    const said = await asSession("anna", "PUT", `/api/v1/shift-reports/${shiftAnna}/lines/${earlyNobody}`, { statement: "mine", note: "мой фан" });
    expect(said.statusCode, said.body).toBe(200);
    const annaSaid = shiftReportResponseSchema.parse((await rawSession("anna", "GET", `/api/v1/shift-reports/${shiftAnna}`)).json());
    expect(annaSaid.view?.lines.find((line) => line.transactionId === earlyNobody)).toMatchObject({ statement: "mine", amountMills: 40_000, disputed: false });
    expect(await claimsOf(earlyNobody)).toEqual([]);

    // Bella (who never messaged the fan) does NOT see it on shared-1.
    const bellaDraft = shiftReportResponseSchema.parse((await rawSession("bella", "GET", `/api/v1/shift-reports/${shiftBella}`)).json());
    expect(bellaDraft.view?.lines.find((line) => line.transactionId === earlyNobody)).toBeUndefined();

    // «Добавить продажу» matches by page_alias ('Theo/UK/', 'Theo/UK', and first '/'-segment 'Theo'), while noisy '+' collisions stay 404.
    const aliasReportSale = await insertSale({
      pageId: sharedPage, fanId: fanAliasId, ref: "h8-alias-report-1", netMills: 41_000,
      occurredAt: `${day}T08:15:00+03:00`, home: "nobody", reason: "no_holder",
    });
    const reportByFirstWord = await rawSession("anna", "POST", `/api/v1/shift-reports/${shiftAnna}/report-sale`, {
      fan: "theo", amountMills: 41_000, note: "общалась с Тео",
    });
    expect(reportByFirstWord.statusCode, reportByFirstWord.body).toBe(200);
    expect(reportByFirstWord.json()).toMatchObject({ transactionId: aliasReportSale });

    const aliasReportSale2 = await insertSale({
      pageId: sharedPage, fanId: fanAliasId, ref: "h8-alias-report-2", netMills: 43_000,
      occurredAt: `${day}T08:20:00+03:00`, home: "nobody", reason: "no_holder",
    });
    const reportWithoutSlash = await rawSession("anna", "POST", `/api/v1/shift-reports/${shiftAnna}/report-sale`, {
      fan: "Theo/UK", amountMills: 43_000, note: "общалась с Тео",
    });
    expect(reportWithoutSlash.statusCode, reportWithoutSlash.body).toBe(200);
    expect(reportWithoutSlash.json()).toMatchObject({ transactionId: aliasReportSale2 });

    // Anna hands in: her version counts the nobody sale as her own; nothing is asked of the owner.
    await handInAndConfirm(asSession, "anna", shiftAnna);
    await runSaleClaims(app);
    expect(await newestLine(shiftAnna, earlyNobody)).toMatchObject({ amountMills: 40_000, disputed: false });
    expect(await claimsOf(earlyNobody)).toEqual([]);

    // Waiting PPV in GET /claimable names its sender + deadline, while POST /report-sale still returns byte-identical 404 (H8).
    const now = Date.now();
    const shiftAnnaRecent = await insertShift(
      users.anna!, "shared-1",
      new Date(now - 4 * 3_600_000).toISOString(),
      new Date(now - 2 * 3_600_000).toISOString(),
    );
    const waitAt = new Date(now - 60 * 60_000);
    const waitUntil = new Date(now + 5 * 86_400_000);
    const waitingTx = await testDb.pool.query<{ id: string }>(
      `insert into transactions (platform_account_id, fan_id, transaction_id, correlation_id, raw_type, canonical_type, transaction_state, raw_status,
         gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
       values ($1, $2, 'h8-wait-ppv-1', 'offer-wait-1', 'message_purchase', 'message_purchase', 'posted', 'ok', 25000, 25000, 20000, 5000, $3::timestamptz, 'fansly:rest', 'USD')
       returning id`,
      [sharedPage, fanAliasId, waitAt.toISOString()],
    );
    const waitingTxId = Number(waitingTx.rows[0]!.id);
    await testDb.pool.query(
      `insert into message_media_offers (page_id, platform, message_ref, offer_ordinal, media_offer_ref, fan_platform_user_id, message_created_at,
         first_observed_at, last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
       values ($1, 'fansly', '777099', 0, 'offer-wait-1', '901055', $2::timestamptz, now(), now(), $3, 1, 1, 1)`,
      [sharedPage, new Date(waitAt.getTime() - 10 * 60_000).toISOString(), "a".repeat(64)],
    );
    await testDb.pool.query(
      `insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at)
       values ('fansly', $1, '777099', '901055', $2, 'fansly-extension', true, true, $3::timestamptz)`,
      [sharedPage, users.anna, new Date(waitAt.getTime() - 10 * 60_000).toISOString()],
    );
    await testDb.pool.query(
      `insert into sale_homes (transaction_id, page_id, occurred_at, net_mills, home, reason, waits_until, shares, rule_version, computed_at)
       values ($1, $2, $3::timestamptz, 20000, 'waiting', 'ppv_sender_no_shift', $4::timestamptz, '[]'::jsonb, '2026-11-12.1', now())`,
      [waitingTxId, sharedPage, waitAt.toISOString(), waitUntil.toISOString()],
    );

    const claimableAnna = await rawSession("anna", "GET", `/api/v1/shift-reports/${shiftAnnaRecent}/claimable`);
    expect(claimableAnna.statusCode, claimableAnna.body).toBe(200);
    const waitingRow = (claimableAnna.json() as { sales: Array<{ transactionId: number; words: string; waitsUntil?: string | null; fan: { alias?: string | null } }> }).sales
      .find((one) => one.transactionId === waitingTxId);
    expect(waitingRow?.words).toContain("ваш PPV, уйдёт в вашу следующую смену (до ");
    expect(waitingRow?.waitsUntil).toBe(waitUntil.toISOString());
    expect(waitingRow?.fan.alias).toBe("Theo/UK/");

    // POST /report-sale must still refuse waiting PPV with the exact same 404 body as a nonexistent ref (H8).
    const rMiss = await rawSession("anna", "POST", `/api/v1/shift-reports/${shiftAnnaRecent}/report-sale`, { transactionRef: "h8-does-not-exist", note: "моя" });
    const rWait = await rawSession("anna", "POST", `/api/v1/shift-reports/${shiftAnnaRecent}/report-sale`, { transactionRef: "h8-wait-ppv-1", note: "моя" });
    expect(rWait.statusCode).toBe(404);
    expect(rWait.body).toBe(rMiss.body);
  });

  it("never counts one nobody's sale twice for one person, however old the report that counts it", async (context) => {
    if (!testDb) return context.skip();
    const now = Date.now();
    const at = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
    const fanTwice = await insertFan(soloPage, "901010", "fan_twice", "Twice Fan");
    // A nobody's sale 16 days ago, counted by Anna's word in her report of that day.
    const sale = await insertSale({ pageId: soloPage, fanId: fanTwice, ref: "h8-twice", netMills: 36_000, occurredAt: at(16 * 24), home: "nobody", reason: "no_holder" });
    const first = await insertShift(users.anna!, "solo-1", at(16 * 24 - 1), at(16 * 24 - 2));
    expect((await rawSession("anna", "POST", `/api/v1/shift-reports/${first}/report-sale`, { transactionRef: "h8-twice", note: "мой фан" })).statusCode).toBe(200);
    await handInAndConfirm(asSession, "anna", first);
    expect(await newestLine(first, sale)).toMatchObject({ amountMills: 36_000, disputed: false });

    // The owner's chain and list show the report that counts it; the list's nobody's sales leave it out.
    const reportLink = `/workboard/report/${first}?sale=${sale}`;
    const chain = (await rawSession("boss", "GET", `/api/v1/sales/chain?saleId=${sale}`)).json() as { people: Array<{ userId: number; report: { link: string | null } }> };
    expect(chain.people).toEqual([expect.objectContaining({ userId: users.anna!, report: expect.objectContaining({ link: reportLink }) })]);
    const day = moscowDayOfMs(Date.parse(at(16 * 24)));
    const listOf = async (home: string) => (await rawSession("boss", "GET", `/api/v1/team/sales/list?from=${day}&to=${day}&home=${home}`)).json() as {
      sales: Array<{ transactionId: number; report: { link: string | null } }>;
    };
    expect((await listOf("all")).sales.find((one) => one.transactionId === sale)?.report.link).toBe(reportLink);
    expect((await listOf("nobody")).sales.map((one) => one.transactionId)).not.toContain(sale);

    // More than 10 days on, «Добавить продажу» on a new shift refuses it as it refuses a sale that does not exist.
    const second = await insertShift(users.anna!, "solo-1", at(26), at(25));
    const missing = await rawSession("anna", "POST", `/api/v1/shift-reports/${second}/report-sale`, { transactionRef: "h8-twice-missing", note: "мой фан" });
    const again = await rawSession("anna", "POST", `/api/v1/shift-reports/${second}/report-sale`, { transactionRef: "h8-twice", note: "мой фан" });
    expect(again.statusCode).toBe(404);
    expect(again.body).toBe(missing.body);

    // A «моё» on it there all the same (a word written before the refusal): «уже в отчёте», it counts 0.
    const person = await findHandinPersonOfUser(app.db, users.anna!);
    const handin = await ensureHandin(app.db, { shiftId: second, userId: users.anna!, personId: person!.personId, reportDate: moscowDayOfMs(Date.parse(at(26))) });
    await setHandinMark(app.db, { handinId: handin.id, transactionId: sale, statement: "mine", shareWithUserId: null, note: "мой фан", byUserId: users.anna!, byAgentKeyId: null, at: new Date() });
    const draft = shiftReportResponseSchema.parse((await rawSession("anna", "GET", `/api/v1/shift-reports/${second}`)).json());
    expect(draft.view?.lines.find((line) => line.transactionId === sale)).toMatchObject({ statement: "mine", amountMills: 0, alreadyIn: { shiftId: first } });
    await handInAndConfirm(asSession, "anna", second);
    expect(await newestLine(second, sale)).toMatchObject({ amountMills: 0 });
    expect(await newestLine(first, sale)).toMatchObject({ amountMills: 36_000 });
  });

  it("enforces agent key page grants on shift-report draft reads and line writes even when the chatter has a solo page", async (context) => {
    if (!testDb) return context.skip();
    const narrowKey = `${AGENT_KEY_TOKEN_PREFIX}h8-narrow-shared-only`;
    await insertAgentKey(testDb.db, {
      name: "h8-narrow-shared-only",
      keyPrefix: narrowKey.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(narrowKey),
      capabilities: ["write:shift_reports"] as never,
      pageIds: [sharedPage],
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      createdBy: users.boss!,
    });
    const day = "2026-11-23";
    // Anna's shift row only records shared-1 (so a shared-1-only agent key passes readableSubject),
    // while her schedule slot (page_id=NULL -> all working pages) adds solo-1 where she is the sole worker.
    await testDb.pool.query(
      `insert into person_schedule_slots (person_id, page_id, start_minute, end_minute)
       select id, null, 600, 1080 from people where code = 'anna'`,
    );
    const shiftId = await insertShift(users.anna!, "shared-1", `${day}T10:00:00+03:00`, `${day}T18:00:00+03:00`, "going");
    const soloNobody = await insertSale({
      pageId: soloPage, fanId: fanAlpha, ref: "h8-grant-solo-nobody", netMills: 42_000,
      occurredAt: `${day}T06:00:00+03:00`, home: "nobody", reason: "no_holder",
    });

    // Anna herself sees the solo-1 nobody sale in «Рядом» on her shift report draft.
    const annaDraft = shiftReportResponseSchema.parse(
      (await rawSession("anna", "GET", `/api/v1/shift-reports/${shiftId}`)).json(),
    );
    expect(annaDraft.view?.lines.some((line) => line.transactionId === soloNobody)).toBe(true);

    // An agent key granted ONLY shared-1 must NOT see solo-1 or its sale in the draft.
    const agentDraftRes = await server!.inject({
      method: "GET",
      url: `/api/v1/agent/shift-reports/draft?shiftId=${shiftId}`,
      headers: { authorization: `Bearer ${narrowKey}` },
    });
    expect(agentDraftRes.statusCode, agentDraftRes.body).toBe(200);
    const agentDraft = shiftReportResponseSchema.parse(agentDraftRes.json());
    expect(agentDraft.view?.lines.some((line) => line.transactionId === soloNobody)).toBe(false);
    expect(agentDraft.view?.pages.map((p) => p.pageLabel)).not.toContain("solo-1");

    // And the narrow agent key cannot mutate the out-of-grant solo-1 sale line either.
    const mutateRes = await server!.inject({
      method: "POST",
      url: "/api/v1/agent/shift-reports/line",
      headers: { authorization: `Bearer ${narrowKey}` },
      payload: {
        shiftId,
        transactionId: soloNobody,
        statement: "mine",
        telegramUserId: ANNA_TG,
        sourceRef: "https://t.me/c/1/999",
      },
    });
    expect(mutateRes.statusCode).toBe(404);
  });

});
