import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createFanslyPage, createModel, rebuildRevenueRollups } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// «Деньги → Месяц» sets the ledger's month card beside Hub's own income. The card is of the ledger's cut (`asOf`):
// what occurred before that instant. So Hub's income of the month is asked up to the same instant (`until`), and
// the two are compared like with like: a shortfall of the ledger as of its own cut is a discrepancy, not «the hour
// of lag». This file holds the read to that: to the instant, the same rows as Главная's day rollup.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

// September 2026 in Moscow: from 2026-08-31T21:00Z to 2026-09-30T21:00Z.
const MONTH = "period=custom&from=2026-09-01&to=2026-10-01";
const CUT = "2026-09-12T15:31:00.000Z";

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let cookie = "";
let pageId = 0;
let otherPageId = 0;

async function sale(id: string, net: number, at: string, options: { type?: string; page?: number; active?: boolean } = {}) {
  await testDb!.pool.query(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, is_active)
     values ($1, $2, '2000', $3, 'posted', 'test', $4, $4, $4, $5, 'fansly:rest', $6)`,
    [options.page ?? pageId, id, options.type ?? "tip", net, new Date(at), options.active ?? true],
  );
}

type Revenue = { netEarningsMills: number; from: string | null; to: string | null; comparison: unknown; pages: Array<{ pageLabel: string; netEarningsMills: number }> };

async function revenue(query: string): Promise<Revenue> {
  const response = await server!.inject({ method: "GET", url: `/api/v1/overview/revenue?${query}`, headers: { cookie } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Revenue;
}

describe("Hub's own income up to an instant (the ledger's cut)", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    pageId = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    otherPageId = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-2" }))!.id;

    await sale("august", 70_000, "2026-08-31T20:59:59.999Z");
    await sale("first-instant", 10_000, "2026-08-31T21:00:00.000Z");
    await sale("a-day-before", 5_000, "2026-09-05T10:00:00.000Z", { type: "subscription" });
    await sale("refund", -1_000, "2026-09-12T09:00:00.000Z", { type: "refund" });
    await sale("other-page", 8_000, "2026-09-12T10:00:00.000Z", { page: otherPageId });
    await sale("last-before-cut", 2_000, "2026-09-12T15:30:59.999Z");
    await sale("at-cut", 40_000, CUT);
    await sale("after-cut", 3_000, "2026-09-12T18:00:00.000Z");
    await sale("later-day", 600, "2026-09-20T08:00:00.000Z", { page: otherPageId });
    // What Главная never counts is not counted here either.
    await sale("not-income", 50_000, "2026-09-12T09:00:00.000Z", { type: "payout_reversal" });
    await sale("inactive", 90_000, "2026-09-12T09:00:00.000Z", { active: false });
    await rebuildRevenueRollups(app.db, pageId);
    await rebuildRevenueRollups(app.db, otherPageId);

    server = await buildApiServer(app);
    await server.ready();
    const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "boss", password: "boss-password-for-tests" } });
    expect(login.statusCode, login.body).toBe(200);
    const header = login.headers["set-cookie"];
    cookie = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("counts what occurred before the instant, inside the month's window", async (context) => {
    if (!testDb) return context.skip();
    const whole = await revenue(MONTH);
    expect(whole.netEarningsMills).toBe(10_000 + 5_000 - 1_000 + 8_000 + 2_000 + 40_000 + 3_000 + 600);

    const cut = await revenue(`${MONTH}&until=${encodeURIComponent(CUT)}`);
    // The sale at the instant itself is not before it; nor is anything later, the same day or after.
    expect(cut.netEarningsMills).toBe(10_000 + 5_000 - 1_000 + 8_000 + 2_000);
    expect({ from: cut.from, to: cut.to }).toEqual({ from: "2026-08-31T21:00:00.000Z", to: CUT });
    expect(cut.comparison).toBeNull();
    expect(Object.fromEntries(cut.pages.map((page) => [page.pageLabel, page.netEarningsMills]))).toEqual({ "mia-1": 16_000, "mia-2": 8_000 });
  });

  it("is the whole window when the instant is at or past its end, the same to the mill as the day rollup", async (context) => {
    if (!testDb) return context.skip();
    const whole = await revenue(MONTH);
    for (const until of ["2026-09-30T21:00:00.000Z", "2026-10-05T00:00:00.000Z"]) {
      const cut = await revenue(`${MONTH}&until=${encodeURIComponent(until)}`);
      expect(cut.netEarningsMills, until).toBe(whole.netEarningsMills);
      expect(cut.to, until).toBe("2026-09-30T21:00:00.000Z");
      expect(cut.pages.map((page) => page.netEarningsMills), until).toEqual(whole.pages.map((page) => page.netEarningsMills));
    }
  });

  it("is nothing before the window starts, and an instant without a time zone is refused", async (context) => {
    if (!testDb) return context.skip();
    const before = await revenue(`${MONTH}&until=${encodeURIComponent("2026-08-15T00:00:00.000Z")}`);
    expect(before.netEarningsMills).toBe(0);
    expect(before.pages.every((page) => page.netEarningsMills === 0)).toBe(true);
    const refused = await server!.inject({ method: "GET", url: `/api/v1/overview/revenue?${MONTH}&until=2026-09-12T15:31:00`, headers: { cookie } });
    expect(refused.statusCode).toBe(400);
  });
});
