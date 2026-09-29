import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  claimOfapiWebhookRaw,
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
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { issueChatterDeviceToken } from "./helpers/device-credentials.ts";
import {
  cleanupExpiredOfapiEvents,
  processOfapiWebhookEvent,
} from "../apps/runtime/src/services/ofapi-events.ts";
import { OFAPI_WEBHOOK_EVENTS } from "../apps/runtime/src/services/ofapi-webhooks.ts";
import { OfapiApiError, type OfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

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
    expect(row.captureState).toBe("accepted");
    expect(row.rawBody).toEqual(Buffer.from(body));
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

  it("journals an observation atomically with every delivery (Stage 7 producer 1)", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await seedWebhookConfig();
    const body = await fixtureBody("messages_received.json");
    const idempotencyKey = nextIdempotencyKey();

    const first = await postWebhook({ body, idempotencyKey });
    expect(first.statusCode).toBe(200);

    const observations = await testDb.pool.query<{
      source: string;
      producer: string;
      platform: string;
      native_account_ref: string;
      kind: string;
      idempotency_key: string;
      payload_hash: Buffer;
    }>(
      `select source, producer, platform, native_account_ref, kind, idempotency_key, payload_hash
       from observations where source = 'webhook'`,
    );
    expect(observations.rows).toHaveLength(1);
    expect(observations.rows[0]).toMatchObject({
      source: "webhook",
      producer: "ofapi:webhook",
      platform: "onlyfans",
      native_account_ref: "acct_01000000000000000000000000000000",
      kind: "messages.received",
      idempotency_key: idempotencyKey,
    });
    const expectedHash = createHash("sha256").update(Buffer.from(body)).digest();
    expect(Buffer.compare(observations.rows[0]!.payload_hash, expectedHash)).toBe(0);

    // Re-delivery of the same idempotent delivery = the same fact: duplicate
    // ack, no second observation.
    const duplicate = await postWebhook({ body, idempotencyKey });
    expect(duplicate.json()).toEqual({ received: true, duplicate: true });
    const recount = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from observations where source = 'webhook'",
    );
    expect(recount.rows[0]!.n).toBe("1");
  });

  it("captures unmapped-account deliveries as retained observations (Stage 7 headline)", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await seedWebhookConfig();
    const envelope = JSON.parse(await fixtureBody("messages_received.json")) as Record<string, unknown>;
    envelope["account_id"] = "acct_unmapped_stage7";
    const body = JSON.stringify(envelope);

    const response = await postWebhook({ body, signature: sign(body) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true, duplicate: false });

    // Processing settles the journal row as skipped (no mapped page) — the
    // observation is retained regardless: capture is unconditional.
    const rows = await appContext.db.select().from(ofapiWebhookEvents);
    expect(rows).toHaveLength(1);
    await processOfapiWebhookEvent(appContext, rows[0]!.id);

    const observation = await testDb.pool.query<{ native_account_ref: string; kind: string }>(
      "select native_account_ref, kind from observations where source = 'webhook'",
    );
    expect(observation.rows).toHaveLength(1);
    expect(observation.rows[0]).toEqual({
      native_account_ref: "acct_unmapped_stage7",
      kind: "messages.received",
    });
  });

  it("rejects untrusted deliveries but retains every signed invalid envelope", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await seedWebhookConfig();
    const body = await fixtureBody("messages_received.json");

    const tampered = await postWebhook({
      body: body.replace("messages.received", "messages.received "),
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
    expect(missingKey.statusCode).toBe(200);
    expect(missingKey.json()).toEqual({ received: true, duplicate: false });

    const oversizedBody = body.replace("messages.received", "users.online");
    const oversizedKey = await postWebhook({
      body: oversizedBody,
      signature: sign(oversizedBody),
      idempotencyKey: "x".repeat(256),
    });
    expect(oversizedKey.statusCode).toBe(200);
    expect(oversizedKey.json()).toEqual({ received: true, duplicate: false });

    const invalidJson = await postWebhook({ body: "{not json", signature: sign("{not json") });
    expect(invalidJson.statusCode).toBe(200);
    expect(invalidJson.json()).toEqual({ received: true, duplicate: false });

    const notEnvelope = JSON.stringify({ hello: "world" });
    const badEnvelope = await postWebhook({ body: notEnvelope, signature: sign(notEnvelope) });
    expect(badEnvelope.statusCode).toBe(200);

    const captured = await appContext.db
      .select()
      .from(ofapiWebhookEvents)
      .orderBy(ofapiWebhookEvents.id);
    expect(captured).toHaveLength(4);
    expect(captured.map((row) => row.captureState)).toEqual([
      "quarantined_malformed",
      "quarantined_malformed",
      "quarantined_malformed",
      "quarantined_malformed",
    ]);
    expect(captured.map((row) => row.status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "skipped",
    ]);
    expect(captured[0]?.rawBody).toEqual(Buffer.from(body));
    expect(captured[1]?.rawBody).toEqual(Buffer.from(oversizedBody));
    expect(captured[2]?.rawBody).toEqual(Buffer.from("{not json"));
    expect(captured[3]?.rawBody).toEqual(Buffer.from(notEnvelope));
    const invalidIdentity = await testDb.pool.query<{
      kind: string;
      payload: Record<string, unknown>;
    }>(`
      select kind, payload
      from observations
      where source = 'webhook' and kind = 'ofapi.webhook.invalid_identity'
      order by id
    `);
    expect(invalidIdentity.rows).toHaveLength(2);
    expect(invalidIdentity.rows[0]?.payload).toMatchObject({
      reason: "signed_webhook_invalid_identity_header",
      providedIdempotencyKey: null,
      body: Buffer.from(body).toString("base64"),
    });
    expect(invalidIdentity.rows[1]?.payload).toMatchObject({
      reason: "signed_webhook_invalid_identity_header",
      providedIdempotencyKey: "x".repeat(256),
      body: Buffer.from(oversizedBody).toString("base64"),
    });
    const malformed = await testDb.pool.query<{ kind: string; payload: Record<string, unknown> }>(`
      select kind, payload
      from observations
      where source = 'webhook' and kind = 'ofapi.webhook.malformed'
      order by id
    `);
    expect(malformed.rows).toHaveLength(2);
    expect(malformed.rows[0]?.payload).toMatchObject({
      reason: "signed_webhook_invalid_json",
      body: Buffer.from("{not json").toString("base64"),
    });
  });

  it("quarantines an idempotency key reused for different signed bytes", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    await seedWebhookConfig();
    const body = await fixtureBody("users_typing.json");
    const idempotencyKey = nextIdempotencyKey();
    expect((await postWebhook({ body, idempotencyKey })).statusCode).toBe(200);
    const conflictingBody = body.replace("users.typing", "users.online");
    const conflict = await postWebhook({
      body: conflictingBody,
      signature: sign(conflictingBody),
      idempotencyKey,
    });
    expect(conflict.statusCode).toBe(200);
    expect(conflict.json()).toEqual({ received: true, duplicate: false });
    expect(await appContext.db.select().from(ofapiWebhookEvents)).toHaveLength(1);
    const facts = await testDb.pool.query<{ payload: Record<string, unknown> }>(`
      select payload
      from observations
      where source = 'webhook' and kind = 'ofapi.webhook.fact_conflict'
    `);
    expect(facts.rows).toHaveLength(1);
    expect(facts.rows[0]?.payload).toMatchObject({
      idempotencyKey,
      body: Buffer.from(conflictingBody).toString("base64"),
    });
  });

  it("finishes a raw capture left behind by a receiver crash", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const body = await fixtureBody("messages_received.json");
    const rawBody = Buffer.from(body);
    const claimed = await claimOfapiWebhookRaw(appContext.db, {
      idempotencyKey: nextIdempotencyKey(),
      rawBody,
      payloadHash: createHash("sha256").update(rawBody).digest(),
      captureHeaders: {},
    });
    expect(claimed.captureState).toBe("raw_captured");
    await processOfapiWebhookEvent(appContext, claimed.id);
    const recovered = await getOfapiWebhookEventById(appContext.db, claimed.id);
    expect(recovered).toMatchObject({
      captureState: "accepted",
      eventType: "messages.received",
      status: "skipped",
    });
    const observation = await testDb.pool.query<{ kind: string }>(`
      select kind from observations where source = 'webhook'
    `);
    expect(observation.rows).toEqual([{ kind: "messages.received" }]);
  });

  it("keeps an invalid-identity delivery quarantined when the receiver crashes after raw claim", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const body = await fixtureBody("messages_received.json");
    const rawBody = Buffer.from(body);
    const payloadHash = createHash("sha256").update(rawBody).digest();
    const claimed = await claimOfapiWebhookRaw(appContext.db, {
      idempotencyKey: `invalid-identity:${payloadHash.toString("hex")}`,
      rawBody,
      payloadHash,
      captureHeaders: {
        signature: sign(body),
        idempotencyKey: "<missing>",
        identityStatus: "invalid",
      },
    });
    expect(claimed.captureState).toBe("raw_captured");

    await processOfapiWebhookEvent(appContext, claimed.id);

    const recovered = await getOfapiWebhookEventById(appContext.db, claimed.id);
    expect(recovered).toMatchObject({
      captureState: "quarantined_malformed",
      status: "skipped",
      fanoutSeq: null,
    });
    const observations = await testDb.pool.query<{ kind: string; payload: Record<string, unknown> }>(`
      select kind, payload from observations where source = 'webhook'
    `);
    expect(observations.rows).toHaveLength(1);
    expect(observations.rows[0]).toMatchObject({
      kind: "ofapi.webhook.invalid_identity",
      payload: {
        reason: "signed_webhook_invalid_identity_header",
        providedIdempotencyKey: null,
      },
    });
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

  it("captures campaign queue events without inferring recipients or fanning out", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    await seedWebhookConfig();
    await seedOnlyFansPage({
      label: "campaign-capture",
      ofapiAccountId: "acct_campaign_capture",
    });
    for (const event of ["chat_queue.updated", "chat_queue.finished"]) {
      const body = JSON.stringify({
        event,
        account_id: "acct_campaign_capture",
        payload: { queue_id: "queue-opaque", sentCount: 7 },
      });
      expect((await postWebhook({ body, signature: sign(body) })).statusCode).toBe(200);
    }
    const rows = await appContext.db
      .select()
      .from(ofapiWebhookEvents)
      .orderBy(ofapiWebhookEvents.id);
    expect(rows.map((row) => row.eventType)).toEqual([
      "chat_queue.updated",
      "chat_queue.finished",
    ]);
    for (const row of rows) {
      await processOfapiWebhookEvent(appContext, row.id);
    }
    const settled = await appContext.db
      .select()
      .from(ofapiWebhookEvents)
      .orderBy(ofapiWebhookEvents.id);
    expect(settled.map((row) => ({
      status: row.status,
      fanoutSeq: row.fanoutSeq,
      syncEvent: row.syncEvent,
      projectionStatus: row.projectionStatus,
    }))).toEqual([
      { status: "skipped", fanoutSeq: null, syncEvent: null, projectionStatus: "none" },
      { status: "skipped", fanoutSeq: null, syncEvent: null, projectionStatus: "none" },
    ]);
  });

  it("retains a consumed replay row when an older row blocks the contiguous prune prefix", async (context) => {
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
    const staleConsumed = await postWebhook({ body: await fixtureBody("messages_deleted.json") });
    expect(staleConsumed.statusCode).toBe(200);
    const staleUnconsumed = await postWebhook({ body: await fixtureBody("messages_received.json") });
    expect(staleUnconsumed.statusCode).toBe(200);

    const rows = await appContext.db
      .select()
      .from(ofapiWebhookEvents)
      .orderBy(ofapiWebhookEvents.id);
    expect(rows).toHaveLength(3);
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    // Both message-shaped rows age out of the window. The later row is fully
    // consumed, but the first fresh replayable row is a continuity blocker:
    // replay deletion is prefix-only, so the later frame must remain too.
    await testDb.pool.query(
      `update ofapi_webhook_events
       set received_at = $1,
           projection_status = 'projected',
           archive_status = 'archived'
       where id = $2`,
      [eightDaysAgo, rows[1]!.id],
    );
    await testDb.pool.query(
      "update ofapi_webhook_events set received_at = $1 where id = $2",
      [eightDaysAgo, rows[2]!.id],
    );
    expect(rows[2]!.projectionStatus).toBe("pending");

    await cleanupExpiredOfapiEvents(appContext);

    const remaining = await appContext.db.select().from(ofapiWebhookEvents).orderBy(ofapiWebhookEvents.id);
    expect(remaining.map((row) => row.id)).toEqual(rows.map((row) => row.id));
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
      getCredentialPreflight: vi.fn(async () => ({ status: "verified" as const, expectedTeam: "test", observedTeam: "test",
        credentialFingerprint: "a".repeat(64), checkedAt: new Date().toISOString(), reason: null, rosterScope: "unknown" as const })),
      getWebhook: vi.fn(async (id: string) => ({ id, url: "https://hub.example.com/api/v1/ofapi/webhook",
        events: [...OFAPI_WEBHOOK_EVENTS], account_scope: "global", enabled: true })),
      listWebhooks: vi.fn(async () => []),
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

  it("registers globally, stores the secret encrypted, and never maps by username alone", async (context) => {
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
    appContext.config.ofapiWebhookManagementScope = "team";
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
    expect(body.mapping.mapped).toEqual([]);
    expect(body.mapping.unmatchedAccounts).toEqual([{ id: "acct_lora", username: "LoraVie" }, { id: "acct_unknown", username: "somebody-else" }]);
    expect(body.mapping.unmappedPages).toEqual(["lily-of", "lora-of"]);

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

    // An identical owner retry verifies remote state without mutation or needless
    // secret rotation after a partial account-mapping failure.
    const updateMock = ofapi.updateWebhook as ReturnType<typeof vi.fn>;
    const sameTarget = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/webhook",
      headers: { cookie },
      payload: { endpointUrl: "https://hub.example.com/api/v1/ofapi/webhook" },
    });
    expect(sameTarget.statusCode).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(0);

    // A changed target goes through fenced updateWebhook with the stored id.
    const reRegister = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/webhook",
      headers: { cookie },
      payload: { endpointUrl: "https://hub.example.com/api/v1/ofapi/webhook-v2" },
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
        bindingGeneration: expect.any(Number),
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
        bindingGeneration: expect.any(Number),
        label: "lora-of",
        username: "loravie",
        ofapiAccountId: null,
        ofapiAuthStatus: null,
        ofapiAuthChangedAt: null,
        lastEventAt: null,
        lastEventAgeSeconds: null,
      },
    ]);
  });

  it("keeps old and pending secrets live across an indeterminate PUT and retries identically", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    await seedWebhookConfig();
    const updateWebhook = vi.fn()
      .mockRejectedValueOnce(new Error("connection lost after dispatch"))
      .mockResolvedValueOnce({ id: "wh_test" });
    const ofapi = fakeOfapiClient({ updateWebhook });
    appContext = createTestAppContext(testDb, { ofapi });
    appContext.config.ofapiWebhookManagementScope = "team";
    await server.close();
    server = await buildApiServer(appContext);
    await server.ready();
    const cookie = await loginOwnerCookie();
    const target = "https://hub.example.com/api/v1/ofapi/webhook-v2";

    const failed = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/webhook",
      headers: { cookie },
      payload: { endpointUrl: target },
    });
    expect(failed.statusCode).toBe(503);
    const pending = await getOfapiWebhookConfig(appContext.db);
    expect(pending?.registrationState).toBe("update_indeterminate");
    const pendingSecret = decryptJsonWithKeyVersion<string>(
      pending!.pendingEncryptedSigningSecret!,
      new Map([[1, ENCRYPTION_KEY]]),
    );
    const body = await fixtureBody("users_typing.json");
    expect((await postWebhook({ body, signature: sign(body, SIGNING_SECRET) })).statusCode).toBe(200);
    expect((await postWebhook({ body, signature: sign(body, pendingSecret) })).statusCode).toBe(200);

    const retry = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/webhook",
      headers: { cookie },
      payload: { endpointUrl: target },
    });
    expect(retry.statusCode).toBe(200);
    expect(updateWebhook).toHaveBeenCalledTimes(2);
    const firstRegistration = updateWebhook.mock.calls[0]?.[1] as { signingSecret: string };
    const secondRegistration = updateWebhook.mock.calls[1]?.[1] as { signingSecret: string };
    expect(secondRegistration.signingSecret).toBe(firstRegistration.signingSecret);
    const stable = await getOfapiWebhookConfig(appContext.db);
    expect(stable).toMatchObject({ registrationState: "stable", externalWebhookId: "wh_test" });
    expect(stable?.pendingEncryptedSigningSecret).toBeNull();
  });

  it("never repeats an indeterminate initial POST", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const createWebhook = vi.fn(async () => {
      throw new Error("connection lost after create dispatch");
    });
    const ofapi = fakeOfapiClient({ createWebhook });
    appContext = createTestAppContext(testDb, { ofapi });
    appContext.config.ofapiWebhookManagementScope = "team";
    await server.close();
    server = await buildApiServer(appContext);
    await server.ready();
    const cookie = await loginOwnerCookie();
    const payload = { endpointUrl: "https://hub.example.com/api/v1/ofapi/webhook" };

    const first = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/webhook",
      headers: { cookie },
      payload,
    });
    expect(first.statusCode).toBe(503);
    const pending = await getOfapiWebhookConfig(appContext.db);
    expect(pending?.registrationState).toBe("create_indeterminate");

    const status = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/webhook",
      headers: { cookie },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      configured: false,
      registrationState: "create_indeterminate",
      registrationError: "connection lost after create dispatch",
      pendingRegistration: {
        operationId: pending!.pendingRegistration!.operationId,
        operation: "create",
        endpointUrl: payload.endpointUrl,
      },
    });

    const second = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/webhook",
      headers: { cookie },
      payload,
    });
    expect(second.statusCode).toBe(503);
    expect(createWebhook).toHaveBeenCalledTimes(1);

    // If the remote POST did apply, its candidate secret is already accepted.
    const pendingSecret = decryptJsonWithKeyVersion<string>(
      pending!.pendingEncryptedSigningSecret!,
      new Map([[1, ENCRYPTION_KEY]]),
    );
    const body = await fixtureBody("users_typing.json");
    expect((await postWebhook({ body, signature: sign(body, pendingSecret) })).statusCode).toBe(200);

    // A live dispatch cannot be reconciled concurrently. A legacy grace secret
    // is retained when the eventual indeterminate create is adopted.
    const previousEncryptedSecret = JSON.stringify(encryptJson(
      "legacy-previous-secret",
      ENCRYPTION_KEY,
      1,
    ));
    await testDb.pool.query(
      `update ofapi_webhook_config
       set registration_state = 'create_dispatching',
           previous_encrypted_signing_secret = $1,
           updated_at = now()
       where id = 1`,
      [previousEncryptedSecret],
    );
    const racedAdopt = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/webhook/reconcile",
      headers: { cookie },
      payload: {
        action: "adopt",
        operationId: pending!.pendingRegistration!.operationId,
        externalWebhookId: "wh_found_too_early",
      },
    });
    expect(racedAdopt.statusCode).toBe(409);
    await testDb.pool.query(
      "update ofapi_webhook_config set registration_state = 'create_indeterminate' where id = 1",
    );

    const adopted = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/webhook/reconcile",
      headers: { cookie },
      payload: {
        action: "adopt",
        operationId: pending!.pendingRegistration!.operationId,
        externalWebhookId: "wh_found_remotely",
      },
    });
    expect(adopted.statusCode).toBe(200);
    expect(adopted.json()).toMatchObject({
      configured: true,
      registrationState: "stable",
      registrationError: null,
      pendingRegistration: null,
      externalWebhookId: "wh_found_remotely",
    });
    const stable = await getOfapiWebhookConfig(appContext.db);
    expect(stable?.pendingEncryptedSigningSecret).toBeNull();
    expect(stable?.previousEncryptedSigningSecret).toBe(previousEncryptedSecret);
    expect(decryptJsonWithKeyVersion<string>(
      stable!.encryptedSigningSecret,
      new Map([[1, ENCRYPTION_KEY]]),
    )).toBe(pendingSecret);
  });

  it("lets an owner confirm an indeterminate create did not happen before retrying", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const createWebhook = vi.fn()
      .mockRejectedValueOnce(new Error("connection lost after create dispatch"))
      .mockResolvedValueOnce({ id: "wh_after_reconcile" });
    appContext = createTestAppContext(testDb, {
      ofapi: fakeOfapiClient({ createWebhook }),
    });
    appContext.config.ofapiWebhookManagementScope = "team";
    await server.close();
    server = await buildApiServer(appContext);
    await server.ready();
    const cookie = await loginOwnerCookie();
    const payload = { endpointUrl: "https://hub.example.com/api/v1/ofapi/webhook" };

    expect((await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/webhook",
      headers: { cookie },
      payload,
    })).statusCode).toBe(503);
    const pending = await getOfapiWebhookConfig(appContext.db);
    expect(pending?.registrationState).toBe("create_indeterminate");

    const reconciled = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/webhook/reconcile",
      headers: { cookie },
      payload: {
        action: "confirm_not_created",
        operationId: pending!.pendingRegistration!.operationId,
        reason: "remote webhook list checked by owner",
      },
    });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json()).toMatchObject({
      configured: false,
      registrationState: "create_failed",
      pendingRegistration: null,
    });

    const retry = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/webhook",
      headers: { cookie },
      payload,
    });
    expect(retry.statusCode).toBe(200);
    expect(createWebhook).toHaveBeenCalledTimes(2);
    expect(await getOfapiWebhookConfig(appContext.db)).toMatchObject({
      registrationState: "stable",
      externalWebhookId: "wh_after_reconcile",
    });
  });

  it("treats a rejected 429 create as retryable owner work, not an indeterminate POST", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const createWebhook = vi.fn()
      .mockRejectedValueOnce(new OfapiApiError("rate limited", 429, null))
      .mockResolvedValueOnce({ id: "wh_after_rate_limit" });
    appContext = createTestAppContext(testDb, {
      ofapi: fakeOfapiClient({ createWebhook }),
    });
    appContext.config.ofapiWebhookManagementScope = "team";
    await server.close();
    server = await buildApiServer(appContext);
    await server.ready();
    const cookie = await loginOwnerCookie();
    const payload = { endpointUrl: "https://hub.example.com/api/v1/ofapi/webhook" };

    const rejected = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/webhook",
      headers: { cookie },
      payload,
    });
    expect(rejected.statusCode).toBe(503);
    expect((await getOfapiWebhookConfig(appContext.db))?.registrationState).toBe("create_failed");

    const retry = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/webhook",
      headers: { cookie },
      payload,
    });
    expect(retry.statusCode).toBe(200);
    expect(createWebhook).toHaveBeenCalledTimes(2);
    expect(await getOfapiWebhookConfig(appContext.db)).toMatchObject({
      registrationState: "stable",
      externalWebhookId: "wh_after_rate_limit",
    });
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
    const { key: chatterKey } = await issueChatterDeviceToken(appContext, {
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
