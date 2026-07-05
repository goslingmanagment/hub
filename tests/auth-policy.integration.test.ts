import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFanslyPage, createModel } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import {
  createUserAccount,
  issueChatterApiKey,
} from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Kernel Stage 19: the declarative auth middleware against real principals on a
// real database, in both modes. In "enforce" the declaration denies before any
// handler runs; in "log" the legacy in-handler guards still answer, and the
// denial grid must come out IDENTICAL — that equality is the stage's whole
// zero-behavior-change claim.

const MONITORING_TOKEN = "monitor-secret";

let testDb: StartedTestDatabase | null = null;
let enforceServer: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let logServer: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let chatterKey = "";

function sessionCookieFrom(response: {
  headers: Record<string, string | string[] | number | undefined>;
}) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || typeof value !== "string") {
    throw new Error("Expected set-cookie header");
  }
  return value.split(";")[0]!;
}

async function loginCookie(
  server: Awaited<ReturnType<typeof buildApiServer>>,
  username: string,
  password: string,
) {
  const login = await server.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  expect(login.statusCode).toBe(200);
  return sessionCookieFrom(login);
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) {
    return;
  }
  const seedContext = createTestAppContext(testDb);

  await createUserAccount(seedContext, {
    username: "dima",
    role: "owner",
    password: "owner-secret",
  }, { source: "cli" });
  await createUserAccount(seedContext, {
    username: "lead",
    role: "team_lead",
    password: "lead-secret",
  }, { source: "cli" });
  await createUserAccount(seedContext, {
    username: "anton",
    role: "chatter",
  }, { source: "cli" });

  const model = await createModel(testDb.db, { slug: "lana-model", name: "Lana Model" });
  await createFanslyPage(testDb.db, { modelId: model.id, label: "lana" });
  await createFanslyPage(testDb.db, { modelId: model.id, label: "lily1" });

  const issued = await issueChatterApiKey(seedContext, {
    username: "anton",
    pageLabel: "lana",
  }, { source: "cli" });
  chatterKey = issued.key;

  // Both servers pin Stage 2's revenue gate to "enforce" — that is production
  // reality (flipped 2026-07-05), and the declarations must reproduce exactly it.
  enforceServer = await buildApiServer(createTestAppContext(testDb, {
    authPolicyEnforcement: "enforce",
    revenueRouteRoleEnforcement: "enforce",
    healthSyncMonitoringToken: MONITORING_TOKEN,
  }));
  logServer = await buildApiServer(createTestAppContext(testDb, {
    revenueRouteRoleEnforcement: "enforce",
    healthSyncMonitoringToken: MONITORING_TOKEN,
  }));
}, 120_000);

afterAll(async () => {
  await enforceServer?.close();
  await logServer?.close();
  await testDb?.stop();
});

function requireServers(context: { skip: () => void }) {
  if (!enforceServer || !logServer) {
    context.skip();
    return null;
  }
  return { enforce: enforceServer, log: logServer };
}

describe("enforce mode: the declared policy answers before any handler", () => {
  it("public routes stay open", async (context) => {
    const servers = requireServers(context);
    if (!servers) return;
    const health = await servers.enforce.inject({ method: "GET", url: "/api/v1/health" });
    expect([200, 503]).toContain(health.statusCode);
  });

  it("principal kinds deny unauthenticated requests with 401", async (context) => {
    const servers = requireServers(context);
    if (!servers) return;
    const admin = await servers.enforce.inject({ method: "GET", url: "/api/v1/admin/users" });
    expect(admin.statusCode).toBe(401);
    const me = await servers.enforce.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(me.statusCode).toBe(401);
  });

  it("owner-session routes refuse chatter keys and team leads, admit the owner", async (context) => {
    const servers = requireServers(context);
    if (!servers) return;
    const viaChatter = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(viaChatter.statusCode).toBe(403);

    const leadCookie = await loginCookie(servers.enforce, "lead", "lead-secret");
    const viaLead = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: { cookie: leadCookie },
    });
    expect(viaLead.statusCode).toBe(403);

    const ownerCookie = await loginCookie(servers.enforce, "dima", "owner-secret");
    const viaOwner = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: { cookie: ownerCookie },
    });
    expect(viaOwner.statusCode).toBe(200);
  });

  it("session routes refuse api keys, admit dashboard sessions", async (context) => {
    const servers = requireServers(context);
    if (!servers) return;
    const viaChatter = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/models",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(viaChatter.statusCode).toBe(403);

    const leadCookie = await loginCookie(servers.enforce, "lead", "lead-secret");
    const viaLead = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/models",
      headers: { cookie: leadCookie },
    });
    expect(viaLead.statusCode).toBe(200);
  });

  it("apiKey routes refuse sessions, admit bearer keys", async (context) => {
    const servers = requireServers(context);
    if (!servers) return;
    const ownerCookie = await loginCookie(servers.enforce, "dima", "owner-secret");
    const viaSession = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/ofapi/credits/summary",
      headers: { cookie: ownerCookie },
    });
    expect(viaSession.statusCode).toBe(403);

    const viaChatter = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/ofapi/credits/summary",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(viaChatter.statusCode).toBe(200);
  });

  it("any-kind routes admit both auth methods", async (context) => {
    const servers = requireServers(context);
    if (!servers) return;
    const viaChatter = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(viaChatter.statusCode).toBe(200);

    const ownerCookie = await loginCookie(servers.enforce, "dima", "owner-secret");
    const viaOwner = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: ownerCookie },
    });
    expect(viaOwner.statusCode).toBe(200);
  });

  it("monitoring routes accept the token without any principal", async (context) => {
    const servers = requireServers(context);
    if (!servers) return;
    const withToken = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/health/sync",
      headers: { "x-monitoring-token": MONITORING_TOKEN },
    });
    expect([200, 503]).toContain(withToken.statusCode);

    const withoutToken = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/health/sync",
    });
    expect(withoutToken.statusCode).toBe(401);

    const viaChatter = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/health/sync",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(viaChatter.statusCode).toBe(403);
  });

  it("page scope: assigned page passes, unassigned page 403s, unknown label 404s", async (context) => {
    const servers = requireServers(context);
    if (!servers) return;
    const assigned = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/pages/lana/subscribers",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(assigned.statusCode).toBe(200);

    const unassigned = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/pages/lily1/subscribers",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(unassigned.statusCode).toBe(403);

    const unknown = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/pages/ghost/subscribers",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(unknown.statusCode).toBe(404);

    const ownerCookie = await loginCookie(servers.enforce, "dima", "owner-secret");
    const ownerBypass = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/pages/lily1/subscribers",
      headers: { cookie: ownerCookie },
    });
    expect(ownerBypass.statusCode).toBe(200);
  });

  it("stage 2's revenue tightening is reproduced declaratively (session-only)", async (context) => {
    const servers = requireServers(context);
    if (!servers) return;
    // pageRevenue declares kind:"session" — a chatter bearer key on an assigned
    // page's ledger is refused by role, not by page scope.
    const viaChatter = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/pages/lana/revenue",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(viaChatter.statusCode).toBe(403);
  });
});

describe("log mode: legacy guards keep answering, statuses identical to enforce", () => {
  it("reproduces the same denial grid through the legacy in-handler guards", async (context) => {
    const servers = requireServers(context);
    if (!servers) return;
    const cases: Array<{ url: string; headers?: Record<string, string>; expected: number }> = [
      { url: "/api/v1/admin/users", expected: 401 },
      { url: "/api/v1/admin/users", headers: { authorization: `Bearer ${chatterKey}` }, expected: 403 },
      { url: "/api/v1/models", headers: { authorization: `Bearer ${chatterKey}` }, expected: 403 },
      { url: "/api/v1/pages/lily1/subscribers", headers: { authorization: `Bearer ${chatterKey}` }, expected: 403 },
      { url: "/api/v1/pages/ghost/subscribers", headers: { authorization: `Bearer ${chatterKey}` }, expected: 404 },
      // Valid query so schema validation does not answer first — the 403 must
      // come from Stage 2's legacy enforceRevenueRouteRoleScope guard.
      { url: "/api/v1/pages/lana/revenue?period=7d", headers: { authorization: `Bearer ${chatterKey}` }, expected: 403 },
      { url: "/api/v1/pages/lana/subscribers", headers: { authorization: `Bearer ${chatterKey}` }, expected: 200 },
    ];

    for (const testCase of cases) {
      const viaLog = await servers.log.inject({
        method: "GET",
        url: testCase.url,
        headers: testCase.headers,
      });
      expect(viaLog.statusCode, `log-mode ${testCase.url}`).toBe(testCase.expected);
    }
  });

  it("keeps the webhook's hmac handler answer identical across modes", async (context) => {
    const servers = requireServers(context);
    if (!servers) return;
    const inject = {
      method: "POST" as const,
      url: "/api/v1/ofapi/webhook",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ probe: true }),
    };
    const viaLog = await servers.log.inject(inject);
    const viaEnforce = await servers.enforce.inject(inject);
    expect(viaEnforce.statusCode).toBe(viaLog.statusCode);
    expect(viaEnforce.statusCode).toBeGreaterThanOrEqual(400);
  });
});
