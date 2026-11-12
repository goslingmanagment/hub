import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { accountReportsResponseSchema, chatterStatsSchema } from "@agency_hub_core/contracts";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { listenOnLoopback } from "./helpers/network.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Workboard lets a chatter in, to a part of their own (owner, 2026-11-10): «Мои
// смены», their shifts with their reports. The app keeps them out of the team's
// screens, but the wall is Hub's: every read and write the owner's and team
// leads' screens send (apps/workboard/src/screens/*/data.ts, shared/reads.ts,
// shared/decisions.ts) refuses a chatter's session, and only their own reads —
// `accountChatterStats` and `accountReports` — answer it.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let ledger: Server | null = null;
const users: Record<string, number> = {};
const cookies: Record<string, string> = {};

/** The ledger's /v1/reports: one report of the chatter's. Anything else it refuses. */
function ledgerReport(hubUserId: number) {
  return {
    id: 1, person: null, hub_username: "nikita", hub_user_id: hubUserId, chatter: "nikita",
    report_date: "2026-11-08", window_from: "2026-11-08T16:00:00+03:00", window_to: "2026-11-09T00:00:00+03:00",
    cut_at: "2026-11-08T23:53:00+03:00", version: 1, versions: 1, status: "draft", source: "agent",
    total_micros: 42_500_000, created_at: "2026-11-08T23:54:10+03:00",
    pages: [{ page: "page-a", model: "", amount_micros: 42_500_000 }],
    lines: [{
      n: 1, transaction_ref: "tx-1", page: "page-a", fan_ref: "fan-1", fan_name: "", kind: "tip",
      occurred_at: "2026-11-08T18:10:00+03:00", net_micros: 42_500_000, gross_micros: 53_125_000,
      counted: true, decision: "auto", added: false, what: "", flags: null, notes: null, ppv_author: "", ppv_sent_at: "",
    }],
  };
}

/** What the team's screens read, by screen: the operation and an address it is read at. */
function teamReads(chatterId: number): Array<[string, string]> {
  return [
    // Смены
    ["teamShifts", "/api/v1/team/shifts?from=2026-11-01T00:00:00.000Z"],
    ["teamShiftSales", "/api/v1/team/shift-sales?days=2"],
    ["teamChatterNumbers", "/api/v1/team/chatter-numbers?from=2026-11-02&to=2026-11-08"],
    ["teamAuthorship", "/api/v1/team/authorship?days=7"],
    // Люди
    ["adminListUsers", "/api/v1/admin/users"],
    ["teamChatterStats", `/api/v1/team/chatter-stats?days=14&userId=${chatterId}`],
    ["adminAiSpend", "/api/v1/admin/ai/spend?from=2026-11-02&to=2026-11-08"],
    // Что продаёт
    ["teamSalesPpv", "/api/v1/team/sales/ppv?days=7"],
    ["teamSalesReplies", "/api/v1/team/sales/replies?days=7"],
    ["teamGreetings", "/api/v1/team/greetings?days=7"],
    ["teamWinBackResults", "/api/v1/team/win-back/results?days=7"],
    ["teamWinBackApproaches", "/api/v1/team/win-back/approaches"],
    // Решения
    ["teamCustoms", "/api/v1/team/customs"],
    ["clientSendCustodyList", "/api/v1/client-send-custody?state=held"],
    // Разбор смены
    ["teamShiftReview", `/api/v1/team/shift-review?userId=${chatterId}&startedAt=2026-11-08T13:00:00.000Z`],
    // Выплаты
    ["teamLedgerPayouts", "/api/v1/team/ledger-payouts?from=2026-11-02&to=2026-11-08"],
    ["teamLedgerReports", "/api/v1/team/ledger-reports?from=2026-11-02&to=2026-11-08"],
    ["teamLedgerPayoutPrepare", "/api/v1/team/ledger-payouts/prepare?person=nikita"],
    ["teamLedgerPayoutPerson", "/api/v1/team/ledger-payouts/person?person=nikita&from=2026-11-02&to=2026-11-08"],
    // Решения: the questions «whose is this sale»
    ["teamLedgerQuestions", "/api/v1/team/ledger-questions"],
    // Доступ
    ["adminPages", "/api/v1/admin/pages"],
    ["adminListDeviceTokens", `/api/v1/admin/users/by-id/${chatterId}/device-tokens`],
    ["adminListAccountLinks", `/api/v1/admin/users/by-id/${chatterId}/links`],
    ["adminAiChatterLimits", "/api/v1/admin/ai/chatter-limits?day=2026-11-08"],
  ];
}

/** And what they write. */
function teamWrites(chatterId: number): Array<[string, string, object]> {
  return [
    ["teamWinBackApproachSave", "/api/v1/team/win-back/approaches", {}],
    ["clientSendCustodyResolve", "/api/v1/pages/page-a/client-send-custody/1/resolve", {}],
    ["adminCreateInvite", "/api/v1/admin/invites", { username: "newcomer", role: "chatter" }],
    ["adminDeactivateUser", `/api/v1/admin/users/by-id/${chatterId}/deactivate`, {}],
  ];
}

/**
 * «refused»: the policy's role refusal of a session that is not the team's (auth-policy.ts) —
 * else the status and what came back, so an answer with data names itself.
 */
function verdict(response: { statusCode: number; body: string }): string {
  let message = "";
  try {
    message = String((JSON.parse(response.body) as { message?: unknown }).message ?? "");
  } catch {
    // Not JSON: the body itself is shown below.
  }
  return response.statusCode === 403 && /\((?:dashboard|owner)_session_required\)/.test(message)
    ? "refused"
    : `${response.statusCode} ${response.body.slice(0, 300)}`;
}

describe("a chatter in Workboard", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "owner", role: "owner", password: "owner-password-for-tests" }, { source: "cli" });
    users.owner = await fixtureUserId(app, "owner");
    await createUserAccount(app, { username: "nikita", role: "chatter" }, { source: "cli" });
    users.nikita = await fixtureUserId(app, "nikita");
    await setUserPassword(app, { userId: users.nikita, password: "nikita-password-for-tests" }, { source: "cli" });

    ledger = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://ledger.test");
      if (url.pathname !== "/v1/reports" || request.headers.authorization !== "Bearer test-reports-key") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ from: url.searchParams.get("from"), to: url.searchParams.get("to"), reports: [ledgerReport(users.nikita!)] }));
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
    for (const user of ["owner", "nikita"]) {
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

  it("is refused every read of the team's screens", async (context) => {
    if (!testDb || !server) return context.skip();
    const answers: Record<string, string> = {};
    for (const [operation, url] of teamReads(users.nikita!)) {
      answers[operation] = verdict(await server.inject({ method: "GET", url, headers: { cookie: cookies.nikita! } }));
    }
    expect(answers).toEqual(Object.fromEntries(teamReads(users.nikita!).map(([operation]) => [operation, "refused"])));
  });

  it("is refused every write of the team's screens", async (context) => {
    if (!testDb || !server) return context.skip();
    const answers: Record<string, string> = {};
    for (const [operation, url, payload] of teamWrites(users.nikita!)) {
      answers[operation] = verdict(await server.inject({ method: "POST", url, payload, headers: { cookie: cookies.nikita! } }));
    }
    expect(answers).toEqual(Object.fromEntries(teamWrites(users.nikita!).map(([operation]) => [operation, "refused"])));
  });

  it("while the owner's session passes the same reads (the refusal is the role's, not the address's)", async (context) => {
    if (!testDb || !server) return context.skip();
    for (const [operation, url] of teamReads(users.nikita!)) {
      const status = (await server.inject({ method: "GET", url, headers: { cookie: cookies.owner! } })).statusCode;
      expect([401, 403], `${operation} answered the owner ${status}`).not.toContain(status);
    }
  });

  it("reads the chatter's own shifts, of a past week too", async (context) => {
    if (!testDb || !server) return context.skip();
    const response = await server.inject({ method: "GET", url: "/api/v1/account/stats?days=7&until=2026-11-08", headers: { cookie: cookies.nikita! } });
    expect(response.statusCode, response.body).toBe(200);
    const body = chatterStatsSchema.parse(response.json());
    // The session's user, whatever the query; the week Monday 2 – Sunday 8 November, Moscow.
    expect({ userId: body.user.userId, from: body.from, to: body.to, days: body.daily.map((day) => day.date) }).toEqual({
      userId: users.nikita,
      from: "2026-11-01T21:00:00.000Z",
      to: "2026-11-08T21:00:00.000Z",
      days: ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"],
    });
  });

  it("reads the chatter's own reports", async (context) => {
    if (!testDb || !server) return context.skip();
    const response = await server.inject({ method: "GET", url: "/api/v1/account/reports", headers: { cookie: cookies.nikita! } });
    expect(response.statusCode, response.body).toBe(200);
    const body = accountReportsResponseSchema.parse(response.json());
    expect(body.reports.map((report) => ({ id: report.id, totalMills: report.totalMills }))).toEqual([{ id: 1, totalMills: 42_500 }]);
  });
});
