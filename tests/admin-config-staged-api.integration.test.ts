import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getConfigOverrides, listConfigAudit, upsertInstanceHeartbeat } from "@agency_hub_core/db";
import { buildRunningSnapshot } from "@agency_hub_core/shared";
import type { AppConfig } from "@agency_hub_core/shared";

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

/** Seed BOTH expected roles (api + worker) reporting the given boot flags as running-on,
 *  so getRunningFlagState sees an all-active fleet that has the prerequisite applied. */
async function seedRunningFlags(flags: Partial<AppConfig>) {
  const config = { ...appContext.config, ...flags } as AppConfig;
  const snapshot = buildRunningSnapshot(config);
  for (const role of ["api", "worker"]) {
    await upsertInstanceHeartbeat(appContext.db, {
      role,
      instanceId: `${role}-1`,
      startedAt: new Date(),
      running: snapshot,
    });
  }
}

/** Rebuild the server with dmProjection desired-on via env (no override row) — the realistic
 *  state for enabling dmSync: the prerequisite was deployed and is running. Lets the staged
 *  enable be genuinely valid (desired-on + running-on) without coupling the test to an
 *  override version, so both concurrent payloads keep expectedVersion: 0. */
async function rebuildServerWithProjectionEnv() {
  await server?.close();
  appContext = createTestAppContext(testDb!, { ofapiDmProjectionEnabled: true });
  server = await buildApiServer(appContext);
  await server.ready();
}

describe("admin config staged api (Stage C)", () => {
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

  it("enables a no-prereq flag (dmProjection): stored at version 1, audit note carries ack", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");

    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config/staged",
      headers: { cookie },
      payload: {
        patches: [{ key: "ofapiDmProjectionEnabled", desired: true, expectedVersion: 0 }],
        note: "kickoff #49",
        ack: true,
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { results: Array<{ key: string; value: boolean; version: number }> };
    expect(body.results).toEqual([{ key: "ofapiDmProjectionEnabled", value: true, version: 1 }]);

    const overrides = await getConfigOverrides(testDb.db);
    expect(overrides.get("ofapiDmProjectionEnabled")).toEqual({ value: true, version: 1 });

    // The ack + operator note are persisted into the audit note (auditable, not just UI).
    const audit = await listConfigAudit(testDb.db, { key: "ofapiDmProjectionEnabled" });
    expect(audit[0]!.newValue).toBe(true);
    const parsed = JSON.parse(audit[0]!.note ?? "{}") as { ack: boolean; note: string | null };
    expect(parsed.ack).toBe(true);
    expect(parsed.note).toBe("kickoff #49");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("enables dmSync once dmProjection is running across the fleet", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    // dmSync's prerequisite must be BOTH desired-on (override) and running-on (B1): stage
    // dmProjection on, then report it running across the fleet.
    await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config/staged",
      headers: { cookie },
      payload: {
        patches: [{ key: "ofapiDmProjectionEnabled", desired: true, expectedVersion: 0 }],
        ack: true,
      },
    });
    await seedRunningFlags({ ofapiDmProjectionEnabled: true });

    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config/staged",
      headers: { cookie },
      payload: {
        patches: [{ key: "ofapiDmSyncEnabled", desired: true, expectedVersion: 0 }],
        ack: true,
      },
    });
    expect(response.statusCode).toBe(200);
    expect((await getConfigOverrides(testDb.db)).get("ofapiDmSyncEnabled")?.value).toBe(true);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rejects an order violation (dmSync before dmProjection running) with 400, nothing written", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    // No heartbeat → dmProjection running state is 'unknown' (not 'on') → blocked.
    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config/staged",
      headers: { cookie },
      payload: {
        patches: [{ key: "ofapiDmSyncEnabled", desired: true, expectedVersion: 0 }],
        ack: true,
      },
    });
    expect(response.statusCode).toBe(400);
    expect((await getConfigOverrides(testDb.db)).has("ofapiDmSyncEnabled")).toBe(false);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reverts a flag to env via desired:null (clears the override, audits a null new value)", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    // Stage dmProjection on (version 1), then revert it to env with desired:null.
    await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config/staged",
      headers: { cookie },
      payload: {
        patches: [{ key: "ofapiDmProjectionEnabled", desired: true, expectedVersion: 0 }],
        ack: true,
      },
    });

    const revert = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config/staged",
      headers: { cookie },
      payload: {
        patches: [{ key: "ofapiDmProjectionEnabled", desired: null, expectedVersion: 1 }],
        ack: true,
      },
    });
    expect(revert.statusCode).toBe(200);
    const body = revert.json() as { results: Array<{ key: string; value: boolean | null; version: number | null }> };
    expect(body.results).toEqual([{ key: "ofapiDmProjectionEnabled", value: null, version: null }]);

    // The override row is gone (reverted to env) and the clear is audited with a null value.
    expect((await getConfigOverrides(testDb.db)).has("ofapiDmProjectionEnabled")).toBe(false);
    const audit = await listConfigAudit(testDb.db, { key: "ofapiDmProjectionEnabled" });
    expect(audit[0]!.newValue).toBeNull();
    expect(audit[0]!.oldValue).toBe(true);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rejects desired:null revert that would leave a dependent desired-on (validated as the env baseline)", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    // Stage dmProjection on (desired-on override, version 1) + running-on, then stage dmSync on
    // (it depends on dmProjection, which must now be desired-on AND running-on to enable). The
    // env baseline for dmProjection stays OFF, so reverting it (desired:null) is a disable.
    await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config/staged",
      headers: { cookie },
      payload: {
        patches: [{ key: "ofapiDmProjectionEnabled", desired: true, expectedVersion: 0 }],
        ack: true,
      },
    });
    await seedRunningFlags({ ofapiDmProjectionEnabled: true });
    await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config/staged",
      headers: { cookie },
      payload: {
        patches: [{ key: "ofapiDmSyncEnabled", desired: true, expectedVersion: 0 }],
        ack: true,
      },
    });

    // Reverting dmProjection to env (env-off) is validated as a disable; dmSync is still
    // desired-on (override) → rejected, and dmProjection is untouched. expectedVersion 1
    // because dmProjection now has an override row at version 1.
    const revert = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config/staged",
      headers: { cookie },
      payload: {
        patches: [{ key: "ofapiDmProjectionEnabled", desired: null, expectedVersion: 1 }],
        ack: true,
      },
    });
    expect(revert.statusCode).toBe(400);
    expect(revert.json()).toMatchObject({ message: expect.stringContaining("ofapiDmSyncEnabled") });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("disables a dependent + its prerequisite atomically in one multi-key patch", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    // Stage dmProjection + dmSync on (dmSync after dmProjection is running).
    await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config/staged",
      headers: { cookie },
      payload: {
        patches: [{ key: "ofapiDmProjectionEnabled", desired: true, expectedVersion: 0 }],
        ack: true,
      },
    });
    await seedRunningFlags({ ofapiDmProjectionEnabled: true });
    await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config/staged",
      headers: { cookie },
      payload: {
        patches: [{ key: "ofapiDmSyncEnabled", desired: true, expectedVersion: 0 }],
        ack: true,
      },
    });

    // One atomic patch disables the dependent (dmSync) and the prerequisite (dmProjection).
    const disable = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config/staged",
      headers: { cookie },
      payload: {
        patches: [
          { key: "ofapiDmSyncEnabled", desired: false, expectedVersion: 1 },
          { key: "ofapiDmProjectionEnabled", desired: false, expectedVersion: 1 },
        ],
        ack: true,
      },
    });
    expect(disable.statusCode).toBe(200);
    const overrides = await getConfigOverrides(testDb.db);
    expect(overrides.get("ofapiDmSyncEnabled")?.value).toBe(false);
    expect(overrides.get("ofapiDmProjectionEnabled")?.value).toBe(false);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("surfaces a mandatory expectedVersion conflict as 409", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    // First flip creates the row at version 1.
    await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config/staged",
      headers: { cookie },
      payload: {
        patches: [{ key: "ofapiDmProjectionEnabled", desired: true, expectedVersion: 0 }],
        ack: true,
      },
    });
    // Re-flip with the stale (brand-new) expectedVersion 0 → conflict.
    const conflict = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config/staged",
      headers: { cookie },
      payload: {
        patches: [{ key: "ofapiDmProjectionEnabled", desired: false, expectedVersion: 0 }],
        ack: true,
      },
    });
    expect(conflict.statusCode).toBe(409);
    // Unchanged: still desired-on at version 1.
    expect((await getConfigOverrides(testDb.db)).get("ofapiDmProjectionEnabled")).toEqual({
      value: true,
      version: 1,
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rejects ack:false with 400, nothing written", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config/staged",
      headers: { cookie },
      payload: {
        patches: [{ key: "ofapiDmProjectionEnabled", desired: true, expectedVersion: 0 }],
        ack: false,
      },
    });
    expect(response.statusCode).toBe(400);
    expect((await getConfigOverrides(testDb.db)).has("ofapiDmProjectionEnabled")).toBe(false);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rejects a non-boot key (transactionLookbackDays) with 400", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config/staged",
      headers: { cookie },
      payload: {
        // transactionLookbackDays is editable+live, not a boot flag — and would fail the
        // boolean check too. logLevel (runtimeApply:'none') is also rejected.
        patches: [{ key: "transactionLookbackDays", desired: true, expectedVersion: 0 }],
        ack: true,
      },
    });
    expect(response.statusCode).toBe(400);
    expect((await getConfigOverrides(testDb.db)).has("transactionLookbackDays")).toBe(false);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rejects setting the same key twice with 400", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const cookie = await loginCookie("dima", "owner-secret");
    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config/staged",
      headers: { cookie },
      payload: {
        patches: [
          { key: "ofapiDmProjectionEnabled", desired: true, expectedVersion: 0 },
          { key: "ofapiDmProjectionEnabled", desired: false, expectedVersion: 0 },
        ],
        ack: true,
      },
    });
    expect(response.statusCode).toBe(400);
    expect((await getConfigOverrides(testDb.db)).has("ofapiDmProjectionEnabled")).toBe(false);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("is owner-only (anon -> 401, lead -> 403, nothing written)", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const anon = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config/staged",
      payload: {
        patches: [{ key: "ofapiDmProjectionEnabled", desired: true, expectedVersion: 0 }],
        ack: true,
      },
    });
    expect(anon.statusCode).toBe(401);

    const leadCookie = await loginCookie("lead", "lead-secret");
    const lead = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config/staged",
      headers: { cookie: leadCookie },
      payload: {
        patches: [{ key: "ofapiDmProjectionEnabled", desired: true, expectedVersion: 0 }],
        ack: true,
      },
    });
    expect(lead.statusCode).toBe(403);
    expect((await getConfigOverrides(testDb.db)).has("ofapiDmProjectionEnabled")).toBe(false);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("serializes two concurrent staged commits via the advisory lock: never persists an orphaned graph (B1)", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    // dmProjection desired-on via env (no override row) + running-on across the fleet, so the
    // dmSync enable is genuinely valid against the baseline and both payloads keep version 0.
    await rebuildServerWithProjectionEnv();
    const cookie = await loginCookie("dima", "owner-secret");
    await seedRunningFlags({ ofapiDmProjectionEnabled: true });

    // Fire two staged commits CONCURRENTLY that, if their read-validate-write interleaved,
    // would both pass and leave an invalid graph:
    //   (A) enable dmSync       — valid against the current baseline (dmProjection running-on,
    //                              dmSync not yet desired-on).
    //   (B) disable dmProjection — valid ONLY while dmSync is not desired-on; once (A) has
    //                              persisted dmSync=on, (B) must be rejected (it would orphan
    //                              dmSync's prerequisite).
    // The fixed advisory lock serializes them, so whichever commits SECOND sees the other's
    // override in its re-read baseline. Exactly one of the two must therefore fail (400):
    // either (B) ran second and is rejected, or (B) ran first (allowed) and then (A) is
    // rejected because dmProjection is now desired-off. The end state is always consistent.
    const [aRes, bRes] = await Promise.all([
      server.inject({
        method: "PATCH",
        url: "/api/v1/admin/config/staged",
        headers: { cookie },
        payload: {
          patches: [{ key: "ofapiDmSyncEnabled", desired: true, expectedVersion: 0 }],
          ack: true,
        },
      }),
      server.inject({
        method: "PATCH",
        url: "/api/v1/admin/config/staged",
        headers: { cookie },
        payload: {
          patches: [{ key: "ofapiDmProjectionEnabled", desired: false, expectedVersion: 0 }],
          ack: true,
        },
      }),
    ]);

    // Serialization guarantee: at least one of the two commits is rejected (400), so the
    // dependent=on/prereq=off graph is never persisted by two interleaving validations.
    const statuses = [aRes.statusCode, bRes.statusCode];
    expect(statuses).toContain(400);

    // Whatever survived, the persisted graph is consistent: dmSync is NOT desired-on while
    // dmProjection is desired-off.
    const overrides = await getConfigOverrides(testDb.db);
    const dmSyncOn = overrides.get("ofapiDmSyncEnabled")?.value === true;
    const dmProjectionOn = overrides.has("ofapiDmProjectionEnabled")
      ? overrides.get("ofapiDmProjectionEnabled")?.value === true
      : true; // no override row → env baseline (running-on here)
    expect(dmSyncOn && !dmProjectionOn).toBe(false);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rejects enabling a dependent after its prerequisite was disabled but is still running (B1, desired-off/running-on)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // dmProjection desired-on via env + running-on across the fleet.
    await rebuildServerWithProjectionEnv();
    const cookie = await loginCookie("dima", "owner-secret");
    await seedRunningFlags({ ofapiDmProjectionEnabled: true });

    // Disable dmProjection (desired-off) — allowed because dmSync is not yet desired-on. The
    // un-restarted fleet keeps reporting dmProjection running-on (it is a boot flag).
    const disable = await server!.inject({
      method: "PATCH",
      url: "/api/v1/admin/config/staged",
      headers: { cookie },
      payload: {
        patches: [{ key: "ofapiDmProjectionEnabled", desired: false, expectedVersion: 0 }],
        ack: true,
      },
    });
    expect(disable.statusCode).toBe(200);

    // Enabling dmSync MUST be rejected now: dmProjection is running-on but desired-off, so
    // enabling would persist an orphaned dependent-on/prereq-off graph. (Before the fix this
    // wrongly succeeded because Rule 3 only checked running-state.)
    const enable = await server!.inject({
      method: "PATCH",
      url: "/api/v1/admin/config/staged",
      headers: { cookie },
      payload: {
        patches: [{ key: "ofapiDmSyncEnabled", desired: true, expectedVersion: 0 }],
        ack: true,
      },
    });
    expect(enable.statusCode).toBe(400);
    expect((enable.json() as { message: string }).message).toContain("ofapiDmProjectionEnabled");

    // The orphan was never persisted.
    const overrides = await getConfigOverrides(testDb.db);
    expect(overrides.get("ofapiDmSyncEnabled")).toBeUndefined();
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
