import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  getOfapiWebhookEventById,
  listOfapiSpendProjectionEvents,
  setPageOfapiAccountId,
  upsertOfapiWebhookConfig,
} from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { processOfapiWebhookEvent } from "../apps/runtime/src/services/ofapi-events.ts";
import {
  projectOfapiSpendEvent,
  sweepOfapiSpendProjections,
} from "../apps/runtime/src/services/ofapi-spend-projection.ts";
import { OFAPI_TIPS_RECEIVED_BLOCKED_REASON } from "../apps/runtime/src/services/ofapi-spend-projection-contract.ts";
import { OFAPI_WEBHOOK_EVENTS } from "../apps/runtime/src/services/ofapi-webhooks.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

const FIXTURES_DIR = path.resolve("tests/fixtures/ofapi-webhooks");
const WEBHOOK_URL = "/api/v1/ofapi/webhook";
const SIGNING_SECRET = "test-signing-secret";
const ENCRYPTION_KEY = Buffer.alloc(32, 7);
const LIVE_SPEND_ACCOUNT = "acct_02000000000000000000000000000000";
const UNVERIFIED_TIP_ACCOUNT = "acct_123";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let idempotencyCounter = 0;

function nextIdempotencyKey() {
  idempotencyCounter += 1;
  return `evt_${String(idempotencyCounter).padStart(40, "0")}`;
}

async function loadFixtureEnvelope(name: string) {
  const raw = JSON.parse(await readFile(path.join(FIXTURES_DIR, name), "utf8")) as Record<string, unknown>;
  delete raw._meta;
  return raw as { event: string; account_id?: string | null; payload: Record<string, unknown> };
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

async function seedOnlyFansPage(input: {
  label: string;
  ofapiAccountId: string;
}) {
  const model = await createModel(appContext.db, {
    slug: `model-${input.label}`,
    name: `Model ${input.label}`,
  });
  const page = await createOnlyFansPage(appContext.db, {
    modelId: model.id,
    label: input.label,
  });
  await setPageOfapiAccountId(appContext.db, {
    pageId: page.id,
    ofapiAccountId: input.ofapiAccountId,
  });
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

async function getJournalRow(eventId: number) {
  const row = await getOfapiWebhookEventById(appContext.db, eventId);
  if (!row) {
    throw new Error(`journal row ${eventId} missing`);
  }
  return row;
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
  appContext = createTestAppContext(testDb, { ofapiSpendProjectionShadowEnabled: true });
  if (server) {
    await server.close();
  }
  server = await buildApiServer(appContext);
  await server.ready();
  await seedWebhookConfig();
});

describe("OFAPI spend shadow projection", () => {
  it("projects transactions.new into pending integer-mill shadow spend", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const page = await seedOnlyFansPage({ label: "lora-of", ofapiAccountId: LIVE_SPEND_ACCOUNT });
    const eventId = await deliverAndProcess(await loadFixtureEnvelope("transactions_new.json"));
    const journal = await getJournalRow(eventId);
    expect(journal.status).toBe("skipped");
    expect(journal.error).toMatch(/journaled without fanout/);

    const rows = await listOfapiSpendProjectionEvents(appContext.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      domainKey: "ofapi:acct_02000000000000000000000000000000:tx:e940b5fb905ba0815d5842a7bde1118c",
      projectionStatus: "projected",
      sourceEventType: "transactions.new",
      journalId: eventId,
      fanoutSeq: null,
      ofapiAccountId: LIVE_SPEND_ACCOUNT,
      pageId: page.id,
      fanPlatformUserId: "1000003",
      transactionId: "e940b5fb905ba0815d5842a7bde1118c",
      messageId: null,
      category: "message",
      currency: "USD",
      grossAmountMills: 17_000n,
      creatorNetAmountMills: 13_600n,
      eventStatus: "pending",
    });

    await projectOfapiSpendEvent(appContext, await getJournalRow(eventId));
    expect(await listOfapiSpendProjectionEvents(appContext.db)).toHaveLength(1);
  });

  it("keeps same-id undo redelivery as a separate reversal projection", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await seedOnlyFansPage({ label: "refund-of", ofapiAccountId: LIVE_SPEND_ACCOUNT });
    const settledEnvelope = await loadFixtureEnvelope("transactions_new.json");
    settledEnvelope.payload.status = "done";
    const undoEnvelope = {
      ...settledEnvelope,
      payload: {
        ...settledEnvelope.payload,
        status: "undo",
      },
    };

    await deliverAndProcess(settledEnvelope);
    await deliverAndProcess(undoEnvelope);

    const rows = await listOfapiSpendProjectionEvents(appContext.db);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => ({
      domainKey: row.domainKey,
      transactionId: row.transactionId,
      eventStatus: row.eventStatus,
      grossAmountMills: row.grossAmountMills,
      creatorNetAmountMills: row.creatorNetAmountMills,
    }))).toEqual([
      {
        domainKey: "ofapi:acct_02000000000000000000000000000000:tx:e940b5fb905ba0815d5842a7bde1118c",
        transactionId: "e940b5fb905ba0815d5842a7bde1118c",
        eventStatus: "settled",
        grossAmountMills: 17_000n,
        creatorNetAmountMills: 13_600n,
      },
      {
        domainKey: "ofapi:acct_02000000000000000000000000000000:tx-reversal:e940b5fb905ba0815d5842a7bde1118c:reversal",
        transactionId: "e940b5fb905ba0815d5842a7bde1118c:reversal",
        eventStatus: "reversed",
        grossAmountMills: 17_000n,
        creatorNetAmountMills: 13_600n,
      },
    ]);
  });

  it("projects ppv unlock only as estimated, not settled revenue", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await seedOnlyFansPage({ label: "lora-of", ofapiAccountId: LIVE_SPEND_ACCOUNT });
    const eventId = await deliverAndProcess(await loadFixtureEnvelope("messages_ppv_unlocked.json"));
    const journal = await getJournalRow(eventId);
    expect(journal.status).toBe("processed");
    expect(journal.fanoutSeq).not.toBeNull();

    const rows = await listOfapiSpendProjectionEvents(appContext.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      domainKey: "ofapi:acct_02000000000000000000000000000000:ppv:1000002:1000003",
      projectionStatus: "projected",
      sourceEventType: "messages.ppv.unlocked",
      fanPlatformUserId: "1000003",
      transactionId: null,
      messageId: null,
      category: "message",
      currency: "USD",
      grossAmountMills: 12_000n,
      creatorNetAmountMills: null,
      eventStatus: "estimated",
    });
  });

  it("records tips.received as blocked until a live verified fixture exists", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const page = await seedOnlyFansPage({ label: "tip-of", ofapiAccountId: UNVERIFIED_TIP_ACCOUNT });
    const eventId = await deliverAndProcess(await loadFixtureEnvelope("unverified_tips_received.json"));

    const rows = await listOfapiSpendProjectionEvents(appContext.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      domainKey: "ofapi:acct_123:tip:123123123123",
      projectionStatus: "blocked",
      blockedReason: OFAPI_TIPS_RECEIVED_BLOCKED_REASON,
      sourceEventType: "tips.received",
      journalId: eventId,
      ofapiAccountId: UNVERIFIED_TIP_ACCOUNT,
      pageId: page.id,
      fanPlatformUserId: "111111111",
      category: "tip",
      currency: "USD",
      grossAmountMills: null,
      creatorNetAmountMills: null,
      eventStatus: null,
    });
  });

  it("back-projects retained journal rows when the flag is enabled after settle", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await server.close();
    appContext = createTestAppContext(testDb, { ofapiSpendProjectionShadowEnabled: false });
    server = await buildApiServer(appContext);
    await server.ready();
    await seedWebhookConfig();

    await seedOnlyFansPage({ label: "lora-of", ofapiAccountId: LIVE_SPEND_ACCOUNT });
    await deliverAndProcess(await loadFixtureEnvelope("transactions_new.json"));
    expect(await listOfapiSpendProjectionEvents(appContext.db)).toHaveLength(0);

    appContext = createTestAppContext(testDb, { ofapiSpendProjectionShadowEnabled: true });
    expect(await sweepOfapiSpendProjections(appContext)).toBe(1);

    const rows = await listOfapiSpendProjectionEvents(appContext.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceEventType).toBe("transactions.new");
  });
});
