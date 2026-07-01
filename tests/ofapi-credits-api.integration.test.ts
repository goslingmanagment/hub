import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  insertOfapiWebhookEvent,
  insertOfapiCreditLedgerEntry,
  recordOfapiCreditSpend,
  setOfapiCreditReconcileCursor,
  setPageOfapiAccountId,
  upsertTransaction,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createUserAccount,
  issueChatterApiKey,
} from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;

function sessionCookieFrom(response: { headers: Record<string, unknown> }) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") {
    throw new Error("Expected a session cookie");
  }
  return value.split(";")[0]!;
}

async function loginCookie(username: string, password: string) {
  if (!server) {
    throw new Error("server not started");
  }
  const login = await server.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  expect(login.statusCode).toBe(200);
  return sessionCookieFrom(login);
}

async function seedUsers() {
  await createUserAccount(appContext, {
    username: "dima",
    role: "owner",
    password: "owner-secret",
  }, { source: "cli" });
  await createUserAccount(appContext, {
    username: "lead",
    role: "team_lead",
    password: "lead-secret",
  }, { source: "cli" });
  await createUserAccount(appContext, {
    username: "anton",
    role: "chatter",
  }, { source: "cli" });
}

async function seedLedgerFixture() {
  const model = await createModel(appContext.db, { slug: "model-credits", name: "Model Credits" });
  const page = await createOnlyFansPage(appContext.db, { modelId: model.id, label: "lora-of" });
  await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId: "acct_credits" });

  // Anchor inside the CURRENT UTC day — "now minus hours" would straddle the
  // UTC midnight boundary when the suite runs early in the UTC day.
  const now = new Date();
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const minutes = (count: number) => new Date(dayStart + count * 60 * 1000);
  await recordOfapiCreditSpend(appContext.db, {
    operation: "ofapi_chats",
    credits: 90,
    balanceAfter: 24_000,
    pageId: page.id,
    httpStatus: 200,
    requestId: "ofapi_chats:seed",
    occurredAt: minutes(1),
  });
  await recordOfapiCreditSpend(appContext.db, {
    operation: "ofapi_chat_messages",
    credits: 2,
    balanceAfter: 23_950,
    pageId: page.id,
    httpStatus: 200,
    occurredAt: minutes(2),
  });
  await insertOfapiCreditLedgerEntry(appContext.db, {
    occurredAt: minutes(3),
    source: "webhook_accrual",
    operation: "ofapi_webhook_events",
    credits: 40,
    estimated: true,
    accrualDay: new Date(dayStart - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  });
  await insertOfapiCreditLedgerEntry(appContext.db, {
    occurredAt: minutes(4),
    source: "external",
    credits: 5,
    estimated: true,
  });
  await insertOfapiCreditLedgerEntry(appContext.db, {
    occurredAt: minutes(5),
    source: "refill",
    credits: -1000,
    estimated: true,
  });
  await setOfapiCreditReconcileCursor(appContext.db, {
    reconciledThroughLedgerId: 2,
    lastReconcileAt: minutes(6),
    lastDriftCredits: 0,
  });

  return page;
}

async function seedWebhookEventsAt(
  prefix: string,
  count: number,
  receivedAt: Date,
  pageId?: number,
) {
  if (!testDb) {
    throw new Error("test database not started");
  }

  for (let index = 0; index < count; index += 1) {
    await insertOfapiWebhookEvent(appContext.db, {
      idempotencyKey: `${prefix}_${String(index).padStart(4, "0")}`,
      eventType: "users.online",
      ofapiAccountId: null,
      payload: {},
    });
  }

  await testDb.pool.query(
    `update ofapi_webhook_events
        set received_at = $1,
            platform_account_id = coalesce($3, platform_account_id)
      where idempotency_key like $2`,
    [receivedAt, `${prefix}_%`, pageId ?? null],
  );
}

describe("ofapi credits admin api", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, 120_000);

  beforeEach(async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await resetIntegrationDatabase(testDb.pool);
    appContext = createTestAppContext(testDb, { ofapiCreditLedgerEnabled: true });
    await seedUsers();
    server = await buildApiServer(appContext);
    await server.ready();
  });

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("rejects unauthenticated and non-owner access on all three routes", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const nonOwnerCookie = await loginCookie("lead", "lead-secret");
    for (const url of [
      "/api/v1/admin/ofapi/credits/summary",
      "/api/v1/admin/ofapi/credits/daily",
      "/api/v1/admin/ofapi/credits/ledger",
      "/api/v1/admin/ofapi/credits/ledger.csv",
    ]) {
      const unauthenticated = await server.inject({ method: "GET", url });
      expect(unauthenticated.statusCode).toBe(401);

      const forbidden = await server.inject({
        method: "GET",
        url,
        headers: { cookie: nonOwnerCookie },
      });
      expect(forbidden.statusCode).toBe(403);
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("returns a chatter-safe page-scoped spend summary", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const page = await seedLedgerFixture();
    const otherModel = await createModel(appContext.db, {
      slug: "other-credits",
      name: "Other Credits",
    });
    const otherPage = await createOnlyFansPage(appContext.db, {
      modelId: otherModel.id,
      label: "other-of",
    });

    const now = new Date();
    const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const minutes = (count: number) => new Date(dayStart + count * 60 * 1000);
    const daysAgo = (days: number, minute: number) =>
      new Date(dayStart - days * 24 * 60 * 60 * 1000 + minute * 60 * 1000);

    await recordOfapiCreditSpend(appContext.db, {
      operation: "ofapi_chats",
      credits: 17,
      balanceAfter: 23_900,
      pageId: otherPage.id,
      httpStatus: 200,
      occurredAt: minutes(7),
    });
    await recordOfapiCreditSpend(appContext.db, {
      operation: "ofapi_chats",
      credits: 3,
      balanceAfter: 23_897,
      pageId: page.id,
      httpStatus: 200,
      occurredAt: daysAgo(2, 1),
    });
    await recordOfapiCreditSpend(appContext.db, {
      operation: "ofapi_chats",
      credits: 11,
      balanceAfter: 23_886,
      pageId: otherPage.id,
      httpStatus: 200,
      occurredAt: daysAgo(2, 2),
    });
    await seedWebhookEventsAt("assigned_today", 101, minutes(8), page.id);
    await seedWebhookEventsAt("other_today", 250, minutes(9), otherPage.id);
    await seedWebhookEventsAt("assigned_7d", 8, daysAgo(2, 3), page.id);

    const { key } = await issueChatterApiKey(appContext, {
      username: "anton",
      pageLabel: page.label,
    }, { source: "test" });

    const unauthenticated = await server.inject({
      method: "GET",
      url: "/api/v1/ofapi/credits/summary",
    });
    expect(unauthenticated.statusCode).toBe(401);

    const ownerCookie = await loginCookie("dima", "owner-secret");
    const ownerSession = await server.inject({
      method: "GET",
      url: "/api/v1/ofapi/credits/summary",
      headers: { cookie: ownerCookie },
    });
    expect(ownerSession.statusCode).toBe(403);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/ofapi/credits/summary",
      headers: { authorization: `Bearer ${key}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.enabled).toBe(true);
    expect(body.scope).toEqual({ pageIds: [page.id], pageCount: 1 });
    expect(body.today.restCredits).toBe(92);
    expect(body.today.webhook).toEqual({ eventCount: 101, estimatedCredits: 2 });
    expect(body.today.totalEstimatedCredits).toBe(94);
    expect(body.last7d.restCredits).toBe(95);
    expect(body.last7d.webhook).toEqual({ eventCount: 109, estimatedCredits: 2 });
    expect(body.last7d.totalEstimatedCredits).toBe(97);
    expect(body.limitations).toContain("owner-only balance, refills, external drift, and adjustments are omitted");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("returns an unavailable chatter summary when the credit ledger is disabled", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await createUserAccount(appContext, {
      username: "boris",
      role: "chatter",
    }, { source: "cli" });
    const model = await createModel(appContext.db, {
      slug: "disabled-ledger",
      name: "Disabled Ledger",
    });
    const page = await createOnlyFansPage(appContext.db, {
      modelId: model.id,
      label: "disabled-of",
    });
    const { key } = await issueChatterApiKey(appContext, {
      username: "boris",
      pageLabel: page.label,
    }, { source: "test" });

    const disabledContext = createTestAppContext(testDb, { ofapiCreditLedgerEnabled: false });
    const disabledServer = await buildApiServer(disabledContext);
    await disabledServer.ready();
    try {
      const response = await disabledServer.inject({
        method: "GET",
        url: "/api/v1/ofapi/credits/summary",
        headers: { authorization: `Bearer ${key}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        enabled: false,
        scope: { pageIds: [page.id], pageCount: 1 },
        today: {
          restCredits: 0,
          webhook: { eventCount: 0, estimatedCredits: 0 },
          totalEstimatedCredits: 0,
        },
        last7d: {
          restCredits: 0,
          webhook: { eventCount: 0, estimatedCredits: 0 },
          totalEstimatedCredits: 0,
        },
        limitations: ["ledger disabled; page-scoped credit summary unavailable"],
      });
    } finally {
      await disabledServer.close();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("returns the summary with balance, spend by source, budgets, and forecast", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await seedLedgerFixture();
    const cookie = await loginCookie("dima", "owner-secret");
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/credits/summary",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.enabled).toBe(true);
    expect(body.balance.value).toBe(23_950);
    expect(body.balance.observedAt).not.toBeNull();
    expect(body.today.total).toBe(137);
    expect(body.today.bySource).toEqual({
      rest: 92,
      webhookAccrual: 40,
      external: 5,
      adjustment: 0,
    });
    expect(body.budgets).toEqual([{
      stream: "dm",
      spentToday: 92,
      dailyCeiling: 500,
      state: "ok",
      retryAt: null,
    }]);
    expect(body.floor).toEqual({ value: 500, blocked: false });
    // A2: all 137 net credits were recorded today (<1 day of history), so the
    // runway divides by the observed span floored at 1 day — not a full 7 — and
    // does not overstate days-left. (The old divide-by-7 reported 19.6/day.)
    expect(body.forecast.avgDailySpend7d).toBe(137);
    expect(body.forecast.daysLeft).toBe(Math.floor(23_950 / 137));
    expect(body.forecast.runOutDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.reconciliation.lastRunAt).not.toBeNull();
    expect(body.reconciliation.lastDriftCredits).toBe(0);
    expect(body.accrual.lastPostedDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.incidents).toEqual([]);
    // Credit price defaults to 0 (unset) so the dashboard hides USD estimates.
    expect(body.pricing).toEqual({ microUsdPerCredit: 0 });
    // D5: all 137 net credits were spent today (this month), and the 23,950
    // balance already covers 30 days above the 500 floor, so no refill is needed.
    expect(body.forecast.monthToDateSpend).toBe(137);
    expect(body.forecast.monthEndProjection).toBeGreaterThanOrEqual(137);
    expect(body.forecast.refillRecommendation).toEqual({ targetDays: 30, credits: 0 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("recommends a refill when the balance falls short of the target runway (D5)", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    // Spend 700 credits today against a low 1,000 balance: with a 500 floor and a
    // ~700/day rate, 30 days of runway needs far more than 1,000.
    await recordOfapiCreditSpend(appContext.db, {
      operation: "ofapi_chats",
      credits: 700,
      balanceAfter: 1_000,
    });

    const cookie = await loginCookie("dima", "owner-secret");
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/credits/summary",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const forecast = response.json().forecast;
    // max(0, floor 500 + avg 700 × 30 − balance 1,000) = 20,500.
    expect(forecast.avgDailySpend7d).toBe(700);
    expect(forecast.refillRecommendation).toEqual({ targetDays: 30, credits: 20_500 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reports trailing-hour burn drivers in the summary (D3)", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const model = await createModel(appContext.db, { slug: "burn-model", name: "Burn" });
    const page = await createOnlyFansPage(appContext.db, { modelId: model.id, label: "burn-of" });
    const now = new Date();
    // 400 credits in the last five minutes — inside the 60-minute burn window and
    // over the default 300/h threshold.
    await recordOfapiCreditSpend(appContext.db, {
      operation: "ofapi_chats",
      credits: 400,
      balanceAfter: 5_000,
      pageId: page.id,
      httpStatus: 200,
      occurredAt: new Date(now.getTime() - 5 * 60 * 1000),
    });

    const cookie = await loginCookie("dima", "owner-secret");
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/credits/summary",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const burn = response.json().recentBurn;
    expect(burn.windowMinutes).toBe(60);
    expect(burn.total).toBe(400);
    expect(burn.threshold).toBe(300);
    expect(burn.alerting).toBe(true);
    expect(burn.topOperations).toEqual([{ operation: "ofapi_chats", requests: 1, credits: 400 }]);
    expect(burn.topPages).toEqual([{ pageId: page.id, pageLabel: "burn-of", credits: 400 }]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("echoes the configured credit price for USD estimates", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    await server.close();

    // 10,000 micro-USD/credit = $0.01/credit.
    appContext = createTestAppContext(testDb, {
      ofapiCreditLedgerEnabled: true,
      ofapiCreditMicroUsdPrice: 10_000,
    });
    server = await buildApiServer(appContext);
    await server.ready();

    const cookie = await loginCookie("dima", "owner-secret");
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/credits/summary",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().pricing).toEqual({ microUsdPerCredit: 10_000 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("sizes the runway from an external residual's spread start, not its post time", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // A zero-credit probe just sets the observed balance (7,000) without adding
    // to spend; the runway's days-left divides the balance by the daily rate.
    await recordOfapiCreditSpend(appContext.db, {
      operation: "ofapi_me",
      credits: 0,
      balanceAfter: 7_000,
      occurredAt: new Date(now.getTime() - 30 * 1000),
    });
    // One external drift residual: 700 credits attributed across the whole 7-day
    // window (fromOccurredAt) but posted just now (occurredAt). sumOfapiCredits…
    // prorates it to ~700 over 7 days; the runway must divide by that 7-day span,
    // not by the ~1-day gap to the post time.
    await insertOfapiCreditLedgerEntry(appContext.db, {
      occurredAt: new Date(now.getTime() - 60 * 1000),
      source: "external",
      credits: 700,
      estimated: true,
      details: {
        fromOccurredAt: sevenDaysAgo.toISOString(),
        fromBalance: 7_700,
        toBalance: 7_000,
      },
    });

    const cookie = await loginCookie("dima", "owner-secret");
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/credits/summary",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // ~700 credits spread over ~7 days → ~100/day, not ~700/day (which anchoring
    // on the post time would produce).
    expect(body.forecast.avgDailySpend7d).toBe(100);
    expect(body.forecast.daysLeft).toBe(Math.floor(7_000 / 100)); // 70
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reports current UTC-day pending webhook accrual without adding it to posted spend", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await seedLedgerFixture();

    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const nextDayStart = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    await seedWebhookEventsAt("evt_pending_before", 1, new Date(dayStart.getTime() - 1));
    await seedWebhookEventsAt("evt_pending_start", 100, dayStart);
    await seedWebhookEventsAt("evt_pending_end", 1, new Date(nextDayStart.getTime() - 1));
    await seedWebhookEventsAt("evt_pending_after", 1, nextDayStart);

    const cookie = await loginCookie("dima", "owner-secret");
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/credits/summary",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.today.total).toBe(137);
    expect(body.today.bySource.webhookAccrual).toBe(40);
    expect(body.accrual.pendingToday).toEqual({
      day: dayStart.toISOString().slice(0, 10),
      eventCount: 101,
      estimatedCredits: 2,
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("flags exhausted budgets and the balance floor in the summary", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await recordOfapiCreditSpend(appContext.db, {
      operation: "ofapi_chats",
      credits: 600,
      balanceAfter: 400,
    });

    const cookie = await loginCookie("dima", "owner-secret");
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/credits/summary",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    // Floor (400 < 500) wins over the exhausted ceiling in the state machine,
    // matching the executor guard's check order.
    expect(body.floor.blocked).toBe(true);
    expect(body.budgets[0].state).toBe("floor_blocked");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("returns dense daily series plus operation and page breakdowns", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const page = await seedLedgerFixture();
    const cookie = await loginCookie("dima", "owner-secret");
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/credits/daily?days=7",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.days).toHaveLength(7);
    const totalAcrossDays = body.days.reduce(
      (sum: number, day: { total: number }) => sum + day.total,
      0,
    );
    expect(totalAcrossDays).toBe(137);

    expect(body.balance.map((point: { value: number }) => point.value)).toEqual([24_000, 23_950]);
    expect(body.refills).toHaveLength(1);
    expect(body.refills[0].credits).toBe(-1000);

    expect(body.byOperation).toEqual([
      { operation: "ofapi_chats", requests: 1, credits: 90 },
      { operation: "ofapi_chat_messages", requests: 1, credits: 2 },
    ]);
    // No transactions seeded, so per-page revenue is 0 but always present.
    expect(body.byPage).toEqual([
      { pageId: page.id, pageLabel: "lora-of", credits: 92, revenueMills: 0 },
    ]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("joins per-page net revenue onto the page breakdown for ROI", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const page = await seedLedgerFixture();
    const now = new Date();
    const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

    // A second page with its own credit spend and its own revenue, so a join that
    // cross-attributes revenue to the wrong pageId would fail this assertion.
    const modelB = await createModel(appContext.db, { slug: "model-credits-b", name: "Model B" });
    const pageB = await createOnlyFansPage(appContext.db, { modelId: modelB.id, label: "kira-of" });
    await recordOfapiCreditSpend(appContext.db, {
      operation: "ofapi_chats",
      credits: 50,
      balanceAfter: 23_900,
      pageId: pageB.id,
      httpStatus: 200,
      requestId: "ofapi_chats:seed_b",
      occurredAt: new Date(dayStart + 7 * 60 * 1000),
    });

    // A reportable transaction per page inside the current UTC day so each lands in
    // the same [from, to) window as that page's credit spend.
    await upsertTransaction(appContext.db, {
      platformAccountId: page.id,
      transactionId: "txn_roi_a",
      rawType: "message",
      canonicalType: "message_purchase",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 30_000n,
      sourceDestinationAmountMills: 30_000n,
      creatorNetAmountMills: 25_000n,
      occurredAt: new Date(dayStart + 3 * 60 * 1000),
    });
    await upsertTransaction(appContext.db, {
      platformAccountId: pageB.id,
      transactionId: "txn_roi_b",
      rawType: "message",
      canonicalType: "message_purchase",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 9_000n,
      sourceDestinationAmountMills: 9_000n,
      creatorNetAmountMills: 7_000n,
      occurredAt: new Date(dayStart + 8 * 60 * 1000),
    });

    const cookie = await loginCookie("dima", "owner-secret");
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/credits/daily?days=7",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    // Ordered by credits desc; each page keeps its own revenue (no cross-attribution).
    expect(response.json().byPage).toEqual([
      { pageId: page.id, pageLabel: "lora-of", credits: 92, revenueMills: 25_000 },
      { pageId: pageB.id, pageLabel: "kira-of", credits: 50, revenueMills: 7_000 },
    ]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("lists, filters, and paginates the ledger", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const page = await seedLedgerFixture();
    const cookie = await loginCookie("dima", "owner-secret");

    const all = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/credits/ledger",
      headers: { cookie },
    });
    expect(all.statusCode).toBe(200);
    expect(all.json().total).toBe(5);
    expect(all.json().rows).toHaveLength(5);

    const restOnly = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/credits/ledger?source=rest",
      headers: { cookie },
    });
    expect(restOnly.json().total).toBe(2);
    expect(restOnly.json().rows.every((row: { source: string }) => row.source === "rest")).toBe(true);
    expect(restOnly.json().rows[0].pageLabel).toBe("lora-of");

    const byPage = await server.inject({
      method: "GET",
      url: `/api/v1/admin/ofapi/credits/ledger?pageId=${page.id}&operation=ofapi_chats`,
      headers: { cookie },
    });
    expect(byPage.json().total).toBe(1);
    expect(byPage.json().rows[0].operation).toBe("ofapi_chats");
    expect(byPage.json().rows[0].credits).toBe(90);

    const paged = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/credits/ledger?limit=2&offset=4",
      headers: { cookie },
    });
    expect(paged.json().total).toBe(5);
    expect(paged.json().rows).toHaveLength(1);

    const badQuery = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/credits/ledger?source=nonsense",
      headers: { cookie },
    });
    expect(badQuery.statusCode).toBe(400);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("exports the filtered ledger as a CSV download", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await seedLedgerFixture();
    const cookie = await loginCookie("dima", "owner-secret");

    const all = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/credits/ledger.csv",
      headers: { cookie },
    });
    expect(all.statusCode).toBe(200);
    expect(all.headers["content-type"]).toContain("text/csv");
    expect(all.headers["content-disposition"]).toContain("attachment");
    expect(all.headers["content-disposition"]).toContain("ofapi-credit-ledger.csv");

    const lines = all.body.trim().split("\r\n");
    expect(lines[0]).toBe(
      "id,occurred_at,source,operation,page_id,page_label,http_status,credits,estimated,balance_after,request_id,accrual_day",
    );
    // Header + the five seeded ledger rows.
    expect(lines).toHaveLength(6);
    expect(all.body).toContain("ofapi_chats");
    expect(all.body).toContain("lora-of");

    // Pin the column-to-value mapping on a full data row (the ofapi_chats spend);
    // none of its fields contain a comma, so a plain split is safe here.
    const chatsLine = lines.find((line) => line.includes("ofapi_chats:seed"));
    expect(chatsLine).toBeDefined();
    const cols = chatsLine!.split(",");
    expect(cols[2]).toBe("rest"); // source
    expect(cols[3]).toBe("ofapi_chats"); // operation
    expect(cols[5]).toBe("lora-of"); // page_label
    expect(cols[6]).toBe("200"); // http_status
    expect(cols[7]).toBe("90"); // credits
    expect(cols[8]).toBe("false"); // estimated
    expect(cols[9]).toBe("24000"); // balance_after
    expect(cols[10]).toBe("ofapi_chats:seed"); // request_id
    expect(cols[11]).toBe(""); // accrual_day (null → empty)

    // Filters narrow the export the same way the JSON ledger does.
    const restOnly = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/credits/ledger.csv?source=rest",
      headers: { cookie },
    });
    expect(restOnly.statusCode).toBe(200);
    expect(restOnly.headers["content-disposition"]).toContain("ofapi-credit-ledger_rest.csv");
    expect(restOnly.body.trim().split("\r\n")).toHaveLength(3);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("sanitizes a hostile filter value out of the CSV download filename", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await seedLedgerFixture();
    const cookie = await loginCookie("dima", "owner-secret");

    // `from` is only shape-validated as a string (isoTimestamp === z.string()), so a
    // slash-separated date (a valid Date, but with a path separator) reaches the
    // handler. It must be clamped before it lands in the Content-Disposition header
    // that is written after reply.hijack().
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/credits/ledger.csv?from=2026%2F01%2F01",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const disposition = String(response.headers["content-disposition"]);
    const filename = /filename="([^"]*)"/.exec(disposition)?.[1] ?? "";
    // The raw '/' from the query never survives into the filename.
    expect(filename).not.toContain("/");
    expect(filename).toMatch(/^[A-Za-z0-9._-]+$/);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reports the ledger as disabled when the flag is off", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    await seedWebhookEventsAt("evt_disabled_pending", 3, new Date());
    await server.close();

    // Users persist in the DB; only the config (and thus the server) changes.
    appContext = createTestAppContext(testDb, { ofapiCreditLedgerEnabled: false });
    server = await buildApiServer(appContext);
    await server.ready();

    const cookie = await loginCookie("dima", "owner-secret");
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/credits/summary",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().enabled).toBe(false);
    expect(response.json().accrual.pendingToday).toBeNull();
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
