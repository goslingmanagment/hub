import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_KEY_MAX_LIFETIME_DAYS,
  createFanslyPage,
  createModel,
  findAgentKeyByDigest,
  insertPersonRow,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { updateAgentKeyPages } from "../apps/runtime/src/services/agent-keys.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { issueDeviceTokenForUsername } from "./helpers/device-credentials.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

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
    agentCode: "audit-bot",
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

    // The agents a key may belong to (the people registry): one working, one gone, and a human who is not one.
    // One live key per agent: a test that keeps several keys alive gives each its own agent (audit-bot-2, -3).
    for (const [code, kind, state] of [
      ["audit-bot", "agent", "working"], ["audit-bot-2", "agent", "working"], ["audit-bot-3", "agent", "working"],
      ["old-bot", "agent", "left"], ["alex", "human", "working"],
    ] as const) {
      await insertPersonRow(testDb.db, {
        code, displayName: code, kind, role: kind === "agent" ? "agent" : "chatter", state, leftOn: null, telegramUserId: null,
        telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
      });
    }

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

  it("gives every key its agent: named at issuance, linked with the key, listed with it", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    const created = await server.inject({ method: "POST", url: "/api/v1/agent/keys", headers: { cookie }, payload: createBody() });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().key.agent).toEqual({ code: "audit-bot", displayName: "audit-bot", state: "working" });
    const listed = (await server.inject({ method: "GET", url: "/api/v1/agent/keys", headers: { cookie } })).json() as Array<Record<string, unknown>>;
    expect(listed[0]?.agent).toEqual({ code: "audit-bot", displayName: "audit-bot", state: "working" });
    expect(listed[0]?.lastCall).toBeNull();
    const linked = await testDb.pool.query(
      "select p.code from person_agent_keys k join people p on p.id = k.person_id where k.agent_key_id = $1", [created.json().key.id]);
    expect(linked.rows.map((row) => row.code)).toEqual(["audit-bot"]);

    // Only a service's own key goes without an agent.
    const service = await server.inject({ method: "POST", url: "/api/v1/agent/keys", headers: { cookie },
      payload: createBody({ name: "taskindex-server", agentCode: undefined, capabilities: ["signin:taskindex", "introspect:agent_keys"] }) });
    expect(service.statusCode, service.body).toBe(200);
    expect(service.json().key.agent).toBeNull();
    for (const payload of [
      createBody({ name: "no-agent", agentCode: undefined }),
      createBody({ name: "gone-agent", agentCode: "old-bot" }),
      createBody({ name: "a-human", agentCode: "alex" }),
    ]) {
      const refused = await server.inject({ method: "POST", url: "/api/v1/agent/keys", headers: { cookie }, payload });
      expect(refused.statusCode, refused.body).toBe(400);
    }
    expect((await server.inject({ method: "POST", url: "/api/v1/agent/keys", headers: { cookie },
      payload: createBody({ name: "nobody", agentCode: "nobody" }) })).statusCode).toBe(404);
    // A refused issuance minted nothing.
    const names = (await testDb.pool.query("select name from agent_keys order by id")).rows.map((row) => row.name);
    expect(names).toEqual(["customs-audit", "taskindex-server"]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("gives an agent one live key at a time, whoever links: issuance and the person's card", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    const issue = (name: string, agentCode?: string) => server!.inject({
      method: "POST", url: "/api/v1/agent/keys", headers: { cookie },
      payload: createBody({ name, agentCode, ...(agentCode === undefined ? { capabilities: ["introspect:agent_keys"] } : {}) }),
    });
    const first = await issue("audit-first", "audit-bot");
    expect(first.statusCode, first.body).toBe(200);
    // A second live key of the same agent would carry the agent's rights in every service: refused, nothing minted.
    const second = await issue("audit-second", "audit-bot");
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json()).toMatchObject({ reason: "agent_holds_live_key" });
    // A key no agent holds is not the agent's: issued, and the card cannot hand it to the agent while the first lives.
    const loose = await issue("audit-loose");
    expect(loose.statusCode, loose.body).toBe(200);
    const link = (add: number[], remove: number[] = []) => server!.inject({
      method: "PATCH", url: "/api/v1/admin/people/audit-bot", headers: { cookie },
      payload: { agentKeys: { ...(add.length > 0 ? { add } : {}), ...(remove.length > 0 ? { remove } : {}) } },
    });
    const firstId = (first.json() as { key: { id: number } }).key.id;
    const looseId = (loose.json() as { key: { id: number } }).key.id;
    const refused = await link([looseId]);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ reason: "agent_holds_live_key" });
    // Taking the live key off and giving the new one in the same change is one key at a time: accepted.
    const swapped = await link([looseId], [firstId]);
    expect(swapped.statusCode, swapped.body).toBe(200);
    // Once the agent's key is revoked, a new one may be issued for it.
    expect((await server.inject({ method: "POST", url: `/api/v1/agent/keys/${looseId}/revoke`, headers: { cookie } })).statusCode).toBe(200);
    expect((await issue("audit-third", "audit-bot")).statusCode).toBe(200);
    const live = await testDb.pool.query(
      `select k.name from person_agent_keys pak join agent_keys k on k.id = pak.agent_key_id join people p on p.id = pak.person_id
        where p.code = 'audit-bot' and k.revoked_at is null and k.expires_at > now() order by k.name`);
    expect(live.rows.map((row) => row.name)).toEqual(["audit-third"]);
    expect((await testDb.pool.query("select name from agent_keys order by id")).rows.map((row) => row.name))
      .toEqual(["audit-first", "audit-loose", "audit-third"]);
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

  // Owner, 2026-10-24: a live key's capabilities change in place instead of a
  // new key being issued. Its pages stay as issued.
  async function capabilitiesAudit() {
    const result = await testDb!.pool.query<{ source: string; actor_user_id: string | null; metadata: Record<string, unknown> }>(
      `select source, actor_user_id::text, metadata from audit_events
       where event_type = 'agent_key.capabilities_updated' order by id`,
    );
    return result.rows;
  }

  it("the owner widens a live key in place: it drafts on its next request, and the change is audited", async (context) => {
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
    const drafts = () => server!.inject({
      method: "GET",
      url: "/api/v1/agent/pages/lora-2/publications",
      headers: { authorization: `Bearer ${token}` },
    });
    expect((await drafts()).statusCode).toBe(403);

    const widened = await server.inject({
      method: "PATCH",
      url: `/api/v1/agent/keys/${key.id}`,
      headers: { cookie },
      payload: { capabilities: ["write:publication_drafts", "read:datasets"] },
    });
    expect(widened.statusCode, widened.body).toBe(200);
    expect(widened.headers["cache-control"]).toBe("no-store");
    expect(widened.json()).toMatchObject({
      id: key.id,
      capabilities: ["read:datasets", "write:publication_drafts"],
      pageLabels: ["lora-2"],
      isActive: true,
    });
    expect(JSON.stringify(widened.json())).not.toContain(token);

    // The same token, no re-issue: the authenticator reads the row per request.
    const after = await drafts();
    expect(after.statusCode, after.body).toBe(200);

    const owner = await testDb.pool.query<{ id: string }>("select id::text from users where username = 'dima'");
    const audit = await capabilitiesAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      source: "api",
      actor_user_id: owner.rows[0]?.id,
      metadata: {
        agentKeyId: key.id,
        name: "customs-audit",
        before: ["read:datasets"],
        after: ["read:datasets", "write:publication_drafts"],
      },
    });
    const stored = await findAgentKeyByDigest(testDb.db, sha256Hex(token));
    expect(JSON.stringify(audit)).not.toContain(token);
    expect(JSON.stringify(audit)).not.toContain(stored?.keyDigest ?? "IMPOSSIBLE");

    // The same set again writes nothing and audits nothing.
    const same = await server.inject({
      method: "PATCH",
      url: `/api/v1/agent/keys/${key.id}`,
      headers: { cookie },
      payload: { capabilities: ["read:datasets", "write:publication_drafts"] },
    });
    expect(same.statusCode).toBe(200);
    expect(await capabilitiesAudit()).toHaveLength(1);

    // Narrowing works the same way, down to an empty set.
    const narrowed = await server.inject({
      method: "PATCH",
      url: `/api/v1/agent/keys/${key.id}`,
      headers: { cookie },
      payload: { capabilities: [] },
    });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(narrowed.json()).toMatchObject({ capabilities: [] });
    expect((await drafts()).statusCode).toBe(403);
    expect(await capabilitiesAudit()).toHaveLength(2);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses an unknown or repeated capability, a dead key, and everyone but the owner's session", async (context) => {
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
    const patch = (payload: Record<string, unknown>, headers: Record<string, string> = { cookie }, id = key.id) =>
      server!.inject({ method: "PATCH", url: `/api/v1/agent/keys/${id}`, headers, payload });
    const widen = { capabilities: ["read:datasets", "write:publication_drafts"] };

    expect((await patch({ capabilities: ["read:everything"] })).statusCode).toBe(400);
    expect((await patch({ capabilities: ["read:datasets", "read:datasets"] })).statusCode).toBe(400);
    expect((await patch(widen, { cookie }, 999_999)).statusCode).toBe(404);

    expect((await patch(widen, {})).statusCode).toBe(401);
    const leadCookie = await loginCookie("lead", "lead-secret");
    expect((await patch(widen, { cookie: leadCookie })).statusCode).toBe(403);
    const ownerDevice = await issueDeviceTokenForUsername(appContext, { username: "dima", label: "owner laptop" });
    expect((await patch(widen, { authorization: `Bearer ${ownerDevice.token}` })).statusCode).toBe(403);
    // A machine principal that could widen its own grant would make the grant decorative.
    expect((await patch(widen, { authorization: `Bearer ${token}` })).statusCode).toBe(403);

    const revoked = await server.inject({ method: "POST", url: `/api/v1/agent/keys/${key.id}/revoke`, headers: { cookie } });
    expect(revoked.statusCode).toBe(200);
    expect((await patch(widen)).statusCode).toBe(409);

    expect(await capabilitiesAudit()).toHaveLength(0);
    const stored = await findAgentKeyByDigest(testDb.db, sha256Hex(token));
    expect(stored?.capabilities).toEqual(["read:datasets"]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  // Owner, 2026-11-12: a live key's pages change in place (CLI agent-keys:pages)
  // instead of a new key being issued and installed again.
  async function pagesAudit() {
    const result = await testDb!.pool.query<{ source: string; actor_user_id: string | null; metadata: Record<string, unknown> }>(
      `select source, actor_user_id::text, metadata from audit_events
       where event_type = 'agent_key.pages_updated' order by id`,
    );
    return result.rows;
  }

  it("the owner adds and removes a live key's pages: the token reaches the new page, the change is audited", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/agent/keys",
      headers: { cookie },
      payload: createBody({ capabilities: ["write:publication_drafts"] }),
    });
    const { token, key } = created.json() as { token: string; key: { id: number } };
    const drafts = (label: string) => server!.inject({
      method: "GET",
      url: `/api/v1/agent/pages/${label}/publications`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect((await drafts("lora-1")).statusCode).not.toBe(200);

    const owner = await testDb.pool.query<{ id: string }>("select id::text from users where username = 'dima'");
    const ownerId = Number(owner.rows[0]!.id);
    const widened = await updateAgentKeyPages(
      appContext,
      { id: key.id, add: ["lora-1"], remove: [], note: "one more page" },
      { source: "cli", actorUserId: ownerId },
    );
    expect(widened).toMatchObject({ pageLabels: ["lora-2", "lora-1"], capabilities: ["write:publication_drafts"] });
    expect((await drafts("lora-1")).statusCode).toBe(200);

    const moved = await updateAgentKeyPages(
      appContext,
      { id: key.id, add: [], remove: ["lora-2"], note: "not hers any more" },
      { source: "cli", actorUserId: ownerId },
    );
    expect(moved.pageLabels).toEqual(["lora-1"]);
    expect((await drafts("lora-2")).statusCode).not.toBe(200);

    // Adding a page the key already has changes nothing and audits nothing.
    await updateAgentKeyPages(appContext, { id: key.id, add: ["lora-1"], remove: [] }, { source: "cli", actorUserId: ownerId });

    const audit = await pagesAudit();
    expect(audit).toEqual([
      {
        source: "cli",
        actor_user_id: owner.rows[0]!.id,
        metadata: { agentKeyId: key.id, name: "customs-audit", before: ["lora-2"], after: ["lora-2", "lora-1"], note: "one more page" },
      },
      {
        source: "cli",
        actor_user_id: owner.rows[0]!.id,
        metadata: { agentKeyId: key.id, name: "customs-audit", before: ["lora-2", "lora-1"], after: ["lora-1"], note: "not hers any more" },
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain(token);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses an unknown page, a key left with no page, and a revoked or expired key", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    // Three keys alive at once: each its own agent (one live key per agent).
    const issue = async (name: string, agentCode: string) => {
      const created = await server!.inject({
        method: "POST",
        url: "/api/v1/agent/keys",
        headers: { cookie },
        payload: createBody({ name, agentCode }),
      });
      return (created.json() as { key: { id: number } }).key.id;
    };
    const audit = { source: "cli", actorUserId: null };
    const keyId = await issue("pages-a", "audit-bot");

    await expect(updateAgentKeyPages(appContext, { id: keyId, add: ["lora-9"], remove: [] }, audit))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(updateAgentKeyPages(appContext, { id: keyId, add: [], remove: ["lora-1"] }, audit))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(updateAgentKeyPages(appContext, { id: keyId, add: [], remove: ["lora-2"] }, audit))
      .rejects.toMatchObject({ statusCode: 400 });

    const revokedId = await issue("pages-revoked", "audit-bot-2");
    await server.inject({ method: "POST", url: `/api/v1/agent/keys/${revokedId}/revoke`, headers: { cookie } });
    await expect(updateAgentKeyPages(appContext, { id: revokedId, add: ["lora-1"], remove: [] }, audit))
      .rejects.toMatchObject({ statusCode: 409 });

    const expiredId = await issue("pages-expired", "audit-bot-3");
    await testDb.pool.query(
      "update agent_keys set expires_at = now() - interval '1 minute', created_at = now() - interval '1 day' where id = $1",
      [expiredId],
    );
    await expect(updateAgentKeyPages(appContext, { id: expiredId, add: ["lora-1"], remove: [] }, audit))
      .rejects.toMatchObject({ statusCode: 409 });

    expect(await pagesAudit()).toHaveLength(0);
    const pages = await testDb.pool.query<{ page_ids: string[] }>("select page_ids::text[] from agent_keys order by id");
    expect(pages.rows.every((row) => row.page_ids.length === 1)).toBe(true);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
