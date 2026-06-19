import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  insertOfapiWebhookEvent,
  insertOfapiCreditLedgerEntry,
  recordOfapiCreditSpend,
  setOfapiCreditReconcileCursor,
  setPageOfapiAccountId,
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
    // 137 credits over 7 days = 19.6/day; days left from the 23,950 balance.
    expect(body.forecast.avgDailySpend7d).toBe(19.6);
    expect(body.forecast.daysLeft).toBe(Math.floor(23_950 / 19.6));
    expect(body.forecast.runOutDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.reconciliation.lastRunAt).not.toBeNull();
    expect(body.reconciliation.lastDriftCredits).toBe(0);
    expect(body.accrual.lastPostedDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.incidents).toEqual([]);
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
    expect(body.byPage).toEqual([
      { pageId: page.id, pageLabel: "lora-of", credits: 92 },
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
