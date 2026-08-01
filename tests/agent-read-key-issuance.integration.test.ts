import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_KEY_MAX_LIFETIME_DAYS,
  createFanslyPage,
  createModel,
  findAgentKeyByDigest,
  listAgentKeys,
  setConfigOverride,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { issueAgentKey, revokeAgentKeyById } from "../apps/runtime/src/services/agent-keys.ts";
import type * as AuthModule from "../apps/runtime/src/services/auth.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

/**
 * Failure injection for the two atomicity cases, aimed at the AUDIT write and
 * nothing else.
 *
 * The obvious injection (an actor id with no row in `users`) does not work and
 * quietly tests nothing: `agent_keys.created_by` is a foreign key into `users`
 * too, so a bogus actor fails on the KEY insert and the audit is never reached.
 * The first draft of these cases passed for exactly that wrong reason, which is
 * why they now assert the injected message.
 *
 * So the seam is `recordAudit` itself, and only for `agent_key.*` events, so
 * every other audit in this file (logins, user creation) stays real.
 */
const injection = vi.hoisted(() => ({ failAgentKeyAudit: false }));

vi.mock("../apps/runtime/src/services/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof AuthModule>();
  return {
    ...actual,
    recordAudit: async (
      app: Parameters<typeof actual.recordAudit>[0],
      input: Parameters<typeof actual.recordAudit>[1],
    ) => {
      if (injection.failAgentKeyAudit && String(input.eventType).startsWith("agent_key.")) {
        throw new Error("injected audit failure: audit_events insert refused");
      }
      return actual.recordAudit(app, input);
    },
  };
});

/**
 * Agent key issuance (slice B): the owner-session half of the plane.
 *
 * The properties pinned here are the ones that make a machine credential safe to
 * hand out at all: the token exists once, the digest never leaves, the closed
 * capability matrix and the lifetime ceiling refuse rather than clamp, the grant
 * is the pages that were named, and nobody below owner can reach any of it.
 */

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
  if (!server) throw new Error("server not started");
  const login = await server.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  expect(login.statusCode).toBe(200);
  return sessionCookieFrom(login);
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "customs-audit",
    capabilities: ["read:messages", "read:money"],
    pageLabels: ["lora-2"],
    ...overrides,
  };
}

describe("agent read plane: key issuance", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  beforeEach(async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await resetIntegrationDatabase(testDb.pool);
    appContext = createTestAppContext(testDb);

    const model = await createModel(testDb.db, { slug: "lora", name: "Lora" });
    if (!model) throw new Error("fixture model was not created");
    await createFanslyPage(testDb.db, { modelId: model.id, label: "lora-2" });
    await createFanslyPage(testDb.db, { modelId: model.id, label: "lora-1" });

    await createUserAccount(
      appContext,
      { username: "dima", role: "owner", password: "owner-secret" },
      { source: "cli" },
    );
    await createUserAccount(
      appContext,
      { username: "lead", role: "team_lead", password: "lead-secret" },
      { source: "cli" },
    );

    server = await buildApiServer(appContext);
    await server.ready();
  });

  afterEach(async () => {
    injection.failAgentKeyAudit = false;
    await server?.close();
    server = null;
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("issues a key, returns the raw token ONCE, and never returns a digest", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");

    const created = await server.inject({
      method: "POST",
      url: "/api/v1/agent/keys",
      headers: { cookie },
      payload: createBody({ pageLabels: ["lora-2", "lora-1"] }),
    });
    expect(created.statusCode).toBe(200);
    const body = created.json() as { token: string; key: Record<string, unknown> };

    expect(body.token.startsWith(AGENT_KEY_TOKEN_PREFIX)).toBe(true);
    expect(body.key.pageLabels).toEqual(["lora-2", "lora-1"]);
    expect(body.key.capabilities).toEqual(["read:messages", "read:money"]);
    expect(body.key.isActive).toBe(true);
    // Defaults from the contract (plan §9 item 25), not something a caller had
    // to remember to send.
    expect(body.key.dailyRequestBudget).toBe(5_000);
    expect(body.key.dailyRowBudget).toBe(500_000);

    // The stored digest is sha256 OF THE RETURNED TOKEN, and the token itself is
    // nowhere in the row.
    const stored = await findAgentKeyByDigest(testDb.db, sha256Hex(body.token));
    expect(stored?.name).toBe("customs-audit");
    expect(JSON.stringify(stored)).not.toContain(body.token);

    // A second read of the same key never carries the token or the digest again.
    const listed = await server.inject({
      method: "GET",
      url: "/api/v1/agent/keys",
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    const list = listed.json() as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("token");
    expect(list[0]).not.toHaveProperty("keyDigest");
    expect(JSON.stringify(list)).not.toContain(body.token);
    expect(JSON.stringify(list)).not.toContain(stored?.keyDigest ?? "IMPOSSIBLE");
    expect(list[0]?.keyPrefix).toBe(body.key.keyPrefix);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("sets Cache-Control: no-store on the response that carries the token", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/agent/keys",
      headers: { cookie },
      payload: createBody(),
    });
    // This is WHY the routes live under /api/v1/agent/ and are registered by the
    // plane's registrar: a freshly minted bearer token must not sit in a cache.
    expect(created.headers["cache-control"]).toBe("no-store");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses a capability outside the closed matrix with a 400", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/agent/keys",
      headers: { cookie },
      payload: createBody({ capabilities: ["read:messages", "read:everything"] }),
    });
    expect(response.statusCode).toBe(400);

    const listed = await server.inject({
      method: "GET",
      url: "/api/v1/agent/keys",
      headers: { cookie },
    });
    // Rejected, not silently narrowed: no key was minted at all.
    expect(listed.json()).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses a lifetime past the hard ceiling with a 400 rather than clamping it", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/agent/keys",
      headers: { cookie },
      payload: createBody({ expiresInDays: AGENT_KEY_MAX_LIFETIME_DAYS + 1 }),
    });
    // An owner who asked for two years and got a key that quietly expires in one
    // would learn about it from a broken agent, not from the issuance.
    expect(response.statusCode).toBe(400);

    const ok = await server.inject({
      method: "POST",
      url: "/api/v1/agent/keys",
      headers: { cookie },
      payload: createBody({ expiresInDays: AGENT_KEY_MAX_LIFETIME_DAYS }),
    });
    expect(ok.statusCode).toBe(200);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses an unknown page label with a 404 and mints nothing", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/agent/keys",
      headers: { cookie },
      payload: createBody({ pageLabels: ["lora-2", "no-such-page"] }),
    });
    expect(response.statusCode).toBe(404);
    const listed = await server.inject({
      method: "GET",
      url: "/api/v1/agent/keys",
      headers: { cookie },
    });
    expect(listed.json()).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses a duplicate name with a 409", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    const first = await server.inject({
      method: "POST",
      url: "/api/v1/agent/keys",
      headers: { cookie },
      payload: createBody(),
    });
    expect(first.statusCode).toBe(200);
    const second = await server.inject({
      method: "POST",
      url: "/api/v1/agent/keys",
      headers: { cookie },
      payload: createBody(),
    });
    expect(second.statusCode).toBe(409);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("revokes idempotently, and a revoked key stops authenticating", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/agent/keys",
      headers: { cookie },
      payload: createBody({ capabilities: ["read:datasets"] }),
    });
    const { token, key } = created.json() as { token: string; key: { id: number } };

    // The plane is `off` by default, and an off plane answers 503 AFTER
    // authenticating. Turn it on so the before/after difference below is about
    // the key's liveness and nothing else.
    await setConfigOverride(testDb.db, {
      key: "agentReadPlaneMode",
      value: "full",
      userId: null,
      groupId: randomUUID(),
    });

    const before = await server.inject({
      method: "GET",
      url: "/api/v1/agent/capabilities",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.statusCode).toBe(200);

    const first = await server.inject({
      method: "POST",
      url: `/api/v1/agent/keys/${key.id}/revoke`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id: key.id, revoked: true });
    const firstRevokedAt = (first.json() as { revokedAt: string }).revokedAt;
    expect(firstRevokedAt).not.toBeNull();

    const second = await server.inject({
      method: "POST",
      url: `/api/v1/agent/keys/${key.id}/revoke`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(200);
    // The SECOND call reports no transition and does not move the original
    // timestamp: the row records when it was revoked, not when it was last asked.
    expect(second.json()).toMatchObject({ revoked: false, revokedAt: firstRevokedAt });

    const after = await server.inject({
      method: "GET",
      url: "/api/v1/agent/capabilities",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(401);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("leaves NO key row behind when the audit write fails", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    // Real failure injection, not a stub: `audit_events.actor_user_id` is a
    // foreign key into `users`, so an actor that does not exist makes the audit
    // insert throw for real, inside the transaction, exactly where a production
    // audit failure would.
    injection.failAgentKeyAudit = true;
    const failure = await issueAgentKey(
      appContext,
      {
        name: "orphan-candidate",
        capabilities: ["read:messages"],
        pageLabels: ["lora-2"],
        dailyRequestBudget: 5_000,
        dailyRowBudget: 500_000,
        expiresInDays: 90,
      },
      { source: "test", actorUserId: null },
    ).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    // Falsifiability: this is the SANITISER's wording, reached only from the
    // unexpected-error branch, so the case cannot pass because issuance died
    // earlier (a missing page would also leave no row behind).
    expect(message).toContain("agent key write failed");
    // Same seam, second property: the driver's own message embeds the statement
    // WITH its bound parameters, which for this table include the key digest, and
    // the global boundary logs whatever it is handed
    // (docs/error-handling.md:339-344).
    expect(message).not.toContain("injected audit failure");
    expect(message).not.toMatch(/insert into/i);

    // The point of the whole transaction: an orphaned credential is WORSE than a
    // failed issuance. A surviving row would be a live key whose only copy of the
    // token nobody received, unauditable, and blocking its own name with a 409.
    expect(await listAgentKeys(testDb.db)).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("does not half-revoke when the audit write fails, and the retry still audits", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/agent/keys",
      headers: { cookie },
      payload: createBody(),
    });
    const { key } = created.json() as { key: { id: number } };

    injection.failAgentKeyAudit = true;
    await expect(revokeAgentKeyById(
      appContext,
      { id: key.id },
      { source: "test", actorUserId: null },
    )).rejects.toThrow(/injected audit failure/);
    injection.failAgentKeyAudit = false;

    // Without the transaction this is where it would end: revoked forever, and
    // the retry would take the already-revoked branch and skip the audit, so no
    // record of the revocation would ever exist.
    const [row] = await listAgentKeys(testDb.db);
    expect(row?.revokedAt).toBeNull();

    const retry = await server.inject({
      method: "POST",
      url: `/api/v1/agent/keys/${key.id}/revoke`,
      headers: { cookie },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ revoked: true });

    const audits = await testDb.pool.query(
      "select count(*)::int as count from audit_events where event_type = 'agent_key.revoked'",
    );
    expect(audits.rows[0]?.count).toBe(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("404s a revoke of a key that does not exist", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/agent/keys/424242/revoke",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("admits the owner only: anonymous 401, team lead 403, agent key refused", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const ownerCookie = await loginCookie("dima", "owner-secret");
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/agent/keys",
      headers: { cookie: ownerCookie },
      payload: createBody(),
    });
    const { token } = created.json() as { token: string };

    for (const [url, method] of [
      ["/api/v1/agent/keys", "GET"],
      ["/api/v1/agent/keys", "POST"],
    ] as const) {
      const anon = await server.inject({ method, url, payload: createBody({ name: "x" }) });
      expect(anon.statusCode, `${method} ${url} anon`).toBe(401);

      const leadCookie = await loginCookie("lead", "lead-secret");
      const lead = await server.inject({
        method,
        url,
        headers: { cookie: leadCookie },
        payload: createBody({ name: "y" }),
      });
      expect(lead.statusCode, `${method} ${url} lead`).toBe(403);

      // An agent key cannot mint or enumerate agent keys: a machine principal
      // that could widen its own grant would make the grant decorative.
      const agent = await server.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        payload: createBody({ name: "z" }),
      });
      expect([401, 403]).toContain(agent.statusCode);
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
