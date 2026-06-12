import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  getOfapiWebhookEventById,
  getPageConversationPreview,
  listOfapiWebhookEventsForDmProjection,
  listPageDmConversationsByPlatformConversationIds,
  listWorkboardRecomputePageIds,
  setPageOfapiAccountId,
  upsertOfapiWebhookConfig,
} from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import {
  OFAPI_DM_PROJECTION_MAX_ATTEMPTS,
  projectOfapiDmEvent,
  sweepOfapiDmProjections,
} from "../apps/runtime/src/services/ofapi-dm-projection.ts";
import { processOfapiWebhookEvent } from "../apps/runtime/src/services/ofapi-events.ts";
import { OFAPI_WEBHOOK_EVENTS } from "../apps/runtime/src/services/ofapi-webhooks.ts";
import { getSyncStatusSnapshot } from "../apps/runtime/src/services/sync-status.ts";
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
const RECEIVED_ACCOUNT = "acct_01000000000000000000000000000000";
const RECEIVED_FAN_ID = "1000005";
const RECEIVED_MESSAGE_ID = "1000006";

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

/** Delivers an envelope through the real receiver and settles it via the worker handler. */
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

async function getConversation(pageId: number, platformConversationId: string) {
  const [conversation] = await listPageDmConversationsByPlatformConversationIds(appContext.db, {
    platformAccountId: pageId,
    platformConversationIds: [platformConversationId],
  });
  return conversation ?? null;
}

async function getStoredMessages(conversationId: number) {
  const { rows } = await testDb!.pool.query<{
    platform_message_id: string;
    sender_role: string;
    content: string;
    total_tip_amount_cents: number;
    purchased_at: Date | null;
  }>(
    `select platform_message_id, sender_role, content, total_tip_amount_cents, purchased_at
     from page_dm_messages where conversation_id = $1
     order by created_at asc, platform_message_id asc`,
    [conversationId],
  );
  return rows;
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
  appContext = createTestAppContext(testDb, { ofapiDmProjectionEnabled: true });
  if (server) {
    await server.close();
  }
  server = await buildApiServer(appContext);
  await server.ready();
  await seedWebhookConfig();
});

describe("OFAPI DM projection", () => {
  it("projects messages.received into a conversation + message visible via the preview API", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const page = await seedOnlyFansPage({ label: "lora-of", ofapiAccountId: RECEIVED_ACCOUNT });
    const eventId = await deliverAndProcess(await loadFixtureEnvelope("messages_received.json"));

    const row = await getJournalRow(eventId);
    expect(row.status).toBe("processed");
    expect(row.fanoutSeq).not.toBeNull();
    expect(row.projectionStatus).toBe("projected");
    expect(row.projectedAt).not.toBeNull();

    const conversation = await getConversation(page.id, RECEIVED_FAN_ID);
    expect(conversation).not.toBeNull();
    expect(conversation!.fanId).not.toBeNull();
    expect(conversation!.partnerUsername).toBe("fan005");
    expect(conversation!.unreadCount).toBe(1);
    expect(conversation!.lastMessageId).toBe(RECEIVED_MESSAGE_ID);
    expect(conversation!.lastMessageSenderRole).toBe("fan");
    expect(conversation!.messageCoverageStatus).toBe("pending_backfill");
    expect(conversation!.storedMessageCount).toBe(1);
    expect(conversation!.newestStoredMessageId).toBe(RECEIVED_MESSAGE_ID);
    expect(conversation!.lastFanMessageAt).not.toBeNull();

    const preview = await getPageConversationPreview(appContext.db, {
      platformAccountId: page.id,
      platformConversationId: RECEIVED_FAN_ID,
    });
    expect(preview).not.toBeNull();
    expect(preview!.fan?.username).toBe("fan005");
    expect(preview!.messages).toHaveLength(1);
    expect(preview!.messages[0]!.content).toBe("Sample fan message text used in anonymized fixtures.");
    expect(preview!.messages[0]!.senderRole).toBe("fan");

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
    const previewResponse = await server.inject({
      method: "GET",
      url: `/api/v1/pages/${page.label}/conversations/${RECEIVED_FAN_ID}/preview`,
      headers: { cookie },
    });
    expect(previewResponse.statusCode).toBe(200);
    const previewBody = previewResponse.json() as {
      messages: Array<{ content: string }>;
    };
    expect(previewBody.messages[0]!.content)
      .toBe("Sample fan message text used in anonymized fixtures.");

    // Mapped OnlyFans pages join the workboard v2 recompute set.
    expect(await listWorkboardRecomputePageIds(appContext.db)).toContain(page.id);

    // The messages_live block reads webhook ingest freshness for OFAPI-fed pages.
    const snapshot = await getSyncStatusSnapshot(appContext, { pageLabel: page.label });
    const messagesLive = snapshot.pages[0]!.blocks.messages_live;
    expect(messagesLive.state).toBe("up_to_date");
    expect(messagesLive.succeededAt).not.toBeNull();
    expect(messagesLive.metrics.webhookIngest).toBe(true);
    expect(messagesLive.statusReason?.code).toBe("webhook_live");
  });

  it("is idempotent under at-least-once projection replays", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const page = await seedOnlyFansPage({ label: "lora-of", ofapiAccountId: RECEIVED_ACCOUNT });
    const eventId = await deliverAndProcess(await loadFixtureEnvelope("messages_received.json"));
    const row = await getJournalRow(eventId);

    // A sweep racing the post-settle projection re-projects the same row.
    const outcome = await projectOfapiDmEvent(appContext, row);
    expect(outcome.status).toBe("projected");

    const conversation = await getConversation(page.id, RECEIVED_FAN_ID);
    expect(conversation!.unreadCount).toBe(1);
    expect(conversation!.storedMessageCount).toBe(1);
    expect(await getStoredMessages(conversation!.id)).toHaveLength(1);
  });

  it("zeroes unread on a model reply and keeps the newest head on out-of-order arrivals", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const page = await seedOnlyFansPage({ label: "lora-of", ofapiAccountId: RECEIVED_ACCOUNT });
    const received = await loadFixtureEnvelope("messages_received.json");
    await deliverAndProcess(received);

    // Model replies later: head advances, unread resets.
    const sent = await loadFixtureEnvelope("messages_sent.json");
    sent.account_id = RECEIVED_ACCOUNT;
    sent.payload = {
      ...sent.payload,
      id: 1000030,
      createdAt: "2026-06-10T19:00:00+00:00",
      toUser: {
        ...(sent.payload.toUser as Record<string, unknown>),
        id: Number(RECEIVED_FAN_ID),
        username: "fan005",
        name: "Fan 4",
      },
    };
    await deliverAndProcess(sent);

    let conversation = await getConversation(page.id, RECEIVED_FAN_ID);
    expect(conversation!.unreadCount).toBe(0);
    expect(conversation!.lastMessageId).toBe("1000030");
    expect(conversation!.lastMessageSenderRole).toBe("model");
    expect(conversation!.storedMessageCount).toBe(2);

    // An older fan message arrives late: stored + counted, but the head stays.
    const older = await loadFixtureEnvelope("messages_received.json");
    older.payload = {
      ...older.payload,
      id: 1000001,
      createdAt: "2026-06-10T18:00:00+00:00",
    };
    await deliverAndProcess(older);

    conversation = await getConversation(page.id, RECEIVED_FAN_ID);
    expect(conversation!.unreadCount).toBe(1);
    expect(conversation!.lastMessageId).toBe("1000030");
    expect(conversation!.lastMessageSenderRole).toBe("model");
    expect(conversation!.storedMessageCount).toBe(3);
    expect(conversation!.oldestStoredMessageId).toBe("1000001");
  });

  it("mirrors messages.deleted by removing the held row and recounting", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const page = await seedOnlyFansPage({ label: "lora-of", ofapiAccountId: RECEIVED_ACCOUNT });
    await deliverAndProcess(await loadFixtureEnvelope("messages_received.json"));

    const deletedUnknown = await deliverAndProcess({
      event: "messages.deleted",
      account_id: RECEIVED_ACCOUNT,
      payload: { id: "999999" },
    });
    expect((await getJournalRow(deletedUnknown)).projectionStatus).toBe("skipped");

    const deletedHeld = await deliverAndProcess({
      event: "messages.deleted",
      account_id: RECEIVED_ACCOUNT,
      payload: { id: RECEIVED_MESSAGE_ID },
    });
    expect((await getJournalRow(deletedHeld)).projectionStatus).toBe("projected");

    const conversation = await getConversation(page.id, RECEIVED_FAN_ID);
    expect(conversation!.storedMessageCount).toBe(0);
    expect(conversation!.newestStoredMessageId).toBeNull();
    expect(await getStoredMessages(conversation!.id)).toHaveLength(0);
    // Deleting the only (head) message must not leave its preview behind (B10).
    expect(conversation!.lastMessageId).toBeNull();
    expect(conversation!.lastMessageAt).toBeNull();
    expect(conversation!.lastMessagePreview).toBeNull();
  });

  it("rebuilds the conversation head when the head message is deleted (audit B10)", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const page = await seedOnlyFansPage({ label: "lora-of", ofapiAccountId: RECEIVED_ACCOUNT });
    await deliverAndProcess(await loadFixtureEnvelope("messages_received.json"));

    const sent = await loadFixtureEnvelope("messages_sent.json");
    sent.account_id = RECEIVED_ACCOUNT;
    sent.payload = {
      ...sent.payload,
      id: 1000030,
      text: "<p>Model reply at the head.</p>",
      createdAt: "2026-06-10T19:00:00+00:00",
      toUser: {
        ...(sent.payload.toUser as Record<string, unknown>),
        id: Number(RECEIVED_FAN_ID),
        username: "fan005",
        name: "Fan 4",
      },
    };
    await deliverAndProcess(sent);

    // Delete the model head: preview/sender/timestamps fall back to the
    // newest remaining (fan) message instead of showing deleted content.
    await deliverAndProcess({
      event: "messages.deleted",
      account_id: RECEIVED_ACCOUNT,
      payload: { id: "1000030" },
    });

    let conversation = await getConversation(page.id, RECEIVED_FAN_ID);
    expect(conversation!.lastMessageId).toBe(RECEIVED_MESSAGE_ID);
    expect(conversation!.lastMessageSenderRole).toBe("fan");
    expect(conversation!.lastMessagePreview).toContain("Sample fan message text");
    expect(conversation!.unreadCount).toBe(0);
    expect(conversation!.storedMessageCount).toBe(1);

    // An unread fan message becomes the head, then gets deleted: the unread
    // state is dropped with it, not left pointing at deleted content.
    const unreadFan = await loadFixtureEnvelope("messages_received.json");
    unreadFan.payload = {
      ...unreadFan.payload,
      id: 1000040,
      text: "<p>Fan follow-up that gets deleted.</p>",
      createdAt: "2026-06-10T20:00:00+00:00",
    };
    await deliverAndProcess(unreadFan);

    conversation = await getConversation(page.id, RECEIVED_FAN_ID);
    expect(conversation!.unreadCount).toBe(1);
    expect(conversation!.lastUnreadMessageId).toBe("1000040");

    await deliverAndProcess({
      event: "messages.deleted",
      account_id: RECEIVED_ACCOUNT,
      payload: { id: "1000040" },
    });

    conversation = await getConversation(page.id, RECEIVED_FAN_ID);
    expect(conversation!.lastMessageId).toBe(RECEIVED_MESSAGE_ID);
    expect(conversation!.lastMessagePreview).toContain("Sample fan message text");
    expect(conversation!.unreadCount).toBe(0);
    expect(conversation!.lastUnreadMessageId).toBeNull();

    // A head legitimately ahead of the stored window is never regressed:
    // deleting a non-head stored message leaves the head fields alone.
    const ahead = await loadFixtureEnvelope("messages_received.json");
    ahead.payload = {
      ...ahead.payload,
      id: 1000050,
      text: "<p>Newest head message.</p>",
      createdAt: "2026-06-10T21:00:00+00:00",
    };
    await deliverAndProcess(ahead);

    await deliverAndProcess({
      event: "messages.deleted",
      account_id: RECEIVED_ACCOUNT,
      payload: { id: RECEIVED_MESSAGE_ID },
    });

    conversation = await getConversation(page.id, RECEIVED_FAN_ID);
    expect(conversation!.lastMessageId).toBe("1000050");
    expect(conversation!.lastMessagePreview).toContain("Newest head message");
    expect(conversation!.storedMessageCount).toBe(1);
  });

  it("marks held messages purchased on ppv.unlocked and raises tips from tips.received", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const page = await seedOnlyFansPage({ label: "lora-of", ofapiAccountId: RECEIVED_ACCOUNT });
    await deliverAndProcess(await loadFixtureEnvelope("messages_received.json"));

    const chatLink = `https://onlyfans.com/my/chats/chat/${RECEIVED_FAN_ID}?firstId=${RECEIVED_MESSAGE_ID}`;
    const ppvEventId = await deliverAndProcess({
      event: "messages.ppv.unlocked",
      account_id: RECEIVED_ACCOUNT,
      payload: {
        type: "paided_message",
        createdAt: "2026-06-10T20:49:00+00:00",
        text: "Fan paid for your message",
        replacePairs: { "{MESSAGE_LINK}": chatLink },
        user: { id: Number(RECEIVED_FAN_ID) },
      },
    });
    expect((await getJournalRow(ppvEventId)).projectionStatus).toBe("projected");

    const tipEventId = await deliverAndProcess({
      event: "tips.received",
      account_id: RECEIVED_ACCOUNT,
      payload: {
        amountGross: 5,
        amountNet: 4,
        type: "tip",
        createdAt: "2026-06-10T20:50:00+00:00",
        text: `paid you a tip of $5.00 ${chatLink}`,
        user: { id: Number(RECEIVED_FAN_ID) },
      },
    });
    expect((await getJournalRow(tipEventId)).projectionStatus).toBe("projected");

    const conversation = await getConversation(page.id, RECEIVED_FAN_ID);
    const messages = await getStoredMessages(conversation!.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.purchased_at).not.toBeNull();
    expect(messages[0]!.total_tip_amount_cents).toBe(500);

    // Tip replays are monotonic, not additive.
    const tipRow = await getJournalRow(tipEventId);
    const replay = await projectOfapiDmEvent(appContext, tipRow);
    expect(replay.status).toBe("projected");
    const replayed = await getStoredMessages(conversation!.id);
    expect(replayed[0]!.total_tip_amount_cents).toBe(500);
  });

  it("never blocks settle/fanout: data problems settle processed and record a projection skip", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const page = await seedOnlyFansPage({ label: "lora-of", ofapiAccountId: RECEIVED_ACCOUNT });
    const envelope = await loadFixtureEnvelope("messages_received.json");
    envelope.payload = { ...envelope.payload, createdAt: "not-a-date" };
    const eventId = await deliverAndProcess(envelope);

    const row = await getJournalRow(eventId);
    // Settle/fanout is untouched by the projection failure path.
    expect(row.status).toBe("processed");
    expect(row.fanoutSeq).not.toBeNull();
    expect(row.projectionStatus).toBe("skipped");
    expect(row.projectionError).toMatch(/createdAt/);

    expect(await getConversation(page.id, RECEIVED_FAN_ID)).toBeNull();
  });

  it("skips events for unmapped accounts without touching DM tables", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    // No page mapped to the tips fixture's acct_123.
    const eventId = await deliverAndProcess(await loadFixtureEnvelope("unverified_tips_received.json"));
    const row = await getJournalRow(eventId);
    expect(row.status).toBe("skipped");
    expect(row.projectionStatus).toBe("skipped");
    expect(row.projectionError).toMatch(/No page mapped/);
  });

  it("leaves rows pending while the flag is off and projects them via the sweep once enabled", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const offContext = createTestAppContext(testDb, { ofapiDmProjectionEnabled: false });
    const page = await seedOnlyFansPage({ label: "lora-of", ofapiAccountId: RECEIVED_ACCOUNT });

    const body = JSON.stringify(await loadFixtureEnvelope("messages_received.json"));
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
    const { rows } = await testDb.pool.query<{ id: number }>(
      "select max(id)::int as id from ofapi_webhook_events",
    );
    const eventId = rows[0]!.id;
    await processOfapiWebhookEvent(offContext, eventId);

    let row = await getJournalRow(eventId);
    expect(row.status).toBe("processed");
    expect(row.projectionStatus).toBe("pending");
    expect(await getConversation(page.id, RECEIVED_FAN_ID)).toBeNull();
    expect(await sweepOfapiDmProjections(offContext)).toBe(0);

    // Flag flipped on: the minutely sweep catches up the journal backlog.
    expect(await sweepOfapiDmProjections(appContext)).toBe(1);
    row = await getJournalRow(eventId);
    expect(row.projectionStatus).toBe("projected");
    const conversation = await getConversation(page.id, RECEIVED_FAN_ID);
    expect(conversation!.storedMessageCount).toBe(1);
  });

  it("retries failed projections via the sweep only under the attempt cap", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await seedOnlyFansPage({ label: "lora-of", ofapiAccountId: RECEIVED_ACCOUNT });
    const eventId = await deliverAndProcess(await loadFixtureEnvelope("messages_received.json"));

    await testDb.pool.query(
      "update ofapi_webhook_events set projection_status = 'failed', projection_attempts = $2 where id = $1",
      [eventId, OFAPI_DM_PROJECTION_MAX_ATTEMPTS - 1],
    );
    let candidates = await listOfapiWebhookEventsForDmProjection(appContext.db, {
      eventTypes: ["messages.received"],
      maxAttempts: OFAPI_DM_PROJECTION_MAX_ATTEMPTS,
      limit: 10,
    });
    expect(candidates.map((candidate) => candidate.id)).toContain(eventId);

    await testDb.pool.query(
      "update ofapi_webhook_events set projection_attempts = $2 where id = $1",
      [eventId, OFAPI_DM_PROJECTION_MAX_ATTEMPTS],
    );
    candidates = await listOfapiWebhookEventsForDmProjection(appContext.db, {
      eventTypes: ["messages.received"],
      maxAttempts: OFAPI_DM_PROJECTION_MAX_ATTEMPTS,
      limit: 10,
    });
    expect(candidates.map((candidate) => candidate.id)).not.toContain(eventId);
  });
});
