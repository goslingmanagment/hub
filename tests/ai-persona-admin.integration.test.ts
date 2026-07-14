import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { archiveAiPersona, upsertAiPersona } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createUserAccount,
  issueChatterApiKey,
  issueDeviceTokenForUsername,
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
    chatterKey = (await issueChatterApiKey(
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
          status: "active",
        },
        {
          key: archived.key,
          displayName: archived.displayName,
          version: archived.revision + 1,
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

  it("lets the owner update and archive keys admitted by the shipped legacy contract", async (context) => {
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
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({
      key: legacyKey,
      displayName: "Owner-managed legacy key",
      version: 2,
      status: "active",
    });

    const archived = await server.inject({
      method: "DELETE",
      url: `/api/v1/admin/ai/personas/${legacyKey}?expectedVersion=2`,
      headers: { cookie },
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json()).toMatchObject({
      key: legacyKey,
      version: 3,
      status: "archived",
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("preserves owner-authored bytes and enforces numeric CAS through archive", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("owner", "owner-secret");
    const exactSystemBlock = "\n  Keep these leading spaces.\nKeep the trailing blank line.\n\n";
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ai/personas",
      headers: { cookie },
      payload: {
        key: " custom:exact-bytes ",
        displayName: " Exact bytes ",
        systemBlock: exactSystemBlock,
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({
      key: "custom:exact-bytes",
      displayName: "Exact bytes",
      systemBlock: exactSystemBlock,
      status: "active",
      version: 1,
    });

    const duplicate = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ai/personas",
      headers: { cookie },
      payload: {
        key: "custom:exact-bytes",
        displayName: "Duplicate",
        systemBlock: "must not overwrite",
      },
    });
    expect(duplicate.statusCode, duplicate.body).toBe(409);

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

    const [left, right] = await Promise.all([
      server.inject({
        method: "PUT",
        url: "/api/v1/admin/ai/personas/custom:exact-bytes",
        headers: { cookie },
        payload: {
          displayName: "Left",
          systemBlock: "left bytes\n",
          expectedVersion: 1,
        },
      }),
      server.inject({
        method: "PUT",
        url: "/api/v1/admin/ai/personas/custom:exact-bytes",
        headers: { cookie },
        payload: {
          displayName: "Right",
          systemBlock: "right bytes\n",
          expectedVersion: 1,
        },
      }),
    ]);
    expect([left.statusCode, right.statusCode].sort()).toEqual([200, 409]);
    const winner = (left.statusCode === 200 ? left : right).json() as {
      displayName: string;
      systemBlock: string;
      version: number;
    };
    expect(winner.version).toBe(2);

    const staleArchive = await server.inject({
      method: "DELETE",
      url: "/api/v1/admin/ai/personas/custom:exact-bytes?expectedVersion=1",
      headers: { cookie },
    });
    expect(staleArchive.statusCode, staleArchive.body).toBe(409);

    const archived = await server.inject({
      method: "DELETE",
      url: `/api/v1/admin/ai/personas/custom:exact-bytes?expectedVersion=${winner.version}`,
      headers: { cookie },
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json()).toMatchObject({
      displayName: winner.displayName,
      systemBlock: winner.systemBlock,
      version: 3,
      status: "archived",
    });

    const staleReplay = await server.inject({
      method: "DELETE",
      url: `/api/v1/admin/ai/personas/custom:exact-bytes?expectedVersion=${winner.version}`,
      headers: { cookie },
    });
    expect(staleReplay.statusCode, staleReplay.body).toBe(409);

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
});
