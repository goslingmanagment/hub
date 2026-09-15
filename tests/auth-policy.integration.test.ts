import { fixtureUserId } from "./helpers/user-identity.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFanslyPage, createModel, insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import {
  AGENT_KEY_TOKEN_PREFIX,
  assignPageToUser,
  authenticateAgentKey,
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
/** A live Agent Read Plane key (slice 0b): authenticates, admitted nowhere yet. */
const agentKeyToken = `${AGENT_KEY_TOKEN_PREFIX}policyprobe000000000`;
let agentAppContext: AppContext;

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
  const lanaPage = await createFanslyPage(testDb.db, { modelId: model.id, label: "lana" });
  await createFanslyPage(testDb.db, { modelId: model.id, label: "lily1" });

  const issued = await issueChatterApiKey(seedContext, {
    userId: await fixtureUserId(seedContext, "anton"),
    pageLabel: "lana",
  }, { source: "cli" });
  chatterKey = issued.key;

  // The module role-matrix wants a team_lead with a page in scope.
  await assignPageToUser(seedContext, {
    userId: await fixtureUserId(seedContext, "lead"),
    pageLabel: "lana",
  }, { source: "cli" });

  agentAppContext = seedContext;
  await insertAgentKey(testDb.db, {
    name: "policy-probe",
    keyPrefix: agentKeyToken.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(agentKeyToken),
    capabilities: ["read:messages"],
    // Granted the very page the human matrix reads, so every refusal below is
    // about the principal KIND and not about a missing page grant.
    pageIds: lanaPage ? [lanaPage.id] : [],
    dailyRequestBudget: 5000,
    dailyRowBudget: 500_000,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    createdBy: null,
  });

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

  it("refuses a live agent key on the pre-agent routes in BOTH modes", async (context) => {
    const servers = requireServers(context);
    if (!servers) return;
    // Dual-layer proof (#143): in enforce mode the declaration denies before any
    // handler; in log mode the in-handler guards must reach the same answer. The
    // key here is real and live — it authenticates, then gets refused by scope.
    const cases: Array<{ url: string; kind: string }> = [
      { url: "/api/v1/auth/me", kind: "any" },
      { url: "/api/v1/models", kind: "session" },
      { url: "/api/v1/admin/users", kind: "owner-session" },
      { url: "/api/v1/events/snapshot?accountId=1&afterSeq=0", kind: "apiKey" },
      { url: "/api/v1/pages/lana/subscribers", kind: "any + page scope" },
    ];
    const headers = { authorization: `Bearer ${agentKeyToken}` };

    for (const testCase of cases) {
      const viaEnforce = await servers.enforce.inject({ method: "GET", url: testCase.url, headers });
      const viaLog = await servers.log.inject({ method: "GET", url: testCase.url, headers });
      expect(viaEnforce.statusCode, `enforce ${testCase.kind} ${testCase.url}`).toBe(403);
      expect(viaLog.statusCode, `log ${testCase.kind} ${testCase.url}`).toBe(403);
    }

    // And the key really is live: the same token authenticates into an agent
    // principal, so these 403s are scope decisions, not a broken credential.
    const principal = await authenticateAgentKey(agentAppContext, agentKeyToken);
    expect(principal?.kind).toBe("agent");
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

// One representative route per bounded-context module (target §6.1). Cells:
// a number = exact status in BOTH modes; "allowed" = the auth layer admitted
// the principal (not 401/403, not 5xx — the handler may 200/400/404 on seeded
// data); "same" = assert only that log and enforce modes agree.
type MatrixCell = number | "allowed" | "same";

const MODULE_MATRIX: Array<{
  module: string;
  url: string;
  cells: Record<"anon" | "chatter" | "lead" | "owner", MatrixCell>;
}> = [
  { module: "identity", url: "/api/v1/auth/me", cells: { anon: 401, chatter: "allowed", lead: "allowed", owner: "allowed" } },
  { module: "catalog", url: "/api/v1/models", cells: { anon: 401, chatter: 403, lead: "allowed", owner: "allowed" } },
  { module: "ingest", url: "/api/v1/ofapi/commands/00000000-0000-4000-8000-000000000001", cells: { anon: 401, chatter: "allowed", lead: 403, owner: 403 } },
  { module: "conversations", url: "/api/v1/pages/lana/fans/9000001/profile", cells: { anon: 401, chatter: "allowed", lead: "allowed", owner: "allowed" } },
  { module: "finance", url: "/api/v1/pages/lana/revenue?period=7d", cells: { anon: 401, chatter: 403, lead: "allowed", owner: "allowed" } },
  { module: "audience", url: "/api/v1/pages/lana/subscribers", cells: { anon: 401, chatter: "allowed", lead: "allowed", owner: "allowed" } },
  { module: "workboard", url: "/api/v1/pages/lana/workboard/v2?tab=subscribers", cells: { anon: 401, chatter: 403, lead: "allowed", owner: "allowed" } },
  { module: "ai", url: "/api/v1/admin/usage/chatters", cells: { anon: 401, chatter: 403, lead: 403, owner: "allowed" } },
  { module: "ops", url: "/api/v1/sync/overview", cells: { anon: 401, chatter: 403, lead: "allowed", owner: "allowed" } },
  { module: "events", url: "/api/v1/events/snapshot?accountId=1&afterSeq=0", cells: { anon: 401, chatter: "same", lead: 403, owner: 403 } },
];

describe("per-module role matrix (Stage 19)", () => {
  it("holds for a representative route of every module, identically in both modes", async (context) => {
    const servers = requireServers(context);
    if (!servers) return;

    const ownerCookie = await loginCookie(servers.enforce, "dima", "owner-secret");
    const leadCookie = await loginCookie(servers.enforce, "lead", "lead-secret");
    const principals: Record<string, Record<string, string>> = {
      anon: {},
      chatter: { authorization: `Bearer ${chatterKey}` },
      lead: { cookie: leadCookie },
      owner: { cookie: ownerCookie },
    };

    for (const row of MODULE_MATRIX) {
      for (const [who, headers] of Object.entries(principals)) {
        const expected = row.cells[who as keyof typeof row.cells];
        const viaEnforce = await servers.enforce.inject({ method: "GET", url: row.url, headers });
        const viaLog = await servers.log.inject({ method: "GET", url: row.url, headers });
        const label = `${row.module} ${row.url} as ${who}`;

        expect(viaLog.statusCode, `${label} — log/enforce parity`).toBe(viaEnforce.statusCode);
        if (typeof expected === "number") {
          expect(viaEnforce.statusCode, label).toBe(expected);
        } else if (expected === "allowed") {
          expect(viaEnforce.statusCode, label).not.toBe(401);
          expect(viaEnforce.statusCode, label).not.toBe(403);
          // 503 is a legitimate flags-off answer (e.g. the command outbox);
          // only a crash counts as failure here.
          expect(viaEnforce.statusCode, label).not.toBe(500);
        }
      }
    }
  });
});
