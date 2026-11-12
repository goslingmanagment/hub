import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { saleChainResponseSchema, type SaleChainResponse } from "@agency_hub_core/contracts";
import { assignUserToPage, createFanslyPage, createModel, insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { readSaleChain } from "../apps/runtime/src/services/sale-chain.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { listenOnLoopback } from "./helpers/network.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Цепочка продажи (package T): who reads a sale's chain and how much of it. The owner every sale with the pay sums; a
// chatter only a sale of their own shifts (their own person alone, pay sums only with «видит свои деньги»); a team lead
// a sale of their pages without anyone's pay, not even its states; an agent key read:team + read:money, its pages,
// without pay sums. Another
// sale is 404. A ledger that is not connected or does not answer is «неизвестно», never «оплачено». Money and rights.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const KEYS = {
  chain: `${AGENT_KEY_TOKEN_PREFIX}chain-team-money`,
  team: `${AGENT_KEY_TOKEN_PREFIX}chain-team-only`,
  elsewhere: `${AGENT_KEY_TOKEN_PREFIX}chain-other-page`,
} as const;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let ledger: Server | null = null;
/** The ledger answers 500 to every read (it is down). */
let broken = false;
/** How many times a person's pay was asked of the ledger. */
let payReads = 0;
const cookies: Record<string, string> = {};
let pageOne = 0;
let pageTwo = 0;
const sales = { anna: 0, bella: 0, other: 0, nobody: 0 };

/** The ledger's GET /v1/payouts/person: anna's day of 10 Nov paid, bella's to pay. */
function ledgerPay(person: string, from: string, to: string) {
  const paid = person === "anna";
  return {
    ok: true, person, name: person, from, to, accrualFrom: "2026-09-01", factsFrom: "", reportsFrom: "2026-11-09",
    generatedAt: "2026-11-12T10:00:00Z",
    accruedMicros: 40_000_000, paidMicros: paid ? 40_000_000 : 0, balanceMicros: paid ? 0 : 40_000_000,
    oldestUnpaidDate: paid ? null : "2026-11-10",
    lastPayout: paid ? { date: "2026-11-11", document: 412, amountMicros: 40_000_000 } : null,
    days: [{
      date: "2026-11-10", model: "Mia", amountMicros: 40_000_000, worked: true, source: "reports", posts: [8],
      state: paid ? "paid" : "to_pay", paidMicros: paid ? 40_000_000 : 0, unpaidMicros: paid ? 0 : 40_000_000, paidBy: paid ? [412] : [],
    }],
    adjustments: [],
    payouts: paid ? [{ date: "2026-11-11", document: 412, amountMicros: 40_000_000 }] : [],
    checks: { stale: false, lastRebuildAt: "2026-11-12T09:30:00Z" },
  };
}

async function insertShift(userId: number, page: string, startedAt: string, endedAt: string): Promise<number> {
  const result = await testDb!.pool.query(
    `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages)
     values ($1, 'closed', $2::timestamptz, $3::timestamptz, 480, 300, $4::date, $5::jsonb) returning id`,
    [userId, startedAt, endedAt, startedAt.slice(0, 10), JSON.stringify([{ pageLabel: page, activeMinutes: 480, messages: 300, salesFrom: startedAt }])],
  );
  return Number(result.rows[0].id);
}

/** A sale and its home by the rule: one person's shift, or nobody's. */
async function insertSale(pageId: number, ref: string, net: number, at: string, home: { userId: number; shiftId: number } | "nobody"): Promise<number> {
  const inserted = await testDb!.pool.query(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
     values ($1, $2, 'tip', 'tip', 'posted', 'ok', $3, $3, $4, $5, $6::timestamptz, 'fansly:rest', 'USD') returning id`,
    [pageId, ref, net + 4_000, net, 4_000, at],
  );
  const id = Number(inserted.rows[0].id);
  const shares = home === "nobody" ? [] : [{ userId: home.userId, workRef: null, shiftId: home.shiftId, percent: 100, mills: net }];
  await testDb!.pool.query(
    `insert into sale_homes (transaction_id, page_id, occurred_at, net_mills, home, reason, shares, rule_version, computed_at)
     values ($1, $2, $3::timestamptz, $4, $5, $6, $7::jsonb, 'test', now())`,
    [id, pageId, at, net, home === "nobody" ? "nobody" : "shift", home === "nobody" ? "no_holder" : "holder", JSON.stringify(shares)],
  );
  return id;
}

const asSession = (who: string, url: string) => server!.inject({ method: "GET", url, headers: { cookie: cookies[who]! } });
const asKey = (key: keyof typeof KEYS, url: string) => server!.inject({ method: "GET", url, headers: { authorization: `Bearer ${KEYS[key]}` } });

async function chainOf(who: string, sale: number): Promise<SaleChainResponse> {
  const response = await asSession(who, `/api/v1/sales/chain?saleId=${sale}`);
  expect(response.statusCode, `${who}: ${response.body}`).toBe(200);
  return saleChainResponseSchema.parse(response.json());
}

/** No pay sum reached the reader: no amount on accrual and payout, no dollar in their words. */
function expectNoPaySums(chain: SaleChainResponse) {
  for (const person of chain.people) {
    for (const link of [person.accrual, person.payout]) {
      expect(link.amountMills).toBeNull();
      expect(link.words).not.toMatch(/\$/u);
    }
  }
}

describe("a sale's chain of money: who reads it and how much", () => {
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
    pageTwo = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-2" }))!.id;
    for (const [name, page] of [["anna", pageOne], ["bella", pageOne], ["dina", pageOne], ["cora", pageTwo], ["lead", pageOne]] as const) {
      await assignUserToPage(app.db, await fixtureUserId(app, name), page);
    }
    const owner = await fixtureUserId(app, "boss");
    const grants: Record<keyof typeof KEYS, { capabilities: string[]; pages: number[] }> = {
      chain: { capabilities: ["read:team", "read:money"], pages: [pageOne, pageTwo] },
      team: { capabilities: ["read:team"], pages: [pageOne, pageTwo] },
      elsewhere: { capabilities: ["read:team", "read:money"], pages: [pageTwo] },
    };
    for (const [name, token] of Object.entries(KEYS) as [keyof typeof KEYS, string][]) {
      await insertAgentKey(testDb.db, {
        name: `chain-${name}`,
        keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
        keyDigest: sha256Hex(token),
        capabilities: grants[name].capabilities as never,
        pageIds: grants[name].pages,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        createdBy: owner,
      });
    }

    ledger = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://ledger.test");
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      const answer = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.headers.authorization !== "Bearer test-chain-key") return answer(401, { error: "unauthorized" });
      if (broken) return answer(500, { error: "down" });
      if (url.pathname === "/v1/payouts/person") {
        payReads += 1;
        return answer(200, ledgerPay(url.searchParams.get("person") ?? "", from, to));
      }
      if (url.pathname === "/v1/reports") return answer(200, { from, to, reports: [] });
      if (url.pathname === "/v1/report-days") return answer(200, { from, to, days: [] });
      return answer(404, { error: "not found" });
    });
    const address = await listenOnLoopback(ledger, "the fake agency ledger");
    if (!address) {
      ledger.close();
      ledger = null;
      return;
    }
    Object.assign(app.config, { ledgerUrl: `http://${address.host}:${address.port}`, ledgerPayoutsKey: "test-chain-key" });

    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["boss", "lead", "anna", "bella", "cora", "dina"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[user] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    }
    // anna sees her own money; bella does not; cora and dina are people too.
    for (const [code, rights] of [["anna", ["submits_shift", "sees_own_pay"]], ["bella", ["submits_shift"]], ["cora", ["submits_shift"]], ["dina", []]] as const) {
      const created = await server.inject({
        method: "POST", url: "/api/v1/admin/people", headers: { cookie: cookies.boss! },
        payload: { code, displayName: code, role: "chatter", state: "working", rights, logins: { add: [await fixtureUserId(app, code)] } },
      });
      expect(created.statusCode, created.body).toBe(200);
    }
    await testDb.pool.query("update person_rights set granted_at = '2026-11-01T00:00:00Z'");

    // anna and bella hold mia-1 together on the evening of 10 Nov; cora holds mia-2.
    const anna = await fixtureUserId(app, "anna");
    const bella = await fixtureUserId(app, "bella");
    const cora = await fixtureUserId(app, "cora");
    const shiftA = await insertShift(anna, "mia-1", "2026-11-10T15:00:00Z", "2026-11-10T23:00:00Z");
    const shiftB = await insertShift(bella, "mia-1", "2026-11-10T15:00:00Z", "2026-11-10T23:00:00Z");
    const shiftC = await insertShift(cora, "mia-2", "2026-11-10T15:00:00Z", "2026-11-10T23:00:00Z");
    sales.anna = await insertSale(pageOne, "tx-chain-anna", 20_000, "2026-11-10T18:00:00Z", { userId: anna, shiftId: shiftA });
    sales.bella = await insertSale(pageOne, "tx-chain-bella", 12_000, "2026-11-10T19:00:00Z", { userId: bella, shiftId: shiftB });
    sales.other = await insertSale(pageTwo, "tx-chain-other", 9_000, "2026-11-10T19:00:00Z", { userId: cora, shiftId: shiftC });
    sales.nobody = await insertSale(pageOne, "tx-chain-nobody", 7_000, "2026-11-10T13:00:00Z", "nobody");
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await new Promise<void>((resolve) => (ledger ? ledger.close(() => resolve()) : resolve()));
    await testDb?.stop();
  });

  it("gives the owner every link, the pay sums included", async (context) => {
    if (!testDb || !server) return context.skip();
    const chain = await chainOf("boss", sales.anna);
    expect(chain.sale).toMatchObject({ transactionId: sales.anna, pageLabel: "mia-1", netMills: 20_000 });
    expect(chain.home).toMatchObject({ state: "done", kind: "shift" });
    expect(chain.people).toHaveLength(1);
    const [anna] = chain.people;
    expect(anna).toMatchObject({ name: "anna", shareMills: 20_000, reportDate: "2026-11-10" });
    expect(anna!.shift.link).toMatch(/^\/workboard\/shifts\/report\/\d+\?sale=\d+$/u);
    expect(anna!.accrual).toMatchObject({ state: "done", amountMills: 40_000, link: "/workboard/payouts?person=anna" });
    expect(anna!.payout).toMatchObject({ state: "done", amountMills: 40_000 });
    expect(anna!.payout.words).toMatch(/^оплачено/u);
    // Another page's sale and a nobody's sale are the owner's too.
    expect((await chainOf("boss", sales.other)).people).toHaveLength(1);
    const nobody = await chainOf("boss", sales.nobody);
    expect(nobody).toMatchObject({ people: [], home: { state: "none", kind: "nobody" } });
    expect(nobody.note).toMatch(/^ничья/u);
  });

  it("gives a chatter only a sale of their own shifts, their own person, and pay sums only with the switch", async (context) => {
    if (!testDb || !server) return context.skip();
    // anna, «видит свои деньги»: her own sale with her own sums, the link to her own shift.
    const own = await chainOf("anna", sales.anna);
    expect(own.people.map((one) => one.name)).toEqual(["anna"]);
    expect(own.people[0]!.shift.link).toMatch(/^\/workboard\/my\/shifts\/\d+\?sale=\d+$/u);
    expect(own.people[0]!.accrual.amountMills).toBe(40_000);
    expect(own.home.link).toBeNull();
    // bella, without the switch: her own sale, the states without sums.
    const bellas = await chainOf("bella", sales.bella);
    expect(bellas.people.map((one) => one.name)).toEqual(["bella"]);
    expect(bellas.people[0]!.accrual.state).toBe("done");
    expect(bellas.people[0]!.payout).toMatchObject({ state: "wait", words: "к выплате" });
    expectNoPaySums(bellas);
    // bella's shift held the page when anna's sale came: she sees whose it is, nothing of anna's report or money.
    const near = await chainOf("bella", sales.anna);
    expect(near.people).toEqual([]);
    expect(near.home.state).toBe("done");
    expect(near.note).toMatch(/^продажа не ваша/u);
    // dina had no shift then, cora works another page: not found, as if there were no such sale.
    expect((await asSession("dina", `/api/v1/sales/chain?saleId=${sales.anna}`)).statusCode).toBe(404);
    expect((await asSession("cora", `/api/v1/sales/chain?saleId=${sales.anna}`)).statusCode).toBe(404);
    expect((await asSession("anna", `/api/v1/sales/chain?saleId=${sales.other}`)).statusCode).toBe(404);
  });

  it("gives a team lead a sale of their pages: whose it is, the shift and the report, never another person's pay", async (context) => {
    if (!testDb || !server) return context.skip();
    const before = payReads;
    const chain = await chainOf("lead", sales.anna);
    expect(chain.people).toHaveLength(1);
    expect(chain.people[0]).toMatchObject({ name: "anna", shareMills: 20_000 });
    expect(chain.home.state).toBe("done");
    expect(chain.people[0]!.shift.state).toBe("done");
    expect(chain.people[0]!.report.state).not.toBe("none");
    // Accrual and payout are anna's pay: not «done» or «к выплате» to a team lead, only that the owner sees them.
    for (const link of [chain.people[0]!.accrual, chain.people[0]!.payout]) {
      expect(link).toEqual({ state: "none", words: "видит только владелец", link: null, amountMills: null });
    }
    expectNoPaySums(chain);
    // The service itself: the ledger is not even asked for the person's pay on a team lead's read.
    const direct = await readSaleChain(app, { kind: "team_lead", pageIds: [pageOne] }, { saleId: sales.anna });
    expect(direct.people.map((one) => [one.accrual.state, one.payout.state])).toEqual([["none", "none"]]);
    expect(payReads).toBe(before);
    // The owner's read of the same sale asks it.
    await chainOf("boss", sales.anna);
    expect(payReads).toBeGreaterThan(before);
    expect((await asSession("lead", `/api/v1/sales/chain?saleId=${sales.other}`)).statusCode).toBe(404);
  });

  it("gives an agent key with read:team and read:money a sale of its pages without pay sums", async (context) => {
    if (!testDb || !server) return context.skip();
    const byId = await asKey("chain", `/api/v1/agent/team/sale-chain?saleRef=${sales.anna}`);
    expect(byId.statusCode, byId.body).toBe(200);
    const chain = saleChainResponseSchema.parse(byId.json());
    expect(chain.people.map((one) => one.name)).toEqual(["anna"]);
    expectNoPaySums(chain);
    // By the page and the platform's id, as the console's rows name it.
    const byRef = await asKey("chain", "/api/v1/agent/team/sale-chain?pageLabel=mia-1&transactionRef=tx-chain-anna");
    expect(byRef.statusCode, byRef.body).toBe(200);
    expect(byRef.json().sale.transactionId).toBe(sales.anna);
    expect((await asKey("team", `/api/v1/agent/team/sale-chain?saleRef=${sales.anna}`)).statusCode).toBe(403);
    expect((await asKey("elsewhere", `/api/v1/agent/team/sale-chain?saleRef=${sales.anna}`)).statusCode).toBe(404);
    expect((await asKey("chain", "/api/v1/agent/team/sale-chain?pageLabel=mia-1&transactionRef=tx-none")).statusCode).toBe(404);
  });

  it("says «неизвестно» when the ledger is not connected or does not answer, never «оплачено»", async (context) => {
    if (!testDb || !server) return context.skip();
    const key = app.config.ledgerPayoutsKey;
    try {
      Object.assign(app.config, { ledgerPayoutsKey: undefined });
      const off = (await chainOf("boss", sales.anna)).people[0]!;
      for (const link of [off.report, off.accrual, off.payout]) {
        expect(link).toMatchObject({ state: "unknown", amountMills: null });
        expect(link.words).toBe("неизвестно: ledger не подключён");
      }
      Object.assign(app.config, { ledgerPayoutsKey: key });
      broken = true;
      const down = (await chainOf("anna", sales.anna)).people[0]!;
      for (const link of [down.accrual, down.payout]) {
        expect(link).toMatchObject({ state: "unknown", words: "неизвестно: ledger не ответил", amountMills: null });
        expect(link.words).not.toMatch(/оплачено/u);
      }
      // The shift and whose it is are Hub's own: still there.
      expect(down.shift.state).toBe("done");
    } finally {
      broken = false;
      Object.assign(app.config, { ledgerPayoutsKey: key });
    }
  });
});
