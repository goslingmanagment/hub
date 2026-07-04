import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  getOfapiWebhookConfig,
  getOfapiWebhookEventById,
  listPendingOfapiWebhookEventIds,
  ofapiWebhookEvents,
  setPageOfapiAccountId,
  upsertOfapiWebhookConfig,
} from "@agency_hub_core/db";
import { decryptJsonWithKeyVersion, encryptJson } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount, issueChatterApiKey } from "../apps/runtime/src/services/auth.ts";
import {
  cleanupExpiredOfapiEvents,
  processOfapiWebhookEvent,
} from "../apps/runtime/src/services/ofapi-events.ts";
import { OFAPI_WEBHOOK_EVENTS } from "../apps/runtime/src/services/ofapi-webhooks.ts";
import type { OfapiClient } from "../apps/runtime/src/services/ofapi.ts";
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

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;

async function fixtureBody(name: string) {
  const raw = JSON.parse(await readFile(path.join(FIXTURES_DIR, name), "utf8")) as Record<string, unknown>;
  delete raw._meta;
  return JSON.stringify(raw);
}

function sign(body: string, secret = SIGNING_SECRET) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

let idempotencyCounter = 0;

function nextIdempotencyKey() {
  idempotencyCounter += 1;
  return `evt_${String(idempotencyCounter).padStart(40, "0")}`;
}

async function seedWebhookConfig(secret = SIGNING_SECRET) {
  await upsertOfapiWebhookConfig(appContext.db, {
    externalWebhookId: "wh_test",
    endpointUrl: "https://hub.example.com/api/v1/ofapi/webhook",
    accountScope: "global",
    events: [...OFAPI_WEBHOOK_EVENTS],
    encryptedSigningSecret: JSON.stringify(encryptJson(secret, ENCRYPTION_KEY, 1)),
  });
}

async function seedOnlyFansPage(input: {
  label: string;
  username?: string | null;
  ofapiAccountId?: string | null;
  modelSlug?: string;
}) {
  const model = await createModel(appContext.db, {
    slug: input.modelSlug ?? `model-${input.label}`,
    name: `Model ${input.label}`,
  });
  const page = await createOnlyFansPage(appContext.db, {
    modelId: model.id,
    label: input.label,
  });
  if (input.username !== undefined) {
    await testDb!.pool.query(
      "update pages set username = $1 where id = $2",
      [input.username, page.id],
    );
  }
  if (input.ofapiAccountId) {
    await setPageOfapiAccountId(appContext.db, {
      pageId: page.id,
      ofapiAccountId: input.ofapiAccountId,
    });
  }
  return page;
}

async function postWebhook(input: {
  body: string;
  signature?: string | null;
  idempotencyKey?: string | null;
}) {
  if (!server) {
    throw new Error("server not started");
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (input.signature !== null) {
    headers.signature = input.signature ?? sign(input.body);
  }
  if (input.idempotencyKey !== null) {
    headers["x-ofapi-idempotency-key"] = input.idempotencyKey ?? nextIdempotencyKey();
  }

  return server.inject({
    method: "POST",
    url: WEBHOOK_URL,
    payload: input.body,
    headers,
  });
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
  appContext = createTestAppContext(testDb);
  if (server) {
    await server.close();
  }
  server = await buildApiServer(appContext);
  await server.ready();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("OFAPI webhook receiver", () => {
  it("verifies the raw-body HMAC, journals the envelope, and dedupes by idempotency key", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await seedWebhookConfig();
    const body = await fixtureBody("messages_received.json");
    const idempotencyKey = nextIdempotencyKey();

    const first = await postWebhook({ body, idempotencyKey });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ received: true, duplicate: false });

    const rows = await appContext.db.select().from(ofapiWebhookEvents);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.idempotencyKey).toBe(idempotencyKey);
    expect(row.eventType).toBe("messages.received");
    expect(row.ofapiAccountId).toBe("acct_01000000000000000000000000000000");
    expect(row.status).toBe("pending");
    expect(row.payload).toEqual(JSON.parse(body));

    const duplicate = await postWebhook({ body, idempotencyKey });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual({ received: true, duplicate: true });
    expect(await appContext.db.select().from(ofapiWebhookEvents)).toHaveLength(1);

    const pending = await listPendingOfapiWebhookEventIds(appContext.db, {
      receivedBefore: new Date(Date.now() + 1000),
      limit: 10,
    });
    expect(pending).toEqual([row.id]);
  });

  it("rejects tampered bodies, bad signatures, missing headers, and malformed payloads", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await seedWebhookConfig();
    const body = await fixtureBody("users_typing.json");

    const tampered = await postWebhook({
      body: body.replace("users.typing", "users.typing "),
      signature: sign(body),
    });
    expect(tampered.statusCode).toBe(401);

    const wrongSecret = await postWebhook({ body, signature: sign(body, "other-secret") });
    expect(wrongSecret.statusCode).toBe(401);

    const missingSignature = await postWebhook({ body, signature: null });
    expect(missingSignature.statusCode).toBe(401);

    const notHex = await postWebhook({ body, signature: "zz".repeat(32) });
    expect(notHex.statusCode).toBe(401);

    const missingKey = await postWebhook({ body, idempotencyKey: null });
    expect(missingKey.statusCode).toBe(400);

    const invalidJson = await postWebhook({ body: "{not json", signature: sign("{not json") });
    expect(invalidJson.statusCode).toBe(400);

    const notEnvelope = JSON.stringify({ hello: "world" });
    const badEnvelope = await postWebhook({ body: notEnvelope, signature: sign(notEnvelope) });
    expect(badEnvelope.statusCode).toBe(400);

    expect(await appContext.db.select().from(ofapiWebhookEvents)).toHaveLength(0);
  });

  it("returns 503 before a webhook registration exists", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const body = await fixtureBody("users_typing.json");
    const response = await postWebhook({ body });
    expect(response.statusCode).toBe(503);
  });
});

describe("OFAPI event processing", () => {
  it("derives frames for mapped pages, skips unmapped accounts and journal-only events", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await seedWebhookConfig();
    const page = await seedOnlyFansPage({
      label: "lora-of",
      ofapiAccountId: "acct_01000000000000000000000000000000",
    });

    const received = await postWebhook({ body: await fixtureBody("messages_received.json") });
    expect(received.statusCode).toBe(200);
    // users_online is for acct_02…, which has no mapped page.
    const online = await postWebhook({ body: await fixtureBody("users_online.json") });
    expect(online.statusCode).toBe(200);
    // transactions.new is journaled without fanout; map acct_02 for it below.
    const transactions = await postWebhook({ body: await fixtureBody("transactions_new.json") });
    expect(transactions.statusCode).toBe(200);

    const rows = await appContext.db
      .select()
      .from(ofapiWebhookEvents)
      .orderBy(ofapiWebhookEvents.id);
    expect(rows).toHaveLength(3);

    await processOfapiWebhookEvent(appContext, rows[0]!.id);
    const processed = await getOfapiWebhookEventById(appContext.db, rows[0]!.id);
    expect(processed?.status).toBe("processed");
    expect(processed?.platformAccountId).toBe(page.id);
    expect(processed?.processedAt).not.toBeNull();
    expect(processed?.fanoutSeq).toBeGreaterThan(0);
    expect(processed?.syncEvent).toMatchObject({
      type: "messageReceived",
      accountId: "acct_01000000000000000000000000000000",
    });

    await processOfapiWebhookEvent(appContext, rows[1]!.id);
    const skippedUnmapped = await getOfapiWebhookEventById(appContext.db, rows[1]!.id);
    expect(skippedUnmapped?.status).toBe("skipped");
    expect(skippedUnmapped?.platformAccountId).toBeNull();
    expect(skippedUnmapped?.fanoutSeq).toBeNull();
    expect(skippedUnmapped?.error).toContain("No page mapped");

    const pageTwo = await seedOnlyFansPage({
      label: "lora-of-2",
      ofapiAccountId: "acct_02000000000000000000000000000000",
    });
    await processOfapiWebhookEvent(appContext, rows[2]!.id);
    const skippedJournalOnly = await getOfapiWebhookEventById(appContext.db, rows[2]!.id);
    expect(skippedJournalOnly?.status).toBe("skipped");
    expect(skippedJournalOnly?.platformAccountId).toBe(pageTwo.id);
    expect(skippedJournalOnly?.error).toContain("journaled without fanout");

    // Re-processing a settled row is a no-op.
    await processOfapiWebhookEvent(appContext, rows[0]!.id);
    expect((await getOfapiWebhookEventById(appContext.db, rows[0]!.id))?.status).toBe("processed");

    expect(await listPendingOfapiWebhookEventIds(appContext.db, {
      receivedBefore: new Date(Date.now() + 1000),
      limit: 10,
    })).toEqual([]);
  });

  it("prunes journal rows past the retention window", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await seedWebhookConfig();
    // Stage 1 stand-down raised the default retention to effectively-forever;
    // pin a short window here to keep exercising the prune mechanics.
    appContext.config.ofapiEventRetentionDays = 7;
    const fresh = await postWebhook({ body: await fixtureBody("users_typing.json") });
    expect(fresh.statusCode).toBe(200);
    const stale = await postWebhook({ body: await fixtureBody("messages_deleted.json") });
    expect(stale.statusCode).toBe(200);

    const rows = await appContext.db
      .select()
      .from(ofapiWebhookEvents)
      .orderBy(ofapiWebhookEvents.id);
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await testDb.pool.query(
      "update ofapi_webhook_events set received_at = $1 where id = $2",
      [eightDaysAgo, rows[1]!.id],
    );

    await cleanupExpiredOfapiEvents(appContext);

    const remaining = await appContext.db.select().from(ofapiWebhookEvents);
    expect(remaining.map((row) => row.id)).toEqual([rows[0]!.id]);
  });
});

describe("OFAPI webhook admin flow", () => {
  async function loginOwnerCookie() {
    if (!server) {
      throw new Error("server not started");
    }

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
    const header = login.headers["set-cookie"];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value || typeof value !== "string") {
      throw new Error("Expected set-cookie header");
    }
    return value.split(";")[0]!;
  }

  function fakeOfapiClient(overrides?: Partial<OfapiClient>): OfapiClient {
    return {
      createWebhook: vi.fn(async () => ({ id: "wh_created" })),
      updateWebhook: vi.fn(async () => ({ id: "wh_created" })),
      listAccounts: vi.fn(async () => []),
      listChats: vi.fn(async () => ({ items: [], hasNextPage: false, meta: null })),
      listChatMessages: vi.fn(async () => ({ items: [], hasNextPage: false, meta: null })),
      listActiveFans: vi.fn(async () => ({ items: [], hasNextPage: false, meta: null })),
      pingBalance: vi.fn(async () => ({ items: [], hasNextPage: false, meta: null })),
      ...overrides,
    };
  }

  it("registers the webhook globally, stores the secret encrypted, and auto-maps accounts by username", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const ofapi = fakeOfapiClient({
      listAccounts: vi.fn(async () => [
        {
          id: "acct_lora",
          username: "LoraVie",
          displayName: null,
          onlyfansName: null,
          onlyfansUserId: null,
          avatarUrl: null,
        },
        {
          id: "acct_unknown",
          username: "somebody-else",
          displayName: null,
          onlyfansName: null,
          onlyfansUserId: null,
          avatarUrl: null,
        },
      ]),
    });
    appContext = createTestAppContext(testDb, { ofapi });
    await server.close();
    server = await buildApiServer(appContext);
    await server.ready();

    await seedOnlyFansPage({ label: "lora-of", username: "loravie" });
    await seedOnlyFansPage({ label: "lily-of", username: "lilyvip" });
    const cookie = await loginOwnerCookie();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/webhook",
      headers: { cookie },
      payload: { endpointUrl: "https://hub.example.com/api/v1/ofapi/webhook" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      externalWebhookId: string | null;
      accountScope: string;
      events: string[];
      signingSecretMask: string;
      mapping: {
        mapped: Array<{ label: string; ofapiAccountId: string }>;
        unmatchedAccounts: Array<{ id: string }>;
        unmappedPages: string[];
      };
    };
    expect(body.externalWebhookId).toBe("wh_created");
    expect(body.accountScope).toBe("global");
    expect(body.events).toEqual([...OFAPI_WEBHOOK_EVENTS]);
    expect(body.mapping.mapped).toEqual([
      { pageId: expect.any(Number), label: "lora-of", ofapiAccountId: "acct_lora" },
    ]);
    expect(body.mapping.unmatchedAccounts).toEqual([{ id: "acct_unknown", username: "somebody-else" }]);
    expect(body.mapping.unmappedPages).toEqual(["lily-of"]);

    const createMock = ofapi.createWebhook as ReturnType<typeof vi.fn>;
    expect(createMock).toHaveBeenCalledTimes(1);
    const registration = createMock.mock.calls[0]![0] as {
      endpointUrl: string;
      signingSecret: string;
      events: string[];
      accountScope: string;
    };
    expect(registration.endpointUrl).toBe("https://hub.example.com/api/v1/ofapi/webhook");
    expect(registration.accountScope).toBe("global");
    expect(registration.events).toEqual([...OFAPI_WEBHOOK_EVENTS]);
    expect(registration.signingSecret.length).toBeGreaterThanOrEqual(32);
    expect(body.signingSecretMask).toBe(`${registration.signingSecret.slice(0, 4)}…`);

    const stored = await getOfapiWebhookConfig(appContext.db);
    expect(stored?.externalWebhookId).toBe("wh_created");
    expect(decryptJsonWithKeyVersion<string>(
      stored!.encryptedSigningSecret,
      new Map([[1, ENCRYPTION_KEY]]),
    )).toBe(registration.signingSecret);

    // The receiver accepts deliveries signed with the freshly registered secret.
    const eventBody = await fixtureBody("users_typing.json");
    const delivery = await postWebhook({
      body: eventBody,
      signature: sign(eventBody, registration.signingSecret),
    });
    expect(delivery.statusCode).toBe(200);

    // Re-registration goes through updateWebhook with the stored external id.
    const updateMock = ofapi.updateWebhook as ReturnType<typeof vi.fn>;
    const reRegister = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/webhook",
      headers: { cookie },
      payload: { endpointUrl: "https://hub.example.com/api/v1/ofapi/webhook" },
    });
    expect(reRegister.statusCode).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0]![0]).toBe("wh_created");

    // Rotation grace: deliveries signed with the outgoing secret keep verifying,
    // the freshly rotated secret works, and anything else still 401s.
    const rotated = updateMock.mock.calls[0]![1] as { signingSecret: string };
    expect(rotated.signingSecret).not.toBe(registration.signingSecret);
    const graceBody = await fixtureBody("messages_deleted.json");
    const oldSecretDelivery = await postWebhook({
      body: graceBody,
      signature: sign(graceBody, registration.signingSecret),
    });
    expect(oldSecretDelivery.statusCode).toBe(200);
    const newSecretDelivery = await postWebhook({
      body: graceBody,
      signature: sign(graceBody, rotated.signingSecret),
    });
    expect(newSecretDelivery.statusCode).toBe(200);
    const bogusDelivery = await postWebhook({
      body: graceBody,
      signature: sign(graceBody, "neither-secret"),
    });
    expect(bogusDelivery.statusCode).toBe(401);

    const status = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/webhook",
      headers: { cookie },
    });
    expect(status.statusCode).toBe(200);
    const statusBody = status.json() as {
      configured: boolean;
      pages: Array<{ label: string; ofapiAccountId: string | null }>;
    };
    expect(statusBody.configured).toBe(true);
    expect(statusBody.pages).toEqual([
      {
        pageId: expect.any(Number),
        label: "lily-of",
        username: "lilyvip",
        ofapiAccountId: null,
        ofapiAuthStatus: null,
        ofapiAuthChangedAt: null,
        lastEventAt: null,
        lastEventAgeSeconds: null,
      },
      {
        pageId: expect.any(Number),
        label: "lora-of",
        username: "loravie",
        ofapiAccountId: "acct_lora",
        ofapiAuthStatus: null,
        ofapiAuthChangedAt: null,
        lastEventAt: null,
        lastEventAgeSeconds: null,
      },
    ]);
  });

  it("requires an owner session and a configured OFAPI key", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await seedOnlyFansPage({ label: "lora-of", username: "loravie" });
    const unauthenticated = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/webhook",
    });
    expect(unauthenticated.statusCode).toBe(401);

    await createUserAccount(appContext, { username: "anton", role: "chatter" }, { source: "cli" });
    const { key: chatterKey } = await issueChatterApiKey(appContext, {
      username: "anton",
      pageLabel: "lora-of",
    }, { source: "cli" });
    const chatterStatus = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/webhook",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(chatterStatus.statusCode).toBe(403);

    const cookie = await loginOwnerCookie();
    // No app.ofapi and no OFAPI_API_KEY in the test config → 503.
    const register = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/webhook",
      headers: { cookie },
      payload: { endpointUrl: "https://hub.example.com/api/v1/ofapi/webhook" },
    });
    expect(register.statusCode).toBe(503);
  });
});
