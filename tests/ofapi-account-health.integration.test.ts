import { createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  findPageById,
  listNotificationIncidents,
  recordOfapiCreditUsage,
  setConfigOverride,
  setPageOfapiAccountId,
  upsertOfapiWebhookConfig,
} from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import {
  applyOfapiAccountHealthEvent,
  runOfapiAccountHealthMonitor,
} from "../apps/runtime/src/services/ofapi-account-health.ts";
import { processOfapiWebhookEvent } from "../apps/runtime/src/services/ofapi-events.ts";
import { OFAPI_WEBHOOK_EVENTS } from "../apps/runtime/src/services/ofapi-webhooks.ts";
import { getSyncStatusSnapshot } from "../apps/runtime/src/services/sync-status.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

const WEBHOOK_URL = "/api/v1/ofapi/webhook";
const SIGNING_SECRET = "test-signing-secret";
const ENCRYPTION_KEY = Buffer.alloc(32, 7);
const OFAPI_ACCOUNT = "acct_health_test";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;

let idempotencyCounter = 0;

function nextIdempotencyKey() {
  idempotencyCounter += 1;
  return `evt_${String(idempotencyCounter).padStart(40, "0")}`;
}

async function seedWebhookConfig() {
  await upsertOfapiWebhookConfig(appContext.db, {
    externalWebhookId: "wh_test",
    endpointUrl: "https://hub.example.com/api/v1/ofapi/webhook",
    accountScope: "global",
    events: [...OFAPI_WEBHOOK_EVENTS],
    encryptedSigningSecret: JSON.stringify(encryptJson(SIGNING_SECRET, ENCRYPTION_KEY, 1)),
  });
}

async function seedMappedPage(label = "lora-of") {
  const model = await createModel(appContext.db, {
    slug: `model-${label}`,
    name: `Model ${label}`,
  });
  const page = await createOnlyFansPage(appContext.db, {
    modelId: model.id,
    label,
  });
  await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId: OFAPI_ACCOUNT });
  return page;
}

async function deliverAndProcess(envelope: Record<string, unknown>) {
  if (!server) {
    throw new Error("server not started");
  }

  const body = JSON.stringify(envelope);
  const response = await server.inject({
    method: "POST",
    url: WEBHOOK_URL,
    payload: body,
    headers: {
      "content-type": "application/json",
      signature: createHmac("sha256", SIGNING_SECRET).update(body).digest("hex"),
      "x-ofapi-idempotency-key": nextIdempotencyKey(),
    },
  });
  expect(response.statusCode).toBe(200);

  const { rows } = await testDb!.pool.query<{ id: number }>(
    "select max(id)::int as id from ofapi_webhook_events",
  );
  const eventId = rows[0]!.id;
  await processOfapiWebhookEvent(appContext, eventId);
  return eventId;
}

async function getPageAuthState(pageId: number) {
  const stored = await findPageById(appContext.db, pageId);
  return {
    status: stored?.page.ofapiAuthStatus ?? null,
    changedAt: stored?.page.ofapiAuthChangedAt ?? null,
  };
}

async function listIncidents(status?: "open" | "resolved") {
  return listNotificationIncidents(appContext.db, status ? { status } : undefined);
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await server?.close();
  server = null;
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }

  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb, { ofapiAccountHealthEnabled: true });
  if (server) {
    await server.close();
  }
  server = await buildApiServer(appContext);
  await server.ready();
  await seedWebhookConfig();
});

describe("OFAPI account health projection", () => {
  it("projects accounts.* events into page auth state and opens/resolves the auth incident", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const page = await seedMappedPage();
    await deliverAndProcess({
      event: "accounts.authentication_failed",
      account_id: OFAPI_ACCOUNT,
      payload: {},
    });

    let authState = await getPageAuthState(page.id);
    expect(authState.status).toBe("authentication_failed");
    expect(authState.changedAt).not.toBeNull();

    let openIncidents = await listIncidents("open");
    expect(openIncidents).toHaveLength(1);
    expect(openIncidents[0]!.kind).toBe("ofapi_auth");
    expect(openIncidents[0]!.platformAccountId).toBe(page.id);
    expect(openIncidents[0]!.errorCode).toBe("authentication_failed");

    // The connection block surfaces the needs-action state for the page.
    const snapshot = await getSyncStatusSnapshot(appContext, { pageLabel: page.label });
    const connection = snapshot.pages[0]!.blocks.connection;
    expect(connection.metrics.ofapiAuthStatus).toBe("authentication_failed");
    expect(connection.connectionStatus).toBe("error");
    expect(connection.needsAttention).toBe(true);
    expect(connection.statusReason?.code).toBe("ofapi_auth");

    await deliverAndProcess({
      event: "accounts.reconnected",
      account_id: OFAPI_ACCOUNT,
      payload: {},
    });

    authState = await getPageAuthState(page.id);
    expect(authState.status).toBe("reconnected");
    openIncidents = await listIncidents("open");
    expect(openIncidents).toHaveLength(0);
    expect((await listIncidents("resolved")).map((incident) => incident.kind)).toContain("ofapi_auth");

    const recovered = await getSyncStatusSnapshot(appContext, { pageLabel: page.label });
    expect(recovered.pages[0]!.blocks.connection.metrics.ofapiAuthStatus).toBe("reconnected");
    expect(recovered.pages[0]!.blocks.connection.statusReason?.code).not.toBe("ofapi_auth");
  });

  it("never regresses to an older state on out-of-order events and stays inert when disabled", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const page = await seedMappedPage();
    await deliverAndProcess({
      event: "accounts.connected",
      account_id: OFAPI_ACCOUNT,
      payload: {},
    });
    expect((await getPageAuthState(page.id)).status).toBe("connected");

    // An older session_expired event must not overwrite the newer state.
    await applyOfapiAccountHealthEvent(appContext, {
      id: 999_999,
      eventType: "accounts.session_expired",
      ofapiAccountId: OFAPI_ACCOUNT,
      receivedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    expect((await getPageAuthState(page.id)).status).toBe("connected");

    // Flag off: nothing is projected and no incidents open.
    const offContext = createTestAppContext(testDb, { ofapiAccountHealthEnabled: false });
    const otherPage = await (async () => {
      const model = await createModel(offContext.db, { slug: "model-off", name: "Model Off" });
      const created = await createOnlyFansPage(offContext.db, { modelId: model.id, label: "off-page" });
      await setPageOfapiAccountId(offContext.db, { pageId: created.id, ofapiAccountId: "acct_off" });
      return created;
    })();
    await applyOfapiAccountHealthEvent(offContext, {
      id: 1_000_000,
      eventType: "accounts.authentication_failed",
      ofapiAccountId: "acct_off",
      receivedAt: new Date(),
    });
    expect((await getPageAuthState(otherPage.id)).status).toBeNull();
  });
});

describe("OFAPI account health monitor", () => {
  it("opens and resolves the low-credit incident around the alert threshold", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await seedMappedPage();
    await recordOfapiCreditUsage(appContext.db, { creditsUsed: 1, balance: 500 });
    await runOfapiAccountHealthMonitor(appContext);

    let open = await listIncidents("open");
    expect(open.map((incident) => incident.kind)).toContain("ofapi_low_credit");
    const lowCredit = open.find((incident) => incident.kind === "ofapi_low_credit");
    expect(lowCredit!.platformAccountId).toBeNull();
    expect(lowCredit!.incidentKey).toBe("ofapi_low_credit:global");

    // Re-running while still low does not duplicate (incident dedupe).
    await runOfapiAccountHealthMonitor(appContext);
    expect((await listIncidents("open")).filter((incident) => incident.kind === "ofapi_low_credit"))
      .toHaveLength(1);

    await recordOfapiCreditUsage(appContext.db, { creditsUsed: 1, balance: 24_000 });
    await runOfapiAccountHealthMonitor(appContext);
    open = await listIncidents("open");
    expect(open.map((incident) => incident.kind)).not.toContain("ofapi_low_credit");
  });

  it("resolves an open low-credit incident when the alert threshold is disabled (set to 0)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await seedMappedPage();
    // Open the incident: default threshold 1000, balance 500 (< threshold).
    await recordOfapiCreditUsage(appContext.db, { creditsUsed: 1, balance: 500 });
    await runOfapiAccountHealthMonitor(appContext);
    expect((await listIncidents("open")).map((incident) => incident.kind)).toContain("ofapi_low_credit");

    // Operator disables the alert by zeroing the threshold (live override). The disabled alert
    // must clear the open incident, not leave it falsely open.
    await setConfigOverride(appContext.db, {
      key: "ofapiCreditAlertThreshold",
      value: 0,
      userId: null,
      groupId: randomUUID(),
    });
    await runOfapiAccountHealthMonitor(appContext);

    expect((await listIncidents("open")).map((incident) => incident.kind)).not.toContain("ofapi_low_credit");
    expect((await listIncidents("resolved")).map((incident) => incident.kind)).toContain("ofapi_low_credit");
  });

  it("alerts on webhook silence while mapped pages exist and resolves on fresh events", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await seedMappedPage();

    // Use the DB receipt clock; the Docker VM and host clock can differ.
    // No journaled events at all: stay quiet (no baseline to measure from).
    await runOfapiAccountHealthMonitor(appContext, (await testDb.pool.query("select now() as now")).rows[0].now);
    expect((await listIncidents("open")).map((incident) => incident.kind))
      .not.toContain("ofapi_webhook_silence");

    // A single stale event beyond the threshold opens the incident.
    await deliverAndProcess({
      event: "users.typing",
      account_id: OFAPI_ACCOUNT,
      payload: { id: 1000005 },
    });
    await testDb.pool.query(
      "update ofapi_webhook_events set received_at = now() - interval '13 hours'",
    );
    await runOfapiAccountHealthMonitor(appContext, (await testDb.pool.query("select now() as now")).rows[0].now);
    const open = await listIncidents("open");
    const silence = open.find((incident) => incident.kind === "ofapi_webhook_silence");
    expect(silence).toBeDefined();
    expect(silence!.platformAccountId).toBeNull();

    // A fresh delivery resolves it.
    await deliverAndProcess({
      event: "users.typing",
      account_id: OFAPI_ACCOUNT,
      payload: { id: 1000005 },
    });
    await runOfapiAccountHealthMonitor(appContext, (await testDb.pool.query("select now() as now")).rows[0].now);
    expect((await listIncidents("open")).map((incident) => incident.kind))
      .not.toContain("ofapi_webhook_silence");
  });
});

describe("OFAPI admin status endpoint", () => {
  it("reports per-page auth status, last-event ages, and the credit state", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const page = await seedMappedPage();
    await deliverAndProcess({
      event: "accounts.otp_code_required",
      account_id: OFAPI_ACCOUNT,
      payload: {},
    });
    await recordOfapiCreditUsage(appContext.db, { creditsUsed: 3, balance: 18_000 });

    await createUserAccount(appContext, {
      username: "dima",
      role: "owner",
      password: "owner-secret",
    }, { source: "cli" });
    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;

    const status = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/webhook",
      headers: { cookie },
    });
    expect(status.statusCode).toBe(200);
    const body = status.json() as {
      pages: Array<{
        pageId: number;
        ofapiAuthStatus: string | null;
        ofapiAuthChangedAt: string | null;
        lastEventAt: string | null;
        lastEventAgeSeconds: number | null;
      }>;
      credit: { lastBalance: number | null; lastBalanceAt: string | null; spentToday: number };
    };

    const pageStatus = body.pages.find((item) => item.pageId === page.id);
    expect(pageStatus).toBeDefined();
    expect(pageStatus!.ofapiAuthStatus).toBe("otp_code_required");
    expect(pageStatus!.ofapiAuthChangedAt).toBeTruthy();
    expect(pageStatus!.lastEventAt).toBeTruthy();
    expect(pageStatus!.lastEventAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(body.credit.lastBalance).toBe(18_000);
    expect(body.credit.spentToday).toBe(3);
  });
});
