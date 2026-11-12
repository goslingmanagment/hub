import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { accountPayResponseSchema, teamLedgerPayoutPersonResponseSchema } from "@agency_hub_core/contracts";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { listenOnLoopback } from "./helpers/network.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// «Мои деньги» (ecosystem package H1): a chatter reads their own pay from the agency ledger, behind their switch
// «видит свои деньги» (person right sees_own_pay). The person is the session user's, through the people registry:
// whatever the query names, Hub asks the ledger for that person alone, and with the switch off it asks nothing. The
// owner reads anyone's through «Выплаты»; nobody else does. No pay terms reach anyone.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let ledger: Server | null = null;
const cookies: Record<string, string> = {};
/** The ledger's requests of a person's pay, as it saw them. */
const asked: URLSearchParams[] = [];
/** The ledger answers of this code whatever it is asked (a broken ledger); null — of the one asked. */
let answerAs: string | null = null;

/** The ledger's GET /v1/payouts/person of a code: two days of one date on two models, a bonus, a payout; and terms it must never pass on. */
function ledgerPay(person: string, from: string, to: string) {
  const big = person === "vanya";
  return {
    ok: true, person, name: person, from, to, accrualFrom: "2026-09-01", factsFrom: "", reportsFrom: "2026-11-09",
    generatedAt: "2026-11-12T10:00:00Z",
    accruedMicros: big ? 900_000_000 : 150_250_000, paidMicros: 100_000_000, balanceMicros: big ? 777_000_000 : 50_255_000,
    oldestUnpaidDate: "2026-11-10",
    lastPayout: { date: "2026-11-09", document: 412, amountMicros: 100_000_000 },
    days: [
      // The day before the window: a night begun that evening; its row may be in the window, its money is not.
      { date: "2026-11-07", model: "Mia", amountMicros: 7_000_000, worked: true, source: "reports", posts: [6], state: "paid", paidMicros: 7_000_000, unpaidMicros: 0, paidBy: [401] },
      { date: "2026-11-09", model: "Mia", amountMicros: 100_000_000, worked: true, source: "reports", posts: [7], state: "paid", paidMicros: 100_000_000, unpaidMicros: 0, paidBy: [412] },
      { date: "2026-11-10", model: "Mia", amountMicros: 30_125_000, worked: true, source: "reports", posts: [8], state: "to_pay", paidMicros: 0, unpaidMicros: 30_125_000, paidBy: [] },
      { date: "2026-11-10", model: "Ivy", amountMicros: 20_125_000, worked: true, source: "reports", posts: [9], state: "to_pay", paidMicros: 0, unpaidMicros: 20_125_000, paidBy: [] },
    ],
    adjustments: [{ date: "2026-11-10", amountMicros: 5_000_000, memo: "за кастом", document: 415 }],
    payouts: [{ date: "2026-11-09", document: 412, amountMicros: 100_000_000 }],
    checks: { stale: false, lastRebuildAt: "2026-11-12T09:30:00Z" },
    // What a ledger must never send and Hub must never pass on, should it ever come.
    rate: 0.2345, shiftFixMicros: 7_000_000, revenueMicros: 640_000_000,
  };
}

describe("«Мои деньги»: the chatter's own pay behind the person's switch", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    await createUserAccount(app, { username: "lead", role: "team_lead", password: "lead-password-for-tests" }, { source: "cli" });
    for (const username of ["nikita", "vanya", "lone"]) {
      await createUserAccount(app, { username, role: "chatter" }, { source: "cli" });
      await setUserPassword(app, { userId: await fixtureUserId(app, username), password: `${username}-password-for-tests` }, { source: "cli" });
    }

    ledger = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://ledger.test");
      if (url.pathname !== "/v1/payouts/person" || request.headers.authorization !== "Bearer test-payouts-key") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      asked.push(url.searchParams);
      const person = url.searchParams.get("person") ?? "";
      if (person === "ghost") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "человека с таким кодом и вкладкой выплат нет" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(ledgerPay(answerAs ?? person, url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? "")));
    });
    const address = await listenOnLoopback(ledger, "the fake agency ledger");
    if (!address) {
      ledger.close();
      ledger = null;
      return;
    }
    Object.assign(app.config, { ledgerUrl: `http://${address.host}:${address.port}`, ledgerPayoutsKey: "test-payouts-key" });

    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["boss", "lead", "nikita", "vanya", "lone"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[user] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    }
    // Никита's switch is on; Ваня's is off; «lone» is a login of nobody in the registry.
    for (const [code, rights] of [["nikita", ["sees_own_pay"]], ["vanya", []]] as const) {
      const created = await server.inject({
        method: "POST", url: "/api/v1/admin/people", headers: { cookie: cookies.boss! },
        payload: { code, displayName: code, role: "chatter", state: "working", rights, logins: { add: [await fixtureUserId(app, code)] } },
      });
      expect(created.statusCode, created.body).toBe(200);
    }
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await new Promise<void>((resolve) => (ledger ? ledger.close(() => resolve()) : resolve()));
    await testDb?.stop();
  });

  const read = (user: string, query: string) => server!.inject({ method: "GET", url: `/api/v1/account/pay${query}`, headers: { cookie: cookies[user]! } });
  const WINDOW = "?from=2026-11-08&to=2026-11-14";

  it("gives a chatter with the switch on their own sums, by date, and no terms", async (context) => {
    if (!testDb || !server) return context.skip();
    asked.length = 0;
    const response = await read("nikita", WINDOW);
    expect(response.statusCode, response.body).toBe(200);
    const body = accountPayResponseSchema.parse(response.json());
    expect(body).toMatchObject({ enabled: true, from: "2026-11-08", to: "2026-11-14" });
    expect(body.pay).toMatchObject({
      // The ledger's cents, half to even, as `ledger payables` prints them: 50.255 → 50.26.
      accruedMills: 150_250, paidMills: 100_000, balanceMills: 50_260, oldestUnpaidDate: "2026-11-10",
      lastPayout: { date: "2026-11-09", amountMills: 100_000 }, reportsFrom: "2026-11-09", stale: false,
    });
    // Two models of one date are one accrual of the day.
    expect(body.pay!.days).toEqual([
      { date: "2026-11-07", amountMills: 7_000, state: "paid", paidMills: 7_000, unpaidMills: 0 },
      { date: "2026-11-09", amountMills: 100_000, state: "paid", paidMills: 100_000, unpaidMills: 0 },
      { date: "2026-11-10", amountMills: 50_250, state: "to_pay", paidMills: 0, unpaidMills: 50_250 },
    ]);
    // From the day before the window, for a night begun that evening; the window's sums leave that day out.
    expect(asked.map((params) => Object.fromEntries(params))).toEqual([{ person: "nikita", from: "2026-11-07", to: "2026-11-14" }]);
    // Neither the terms the ledger should never send, nor the journal: no rate, fix, revenue, memo, documents, model.
    for (const word of ['"rate"', '"shiftFixMicros"', '"revenueMicros"', '"memo"', '"document"', '"paidBy"', '"posts"', "Mia", "Ivy", "за кастом"]) {
      expect(response.body).not.toContain(word);
    }
  });

  it("asks the ledger for the session's person, whatever the query names", async (context) => {
    if (!testDb || !server) return context.skip();
    asked.length = 0;
    const vanyaId = await fixtureUserId(app, "vanya");
    const response = await read("nikita", `${WINDOW}&person=vanya&code=vanya&slug=vanya&userId=${vanyaId}&hub_user_id=${vanyaId}`);
    expect(response.statusCode, response.body).toBe(200);
    expect(accountPayResponseSchema.parse(response.json()).pay?.balanceMills).toBe(50_260);
    expect(asked.map((params) => params.getAll("person"))).toEqual([["nikita"]]);
  });

  it("with the switch off, or for a login of nobody, says so, carries no sums and asks the ledger nothing", async (context) => {
    if (!testDb || !server) return context.skip();
    asked.length = 0;
    for (const user of ["vanya", "lone"]) {
      const response = await read(user, `${WINDOW}&person=nikita`);
      expect(response.statusCode, response.body).toBe(200);
      expect(accountPayResponseSchema.parse(response.json())).toMatchObject({ enabled: false, pay: null });
    }
    expect(asked).toHaveLength(0);
  });

  it("follows the owner's switch: on for Ваня, his own; off for Никита, nothing", async (context) => {
    if (!testDb || !server) return context.skip();
    const set = (code: string, rights: string[]) => server!.inject({ method: "PATCH", url: `/api/v1/admin/people/${code}`, headers: { cookie: cookies.boss! }, payload: { rights } });
    try {
      expect((await set("vanya", ["sees_own_pay"])).statusCode).toBe(200);
      expect((await set("nikita", [])).statusCode).toBe(200);
      asked.length = 0;
      const vanya = accountPayResponseSchema.parse((await read("vanya", WINDOW)).json());
      expect(vanya.pay?.balanceMills).toBe(777_000);
      expect(asked.map((params) => params.get("person"))).toEqual(["vanya"]);
      expect(accountPayResponseSchema.parse((await read("nikita", WINDOW)).json())).toMatchObject({ enabled: false, pay: null });
      // A chatter cannot turn it on for themselves.
      expect((await server!.inject({ method: "PATCH", url: "/api/v1/admin/people/nikita", headers: { cookie: cookies.nikita! }, payload: { rights: ["sees_own_pay"] } })).statusCode).toBe(403);
    } finally {
      await set("vanya", []);
      await set("nikita", ["sees_own_pay"]);
    }
  });

  it("is a 503, never someone else's numbers, when the ledger answers of another person", async (context) => {
    if (!testDb || !server) return context.skip();
    answerAs = "vanya";
    try {
      const response = await read("nikita", WINDOW);
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("777");
    } finally {
      answerAs = null;
    }
  });

  it("is a 401 without a session, a 400 past 61 days or without a window, a 503 when the ledger refuses Hub's key", async (context) => {
    if (!testDb || !server) return context.skip();
    expect((await server.inject({ method: "GET", url: `/api/v1/account/pay${WINDOW}` })).statusCode).toBe(401);
    expect((await read("nikita", "?from=2026-08-01&to=2026-11-10")).statusCode).toBe(400);
    expect((await read("nikita", "?from=2026-09-10&to=2026-11-10")).statusCode).toBe(400);
    expect((await read("nikita", "")).statusCode).toBe(400);
    const key = app.config.ledgerPayoutsKey;
    Object.assign(app.config, { ledgerPayoutsKey: "a-key-the-ledger-does-not-know" });
    try {
      expect((await read("nikita", WINDOW)).statusCode).toBe(503);
      // The switch off answers without the ledger at all.
      expect((await read("vanya", WINDOW)).statusCode).toBe(200);
    } finally {
      Object.assign(app.config, { ledgerPayoutsKey: key });
    }
  });

  it("gives the owner anyone's pay with the adjustments and the days' states, and nobody else", async (context) => {
    if (!testDb || !server) return context.skip();
    const url = `/api/v1/team/ledger-payouts/person${WINDOW}&person=vanya`;
    const owner = await server.inject({ method: "GET", url, headers: { cookie: cookies.boss! } });
    expect(owner.statusCode, owner.body).toBe(200);
    const body = teamLedgerPayoutPersonResponseSchema.parse(owner.json());
    expect(body).toMatchObject({ slug: "vanya", balanceMills: 777_000, adjustments: [{ date: "2026-11-10", amountMills: 5_000, memo: "за кастом", document: 415 }] });
    expect(body.days.map((day) => [day.date, day.model, day.state, day.paidBy])).toEqual([
      ["2026-11-07", "Mia", "paid", [401]], ["2026-11-09", "Mia", "paid", [412]], ["2026-11-10", "Mia", "to_pay", []], ["2026-11-10", "Ivy", "to_pay", []],
    ]);
    for (const word of ['"rate"', '"shiftFixMicros"', '"revenueMicros"']) expect(owner.body).not.toContain(word);
    expect((await server.inject({ method: "GET", url: `/api/v1/team/ledger-payouts/person${WINDOW}&person=ghost`, headers: { cookie: cookies.boss! } })).statusCode).toBe(404);
    for (const user of ["lead", "nikita", "vanya", "lone"]) {
      expect((await server.inject({ method: "GET", url, headers: { cookie: cookies[user]! } })).statusCode, user).toBe(403);
    }
  });
});
