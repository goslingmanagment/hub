import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { accountReportsResponseSchema } from "@agency_hub_core/contracts";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { listenOnLoopback } from "./helpers/network.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Workboard «Мои смены» (owner, 2026-11-10): a chatter reads their own
// shift reports from the agency ledger — the drafts and the posts. The user is the session's: whatever
// the query says, Hub asks the ledger for the caller, and a report of someone
// else in the ledger's answer never reaches them.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let ledger: Server | null = null;
const users: Record<string, number> = {};
const cookies: Record<string, string> = {};
/** The ledger's requests, as it saw them. */
const asked: Array<{ path: string; params: URLSearchParams }> = [];

function ledgerReport(id: number, hubUserId: number | null, hubUsername: string) {
  return {
    id, person: null, hub_username: hubUsername, hub_user_id: hubUserId, chatter: hubUsername,
    report_date: "2026-11-08", window_from: "2026-11-08T16:00:00+03:00", window_to: "2026-11-09T00:00:00+03:00",
    cut_at: "2026-11-08T23:53:00+03:00", version: 1, versions: 1, status: "draft", source: "agent",
    total_micros: 42_500_000, created_at: "2026-11-08T23:54:10+03:00",
    pages: [{ page: "page-a", model: "", amount_micros: 42_500_000 }],
    lines: [{
      n: 1, transaction_ref: `tx-${id}`, page: "page-a", fan_ref: "fan-1", fan_name: "", kind: "tip",
      occurred_at: "2026-11-08T18:10:00+03:00", net_micros: 42_500_000, gross_micros: 53_125_000,
      counted: true, decision: "auto", added: false, what: "", flags: null, notes: null, ppv_author: "", ppv_sent_at: "",
    }],
  };
}

describe("the chatter's own shift reports from the ledger", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    for (const username of ["nikita", "vanya"]) {
      await createUserAccount(app, { username, role: "chatter" }, { source: "cli" });
      users[username] = await fixtureUserId(app, username);
      await setUserPassword(app, { userId: users[username]!, password: `${username}-password-for-tests` }, { source: "cli" });
    }

    // A fake ledger that answers every reader with Никита's and Ваня's reports: Hub must keep the caller's only. The
    // posts (report days) it has none of.
    ledger = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://ledger.test");
      asked.push({ path: url.pathname, params: url.searchParams });
      const known = url.pathname === "/v1/reports" || url.pathname === "/v1/report-days";
      if (!known || request.headers.authorization !== "Bearer test-reports-key") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const window = { from: url.searchParams.get("from"), to: url.searchParams.get("to") };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(url.pathname === "/v1/report-days"
        ? { ...window, days: [] }
        : { ...window, reports: [ledgerReport(1, users.nikita!, "nikita"), ledgerReport(2, users.vanya!, "vanya"), ledgerReport(3, null, "Vanya")] }));
    });
    const address = await listenOnLoopback(ledger, "the fake agency ledger");
    if (!address) {
      ledger.close();
      ledger = null;
      return;
    }
    Object.assign(app.config, { ledgerUrl: `http://${address.host}:${address.port}`, ledgerPayoutsKey: "test-reports-key" });

    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["nikita", "vanya"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[user] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    }
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await new Promise<void>((resolve) => (ledger ? ledger.close(() => resolve()) : resolve()));
    await testDb?.stop();
  });

  const read = (user: string, query = "") => server!.inject({ method: "GET", url: `/api/v1/account/reports${query}`, headers: { cookie: cookies[user]! } });

  it("gives a chatter their own reports, in mills, and nobody else's", async (context) => {
    if (!testDb || !server) return context.skip();
    asked.length = 0;
    const response = await read("nikita", "?from=2026-11-01&to=2026-11-10");
    expect(response.statusCode, response.body).toBe(200);
    const body = accountReportsResponseSchema.parse(response.json());
    expect(body).toMatchObject({ from: "2026-11-01", to: "2026-11-10", postsRead: true });
    expect(body.reports.map((report) => report.id)).toEqual([1]);
    expect(body.reports[0]).toMatchObject({ source: "draft", totalMills: 42_500, pages: [{ pageLabel: "page-a", amountMills: 42_500 }], lines: [{ netMills: 42_500, flags: [], notes: [] }] });
    expect(asked.map((one) => one.path).sort()).toEqual(["/v1/report-days", "/v1/reports"]);
    for (const one of asked) expect(Object.fromEntries(one.params)).toMatchObject({ hub_user_id: String(users.nikita), hub_username: "nikita" });

    // Ваня gets his two: by id, and the one the ledger has by his name only.
    const vanya = accountReportsResponseSchema.parse((await read("vanya")).json());
    expect(vanya.reports.map((report) => report.id).sort()).toEqual([2, 3]);
  });

  it("asks the ledger for the session's user, whatever the query names", async (context) => {
    if (!testDb || !server) return context.skip();
    asked.length = 0;
    const response = await read("nikita", `?hub_user_id=${users.vanya}&hub_username=vanya&userId=${users.vanya}`);
    expect(response.statusCode, response.body).toBe(200);
    expect(accountReportsResponseSchema.parse(response.json()).reports.map((report) => report.id)).toEqual([1]);
    // The drafts and the posts, both for the caller.
    expect(asked).toHaveLength(2);
    for (const one of asked) {
      expect(one.params.getAll("hub_user_id")).toEqual([String(users.nikita)]);
      expect(one.params.getAll("hub_username")).toEqual(["nikita"]);
    }
  });

  it("is a 401 without a session and a 400 past 62 days", async (context) => {
    if (!testDb || !server) return context.skip();
    expect((await server.inject({ method: "GET", url: "/api/v1/account/reports" })).statusCode).toBe(401);
    expect((await read("nikita", "?from=2026-08-01&to=2026-11-10")).statusCode).toBe(400);
  });

  it("is a 503 when the ledger refuses Hub's key", async (context) => {
    if (!testDb || !server) return context.skip();
    const key = app.config.ledgerPayoutsKey;
    Object.assign(app.config, { ledgerPayoutsKey: "a-key-the-ledger-does-not-know" });
    try {
      expect((await read("nikita")).statusCode).toBe(503);
    } finally {
      Object.assign(app.config, { ledgerPayoutsKey: key });
    }
  });
});
