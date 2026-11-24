import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { saleNobodyResponseSchema, shiftReportResponseSchema } from "@agency_hub_core/contracts";
import { assignUserToPage, createFanslyPage, createModel, insertAgentKey } from "@agency_hub_core/db";
import { moscowDayOfMs, sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { cancelSaleDecisionApplied } from "../apps/runtime/src/services/sale-claims.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { editingSession, handInAndConfirm } from "./helpers/shift-report-hand-in.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Wave 2 PR H8: nobody's sales are hidden from chatters and team leads across all 4 reads (before LIMIT/OFFSET);
// «Моё» on a nobody sale counts 0 (disputed) and opens an owner claim without a respondent; «Сообщить владельцу»
// matches strictly 1 sale within caller's granted pages and realm with byte-identical refusal on 0 / >1 / outside-grant
// / cross-realm; owner sees ALL open nobody sales regardless of week close with live solo-page suggestion; «Отдать <имя>»
// delivers to open draft, submitted report (system version), or next shift (cancel before next shift leaves nothing).
// Synthetic names, pages, fans and amounts only.

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
  home: "nobody" | "shift" | "decide";
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
    const register = async (body: Record<string, unknown>) => {
      const res = await rawSession("boss", "POST", "/api/v1/admin/people", body);
      expect(res.statusCode, res.body).toBe(200);
    };
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

  it("hides nobody sales from chatters and team leads across all 4 reads (team list, draft, claimable, saleChain) while owner sees all", async (context) => {
    if (!testDb) return context.skip();
    const now = Date.now();
    const shiftStart = new Date(now - 3 * 3_600_000).toISOString();
    const shiftEnd = new Date(now - 30 * 60_000).toISOString();
    const shiftAnna = await insertShift(users.anna!, "solo-1", shiftStart, shiftEnd);

    const visibleSale = await insertSale({
      pageId: soloPage, fanId: fanAlpha, ref: "h8-vis-1", netMills: 20_000,
      occurredAt: new Date(now - 2 * 3_600_000).toISOString(),
      home: "shift", reason: "holder",
      shares: [{ userId: users.anna!, workRef: null, shiftId: shiftAnna, percent: 100, mills: 20_000 }],
    });
    const hiddenNobody = await insertSale({
      pageId: soloPage, fanId: fanAlpha, ref: "h8-hid-1", netMills: 35_000,
      occurredAt: new Date(now - 90 * 60_000).toISOString(),
      home: "nobody", reason: "no_holder",
    });

    const today = moscowDayOfMs(now);
    const yesterday = moscowDayOfMs(now - 86_400_000);

    // 1. Team sales list & counts: hidden for chatter & team lead, visible for owner.
    for (const viewer of ["anna", "lena"] as const) {
      const listAll = await rawSession(viewer, "GET", `/api/v1/team/sales/list?from=${yesterday}&to=${today}&home=all`);
      expect(listAll.statusCode, listAll.body).toBe(200);
      const bodyAll = listAll.json() as { sales: Array<{ transactionId: number }>; counts: Record<string, number> };
      expect(bodyAll.sales.map((one) => one.transactionId)).toContain(visibleSale);
      expect(bodyAll.sales.map((one) => one.transactionId)).not.toContain(hiddenNobody);
      expect(bodyAll.counts.nobody).toBe(0);

      const listNobody = await rawSession(viewer, "GET", `/api/v1/team/sales/list?from=${yesterday}&to=${today}&home=nobody`);
      expect(listNobody.statusCode).toBe(200);
      expect((listNobody.json() as { sales: unknown[] }).sales).toEqual([]);
    }
    const bossList = await rawSession("boss", "GET", `/api/v1/team/sales/list?from=${yesterday}&to=${today}&home=nobody`);
    expect(bossList.statusCode, bossList.body).toBe(200);
    const bossBody = bossList.json() as { sales: Array<{ transactionId: number }>; counts: Record<string, number> };
    expect(bossBody.sales.map((one) => one.transactionId)).toContain(hiddenNobody);
    expect(bossBody.counts.nobody).toBeGreaterThanOrEqual(1);

    // 2. Shift report draft: nobody sale hidden from «Рядом» (near).
    const draft = await rawSession("anna", "GET", `/api/v1/shift-reports/${shiftAnna}`);
    expect(draft.statusCode, draft.body).toBe(200);
    const draftBody = shiftReportResponseSchema.parse(draft.json());
    expect(draftBody.view?.lines.map((line) => line.transactionId)).not.toContain(hiddenNobody);

    // 3. Add-sale claimable list: hidden for human & agent doors, and direct lineSet on hidden nobody returns 404.
    const claimable = await rawSession("anna", "GET", `/api/v1/shift-reports/${shiftAnna}/claimable`);
    expect(claimable.statusCode, claimable.body).toBe(200);
    expect((claimable.json() as { sales: Array<{ transactionId: number }> }).sales.map((s) => s.transactionId)).not.toContain(hiddenNobody);

    const directClaim = await asSession("anna", "PUT", `/api/v1/shift-reports/${shiftAnna}/lines/${hiddenNobody}`, { statement: "mine", note: "пытаюсь добавить" });
    expect(directClaim.statusCode).toBe(404);

    // 4. Direct saleChain: 404 for chatter and team lead, 200 for owner.
    expect((await rawSession("anna", "GET", `/api/v1/sales/chain?saleId=${hiddenNobody}`)).statusCode).toBe(404);
    expect((await rawSession("lena", "GET", `/api/v1/sales/chain?saleId=${hiddenNobody}`)).statusCode).toBe(404);
    expect((await rawSession("boss", "GET", `/api/v1/sales/chain?saleId=${hiddenNobody}`)).statusCode).toBe(200);
  });

  it("supports «Сообщить владельцу» (human + agent doors) with identical 0/>1/cross-realm refusal and opens disputed $0 line + owner claim", async (context) => {
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
    const uniqueHuman = await insertSale({ pageId: soloPage, fanId: fanAlpha, ref: "h8-rep-human", netMills: 42_000, occurredAt: new Date(now - 70 * 60_000).toISOString(), home: "nobody", reason: "no_holder" });
    const uniqueAgent = await insertSale({ pageId: sharedPage, fanId: fanBeta, ref: "h8-rep-agent", netMills: 53_000, occurredAt: new Date(now - 60 * 60_000).toISOString(), home: "nobody", reason: "no_holder" });
    await insertSale({ pageId: otherPage, fanId: fanOther, ref: "h8-other-grant", netMills: 61_000, occurredAt: new Date(now - 50 * 60_000).toISOString(), home: "nobody", reason: "no_holder" });
    await insertSale({ pageId: testPage, fanId: fanTest, ref: "h8-test-realm", netMills: 71_000, occurredAt: new Date(now - 40 * 60_000).toISOString(), home: "nobody", reason: "no_holder" });

    // 0 matches, >1 matches, out-of-grant, cross-realm: byte-identical 404 body with NO candidate list!
    const rZero = await rawSession("anna", "POST", `/api/v1/shift-reports/${shiftAnna}/report-sale`, { transactionRef: "h8-missing", note: "моя" });
    const rAmbig = await rawSession("anna", "POST", `/api/v1/shift-reports/${shiftAnna}/report-sale`, { fan: "fan_alpha", amountMills: 15_000, note: "моя" });
    const rOther = await rawSession("anna", "POST", `/api/v1/shift-reports/${shiftAnna}/report-sale`, { transactionRef: "h8-other-grant", note: "моя" });
    const rRealm = await rawSession("anna", "POST", `/api/v1/shift-reports/${shiftAnna}/report-sale`, { transactionRef: "h8-test-realm", note: "моя" });
    for (const res of [rZero, rAmbig, rOther, rRealm]) {
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(rZero.body);
      expect(res.json()).toMatchObject({ reason: "sale_not_matched" });
    }

    // Exact 1 match via human door (transactionRef): disputed $0 line + owner claim without respondent.
    const okHuman = await rawSession("anna", "POST", `/api/v1/shift-reports/${shiftAnna}/report-sale`, {
      transactionRef: "h8-rep-human", note: "общалась с фаном в чате",
    });
    expect(okHuman.statusCode, okHuman.body).toBe(200);
    expect(okHuman.json()).toMatchObject({ transactionId: uniqueHuman });

    const draft = shiftReportResponseSchema.parse((await rawSession("anna", "GET", `/api/v1/shift-reports/${shiftAnna}`)).json());
    const reportedLine = draft.view?.lines.find((line) => line.transactionId === uniqueHuman);
    expect(reportedLine).toMatchObject({
      group: "mine", statement: "mine", amountMills: 0, disputed: true, claimedMills: 42_000,
    });

    const claims = await testDb.pool.query(
      "select state, side_user_id, escalated_why, origin from sale_claims where transaction_id = $1",
      [uniqueHuman],
    );
    expect(claims.rows).toHaveLength(1);
    expect(claims.rows[0]).toMatchObject({ state: "owner", side_user_id: null, escalated_why: "no_side", origin: "draft" });

    // Caller with their own claim CAN now read saleChain; team lead still cannot.
    expect((await rawSession("anna", "GET", `/api/v1/sales/chain?saleId=${uniqueHuman}`)).statusCode).toBe(200);
    expect((await rawSession("lena", "GET", `/api/v1/sales/chain?saleId=${uniqueHuman}`)).statusCode).toBe(404);

    // Exact 1 match via agent door (fan + amountMills).
    const okAgent = await asAgent("POST", "/api/v1/agent/shift-reports/report-sale", {
      shiftId: shiftAnna, fan: "@fan_beta", amountMills: 53_000, note: "купил по моей рассылке", telegramUserId: ANNA_TG,
    });
    expect(okAgent.statusCode, okAgent.body).toBe(200);
    expect(okAgent.json()).toMatchObject({ transactionId: uniqueAgent });
    const agentClaim = await testDb.pool.query("select state, side_user_id from sale_claims where transaction_id = $1", [uniqueAgent]);
    expect(agentClaim.rows).toMatchObject([{ state: "owner", side_user_id: null }]);
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
});
