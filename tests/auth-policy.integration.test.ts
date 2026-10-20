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
} from "../apps/runtime/src/services/auth.ts";
import { issueChatterDeviceToken } from "./helpers/device-credentials.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Kernel Stage 19: the declarative auth middleware against real principals on a
// real database. The declaration denies before any handler runs.

const MONITORING_TOKEN = "monitor-secret";

let testDb: StartedTestDatabase | null = null;
let enforceServer: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let chatterDeviceToken = "";
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

  const issued = await issueChatterDeviceToken(seedContext, {
    username: "anton",
    pageLabel: "lana",
  }, { source: "cli" });
  chatterDeviceToken = issued.key;

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

  enforceServer = await buildApiServer(createTestAppContext(testDb, {
    healthSyncMonitoringToken: MONITORING_TOKEN,
  }));
}, 120_000);

afterAll(async () => {
  await enforceServer?.close();
  await testDb?.stop();
});

function requireServers(context: { skip: () => void }) {
  if (!enforceServer) {
    context.skip();
    return null;
  }
  return { enforce: enforceServer };
}

describe("the declared policy answers before any handler", () => {
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

  it("owner-session routes refuse chatter device tokens and team leads, admit the owner", async (context) => {
    const servers = requireServers(context);
    if (!servers) return;
    const viaChatter = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: { authorization: `Bearer ${chatterDeviceToken}` },
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

  it("session routes refuse bearers, admit dashboard sessions", async (context) => {
    const servers = requireServers(context);
    if (!servers) return;
    const viaChatter = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/models",
      headers: { authorization: `Bearer ${chatterDeviceToken}` },
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

  it("apiKey routes refuse sessions, admit device tokens", async (context) => {
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
      headers: { authorization: `Bearer ${chatterDeviceToken}` },
    });
    expect(viaChatter.statusCode).toBe(200);
  });

  it("any-kind routes admit both auth methods", async (context) => {
    const servers = requireServers(context);
    if (!servers) return;
    const viaChatter = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${chatterDeviceToken}` },
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
      headers: { authorization: `Bearer ${chatterDeviceToken}` },
    });
    expect(viaChatter.statusCode).toBe(403);
  });

  it("page scope: assigned page passes, unassigned page 403s, unknown label 404s", async (context) => {
    const servers = requireServers(context);
    if (!servers) return;
    const assigned = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/pages/lana/subscribers",
      headers: { authorization: `Bearer ${chatterDeviceToken}` },
    });
    expect(assigned.statusCode).toBe(200);

    const unassigned = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/pages/lily1/subscribers",
      headers: { authorization: `Bearer ${chatterDeviceToken}` },
    });
    expect(unassigned.statusCode).toBe(403);

    const unknown = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/pages/ghost/subscribers",
      headers: { authorization: `Bearer ${chatterDeviceToken}` },
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
    // pageRevenue declares kind:"session" — a chatter bearer on an assigned
    // page's ledger is refused by role, not by page scope.
    const viaChatter = await servers.enforce.inject({
      method: "GET",
      url: "/api/v1/pages/lana/revenue",
      headers: { authorization: `Bearer ${chatterDeviceToken}` },
    });
    expect(viaChatter.statusCode).toBe(403);
  });
});

describe("principal kinds the pre-agent and owner routes refuse", () => {
  it("refuses a live agent key on the pre-agent routes", async (context) => {
    const servers = requireServers(context);
    if (!servers) return;
    // The declaration denies before any handler. The key here is real and
    // live — it authenticates, then gets refused by scope.
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
      expect(viaEnforce.statusCode, `enforce ${testCase.kind} ${testCase.url}`).toBe(403);
    }

    // And the key really is live: the same token authenticates into an agent
    // principal, so these 403s are scope decisions, not a broken credential.
    const principal = await authenticateAgentKey(agentAppContext, agentKeyToken);
    expect(principal?.kind).toBe("agent");
  });

  it("keeps the persona and raw-prompt routes owner-session (persona cutover)", async (context) => {
    const servers = requireServers(context);
    if (!servers) return;
    // The declaration (owner-session) and the handler guard (requireOwner) must
    // agree: a route moved to owner-session that still called requireApiKeyUser
    // would 403 the owner too. Bodies are valid so schema validation never
    // answers first.
    const ownerCookie = await loginCookie(servers.enforce, "dima", "owner-secret");
    const leadCookie = await loginCookie(servers.enforce, "lead", "lead-secret");
    const chatter = { authorization: `Bearer ${chatterDeviceToken}` };
    const rawPrompt = {
      clientRequestId: "00000000-0000-4000-8000-000000000002",
      feature: "fast-reply",
      pageLabel: "lana",
      platform: "fansly",
      platformUserId: "9000001",
      conversationId: "9000001",
      model: "anthropic:claude-sonnet-4-6",
      reasoningEffort: "low",
      isRegeneration: false,
      prompt: {
        systemBlocks: [{ text: "raw system", cache: "none" }],
        userBlocks: [{ text: "raw user", cache: "none" }],
      },
    };
    const routes: Array<{
      method: "GET" | "PUT" | "DELETE" | "POST";
      url: string;
      payload?: Record<string, unknown>;
      owner: number;
    }> = [
      { method: "GET", url: "/api/v1/ai/personas", owner: 200 },
      // Retired: the owner is admitted by the policy and told to use the console.
      {
        method: "PUT",
        url: "/api/v1/ai/personas/custom:probe",
        payload: { displayName: "Probe", systemBlock: "probe prompt" },
        owner: 409,
      },
      { method: "DELETE", url: "/api/v1/ai/personas/custom:probe", owner: 409 },
      // Admitted, then the gateway's own flag answers (off in this fixture).
      { method: "POST", url: "/api/v1/ai/gateway/stream", payload: rawPrompt, owner: 503 },
    ];

    for (const route of routes) {
      const cells: Array<[string, Record<string, string>, number]> = [
        ["anon", {}, 401],
        ["chatter device token", chatter, 403],
        ["team_lead cookie", { cookie: leadCookie }, 403],
        ["owner cookie", { cookie: ownerCookie }, route.owner],
      ];
      for (const [who, headers, expected] of cells) {
        const request = {
          method: route.method,
          url: route.url,
          headers,
          ...(route.payload ? { payload: route.payload } : {}),
        };
        const viaEnforce = await servers.enforce.inject(request);
        const label = `${route.method} ${route.url} as ${who}`;
        expect(viaEnforce.statusCode, `enforce ${label}: ${viaEnforce.body}`).toBe(expected);
      }
    }
  });
});

// One representative route per bounded-context module (target §6.1). Cells:
// a number = exact status; "allowed" = the auth layer admitted the principal
// (not 401/403, not 5xx — the handler may 200/400/404 on seeded data);
// "unchecked" = the handler's answer depends on data this file does not seed.
type MatrixCell = number | "allowed" | "unchecked";

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
  { module: "ai", url: "/api/v1/admin/usage/chatters", cells: { anon: 401, chatter: 403, lead: 403, owner: "allowed" } },
  { module: "ops", url: "/api/v1/sync/overview", cells: { anon: 401, chatter: 403, lead: "allowed", owner: "allowed" } },
  { module: "events", url: "/api/v1/events/snapshot?accountId=1&afterSeq=0", cells: { anon: 401, chatter: "unchecked", lead: 403, owner: 403 } },
];

describe("per-module role matrix (Stage 19)", () => {
  it("holds for a representative route of every module", async (context) => {
    const servers = requireServers(context);
    if (!servers) return;

    const ownerCookie = await loginCookie(servers.enforce, "dima", "owner-secret");
    const leadCookie = await loginCookie(servers.enforce, "lead", "lead-secret");
    const principals: Record<string, Record<string, string>> = {
      anon: {},
      chatter: { authorization: `Bearer ${chatterDeviceToken}` },
      lead: { cookie: leadCookie },
      owner: { cookie: ownerCookie },
    };

    for (const row of MODULE_MATRIX) {
      for (const [who, headers] of Object.entries(principals)) {
        const expected = row.cells[who as keyof typeof row.cells];
        const viaEnforce = await servers.enforce.inject({ method: "GET", url: row.url, headers });
        const label = `${row.module} ${row.url} as ${who}`;

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
