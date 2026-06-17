import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { getConfigOverrides, listConfigAudit, setConfigOverride, upsertInstanceHeartbeat } from "@agency_hub_core/db";
import { buildRunningSnapshot } from "@agency_hub_core/shared";
import type { ConfigItem, ConfigViewResponse } from "@agency_hub_core/contracts";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { loadEffectiveConfig } from "../apps/runtime/src/services/effective-config.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
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

function findItem(body: ConfigViewResponse, key: string): ConfigItem {
  const item = body.subsystems.flatMap((group) => group.items).find((candidate) => candidate.key === key);
  if (!item) throw new Error(`item ${key} not found in config view`);
  return item;
}

describe("admin config update api (Stage B1)", () => {
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

  it("applies a multi-key patch atomically under one audit group", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");

    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config",
      headers: { cookie },
      payload: {
        patches: [
          { key: "transactionLookbackDays", value: 14 },
          { key: "ofapiCreditAlertThreshold", value: 250 },
        ],
        note: "tuning",
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { results: Array<{ key: string; value: unknown; version: number }> };
    expect(body.results).toEqual([
      { key: "transactionLookbackDays", value: 14, version: 1 },
      { key: "ofapiCreditAlertThreshold", value: 250, version: 1 },
    ]);

    const overrides = await getConfigOverrides(testDb.db);
    expect(overrides.get("transactionLookbackDays")).toEqual({ value: 14, version: 1 });
    expect(overrides.get("ofapiCreditAlertThreshold")).toEqual({ value: 250, version: 1 });

    // Both audit rows share one group id.
    const auditA = await listConfigAudit(testDb.db, { key: "transactionLookbackDays" });
    const auditB = await listConfigAudit(testDb.db, { key: "ofapiCreditAlertThreshold" });
    expect(auditA[0]!.groupId).toBe(auditB[0]!.groupId);
    expect(auditB[0]!.note).toContain("tuning [cost-warnings]");
    expect(auditB[0]!.note).toContain("ofapiCreditAlertThreshold: Lowering silences the early low-credit warning.");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rolls the WHOLE multi-key patch back when one key conflicts", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    // Seed transactionLookbackDays at version 1.
    await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config",
      headers: { cookie },
      payload: { patches: [{ key: "transactionLookbackDays", value: 14 }] },
    });

    // A two-key patch where the second key carries a STALE expectedVersion. The first
    // key would create a brand-new override, but the conflict must roll back everything.
    const conflict = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config",
      headers: { cookie },
      payload: {
        patches: [
          { key: "ofapiCreditAlertThreshold", value: 250 },
          { key: "transactionLookbackDays", value: 21, expectedVersion: 0 },
        ],
      },
    });
    expect(conflict.statusCode).toBe(409);

    const overrides = await getConfigOverrides(testDb.db);
    // The brand-new key was NOT created, and the existing key is untouched.
    expect(overrides.has("ofapiCreditAlertThreshold")).toBe(false);
    expect(overrides.get("transactionLookbackDays")?.value).toBe(14);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rejects a patch that sets the same key twice (400, nothing written)", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config",
      headers: { cookie },
      payload: {
        patches: [
          { key: "transactionLookbackDays", value: 14 },
          { key: "transactionLookbackDays", value: 21 },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect((await getConfigOverrides(testDb.db)).has("transactionLookbackDays")).toBe(false);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rejects a non-live editable+reload key (400)", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    // ofapiDmDailyCreditBudget is editable + reload but NOT wired live.
    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config",
      headers: { cookie },
      payload: { patches: [{ key: "ofapiDmDailyCreditBudget", value: 999 }] },
    });
    expect(response.statusCode).toBe(400);
    expect((await getConfigOverrides(testDb.db)).has("ofapiDmDailyCreditBudget")).toBe(false);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rejects a restart-mode key (logLevel) with 400", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config",
      headers: { cookie },
      payload: { patches: [{ key: "logLevel", value: "debug" }] },
    });
    expect(response.statusCode).toBe(400);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rejects a staged key with 400", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config",
      headers: { cookie },
      payload: { patches: [{ key: "ofapiDmProjectionEnabled", value: true }] },
    });
    expect(response.statusCode).toBe(400);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("clamps an out-of-range number and returns the clamped value", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    // healthSyncLightMaxAgeMinutes has min:1 -> -5 clamps to 1.
    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config",
      headers: { cookie },
      payload: { patches: [{ key: "healthSyncLightMaxAgeMinutes", value: -5 }] },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { results: Array<{ key: string; value: unknown }> };
    expect(body.results[0]!.value).toBe(1);
    expect((await getConfigOverrides(testDb.db)).get("healthSyncLightMaxAgeMinutes")?.value).toBe(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("surfaces a stale expectedVersion as 409", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config",
      headers: { cookie },
      payload: { patches: [{ key: "transactionLookbackDays", value: 14 }] },
    });
    // Row is at version 1 now; expectedVersion 0 (brand-new assumption) conflicts.
    const conflict = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config",
      headers: { cookie },
      payload: { patches: [{ key: "transactionLookbackDays", value: 21, expectedVersion: 0 }] },
    });
    expect(conflict.statusCode).toBe(409);
    // Unchanged.
    expect((await getConfigOverrides(testDb.db)).get("transactionLookbackDays")?.value).toBe(14);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("is owner-only (lead -> 403, anon -> 401)", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const anon = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config",
      payload: { patches: [{ key: "transactionLookbackDays", value: 14 }] },
    });
    expect(anon.statusCode).toBe(401);

    const leadCookie = await loginCookie("lead", "lead-secret");
    const lead = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config",
      headers: { cookie: leadCookie },
      payload: { patches: [{ key: "transactionLookbackDays", value: 14 }] },
    });
    expect(lead.statusCode).toBe(403);
    expect((await getConfigOverrides(testDb.db)).has("transactionLookbackDays")).toBe(false);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reflects the override in buildConfigView (desired/source/pendingApply, live:true)", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config",
      headers: { cookie },
      payload: { patches: [{ key: "transactionLookbackDays", value: 14 }] },
    });

    // A heartbeat reporting the BOOT value (no overlay) -> override is pending.
    await upsertInstanceHeartbeat(appContext.db, {
      role: "worker",
      instanceId: "worker-1",
      startedAt: new Date(),
      running: buildRunningSnapshot(appContext.config),
    });

    const view = (await server
      .inject({ method: "GET", url: "/api/v1/admin/config", headers: { cookie } })
      .then((r) => r.json())) as ConfigViewResponse;
    const item = findItem(view, "transactionLookbackDays");
    expect(item.live).toBe(true);
    expect(item.source).toBe("override");
    expect(item.desired).toBe(14);
    expect(item.pendingApply).toBe(true);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("clears pendingApply once a heartbeat reports the EFFECTIVE override", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config",
      headers: { cookie },
      payload: { patches: [{ key: "transactionLookbackDays", value: 14 }] },
    });

    // The heartbeat snapshot is built from loadEffectiveConfig — exactly what the process now
    // consumes — so running == override. Both expected roles (api + worker) must report it for
    // pendingApply to clear (role-complete: a single role reporting can't clear it).
    const effective = await loadEffectiveConfig(appContext.db, appContext.config);
    for (const role of ["api", "worker"]) {
      await upsertInstanceHeartbeat(appContext.db, {
        role,
        instanceId: `${role}-1`,
        startedAt: new Date(),
        running: buildRunningSnapshot(effective),
      });
    }

    const view = (await server
      .inject({ method: "GET", url: "/api/v1/admin/config", headers: { cookie } })
      .then((r) => r.json())) as ConfigViewResponse;
    const item = findItem(view, "transactionLookbackDays");
    expect(item.running.find((entry) => entry.role === "worker")?.value).toBe(14);
    expect(item.pendingApply).toBe(false);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("DELETE clears the override and audits it", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config",
      headers: { cookie },
      payload: { patches: [{ key: "transactionLookbackDays", value: 14 }] },
    });

    const cleared = await server.inject({
      method: "DELETE",
      url: "/api/v1/admin/config/transactionLookbackDays?note=revert",
      headers: { cookie },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ ok: true, key: "transactionLookbackDays" });

    expect((await getConfigOverrides(testDb.db)).has("transactionLookbackDays")).toBe(false);
    const audit = await listConfigAudit(testDb.db, { key: "transactionLookbackDays" });
    // Newest first: the clear row has a null new_value.
    expect(audit[0]!.newValue).toBeNull();
    expect(audit[0]!.oldValue).toBe(14);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("allows DELETE of an editable override even when it is NOT in the live set", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    // ofapiDmDailyCreditBudget is editable + reload but not wired live; PATCH rejects
    // it, so seed a stuck override directly and prove DELETE can still remove it.
    await setConfigOverride(testDb.db, {
      key: "ofapiDmDailyCreditBudget",
      value: 999,
      userId: null,
      groupId: randomUUID(),
    });
    expect((await getConfigOverrides(testDb.db)).has("ofapiDmDailyCreditBudget")).toBe(true);

    const response = await server.inject({
      method: "DELETE",
      url: "/api/v1/admin/config/ofapiDmDailyCreditBudget",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect((await getConfigOverrides(testDb.db)).has("ofapiDmDailyCreditBudget")).toBe(false);
    const audit = await listConfigAudit(testDb.db, { key: "ofapiDmDailyCreditBudget" });
    expect(audit[0]!.newValue).toBeNull();
    expect(audit[0]!.oldValue).toBe(999);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rejects DELETE for a non-editable key with 400", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    // databaseUrl is editability 'never' — not clearable.
    const response = await server.inject({
      method: "DELETE",
      url: "/api/v1/admin/config/databaseUrl",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rejects DELETE for a staged (boot) key with 400, leaving the override in place", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    // ofapiDmProjectionEnabled is editability 'staged' — the generic DELETE must not clear
    // it (that would bypass the staged endpoint's expectedVersion + ack + order rules).
    // Seed an override and prove DELETE rejects it and leaves the row.
    await setConfigOverride(testDb.db, {
      key: "ofapiDmProjectionEnabled",
      value: true,
      userId: null,
      groupId: randomUUID(),
    });
    const response = await server.inject({
      method: "DELETE",
      url: "/api/v1/admin/config/ofapiDmProjectionEnabled",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
    expect((await getConfigOverrides(testDb.db)).has("ofapiDmProjectionEnabled")).toBe(true);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
