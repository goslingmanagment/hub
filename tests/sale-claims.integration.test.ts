import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { saleClaimAnswerResponseSchema, saleDisputeResponseSchema, shiftReportResponseSchema } from "@agency_hub_core/contracts";
import { assignUserToPage, createFanslyPage, createModel, insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { runSaleClaims } from "../apps/runtime/src/services/sale-claims.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Заявки и договорённости (package G): who answers a claim, who decides a dispute, who sees what, and what the
// settlement writes. The other side alone answers; a colleague, the claimant, a team lead, a chatter of another page
// and the owner cannot answer for them; an agent «со слов» only with the message and the side as its sender. Only the
// owner reads and decides a dispute; the decision gives each counting report a new version with what it gives, the odd
// mill as the rule gives it. A chatter's matters carry only the sale's amount, and a chatter of another page sees
// nothing of it. Money and rights: required.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const SENDER_B = 700_000_222;
const KEYS = {
  none: `${AGENT_KEY_TOKEN_PREFIX}claims-no-capability`,
  writer: `${AGENT_KEY_TOKEN_PREFIX}claims-writer-key`,
  reader: `${AGENT_KEY_TOKEN_PREFIX}claims-reader-key`,
  elsewhere: `${AGENT_KEY_TOKEN_PREFIX}claims-other-page`,
  ledger: `${AGENT_KEY_TOKEN_PREFIX}claims-ledger-key`,
  matters: `${AGENT_KEY_TOKEN_PREFIX}claims-matters-key`,
} as const;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
let pageOne = 0;
let shiftA = 0;
let shiftB = 0;
let anna = 0;
let bella = 0;

const asSession = (who: string, method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });
const asKey = (key: keyof typeof KEYS, method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { authorization: `Bearer ${KEYS[key]}` }, ...(payload ? { payload } : {}) });

async function insertShift(userId: number, page: string, startedAt: string, endedAt: string): Promise<number> {
  const result = await testDb!.pool.query(
    `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages)
     values ($1, 'closed', $2::timestamptz, $3::timestamptz, 400, 300, $4::date, $5::jsonb) returning id`,
    [userId, startedAt, endedAt, startedAt.slice(0, 10), JSON.stringify([{ pageLabel: page, activeMinutes: 400, messages: 300, salesFrom: startedAt }])],
  );
  return Number(result.rows[0].id);
}

/** A sale of mia-1 an hour ago whose home by the rule is bella's shift. */
async function bellasSale(ref: string, net: number): Promise<number> {
  const inserted = await testDb!.pool.query(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
     values ($1, $2, 'subscription', 'subscription', 'posted', 'ok', $3, $3, $4, $5, now() - interval '1 hour', 'fansly:rest', 'USD')
     returning id, occurred_at`,
    [pageOne, ref, net + 4_000, net, 4_000],
  );
  const id = Number(inserted.rows[0].id);
  await testDb!.pool.query(
    `insert into sale_homes (transaction_id, page_id, occurred_at, net_mills, home, reason, shares, rule_version, computed_at)
     values ($1, $2, $3, $4, 'shift', 'holder', $5::jsonb, 'test', now())`,
    [id, pageOne, inserted.rows[0].occurred_at, net, JSON.stringify([{ userId: bella, workRef: null, shiftId: shiftB, percent: 100, mills: net }])],
  );
  return id;
}

/** anna says «моё» of a sale by hand and hands her shift in: a claim against bella. */
async function annaClaims(sale: number, why: string): Promise<number> {
  const said = await asSession("anna", "PUT", `/api/v1/shift-reports/${shiftA}/lines/${sale}`, { statement: "mine", note: why });
  expect(said.statusCode, said.body).toBe(200);
  const submitted = await asSession("anna", "POST", `/api/v1/shift-reports/${shiftA}/submit`);
  expect(submitted.statusCode, submitted.body).toBe(200);
  await runSaleClaims(app);
  const claim = await testDb!.pool.query("select id, state, side_user_id from sale_claims where transaction_id = $1", [sale]);
  expect(claim.rows).toHaveLength(1);
  expect(claim.rows[0]).toMatchObject({ state: "asked" });
  expect(Number(claim.rows[0].side_user_id)).toBe(bella);
  return Number(claim.rows[0].id);
}

async function newestLine(shiftId: number, sale: number) {
  const row = await testDb!.pool.query(
    `select v.version, v.total_mills, v.made_for, v.door, line
     from shift_handins h join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version
     cross join lateral jsonb_array_elements(v.lines) as line
     where h.shift_id = $1 and (line ->> 'transactionId')::bigint = $2`,
    [shiftId, sale],
  );
  return row.rows[0] as { version: number; total_mills: string; made_for: Record<string, unknown> | null; door: string; line: Record<string, unknown> } | undefined;
}

describe("claims of a sale: who answers, who decides, who sees", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    await createUserAccount(app, { username: "lead", role: "team_lead", password: "lead-password-for-tests" }, { source: "cli" });
    for (const name of ["anna", "bella", "cora", "dina"]) {
      await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
      await setUserPassword(app, { userId: await fixtureUserId(app, name), password: `${name}-password-for-tests` }, { source: "cli" });
    }
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    pageOne = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    const two = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-2" }))!.id;
    for (const [name, page] of [["anna", pageOne], ["bella", pageOne], ["dina", pageOne], ["cora", two], ["lead", pageOne]] as const) {
      await assignUserToPage(app.db, await fixtureUserId(app, name), page);
    }
    const owner = await fixtureUserId(app, "boss");
    const grants: Record<keyof typeof KEYS, { capabilities: string[]; pages: number[] }> = {
      none: { capabilities: ["read:money"], pages: [pageOne, two] },
      writer: { capabilities: ["write:shift_reports"], pages: [pageOne, two] },
      reader: { capabilities: ["read:team"], pages: [pageOne, two] },
      elsewhere: { capabilities: ["read:team"], pages: [two] },
      ledger: { capabilities: ["read:team", "read:money"], pages: [pageOne, two] },
      matters: { capabilities: ["write:matters"], pages: [pageOne, two] },
    };
    for (const [name, token] of Object.entries(KEYS) as [keyof typeof KEYS, string][]) {
      await insertAgentKey(testDb.db, {
        name: `claims-${name}`,
        keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
        keyDigest: sha256Hex(token),
        capabilities: grants[name].capabilities as never,
        pageIds: grants[name].pages,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        createdBy: owner,
      });
    }
    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["boss", "lead", "anna", "bella", "cora", "dina"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[user] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    }
    const person = async (code: string, rights: string[], telegram?: number) => {
      const created = await asSession("boss", "POST", "/api/v1/admin/people", {
        code, displayName: code, role: "chatter", state: "working", rights,
        ...(telegram === undefined ? {} : { telegram: { userId: telegram } }),
        logins: { add: [await fixtureUserId(app, code)] },
      });
      expect(created.statusCode, created.body).toBe(200);
    };
    await person("anna", ["submits_shift"]);
    await person("bella", ["submits_shift"], SENDER_B);
    await person("cora", ["submits_shift"]);
    await person("dina", []);
    await testDb.pool.query("update person_rights set granted_at = '2026-11-01T00:00:00Z'");
    anna = await fixtureUserId(app, "anna");
    bella = await fixtureUserId(app, "bella");
    shiftA = await insertShift(anna, "mia-1", "2026-11-10T15:00:00Z", "2026-11-10T23:00:00Z");
    shiftB = await insertShift(bella, "mia-1", "2026-11-10T07:00:00Z", "2026-11-10T15:00:00Z");
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("asks the other side alone, and shows a chatter of another page nothing", async (context) => {
    if (!testDb) return context.skip();
    const sale = await bellasSale("tx-claim-one", 16_001);
    const claimId = await annaClaims(sale, "договорились вчера в чате");

    // The other side's matter: the sale's amount, no money of anyone's pay; a chatter of another page sees none.
    const mine = await asSession("bella", "GET", "/api/v1/matters?state=open");
    expect(mine.statusCode, mine.body).toBe(200);
    const matter = mine.json().matters.find((one: { kind: string }) => one.kind === "sale.claim");
    expect(matter).toMatchObject({ money: false, link: `/workboard/my/shifts/${shiftB}?sale=${sale}` });
    for (const who of ["cora", "dina", "anna"]) {
      const list = (await asSession(who, "GET", "/api/v1/matters?state=open")).json().matters as Array<{ kind: string }>;
      expect(list.some((one) => one.kind === "sale.claim")).toBe(false);
    }
    // bella's report shows it on the line, to answer; cora (another page) cannot open bella's report at all.
    const report = shiftReportResponseSchema.parse((await asSession("bella", "GET", `/api/v1/shift-reports/${shiftB}`)).json());
    expect(report.claims).toEqual([expect.objectContaining({ id: claimId, direction: "incoming", canAnswer: true, statement: "mine", note: "договорились вчера в чате" })]);
    expect((await asSession("cora", "GET", `/api/v1/shift-reports/${shiftB}`)).statusCode).toBe(403);
    // anna sees where her claim stands, and cannot answer it.
    const own = shiftReportResponseSchema.parse((await asSession("anna", "GET", `/api/v1/shift-reports/${shiftA}`)).json());
    expect(own.claims).toEqual([expect.objectContaining({ id: claimId, direction: "outgoing", canAnswer: false, state: "asked" })]);

    // Nobody but the other side answers: the claimant, a colleague, another page, a team lead, the owner.
    for (const who of ["anna", "dina", "cora", "lead", "boss"]) {
      const refused = await asSession(who, "POST", `/api/v1/sale-claims/${claimId}/answer`, { answer: "agree" });
      expect(refused.statusCode, `${who}: ${refused.body}`).toBe(403);
    }
    // «Не согласен» needs a line of why.
    expect((await asSession("bella", "POST", `/api/v1/sale-claims/${claimId}/answer`, { answer: "disagree" })).statusCode).toBe(400);

    // An agent: only with write:shift_reports, the message, and bella as its sender.
    expect((await asKey("none", "POST", "/api/v1/agent/sale-claims/answer", { claimId, answer: "agree", telegramUserId: SENDER_B, sourceRef: "chat:1" })).statusCode).toBe(403);
    expect((await asKey("writer", "POST", "/api/v1/agent/sale-claims/answer", { claimId, answer: "agree", telegramUserId: SENDER_B })).statusCode).toBe(400);
    const stranger = await asKey("writer", "POST", "/api/v1/agent/sale-claims/answer", { claimId, answer: "agree", telegramUserId: SENDER_B + 1, sourceRef: "chat:2" });
    expect(stranger.statusCode).toBe(409);
    expect(stranger.json().reason).toBe("sender_not_person");

    // Agents read the claims of a sale on their pages only.
    const read = await asKey("reader", "GET", `/api/v1/agent/sale-claims?transactionId=${sale}`);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().claims).toEqual([expect.objectContaining({ id: claimId, state: "asked" })]);
    expect((await asKey("elsewhere", "GET", `/api/v1/agent/sale-claims?transactionId=${sale}`)).json().claims).toEqual([]);
    expect((await asKey("none", "GET", `/api/v1/agent/sale-claims?transactionId=${sale}`)).statusCode).toBe(403);
  });

  it("takes «Не согласен» to the owner alone, and the owner's «пополам» gives each report its half", async (context) => {
    if (!testDb) return context.skip();
    const sale = String((await testDb.pool.query("select id from transactions where transaction_id = 'tx-claim-one'")).rows[0].id);
    const claimId = String((await testDb.pool.query("select id from sale_claims where transaction_id = $1", [sale])).rows[0].id);
    const answered = await asSession("bella", "POST", `/api/v1/sale-claims/${claimId}/answer`, { answer: "disagree", note: "фан мой, писала ему последней" });
    expect(answered.statusCode, answered.body).toBe(200);
    expect(saleClaimAnswerResponseSchema.parse(answered.json()).claim).toMatchObject({ state: "owner", answer: "disagree" });
    // Answered once: not again.
    expect((await asSession("bella", "POST", `/api/v1/sale-claims/${claimId}/answer`, { answer: "agree" })).statusCode).toBe(409);
    // ONE matter for the owner; the side's matter closed.
    const matters = await testDb.pool.query("select kind, state, owner_role, money from matters where kind in ('sale.claim', 'sale.dispute') order by kind");
    expect(matters.rows).toEqual([
      { kind: "sale.claim", state: "closed", owner_role: null, money: false },
      { kind: "sale.dispute", state: "open", owner_role: "owner", money: true },
    ]);

    // Only the owner reads and decides it.
    for (const who of ["anna", "bella", "lead"]) {
      expect((await asSession(who, "GET", `/api/v1/sale-disputes/${sale}`)).statusCode).toBe(403);
      expect((await asSession(who, "POST", "/api/v1/sale-disputes/decide", { transactionId: Number(sale), outcome: "first" })).statusCode).toBe(403);
    }
    const dispute = saleDisputeResponseSchema.parse((await asSession("boss", "GET", `/api/v1/sale-disputes/${sale}`)).json());
    // anna's «моё» counts nothing while it is disputed: it claims the net (review R2b-2).
    expect(dispute.parties.map((one) => [one.userId, one.role, one.countedMills, one.claimedMills])).toEqual([[anna, "first", 0, 16_001], [bella, "second", null, null]]);
    expect(dispute.outcomes.map((one) => one.outcome)).toEqual(["first", "second", "half", "nobody"]);
    // «Пополам» splits 16.001 as the rule does: the odd mill to the lower user id.
    const half = dispute.outcomes.find((one) => one.outcome === "half")!.gives;
    const low = Math.min(anna, bella);
    expect(half.find((one) => one.userId === low)!.mills).toBe(8_001);
    expect(half.reduce((sum, one) => sum + one.mills, 0)).toBe(16_001);

    const decided = await asSession("boss", "POST", "/api/v1/sale-disputes/decide", { transactionId: Number(sale), outcome: "half", note: "вели вдвоём" });
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json().versions).toEqual([{ shiftId: shiftA, version: 2 }]);
    // anna's report: a new version made by the system, her half, no longer disputed, the reason kept.
    const line = await newestLine(shiftA, Number(sale));
    expect(line).toMatchObject({ version: 2, door: "workboard", made_for: { kind: "claim", outcome: "half" } });
    expect(line!.line).toMatchObject({ amountMills: anna === low ? 8_001 : 8_000, disputed: false, settled: "owner" });
    // The page's sum is its lines rounded to the cent: $8.00 either way.
    expect(Number(line!.total_mills)).toBe(8_000);
    const decision = await testDb.pool.query("select kind, shares, outcome, note, state, decided_by_user_id from sale_owner_decisions where transaction_id = $1", [sale]);
    expect(decision.rows).toEqual([expect.objectContaining({ kind: "split", outcome: "half", note: "вели вдвоём", state: "active" })]);
    expect(Number(decision.rows[0].decided_by_user_id)).toBe(await fixtureUserId(app, "boss"));
    expect((await testDb.pool.query("select state from matters where kind = 'sale.dispute'")).rows).toEqual([{ state: "closed" }]);
    // The ledger's feed serves the system's version with why it was made.
    const feed = await asKey("ledger", "GET", "/api/v1/agent/shift-reports?limit=50");
    expect(feed.statusCode, feed.body).toBe(200);
  });

  it("settles a claim when the other side agrees: the claimant's line stops being disputed", async (context) => {
    if (!testDb) return context.skip();
    const sale = await bellasSale("tx-claim-two", 20_000);
    const claimId = await annaClaims(sale, "мой постоянный");
    const agreed = await asSession("bella", "POST", `/api/v1/sale-claims/${claimId}/answer`, { answer: "agree" });
    expect(agreed.statusCode, agreed.body).toBe(200);
    expect(agreed.json().claim).toMatchObject({ state: "agreed", answer: "agree" });
    const line = await newestLine(shiftA, sale);
    expect(line!.made_for).toMatchObject({ kind: "claim", outcome: "agreed" });
    expect(line!.line).toMatchObject({ amountMills: 20_000, disputed: false, settled: "agreed" });
    expect((await testDb.pool.query("select state from matters where reason_key = $1", [`sale.claim:${claimId}`])).rows).toEqual([{ state: "closed" }]);
  });

  it("lets only the owner confirm «мимо площадки»; a confirmed amount enters its page's sum as a new version", async (context) => {
    if (!testDb) return context.skip();
    const added = await asSession("anna", "POST", `/api/v1/shift-reports/${shiftA}/off-platform`, { amountMills: 50_000, fromWhom: "фан", whatFor: "кастом" });
    expect(added.statusCode, added.body).toBe(200);
    expect((await asSession("anna", "POST", `/api/v1/shift-reports/${shiftA}/submit`)).statusCode).toBe(200);
    const id = added.json().line.id as number;
    for (const who of ["anna", "bella", "lead"]) {
      expect((await asSession(who, "POST", `/api/v1/off-platform/${id}/decide`, { decision: "confirm" })).statusCode).toBe(403);
    }
    await runSaleClaims(app);
    expect((await testDb.pool.query("select state from matters where kind = 'off_platform.pending'")).rows).toEqual([{ state: "open" }]);
    const before = await testDb.pool.query("select v.total_mills from shift_handins h join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version where h.shift_id = $1", [shiftA]);
    const confirmed = await asSession("boss", "POST", `/api/v1/off-platform/${id}/decide`, { decision: "confirm", pageLabel: "mia-1" });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const after = await testDb.pool.query(
      "select v.total_mills, v.made_for, v.off_platform from shift_handins h join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version where h.shift_id = $1",
      [shiftA],
    );
    expect(Number(after.rows[0].total_mills)).toBe(Number(before.rows[0].total_mills) + 50_000);
    expect(after.rows[0].made_for).toMatchObject({ kind: "off_platform", decision: "confirmed" });
    expect(after.rows[0].off_platform).toEqual([expect.objectContaining({ id, state: "confirmed", pageLabel: "mia-1" })]);
    expect((await testDb.pool.query("select state from matters where kind = 'off_platform.pending'")).rows).toEqual([{ state: "closed" }]);
    // Decided once.
    expect((await asSession("boss", "POST", `/api/v1/off-platform/${id}/decide`, { decision: "reject" })).statusCode).toBe(409);
  });

  it("refuses an agent key the claims' matter kinds", async (context) => {
    if (!testDb) return context.skip();
    for (const kind of ["sale.claim", "sale.dispute", "off_platform.pending", "sale.nobody_week"]) {
      const opened = await asKey("matters", "POST", "/api/v1/agent/matters", { key: `${kind}:1`, kind, title: "x", owner: { role: "owner" } });
      expect(opened.statusCode, opened.body).toBe(409);
      expect(opened.json().reason).toBe("matter_not_agents");
    }
  });
});
