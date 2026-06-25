import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  setPageOfapiAccountId,
  upsertOfapiWebhookConfig,
} from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createUserAccount,
  issueChatterApiKey,
} from "../apps/runtime/src/services/auth.ts";
import { processOfapiWebhookEvent } from "../apps/runtime/src/services/ofapi-events.ts";
import { OFAPI_WEBHOOK_EVENTS } from "../apps/runtime/src/services/ofapi-webhooks.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

const FIXTURES_DIR = path.resolve("tests/fixtures/ofapi-webhooks");
const SIGNING_SECRET = "snapshot-signing-secret";
const ENCRYPTION_KEY = Buffer.alloc(32, 7);
const ACCOUNT_ONE = "acct_01000000000000000000000000000000";
const ACCOUNT_TWO = "acct_02000000000000000000000000000000";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let chatterKey = "";
let eventCounter = 0;

async function loadReceivedFixture() {
  const raw = JSON.parse(
    await readFile(path.join(FIXTURES_DIR, "messages_received.json"), "utf8"),
  ) as Record<string, unknown>;
  delete raw._meta;
  return raw as {
    event: string;
    account_id: string;
    payload: Record<string, unknown> & {
      fromUser: Record<string, unknown>;
    };
  };
}

async function loadFixture(name: string) {
  const raw = JSON.parse(
    await readFile(path.join(FIXTURES_DIR, name), "utf8"),
  ) as Record<string, unknown>;
  delete raw._meta;
  return raw;
}

async function deliverAndProcess(envelope: Record<string, unknown>) {
  eventCounter += 1;
  const body = JSON.stringify(envelope);
  const response = await server!.inject({
    method: "POST",
    url: "/api/v1/ofapi/webhook",
    payload: body,
    headers: {
      "content-type": "application/json",
      signature: createHmac("sha256", SIGNING_SECRET).update(body).digest("hex"),
      "x-ofapi-idempotency-key": `snapshot_evt_${String(eventCounter).padStart(32, "0")}`,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const { rows } = await testDb!.pool.query<{ id: number }>(
    "select max(id)::int as id from ofapi_webhook_events",
  );
  await processOfapiWebhookEvent(appContext, rows[0]!.id);
  return rows[0]!.id;
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
});

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  eventCounter = 0;
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb, {
    ofapiDmProjectionEnabled: true,
    ofapiDmColdArchiveEnabled: true,
    ofapiDmColdArchiveRetentionDays: 30,
  });

  const model = await createModel(appContext.db, { slug: "lora", name: "Lora" });
  const pageOne = await createOnlyFansPage(appContext.db, {
    modelId: model.id,
    label: "lora-of",
  });
  await setPageOfapiAccountId(appContext.db, {
    pageId: pageOne.id,
    ofapiAccountId: ACCOUNT_ONE,
  });
  const pageTwo = await createOnlyFansPage(appContext.db, {
    modelId: model.id,
    label: "lora-vip-of",
  });
  await setPageOfapiAccountId(appContext.db, {
    pageId: pageTwo.id,
    ofapiAccountId: ACCOUNT_TWO,
  });
  await upsertOfapiWebhookConfig(appContext.db, {
    externalWebhookId: "wh_snapshot_test",
    endpointUrl: "https://hub.example.com/api/v1/ofapi/webhook",
    accountScope: "global",
    events: [...OFAPI_WEBHOOK_EVENTS],
    encryptedSigningSecret: JSON.stringify(encryptJson(SIGNING_SECRET, ENCRYPTION_KEY, 1)),
  });
  await createUserAccount(appContext, {
    username: "owner",
    role: "owner",
    password: "owner-secret",
  }, { source: "cli" });
  await createUserAccount(appContext, {
    username: "chatter",
    role: "chatter",
  }, { source: "cli" });
  chatterKey = (await issueChatterApiKey(appContext, {
    username: "chatter",
    pageLabel: "lora-of",
  }, { source: "cli" })).key;

  await server?.close();
  server = await buildApiServer(appContext);
  await server.ready();
});

describe("OFAPI sync snapshot", () => {
  it("returns assigned durable state, paginates threads, and reuses one snapshot cursor", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const first = await loadReceivedFixture();
    first.payload.isTip = true;
    first.payload.price = 10;
    await deliverAndProcess(first);
    const second = await loadReceivedFixture();
    second.payload.id = 2000006;
    second.payload.fromUser.id = 2000005;
    second.payload.fromUser.name = "Second fan";
    second.payload.fromUser.displayName = "Second fan";
    second.payload.fromUser.username = "second-fan";
    await deliverAndProcess(second);

    const pageOne = await server.inject({
      method: "GET",
      url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=0&limit=1`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(pageOne.statusCode).toBe(200);
    const bodyOne = pageOne.json();
    expect(bodyOne).toMatchObject({
      version: 1,
      requestedAfterSeq: 0,
      resumeAllowed: true,
      page: {
        accountId: ACCOUNT_ONE,
        label: "lora-of",
      },
      coverage: {
        durableDomains: [
          "chat_heads",
          "hot_messages",
          "message_tombstones",
          "account_auth",
        ],
        messageWindow: "hot_projection_plus_archive_delta",
      },
    });
    expect(bodyOne.threads).toHaveLength(1);
    expect(bodyOne.threads[0]).toMatchObject({
      chatId: "1000005",
      unreadCount: 1,
      hasUnreadTips: true,
    });
    expect(bodyOne.unresolvedTombstones).toEqual([]);
    expect(bodyOne.nextPageCursor).not.toBeNull();
    expect(bodyOne.threads[0].messages[0]).toMatchObject({
      chatId: "1000005",
      messageId: "1000006",
      message: {
        id: "1000006",
        isSentByMe: false,
        text: "Sample fan message text used in anonymized fixtures.",
      },
      deletedAt: null,
    });
    expect(bodyOne.threads[0].messages[0].sourceFanoutSeq).toBeGreaterThan(0);

    const pageTwo = await server.inject({
      method: "GET",
      url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=0`
        + `&limit=1&pageCursor=${bodyOne.nextPageCursor}`
        + `&snapshotCursor=${bodyOne.snapshotCursor}`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(pageTwo.statusCode).toBe(200);
    expect(pageTwo.json()).toMatchObject({
      snapshotCursor: bodyOne.snapshotCursor,
      nextPageCursor: null,
    });
    expect(pageTwo.json().threads[0].chatId).toBe("2000005");
  });

  it("fails closed for an OFAPI account outside the chatter assignment", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const response = await server.inject({
      method: "GET",
      url: `/api/v1/events/snapshot?accountId=${ACCOUNT_TWO}&afterSeq=0`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns snapshot_required instead of silently replaying past retention", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    await deliverAndProcess(await loadReceivedFixture());
    const second = await loadReceivedFixture();
    second.payload.id = 2000006;
    await deliverAndProcess(second);
    await testDb.pool.query(
      "delete from ofapi_webhook_events where fanout_seq = (select min(fanout_seq) from ofapi_webhook_events)",
    );

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/events/stream?lastEventId=0",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body).toMatchObject({
      error: "sync_snapshot_required",
      statusCode: 409,
      version: 1,
      requestedSeq: 0,
      snapshotPath: "/api/v1/events/snapshot",
    });
    expect(body.oldestAvailableSeq).toBe(body.currentSeq);
    expect(body.currentSeq).toBeGreaterThan(0);
  });

  it("does not authorize cursor advancement when a durable projection is disabled", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    appContext.config.ofapiDmColdArchiveEnabled = false;
    const response = await server.inject({
      method: "GET",
      url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=0`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      resumeAllowed: false,
      coverage: {
        omittedDomains: [
          { domain: "presence", reason: "ephemeral_not_snapshotted" },
          { domain: "typing", reason: "ephemeral_not_snapshotted" },
          { domain: "message_tombstones", reason: "dm_cold_archive_disabled" },
        ],
      },
    });
  });

  it("includes delete tombstones whose webhook carried no chat id", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    await deliverAndProcess(await loadFixture("messages_deleted.json"));
    const response = await server.inject({
      method: "GET",
      url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=0`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().unresolvedTombstones).toEqual([
      expect.objectContaining({
        messageId: "1000001",
        sourceFanoutSeq: expect.any(Number),
      }),
    ]);
  });
});
