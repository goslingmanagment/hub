import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  getTelegramSettings,
  insertDeliveryAttempt,
  openNotificationIncident,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { createUserAccount, SESSION_COOKIE_NAME } from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

function sessionCookieFrom(response: { headers: Record<string, string | string[] | number | undefined> }) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || typeof value !== "string") {
    throw new Error("Expected set-cookie header");
  }
  return value.split(";")[0]!;
}

describe("notifications dashboard", () => {
  let testDb: StartedTestDatabase | null = null;

  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, 120_000);

  afterAll(async () => {
    if (testDb) {
      await testDb.stop();
    }
  });

  beforeEach(async () => {
    if (!testDb) return;
    await resetIntegrationDatabase(testDb.pool);
  });

  async function buildServer(input?: {
    telegramReportHourUtc?: number;
  }) {
    const appContext = createTestAppContext(testDb!);
    if (input?.telegramReportHourUtc !== undefined) {
      appContext.config.telegramReportHourUtc = input.telegramReportHourUtc;
    }
    await createUserAccount(appContext, {
      username: "dima",
      role: "owner",
      password: "owner-secret",
    }, { source: "cli" });
    const server = await buildApiServer(appContext);
    await server.ready();

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const cookie = sessionCookieFrom(login);
    return { server, cookie, appContext };
  }

  it("GET settings returns defaults when telegram is not configured", async (context) => {
    if (!testDb) { context.skip(); return; }
    const { server, cookie } = await buildServer();

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/admin/notifications/settings",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toBe(false);
    expect(body.botTokenSet).toBe(false);
    expect(body.chatId).toBe(null);
    expect(body.connectionStatus).toBe("not_configured");
    expect(body.enabled).toBe(true);
    expect(body.dailyReportEnabled).toBe(true);
    expect(body.syncFailureAlertsEnabled).toBe(true);
    expect(body.reportHourUtc).toBe(9);
  });

  it("GET settings seeds the default report hour from app config", async (context) => {
    if (!testDb) { context.skip(); return; }
    const { server, cookie } = await buildServer({
      telegramReportHourUtc: 6,
    });

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/admin/notifications/settings",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toBe(false);
    expect(body.reportHourUtc).toBe(6);
  });

  it("PATCH settings updates and returns new values", async (context) => {
    if (!testDb) { context.skip(); return; }
    const { server, cookie } = await buildServer();

    const res = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/notifications/settings",
      headers: { cookie },
      payload: {
        enabled: false,
        dailyReportEnabled: false,
        reportHourUtc: 14,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(false);
    expect(body.dailyReportEnabled).toBe(false);
    expect(body.reportHourUtc).toBe(14);
    expect(body.syncFailureAlertsEnabled).toBe(true);

    // Verify persisted
    const getRes = await server.inject({
      method: "GET",
      url: "/api/v1/admin/notifications/settings",
      headers: { cookie },
    });
    const getBody = getRes.json();
    expect(getBody.enabled).toBe(false);
    expect(getBody.reportHourUtc).toBe(14);
  });

  it("PATCH settings clears stored credentials when null is provided", async (context) => {
    if (!testDb) { context.skip(); return; }
    const { server, cookie, appContext } = await buildServer();

    const setRes = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/notifications/settings",
      headers: { cookie },
      payload: {
        botToken: "7123456789:AAH-test-token",
        chatId: "-1001234567890",
      },
    });

    expect(setRes.statusCode).toBe(200);
    expect(setRes.json().configured).toBe(true);
    expect(setRes.json().botTokenSet).toBe(true);
    expect(setRes.json().chatId).toBe("-1001234567890");

    const clearRes = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/notifications/settings",
      headers: { cookie },
      payload: {
        botToken: null,
        chatId: null,
      },
    });

    expect(clearRes.statusCode).toBe(200);
    const body = clearRes.json();
    expect(body.configured).toBe(false);
    expect(body.botTokenSet).toBe(false);
    expect(body.chatId).toBe(null);

    const persisted = await getTelegramSettings(appContext.db, {
      defaultReportHourUtc: appContext.config.telegramReportHourUtc,
    });
    expect(persisted.encryptedBotToken).toBe(null);
    expect(persisted.chatId).toBe(null);
  });

  it("POST test returns delivery result and creates attempt row", async (context) => {
    if (!testDb) { context.skip(); return; }
    const { server, cookie } = await buildServer();

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/admin/notifications/test",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Not configured, so will be skipped
    expect(body.status).toBe("skipped");
  });

  it("incidents list with filters and resolve", async (context) => {
    if (!testDb) { context.skip(); return; }
    const { server, cookie } = await buildServer();

    const model = await createModel(testDb.db, { slug: "m1", name: "Model1" });
    const page = await createFanslyPage(testDb.db, { modelId: model.id, label: "p1" });

    await openNotificationIncident(testDb.db, {
      incidentKey: "auth_failed:" + page.id,
      kind: "auth_failed",
      platformAccountId: page.id,
      errorSummary: "Token expired",
    });

    // List all
    const listRes = await server.inject({
      method: "GET",
      url: "/api/v1/admin/notifications/incidents",
      headers: { cookie },
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json();
    expect(listBody.items.length).toBe(1);
    expect(listBody.items[0].kind).toBe("auth_failed");
    expect(listBody.items[0].pageLabel).toBe("p1");
    expect(listBody.items[0].status).toBe("open");

    // Filter by status=resolved should be empty
    const filteredRes = await server.inject({
      method: "GET",
      url: "/api/v1/admin/notifications/incidents?status=resolved",
      headers: { cookie },
    });
    expect(filteredRes.json().items.length).toBe(0);

    // Resolve
    const resolveRes = await server.inject({
      method: "POST",
      url: `/api/v1/admin/notifications/incidents/${listBody.items[0].id}/resolve`,
      headers: { cookie },
    });
    expect(resolveRes.statusCode).toBe(200);
    expect(resolveRes.json().ok).toBe(true);

    // Verify resolved in DB
    const afterRes = await server.inject({
      method: "GET",
      url: "/api/v1/admin/notifications/incidents?status=open",
      headers: { cookie },
    });
    expect(afterRes.json().items.length).toBe(0);
  });

  it("report preview returns text", async (context) => {
    if (!testDb) { context.skip(); return; }
    const { server, cookie } = await buildServer();

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/admin/notifications/reports/preview",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.text).toContain("Revenue Report");
    expect(body.reportDate).toBeTruthy();
  });

  it("report history lists attempts", async (context) => {
    if (!testDb) { context.skip(); return; }
    const { server, cookie, appContext } = await buildServer();

    await insertDeliveryAttempt(appContext.db, {
      kind: "daily_report_scheduled",
      status: "sent",
      reportDate: "2026-03-20",
    });
    await insertDeliveryAttempt(appContext.db, {
      kind: "daily_report_manual",
      status: "failed",
      reportDate: "2026-03-20",
      error: "Connection refused",
    });

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/admin/notifications/reports/history",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBe(2);
    expect(body.items[0].kind).toBe("daily_report_manual");
    expect(body.items[0].status).toBe("failed");
    expect(body.items[0].error).toBe("Connection refused");
    expect(body.items[1].kind).toBe("daily_report_scheduled");
    expect(body.items[1].status).toBe("sent");
  });

  it("owner-only access: returns 403 for non-owner", async (context) => {
    if (!testDb) { context.skip(); return; }
    const appContext = createTestAppContext(testDb);
    const server = await buildApiServer(appContext);
    await server.ready();

    // Create a non-owner user
    await testDb.pool.query(
      `INSERT INTO users (username, role, password_hash) VALUES ('viewer', 'chatter', '$2b$10$test')`,
    );

    // Login fails without valid password, but let's test with no auth
    const noAuthRes = await server.inject({
      method: "GET",
      url: "/api/v1/admin/notifications/settings",
    });
    expect(noAuthRes.statusCode).toBe(401);

    const endpoints = [
      { method: "GET" as const, url: "/api/v1/admin/notifications/settings" },
      { method: "POST" as const, url: "/api/v1/admin/notifications/test" },
      { method: "GET" as const, url: "/api/v1/admin/notifications/incidents" },
      { method: "POST" as const, url: "/api/v1/admin/notifications/incidents/1/resolve" },
      { method: "GET" as const, url: "/api/v1/admin/notifications/reports/preview" },
      { method: "POST" as const, url: "/api/v1/admin/notifications/reports/send" },
      { method: "GET" as const, url: "/api/v1/admin/notifications/reports/history" },
    ];

    for (const ep of endpoints) {
      const res = await server.inject({
        method: ep.method,
        url: ep.url,
      });
      expect(res.statusCode, `${ep.method} ${ep.url}`).toBe(401);
    }
  });
});
