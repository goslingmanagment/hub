import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { archiveAiPersona, upsertAiPersona } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createUserAccount,
} from "../apps/runtime/src/services/auth.ts";
import { issueChatterDeviceToken, issueDeviceTokenForUsername } from "./helpers/device-credentials.ts";
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
    deviceToken = (await issueDeviceTokenForUsername(
      appContext,
      { username: "chatter", label: "persona-admin-auth-test" },
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

  it("keeps full prompt text owner-only while both bearer forms receive metadata", async (context) => {
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

      const admin = await server.inject({
        method: "GET",
        url: "/api/v1/admin/ai/personas",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(admin.statusCode, admin.body).toBe(403);
    }

    const anonymous = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ai/personas",
    });
    expect(anonymous.statusCode).toBe(401);
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

    const legacyFullText = await server.inject({
      method: "GET",
      url: "/api/v1/ai/personas",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(legacyFullText.statusCode, legacyFullText.body).toBe(200);
    expect(legacyFullText.body).toContain("SECRET ACTIVE PROMPT");
    expect(legacyFullText.body).not.toContain("SECRET ARCHIVED PROMPT");

    const lead = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ai/personas",
      headers: { cookie: await loginCookie("lead", "lead-secret") },
    });
    expect(lead.statusCode, lead.body).toBe(403);

    const owner = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ai/personas",
      headers: { cookie: await loginCookie("owner", "owner-secret") },
    });
    expect(owner.statusCode, owner.body).toBe(200);
    expect(owner.body).toContain("SECRET ACTIVE PROMPT");
    expect(owner.body).toContain("SECRET ARCHIVED PROMPT");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps owner mutations read-only while the shipped legacy write lane remains open", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const legacyKey = "legacy.persona";
    const created = await server.inject({
      method: "PUT",
      url: `/api/v1/ai/personas/${legacyKey}`,
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        displayName: "Legacy dotted key",
        systemBlock: "legacy prompt",
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({ key: legacyKey, version: 1 });

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
    expect(updated.statusCode, updated.body).toBe(409);
    expect(updated.body).toContain("read-only");

    const archived = await server.inject({
      method: "DELETE",
      url: `/api/v1/admin/ai/personas/${legacyKey}?expectedVersion=2`,
      headers: { cookie },
    });
    expect(archived.statusCode, archived.body).toBe(409);

    const unchanged = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ai/personas",
      headers: { cookie },
    });
    expect(unchanged.statusCode, unchanged.body).toBe(200);
    expect(unchanged.json().personas).toContainEqual(expect.objectContaining({
      key: legacyKey,
      displayName: "Legacy dotted key",
      version: 1,
      status: "active",
    }));
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("validates owner input, then rejects valid mutations without exposing admin routes to bearers", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("owner", "owner-secret");
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ai/personas",
      headers: { cookie },
      payload: {
        key: "custom:blocked",
        displayName: "Blocked",
        systemBlock: "valid owner prompt",
      },
    });
    expect(created.statusCode, created.body).toBe(409);

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

    for (const token of [chatterKey, deviceToken]) {
      const deniedMutation = await server.inject({
        method: "POST",
        url: "/api/v1/admin/ai/personas",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          key: "custom:denied",
          displayName: "Denied",
          systemBlock: "must not be created",
        },
      });
      expect(deniedMutation.statusCode, deniedMutation.body).toBe(403);
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("changes the opaque definition identity only when exact definition bytes change", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const key = "custom:definition-identity";
    const write = (systemBlock: string) => server!.inject({
      method: "PUT",
      url: `/api/v1/ai/personas/${key}`,
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: { displayName: "Definition Identity", systemBlock },
    });
    const read = async () => {
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

    expect((await write("first bytes")).statusCode).toBe(200);
    const first = await read();
    expect((await write("second bytes")).statusCode).toBe(200);
    const second = await read();
    expect(second.version).toBe(first.version + 1);
    expect(second.definitionId).not.toBe(first.definitionId);

    // The shipped reconnect replay is a true no-op: revision, timestamp, and
    // content identity all remain stable for identical bytes.
    expect((await write("second bytes")).statusCode).toBe(200);
    expect(await read()).toEqual(second);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
