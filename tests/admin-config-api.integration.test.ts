import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { upsertInstanceHeartbeat } from "@agency_hub_core/db";
import { buildRunningSnapshot } from "@agency_hub_core/shared";
import type { ConfigItem, ConfigViewResponse } from "@agency_hub_core/contracts";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
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

async function seedUsers() {
  await createUserAccount(appContext, { username: "dima", role: "owner", password: "owner-secret" }, { source: "cli" });
  await createUserAccount(appContext, { username: "lead", role: "team_lead", password: "lead-secret" }, { source: "cli" });
}

function allItems(body: ConfigViewResponse): ConfigItem[] {
  return body.subsystems.flatMap((group) => group.items);
}

function findItem(body: ConfigViewResponse, key: string): ConfigItem {
  const item = allItems(body).find((candidate) => candidate.key === key);
  if (!item) throw new Error(`item ${key} not found in config view`);
  return item;
}

describe("admin config api", () => {
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

  it("requires owner access", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const anon = await server.inject({ method: "GET", url: "/api/v1/admin/config" });
    expect(anon.statusCode).toBe(401);

    const leadCookie = await loginCookie("lead", "lead-secret");
    const lead = await server.inject({
      method: "GET",
      url: "/api/v1/admin/config",
      headers: { cookie: leadCookie },
    });
    expect(lead.statusCode).toBe(403);

    const ownerCookie = await loginCookie("dima", "owner-secret");
    const owner = await server.inject({
      method: "GET",
      url: "/api/v1/admin/config",
      headers: { cookie: ownerCookie },
    });
    expect(owner.statusCode).toBe(200);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("groups settings by subsystem and surfaces a known flag", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/config",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as ConfigViewResponse;

    expect(body.subsystems.length).toBeGreaterThan(0);
    const ofapi = body.subsystems.find((group) => group.subsystem === "OFAPI");
    expect(ofapi).toBeTruthy();

    // With no process having reported in this test, every expected role is missing.
    expect(body.roleStatuses.map((r) => r.role)).toEqual(expect.arrayContaining(["api", "worker", "sync"]));

    const dmSync = findItem(body, "ofapiDmSyncEnabled");
    expect(dmSync.editability).toBe("staged");
    expect(dmSync.requires).toContain("ofapiDmProjectionEnabled");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reports per-instance running values, drift, masking, and active-only filtering", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const apiConfig = appContext.config;
    const workerConfig = {
      ...appContext.config,
      ofapiDmDailyCreditBudget: 999,
      ofapiApiKey: "secret-key-xyz",
    };

    await upsertInstanceHeartbeat(appContext.db, {
      role: "api",
      instanceId: "api-1",
      startedAt: new Date(),
      running: buildRunningSnapshot(apiConfig),
    });
    await upsertInstanceHeartbeat(appContext.db, {
      role: "worker",
      instanceId: "worker-1",
      startedAt: new Date(),
      running: buildRunningSnapshot(workerConfig),
    });

    const cookie = await loginCookie("dima", "owner-secret");
    const first = (await server
      .inject({ method: "GET", url: "/api/v1/admin/config", headers: { cookie } })
      .then((r) => r.json())) as ConfigViewResponse;

    expect(first.instances).toHaveLength(2);
    expect(first.roleStatuses.find((r) => r.role === "api")?.status).toBe("active");
    expect(first.roleStatuses.find((r) => r.role === "worker")?.status).toBe("active");

    // Two live instances disagree on the daily credit budget -> drift.
    const budget = findItem(first, "ofapiDmDailyCreditBudget");
    expect(budget.drift).toBe(true);
    expect(budget.running).toHaveLength(2);
    expect(budget.running.map((entry) => entry.value).sort()).toEqual([500, 999]);

    // The OFAPI key is a secret: set in worker, unset in api -> state drift, but the
    // value is never exposed anywhere in the payload.
    const apiKey = findItem(first, "ofapiApiKey");
    expect(apiKey.secret).toBe(true);
    expect(apiKey.drift).toBe(true);
    expect(apiKey.running.every((entry) => entry.value === null && entry.masked)).toBe(true);
    expect(JSON.stringify(first)).not.toContain("secret-key-xyz");

    // Age the worker row past the staleness TTL: it is surfaced as STALE (not hidden)
    // and drops out of running/drift.
    await testDb.pool.query(
      "update runtime_instances set last_seen_at = now() - interval '5 minutes' where role = 'worker'",
    );
    const second = (await server
      .inject({ method: "GET", url: "/api/v1/admin/config", headers: { cookie } })
      .then((r) => r.json())) as ConfigViewResponse;

    expect(second.instances).toHaveLength(2);
    expect(second.instances.find((i) => i.role === "worker")?.status).toBe("stale");
    expect(second.roleStatuses.find((r) => r.role === "worker")?.status).toBe("stale");
    const budgetAfter = findItem(second, "ofapiDmDailyCreditBudget");
    expect(budgetAfter.drift).toBe(false);
    expect(budgetAfter.running).toHaveLength(1);
    expect(budgetAfter.running[0]!.value).toBe(500);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
