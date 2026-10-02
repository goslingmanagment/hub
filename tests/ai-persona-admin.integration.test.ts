import { fixtureUserId } from "./helpers/user-identity.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { archiveAiPersona, upsertAiPersona } from "@agency_hub_core/db";
import type { AiGatewayProvider } from "../apps/runtime/src/services/ai-gateway.ts";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createUserAccount,
} from "../apps/runtime/src/services/auth.ts";
import {
  issueChatterDeviceToken,
  issueDeviceTokenForUserId,
} from "./helpers/device-credentials.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let chatterKey = "";
let deviceToken = "";

function sessionCookieFrom(response: { headers: Record<string, unknown> }) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") {
    throw new Error("Expected a session cookie");
  }
  return value.split(";")[0]!;
}

async function loginCookie(username: string, password: string) {
  const response = await server!.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  expect(response.statusCode, response.body).toBe(200);
  return sessionCookieFrom(response);
}

describe("AI persona owner administration", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, 120_000);

  beforeEach(async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await resetIntegrationDatabase(testDb.pool);
    appContext = createTestAppContext(testDb);
    await createUserAccount(
      appContext,
      { username: "owner", role: "owner", password: "owner-secret" },
      { source: "cli" },
    );
    await createUserAccount(
      appContext,
      { username: "lead", role: "team_lead", password: "lead-secret" },
      { source: "cli" },
    );
    await createUserAccount(
      appContext,
      { username: "chatter", role: "chatter" },
      { source: "cli" },
    );
    chatterKey = (await issueChatterDeviceToken(
      appContext,
      { username: "chatter" },
      { source: "cli" },
    )).key;
    deviceToken = (await issueDeviceTokenForUserId(
      appContext,
      { userId: await fixtureUserId(appContext, "chatter"), label: "persona-admin-auth-test" },
      { source: "cli" },
    )).token;
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

  it("keeps full prompt text owner-session only while every bearer receives metadata", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const active = await upsertAiPersona(appContext.db, {
      key: "custom:active",
      displayName: "Active",
      systemBlock: "SECRET ACTIVE PROMPT",
      expectedVersion: null,
    });
    const archived = await upsertAiPersona(appContext.db, {
      key: "custom:archived",
      displayName: "Archived",
      systemBlock: "SECRET ARCHIVED PROMPT",
      expectedVersion: null,
    });
    await archiveAiPersona(appContext.db, archived.key, archived.revision);

    for (const token of [chatterKey, deviceToken]) {
      const catalog = await server.inject({
        method: "GET",
        url: "/api/v1/ai/persona-catalog",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(catalog.statusCode, catalog.body).toBe(200);
      expect(catalog.json().personas).toEqual([
        {
          key: active.key,
          displayName: active.displayName,
          version: active.revision,
          definitionId: expect.stringMatching(/^v1:[A-Za-z0-9_-]{43}$/),
          status: "active",
        },
        {
          key: archived.key,
          displayName: archived.displayName,
          version: archived.revision + 1,
          definitionId: expect.stringMatching(/^v1:[A-Za-z0-9_-]{43}$/),
          status: "archived",
        },
      ]);
      expect(catalog.body).not.toContain("SECRET");

      // Neither full-text lane admits a bearer: the console list was always
      // owner-session, and the legacy list is since the persona cutover.
      for (const url of ["/api/v1/admin/ai/personas", "/api/v1/ai/personas"]) {
        const denied = await server.inject({
          method: "GET",
          url,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(denied.statusCode, `${url} ${denied.body}`).toBe(403);
        expect(denied.body).not.toContain("SECRET");
      }
    }

    for (const url of ["/api/v1/admin/ai/personas", "/api/v1/ai/personas"]) {
      const anonymous = await server.inject({ method: "GET", url });
      expect(anonymous.statusCode, url).toBe(401);
    }
    const anonymousMutation = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ai/personas",
      payload: {
        key: "custom:anonymous-denied",
        displayName: "Denied",
        systemBlock: "must not be created",
      },
    });
    expect(anonymousMutation.statusCode).toBe(401);

    const leadCookie = await loginCookie("lead", "lead-secret");
    for (const url of ["/api/v1/admin/ai/personas", "/api/v1/ai/personas"]) {
      const lead = await server.inject({ method: "GET", url, headers: { cookie: leadCookie } });
      expect(lead.statusCode, `${url} ${lead.body}`).toBe(403);
    }

    const ownerCookie = await loginCookie("owner", "owner-secret");
    const owner = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ai/personas",
      headers: { cookie: ownerCookie },
    });
    expect(owner.statusCode, owner.body).toBe(200);
    expect(owner.body).toContain("SECRET ACTIVE PROMPT");
    expect(owner.body).toContain("SECRET ARCHIVED PROMPT");

    // The legacy list keeps its shape for the owner: active rows only.
    const ownerLegacy = await server.inject({
      method: "GET",
      url: "/api/v1/ai/personas",
      headers: { cookie: ownerCookie },
    });
    expect(ownerLegacy.statusCode, ownerLegacy.body).toBe(200);
    expect(ownerLegacy.body).toContain("SECRET ACTIVE PROMPT");
    expect(ownerLegacy.body).not.toContain("SECRET ARCHIVED PROMPT");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("closes the legacy write lane: bearers 403, the owner 409 with a pointer, nothing written", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const seeded = await upsertAiPersona(appContext.db, {
      key: "custom:legacy-target",
      displayName: "Target",
      systemBlock: "original prompt",
      expectedVersion: null,
    });

    for (const token of [chatterKey, deviceToken]) {
      const headers = { authorization: `Bearer ${token}` };
      const create = await server.inject({
        method: "PUT",
        url: "/api/v1/ai/personas/custom:bearer-new",
        headers,
        payload: { displayName: "New", systemBlock: "bearer-created", expectedVersion: null },
      });
      expect(create.statusCode, create.body).toBe(403);
      const overwrite = await server.inject({
        method: "PUT",
        url: `/api/v1/ai/personas/${seeded.key}`,
        headers,
        payload: { displayName: "Hijacked", systemBlock: "hijacked prompt" },
      });
      expect(overwrite.statusCode, overwrite.body).toBe(403);
      const archive = await server.inject({
        method: "DELETE",
        url: `/api/v1/ai/personas/${seeded.key}`,
        headers,
      });
      expect(archive.statusCode, archive.body).toBe(403);
    }

    const cookie = await loginCookie("owner", "owner-secret");
    const ownerPut = await server.inject({
      method: "PUT",
      url: `/api/v1/ai/personas/${seeded.key}`,
      headers: { cookie },
      payload: { displayName: "Owner legacy", systemBlock: "owner legacy prompt", expectedVersion: 1 },
    });
    expect(ownerPut.statusCode, ownerPut.body).toBe(409);
    expect(ownerPut.json().message).toContain("/api/v1/admin/ai/personas");
    const ownerDelete = await server.inject({
      method: "DELETE",
      url: `/api/v1/ai/personas/${seeded.key}?expectedVersion=1`,
      headers: { cookie },
    });
    expect(ownerDelete.statusCode, ownerDelete.body).toBe(409);

    const rows = await testDb.pool.query<{ key: string; revision: string; archived: boolean; system_block: string }>(
      "select key, revision::text, archived_at is not null as archived, system_block from ai_personas order by key",
    );
    expect(rows.rows).toEqual([
      { key: seeded.key, revision: "1", archived: false, system_block: "original prompt" },
    ]);
    const audit = await testDb.pool.query("select 1 from audit_events where event_type like 'ai_persona.%'");
    expect(audit.rowCount).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("closes the raw prompt gateway to bearers while the owner session still reaches it", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    appContext.config.chatMuseAiGatewayEnabled = true;
    let providerCalls = 0;
    const provider: AiGatewayProvider = {
      provider: "anthropic",
      async *stream() {
        providerCalls += 1;
        yield* [];
        throw new Error("must not be reached");
      },
    };
    appContext.aiGatewayProvider = provider;
    const body = {
      clientRequestId: "00000000-0000-4000-8000-000000000001",
      feature: "fast-reply",
      pageLabel: "no-such-page",
      platform: "onlyfans",
      platformUserId: "123",
      conversationId: "123",
      model: "anthropic:claude-sonnet-4-6",
      reasoningEffort: "low",
      isRegeneration: false,
      prompt: {
        systemBlocks: [{ text: "raw system", cache: "none" }],
        userBlocks: [{ text: "raw user", cache: "none" }],
      },
    };
    for (const token of [chatterKey, deviceToken]) {
      const denied = await server.inject({
        method: "POST",
        url: "/api/v1/ai/gateway/stream",
        headers: { authorization: `Bearer ${token}` },
        payload: body,
      });
      expect(denied.statusCode, denied.body).toBe(403);
    }
    const lead = await server.inject({
      method: "POST",
      url: "/api/v1/ai/gateway/stream",
      headers: { cookie: await loginCookie("lead", "lead-secret") },
      payload: body,
    });
    expect(lead.statusCode, lead.body).toBe(403);
    // The owner passes the auth layer and lands on ordinary page resolution.
    const owner = await server.inject({
      method: "POST",
      url: "/api/v1/ai/gateway/stream",
      headers: { cookie: await loginCookie("owner", "owner-secret") },
      payload: body,
    });
    expect(owner.statusCode, owner.body).toBe(404);
    expect(providerCalls).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("lets the owner create, edit and archive every listed key, legacy-created ones included", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    // A row the retired legacy API could create: its key is outside the admin
    // create policy, and the admin path params must still reach it.
    const legacyKey = "legacy.persona";
    await upsertAiPersona(appContext.db, {
      key: legacyKey,
      displayName: "Legacy dotted key",
      systemBlock: "legacy prompt",
      expectedVersion: null,
    });

    const cookie = await loginCookie("owner", "owner-secret");
    const updated = await server.inject({
      method: "PUT",
      url: `/api/v1/admin/ai/personas/${legacyKey}`,
      headers: { cookie },
      payload: {
        displayName: "Owner-managed legacy key",
        systemBlock: "owner prompt",
        expectedVersion: 1,
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({
      key: legacyKey,
      displayName: "Owner-managed legacy key",
      systemBlock: "owner prompt",
      version: 2,
      status: "active",
    });

    const archived = await server.inject({
      method: "DELETE",
      url: `/api/v1/admin/ai/personas/${legacyKey}?expectedVersion=2`,
      headers: { cookie },
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json()).toMatchObject({ key: legacyKey, version: 3, status: "archived" });

    const created = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ai/personas",
      headers: { cookie },
      payload: {
        key: "custom:fresh",
        displayName: "Fresh",
        systemBlock: "valid owner prompt",
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({ key: "custom:fresh", version: 1, status: "active" });

    const list = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ai/personas",
      headers: { cookie },
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().personas).toEqual([
      expect.objectContaining({ key: "custom:fresh", version: 1, status: "active" }),
      expect.objectContaining({ key: legacyKey, version: 3, status: "archived" }),
    ]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("validates owner input and keeps admin mutations closed to bearers and team leads", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("owner", "owner-secret");
    const whitespaceOnly = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ai/personas",
      headers: { cookie },
      payload: {
        key: "custom:whitespace",
        displayName: "Whitespace",
        systemBlock: " \n\t ",
      },
    });
    expect(whitespaceOnly.statusCode, whitespaceOnly.body).toBe(400);
    const badKey = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ai/personas",
      headers: { cookie },
      payload: { key: "bad key!", displayName: "Bad", systemBlock: "prompt" },
    });
    expect(badKey.statusCode, badKey.body).toBe(400);

    const leadCookie = await loginCookie("lead", "lead-secret");
    const principals = [
      { authorization: `Bearer ${chatterKey}` },
      { authorization: `Bearer ${deviceToken}` },
      { cookie: leadCookie },
    ];
    for (const headers of principals) {
      const deniedMutation = await server.inject({
        method: "POST",
        url: "/api/v1/admin/ai/personas",
        headers,
        payload: {
          key: "custom:denied",
          displayName: "Denied",
          systemBlock: "must not be created",
        },
      });
      expect(deniedMutation.statusCode, deniedMutation.body).toBe(403);
    }
    const rows = await testDb.pool.query("select 1 from ai_personas");
    expect(rows.rowCount).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps create-only strict and never resurrects an archived tombstone", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("owner", "owner-secret");
    const key = "custom:tombstone";
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ai/personas",
      headers: { cookie },
      payload: { key, displayName: "Tombstone regression", systemBlock: "Must remain archived" },
    });
    expect(created.statusCode, created.body).toBe(200);

    const duplicate = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ai/personas",
      headers: { cookie },
      payload: { key, displayName: "Duplicate", systemBlock: "second create" },
    });
    expect(duplicate.statusCode, duplicate.body).toBe(409);

    const archived = await server.inject({
      method: "DELETE",
      url: `/api/v1/admin/ai/personas/${key}?expectedVersion=1`,
      headers: { cookie },
    });
    expect(archived.statusCode, archived.body).toBe(200);

    const catalog = await server.inject({
      method: "GET",
      url: "/api/v1/ai/persona-catalog",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(catalog.json().personas).toContainEqual({
      status: "archived",
      key,
      displayName: "Tombstone regression",
      version: 2,
      definitionId: expect.any(String),
    });
    expect(catalog.body).not.toContain("Must remain archived");

    // No lane brings it back: create is create-only against the tombstone, an
    // update needs an ACTIVE revision, and the legacy LWW lane is retired.
    const recreate = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ai/personas",
      headers: { cookie },
      payload: { key, displayName: "Stale desktop cache", systemBlock: "Must not unarchive" },
    });
    expect(recreate.statusCode, recreate.body).toBe(409);
    const updateArchived = await server.inject({
      method: "PUT",
      url: `/api/v1/admin/ai/personas/${key}`,
      headers: { cookie },
      payload: { displayName: "Revive", systemBlock: "revived", expectedVersion: 2 },
    });
    expect(updateArchived.statusCode, updateArchived.body).toBe(409);
    const archiveAgain = await server.inject({
      method: "DELETE",
      url: `/api/v1/admin/ai/personas/${key}?expectedVersion=2`,
      headers: { cookie },
    });
    expect(archiveAgain.statusCode, archiveAgain.body).toBe(409);
    const unknown = await server.inject({
      method: "DELETE",
      url: "/api/v1/admin/ai/personas/custom:never-existed?expectedVersion=1",
      headers: { cookie },
    });
    expect(unknown.statusCode, unknown.body).toBe(404);

    const state = await testDb.pool.query<{ revision: string; archived: boolean }>(
      "select revision::text, archived_at is not null as archived from ai_personas where key = $1",
      [key],
    );
    expect(state.rows).toEqual([{ revision: "2", archived: true }]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("allows exactly one expected-version winner and rejects stale writers", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("owner", "owner-secret");
    const key = "custom:cas";
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ai/personas",
      headers: { cookie },
      payload: { key, displayName: "CAS seed", systemBlock: "initial" },
    });
    expect(created.statusCode, created.body).toBe(200);

    const write = (displayName: string, systemBlock: string, expectedVersion: number) => server!.inject({
      method: "PUT",
      url: `/api/v1/admin/ai/personas/${key}`,
      headers: { cookie },
      payload: { displayName, systemBlock, expectedVersion },
    });
    const [left, right] = await Promise.all([
      write("Left writer", "left won", 1),
      write("Right writer", "right won", 1),
    ]);
    expect([left.statusCode, right.statusCode].sort()).toEqual([200, 409]);
    const winner = (left.statusCode === 200 ? left : right).json() as {
      displayName: string;
      systemBlock: string;
      version: number;
    };
    expect(winner.version).toBe(2);

    const stale = await write("Stale retry", "must not overwrite the winner", 1);
    expect(stale.statusCode, stale.body).toBe(409);

    const staleArchive = await server.inject({
      method: "DELETE",
      url: `/api/v1/admin/ai/personas/${key}?expectedVersion=1`,
      headers: { cookie },
    });
    expect(staleArchive.statusCode, staleArchive.body).toBe(409);

    const list = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ai/personas",
      headers: { cookie },
    });
    expect(list.json().personas).toEqual([
      expect.objectContaining({
        key,
        displayName: winner.displayName,
        systemBlock: winner.systemBlock,
        version: 2,
        status: "active",
      }),
    ]);

    // Exactly the changes that happened are audited: one create, one update.
    const audit = await testDb.pool.query<{ event_type: string }>(
      "select event_type from audit_events where event_type like 'ai_persona.%' order by id",
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual([
      "ai_persona.created",
      "ai_persona.updated",
    ]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("audits every owner change with definition identities and no prompt text", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("owner", "owner-secret");
    const key = "custom:audited";
    const catalogEntry = async () => {
      const response = await server!.inject({
        method: "GET",
        url: "/api/v1/ai/persona-catalog",
        headers: { authorization: `Bearer ${chatterKey}` },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().personas.find((persona: { key: string }) => persona.key === key) as {
        version: number;
        definitionId: string;
      };
    };
    const update = (systemBlock: string, expectedVersion: number) => server!.inject({
      method: "PUT",
      url: `/api/v1/admin/ai/personas/${key}`,
      headers: { cookie },
      payload: { displayName: "Audited", systemBlock, expectedVersion },
    });

    expect((await server.inject({
      method: "POST",
      url: "/api/v1/admin/ai/personas",
      headers: { cookie },
      payload: { key, displayName: "Audited", systemBlock: "PROMPT BYTES ONE" },
    })).statusCode).toBe(200);
    const first = await catalogEntry();
    expect((await update("PROMPT BYTES TWO", 1)).statusCode).toBe(200);
    const second = await catalogEntry();
    // Same bytes again: a new revision, but the same definition identity.
    expect((await update("PROMPT BYTES TWO", 2)).statusCode).toBe(200);
    const third = await catalogEntry();
    expect(second.definitionId).not.toBe(first.definitionId);
    expect(third.definitionId).toBe(second.definitionId);
    expect(third.version).toBe(3);
    expect((await server.inject({
      method: "DELETE",
      url: `/api/v1/admin/ai/personas/${key}?expectedVersion=3`,
      headers: { cookie },
    })).statusCode).toBe(200);

    const audit = await testDb.pool.query<{
      event_type: string;
      actor_user_id: number;
      source: string;
      metadata: Record<string, unknown>;
    }>(
      `select event_type, actor_user_id::int as actor_user_id, source, metadata
         from audit_events where event_type like 'ai_persona.%' order by id`,
    );
    const ownerId = await fixtureUserId(appContext, "owner");
    expect(audit.rows).toEqual([
      {
        event_type: "ai_persona.created",
        actor_user_id: ownerId,
        source: "api",
        metadata: {
          personaKey: key,
          displayName: "Audited",
          version: 1,
          previousVersion: null,
          definitionId: first.definitionId,
          previousDefinitionId: null,
          systemBlockChars: "PROMPT BYTES ONE".length,
        },
      },
      {
        event_type: "ai_persona.updated",
        actor_user_id: ownerId,
        source: "api",
        metadata: expect.objectContaining({
          version: 2,
          previousVersion: 1,
          definitionId: second.definitionId,
          previousDefinitionId: first.definitionId,
        }),
      },
      {
        event_type: "ai_persona.updated",
        actor_user_id: ownerId,
        source: "api",
        metadata: expect.objectContaining({
          version: 3,
          previousVersion: 2,
          definitionId: second.definitionId,
          previousDefinitionId: second.definitionId,
        }),
      },
      {
        event_type: "ai_persona.archived",
        actor_user_id: ownerId,
        source: "api",
        metadata: expect.objectContaining({
          version: 4,
          previousVersion: 3,
          definitionId: second.definitionId,
        }),
      },
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain("PROMPT BYTES");
    // The audit choke point journals each change as an operator observation
    // too, built from the same prompt-free metadata checked above.
    const journal = await testDb.pool.query<{ producer: string; payload: unknown }>(
      "select producer, payload from observations where kind like 'ai_persona.%' order by id",
    );
    expect(journal.rows.map((row) => row.producer)).toEqual(Array(4).fill("api:admin"));
    expect(JSON.stringify(journal.rows)).not.toContain("PROMPT BYTES");
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
