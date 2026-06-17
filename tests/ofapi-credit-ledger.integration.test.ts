import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  getOfapiCreditReconcileState,
  getOfapiCreditState,
  insertOfapiWebhookEvent,
  listNotificationIncidents,
  recordOfapiCreditSpend,
  setConfigOverride,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createOfapiCreditSpendSink,
  runOfapiBalancePing,
  runOfapiCreditBurnMonitor,
  runOfapiCreditReconciliation,
  runOfapiWebhookAccrual,
} from "../apps/runtime/src/services/ofapi-credits.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { listenOnLoopback } from "./helpers/network.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

interface ScriptedResponse {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let httpServer: Server | null = null;

const scriptedResponses: ScriptedResponse[] = [];

function scriptResponse(response: ScriptedResponse) {
  scriptedResponses.push(response);
}

function metaBody(data: unknown, credits: { used: number; balance: number }) {
  return JSON.stringify({
    data,
    _pagination: { next_page: null },
    _meta: {
      _credits: { used: credits.used, balance: credits.balance },
      _cache: { is_cached: false },
      _rate_limits: { remaining_minute: 999 },
    },
  });
}

async function startScriptedOfapiServer() {
  const server = createServer((request, response) => {
    const scripted = scriptedResponses.shift() ?? { status: 500, body: "unscripted request" };
    response.writeHead(scripted.status, {
      "content-type": "application/json",
      ...scripted.headers,
    });
    response.end(scripted.body);
  });
  const address = await listenOnLoopback(server, "OFAPI credit ledger tests");
  if (!address) {
    server.close();
    return null;
  }
  httpServer = server;
  return `http://${address.host}:${address.port}`;
}

function buildClient(baseUrl: string, app: AppContext) {
  return createOfapiClient({
    baseUrl,
    apiKey: "test-key",
    restDelayMs: 0,
    onCreditSpend: createOfapiCreditSpendSink(app),
  });
}

async function listLedgerRows() {
  const { rows } = await testDb!.pool.query<{
    id: number;
    source: string;
    operation: string | null;
    credits: number;
    estimated: boolean;
    balance_after: number | null;
    page_id: number | null;
    request_id: string | null;
    accrual_day: string | null;
  }>(
    `select id::int, source, operation, credits, estimated, balance_after, page_id::int,
            request_id, to_char(accrual_day, 'YYYY-MM-DD') as accrual_day
     from ofapi_credit_ledger order by id`,
  );
  return rows;
}

async function seedMappedPage(label: string, ofapiAccountId: string) {
  const model = await createModel(appContext.db, {
    slug: `model-${label}`,
    name: `Model ${label}`,
  });
  const page = await createOnlyFansPage(appContext.db, { modelId: model.id, label });
  await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId });
  return page;
}

describe("ofapi credit ledger integration", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, 120_000);

  beforeEach(async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await resetIntegrationDatabase(testDb.pool);
    appContext = createTestAppContext(testDb, { ofapiCreditLedgerEnabled: true });
    scriptedResponses.length = 0;
  });

  afterEach(() => {
    httpServer?.close();
    httpServer = null;
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("records every client response as a ledger row plus the day counter, atomically", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const baseUrl = await startScriptedOfapiServer();
    if (!baseUrl) {
      context.skip();
      return;
    }

    const page = await seedMappedPage("lora-of-credits", "acct_credits");
    const client = buildClient(baseUrl, appContext);

    // 1. Server-reported _meta lands verbatim.
    scriptResponse({ status: 200, body: metaBody([], { used: 2, balance: 4000 }) });
    await client.listChats({ pageId: page.id }, "acct_credits", { limit: 5 });

    // 2. A 2xx without _meta is the estimated 1-credit fallback.
    scriptResponse({ status: 200, body: JSON.stringify({ data: [] }) });
    await client.listChats({ pageId: page.id }, "acct_credits", { limit: 5 });

    // 3. An error without _meta writes no row (reconciliation absorbs it).
    scriptResponse({ status: 400, body: JSON.stringify({ error: "bad request" }) });
    await expect(
      client.listChats({ pageId: page.id }, "acct_credits", { limit: 5 }),
    ).rejects.toThrow("returned 400");

    // 4. A retried 429 reports nothing; the succeeding attempt reports once.
    scriptResponse({ status: 429, headers: { "retry-after": "0" }, body: "slow down" });
    scriptResponse({ status: 200, body: metaBody([], { used: 1, balance: 3999 }) });
    await client.listChats({ pageId: page.id }, "acct_credits", { limit: 5 });

    const rows = await listLedgerRows();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      source: "rest",
      operation: "ofapi_chats",
      credits: 2,
      estimated: false,
      balance_after: 4000,
      page_id: page.id,
    });
    expect(rows[0]!.request_id).toMatch(/^ofapi_chats:/);
    expect(rows[1]).toMatchObject({
      source: "rest",
      credits: 1,
      estimated: true,
      balance_after: null,
      page_id: page.id,
    });
    expect(rows[2]).toMatchObject({
      source: "rest",
      credits: 1,
      estimated: false,
      balance_after: 3999,
    });

    // Counter agrees with the ledger (same-transaction updates, D2).
    const credit = await getOfapiCreditState(appContext.db);
    expect(credit.spentToday).toBe(4);
    expect(credit.lastBalance).toBe(3999);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps the sink inert and counter behavior unchanged with the flag off", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const baseUrl = await startScriptedOfapiServer();
    if (!baseUrl) {
      context.skip();
      return;
    }

    const disabledContext = createTestAppContext(testDb, { ofapiCreditLedgerEnabled: false });
    const client = buildClient(baseUrl, disabledContext);

    scriptResponse({ status: 200, body: metaBody([], { used: 2, balance: 4000 }) });
    await client.listChats({}, "acct_credits", { limit: 5 });

    expect(await listLedgerRows()).toHaveLength(0);
    const credit = await getOfapiCreditState(disabledContext.db);
    expect(credit.spentToday).toBe(0);
    expect(credit.lastBalance).toBeNull();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("posts idempotent webhook accrual rows for completed UTC days", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // 101 events yesterday (-> 2 credits) and 1 event two days ago (-> 1 credit).
    for (let index = 0; index < 101; index += 1) {
      await insertOfapiWebhookEvent(appContext.db, {
        idempotencyKey: `evt_accrual_y_${String(index).padStart(34, "0")}`,
        eventType: "users.online",
        ofapiAccountId: null,
        payload: {},
      });
    }
    await insertOfapiWebhookEvent(appContext.db, {
      idempotencyKey: `evt_accrual_old_${String(0).padStart(32, "0")}`,
      eventType: "users.online",
      ofapiAccountId: null,
      payload: {},
    });
    await testDb.pool.query(
      `update ofapi_webhook_events set received_at = now() - interval '1 day'
       where idempotency_key like 'evt_accrual_y_%'`,
    );
    await testDb.pool.query(
      `update ofapi_webhook_events set received_at = now() - interval '2 days'
       where idempotency_key like 'evt_accrual_old_%'`,
    );

    const posted = await runOfapiWebhookAccrual(appContext);
    expect(posted).toBe(2);

    const rows = (await listLedgerRows()).filter((row) => row.source === "webhook_accrual");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.credits).sort()).toEqual([1, 2]);
    expect(rows.every((row) => row.estimated)).toBe(true);

    // occurred_at must land INSIDE the accrued day so daily/burn aggregates
    // attribute the credits to the day the events arrived.
    const { rows: accrualDays } = await testDb.pool.query<{ matches: boolean }>(
      `select bool_and((occurred_at at time zone 'UTC')::date = accrual_day) as matches
       from ofapi_credit_ledger where source = 'webhook_accrual'`,
    );
    expect(accrualDays[0]!.matches).toBe(true);

    // Re-running never double-posts a day.
    expect(await runOfapiWebhookAccrual(appContext)).toBe(0);
    expect(
      (await listLedgerRows()).filter((row) => row.source === "webhook_accrual"),
    ).toHaveLength(2);

    // Flag off: inert.
    const disabledContext = createTestAppContext(testDb, { ofapiCreditLedgerEnabled: false });
    expect(await runOfapiWebhookAccrual(disabledContext)).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("decomposes balance drift into external and refill rows and advances the cursor", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const t0 = new Date(Date.now() - 10 * 60 * 1000);
    const minutes = (count: number) => new Date(t0.getTime() + count * 60 * 1000);

    // Three observations: 1000 -> 950 with only 10 credits recorded (40 external),
    // then 950 -> 2000 with 5 recorded (a 1055 refill, net of spend).
    await recordOfapiCreditSpend(appContext.db, {
      operation: "ofapi_chats", credits: 5, balanceAfter: 1000, occurredAt: t0,
    });
    await recordOfapiCreditSpend(appContext.db, {
      operation: "ofapi_chats", credits: 10, balanceAfter: 950, occurredAt: minutes(2),
    });
    await recordOfapiCreditSpend(appContext.db, {
      operation: "ofapi_chats", credits: 5, balanceAfter: 2000, occurredAt: minutes(4),
    });

    const plan = await runOfapiCreditReconciliation(appContext);
    expect(plan?.adjustments).toHaveLength(2);

    const rows = await listLedgerRows();
    const external = rows.find((row) => row.source === "external");
    const refill = rows.find((row) => row.source === "refill");
    expect(external).toMatchObject({ credits: 40, estimated: true });
    expect(refill).toMatchObject({ credits: -1055, estimated: true });

    const state = await getOfapiCreditReconcileState(appContext.db);
    expect(state.reconciledThroughLedgerId).toBe(rows[2]!.id);
    expect(state.lastDriftCredits).toBe(-1055);
    expect(state.lastReconcileAt).not.toBeNull();

    // A second run finds nothing new past the cursor.
    const second = await runOfapiCreditReconciliation(appContext);
    expect(second?.adjustments).toHaveLength(0);
    expect(await listLedgerRows()).toHaveLength(rows.length);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("opens and resolves the burn-rate incident from trailing-hour ledger spend", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await recordOfapiCreditSpend(appContext.db, {
      operation: "ofapi_chat_messages",
      credits: 400,
      balanceAfter: 20_000,
      occurredAt: new Date(Date.now() - 5 * 60 * 1000),
    });

    await runOfapiCreditBurnMonitor(appContext);
    let incidents = await listNotificationIncidents(appContext.db, { status: "open" });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      kind: "ofapi_burn_rate",
      incidentKey: "ofapi_burn_rate:global",
      platformAccountId: null,
    });

    // Debounced: a second pass keeps the single open incident.
    await runOfapiCreditBurnMonitor(appContext);
    incidents = await listNotificationIncidents(appContext.db, { status: "open" });
    expect(incidents).toHaveLength(1);

    // Once the spend ages out of the trailing hour, the incident resolves.
    await testDb.pool.query(
      "update ofapi_credit_ledger set occurred_at = now() - interval '2 hours'",
    );
    await runOfapiCreditBurnMonitor(appContext);
    expect(await listNotificationIncidents(appContext.db, { status: "open" })).toHaveLength(0);
    const resolved = await listNotificationIncidents(appContext.db, { status: "resolved" });
    expect(resolved).toHaveLength(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("resolves an open burn-rate incident when the burn threshold is disabled (set to 0)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // Open the burn incident: default threshold 300/h, 400 spent in the trailing hour.
    await recordOfapiCreditSpend(appContext.db, {
      operation: "ofapi_chat_messages",
      credits: 400,
      balanceAfter: 20_000,
      occurredAt: new Date(Date.now() - 5 * 60 * 1000),
    });
    await runOfapiCreditBurnMonitor(appContext);
    expect(await listNotificationIncidents(appContext.db, { status: "open" })).toHaveLength(1);

    // Operator disables the burn alert by zeroing the threshold (live override). The disabled
    // alert must resolve the open incident, not leave it falsely open.
    await setConfigOverride(appContext.db, {
      key: "ofapiBurnAlertCreditsPerHour",
      value: 0,
      userId: null,
      groupId: randomUUID(),
    });
    await runOfapiCreditBurnMonitor(appContext);

    expect(await listNotificationIncidents(appContext.db, { status: "open" })).toHaveLength(0);
    expect(await listNotificationIncidents(appContext.db, { status: "resolved" })).toHaveLength(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("anchors reconciliation with the optional balance ping", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const baseUrl = await startScriptedOfapiServer();
    if (!baseUrl) {
      context.skip();
      return;
    }

    const page = await seedMappedPage("lora-of-ping", "acct_ping");
    const pingContext: AppContext = {
      ...createTestAppContext(testDb, {
        ofapiCreditLedgerEnabled: true,
        ofapiBalancePingEnabled: true,
      }),
    };
    pingContext.ofapi = buildClient(baseUrl, pingContext);

    scriptResponse({ status: 200, body: metaBody([], { used: 1, balance: 23_950 }) });
    await runOfapiBalancePing(pingContext);

    const rows = await listLedgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "rest",
      operation: "ofapi_balance_ping",
      credits: 1,
      balance_after: 23_950,
      page_id: page.id,
    });

    // Ping without the ledger (or with the ping flag off) is inert.
    const disabledContext: AppContext = {
      ...createTestAppContext(testDb, { ofapiCreditLedgerEnabled: true }),
    };
    disabledContext.ofapi = buildClient(baseUrl, disabledContext);
    await runOfapiBalancePing(disabledContext);
    expect(await listLedgerRows()).toHaveLength(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
