import { fixtureUserId } from "./helpers/user-identity.ts";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  decodeDomainEventCursor,
  encodeDomainEventCursor,
} from "@agency_hub_core/contracts";
import {
  appendDomainEvents,
  createModel,
  createOnlyFansPage,
  insertOfapiWebhookEvent,
  insertObservation,
  listDomainEventAccountBounds,
  listEventsSince,
  listOfapiSyncEventsForReplay,
  settleOfapiWebhookEvent,
  setPageOfapiAccountId,
  upsertOfapiWebhookConfig,
} from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import {
  createUserAccount,
  issueChatterApiKey,
} from "../apps/runtime/src/services/auth.ts";
import {
  decodeOfapiSyncSnapshotStateCursor,
  encodeOfapiSyncSnapshotStateCursor,
} from "../apps/runtime/src/services/ofapi-sync-snapshot-cursor.ts";
import {
  mapOfapiEventToSyncEvent,
  processOfapiWebhookEvent,
} from "../apps/runtime/src/services/ofapi-events.ts";
import { resolveOfapiSyncSnapshotCursor } from "../apps/runtime/src/services/ofapi-sync-snapshot.ts";
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

async function deliver(envelope: Record<string, unknown>) {
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
  return rows[0]!.id;
}

async function deliverAndProcess(envelope: Record<string, unknown>) {
  const id = await deliver(envelope);
  await processOfapiWebhookEvent(appContext, id);
  return id;
}

async function settleWithoutPostSettleProjection(envelope: Record<string, unknown>) {
  const id = await deliver(envelope);
  const mapped = mapOfapiEventToSyncEvent(
    envelope as Parameters<typeof mapOfapiEventToSyncEvent>[0],
  );
  expect(mapped).not.toBeNull();
  const { rows: pages } = await testDb!.pool.query<{ id: number }>(
    "select id::int from pages where ofapi_account_id = $1",
    [ACCOUNT_ONE],
  );
  expect(pages).toHaveLength(1);
  expect(await settleOfapiWebhookEvent(appContext.db, {
    id,
    status: "processed",
    platformAccountId: pages[0]!.id,
    syncEvent: mapped!,
    processedAt: new Date(),
  })).toBe(true);
  const { rows } = await testDb!.pool.query<{ fanout_seq: number }>(
    "select fanout_seq::int from ofapi_webhook_events where id = $1",
    [id],
  );
  return {
    id,
    pageId: pages[0]!.id,
    fanoutSeq: rows[0]!.fanout_seq,
  };
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
    userId: await fixtureUserId(appContext, "chatter"),
    pageLabel: "lora-of",
  }, { source: "cli" })).key;

  await server?.close();
  server = await buildApiServer(appContext);
  await server.ready();
});

describe("OFAPI sync snapshot", () => {
  it("authenticates bounded cursors through the configured key-rotation ring", () => {
    const oldKey = Buffer.alloc(32, 4);
    const nextKey = Buffer.alloc(32, 5);
    const payload = {
      version: 1 as const,
      accountId: ACCOUNT_ONE,
      afterSeq: 41,
      snapshotCursor: 57,
      stateAt: "2026-07-13T12:00:00.000Z",
      messageLimit: 100,
      phase: { kind: "archive" as const, threadId: 8, afterRowId: 13 },
    };
    const cursor = encodeOfapiSyncSnapshotStateCursor(payload, {
      key: oldKey,
      keyVersion: 7,
    });

    expect(decodeOfapiSyncSnapshotStateCursor(
      cursor,
      new Map([[7, oldKey], [8, nextKey]]),
    )).toEqual(payload);
    expect(decodeOfapiSyncSnapshotStateCursor(
      cursor,
      new Map([[8, nextKey]]),
    )).toBeNull();

    const envelope = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    envelope.payload.snapshotCursor += 1;
    const tampered = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
    expect(decodeOfapiSyncSnapshotStateCursor(
      tampered,
      new Map([[7, oldKey]]),
    )).toBeNull();
  });

  it("reuses a scope-bound state cursor without querying the journal window again", async () => {
    let windowLoads = 0;
    const snapshotCursor = await resolveOfapiSyncSnapshotCursor({
      accountId: ACCOUNT_ONE,
      afterSeq: 41,
      snapshotCursor: 57,
      messageLimit: 100,
    }, {
      version: 1,
      accountId: ACCOUNT_ONE,
      afterSeq: 41,
      snapshotCursor: 57,
      stateAt: "2026-07-13T12:00:00.000Z",
      messageLimit: 100,
      phase: { kind: "unresolved", afterRowId: 5 },
    }, async () => {
      windowLoads += 1;
      return 999;
    });

    expect(snapshotCursor).toBe(57);
    expect(windowLoads).toBe(0);
  });

  it("rejects caller-raised afterSeq values and forged bounded state cursors", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const future = await server.inject({
      method: "GET",
      url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=999999999`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(future.statusCode, future.body).toBe(400);

    // Canonical signed-envelope shape and canonical base64url encoding, but a
    // caller-chosen payload and MAC. Omitting snapshotCursor used to let this
    // decoded payload bypass the safe-window lookup entirely.
    const forgedStateCursor = Buffer.from(JSON.stringify({
      format: 1,
      keyVersion: appContext.config.encryptionKeyVersion,
      payload: {
        version: 1,
        accountId: ACCOUNT_ONE,
        afterSeq: 0,
        snapshotCursor: 999_999_999,
        stateAt: "2026-07-13T12:00:00.000Z",
        messageLimit: 100,
        phase: { kind: "unresolved", afterRowId: 0 },
      },
      mac: Buffer.alloc(32, 9).toString("base64url"),
    }), "utf8").toString("base64url");
    const forged = await server.inject({
      method: "GET",
      url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=0`
        + "&pageMode=bounded_v1&messageLimit=100"
        + `&stateCursor=${forgedStateCursor}`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(forged.statusCode, forged.body).toBe(400);
  });

  it("keeps a canonicalized webhook domain event in v2 replay until durable state is complete", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const envelope = await loadReceivedFixture();
    envelope.payload.id = 9_910_001;
    const journalId = await deliver(envelope);

    // This is the real competing lifecycle: the canonicalizer consumes the
    // receipt-time observation before the independent OFAPI worker settles or
    // performs either durable-state projection.
    const canonicalized = await runCanonicalization(appContext, {
      kinds: ["messages.received"],
    });
    expect(canonicalized).toMatchObject({ appended: 1, errored: 0 });

    const { rows } = await testDb.pool.query<{
      page_id: number;
      account_seq: number;
      status: string;
      fanout_seq: number | null;
      projection_status: string;
      archive_status: string;
    }>(
      `select event.account_id::int as page_id,
              event.account_seq::int,
              webhook.status,
              webhook.fanout_seq::int,
              webhook.projection_status,
              webhook.archive_status
         from ofapi_webhook_events webhook
         join observations observation
           on observation.idempotency_key = webhook.idempotency_key
          and observation.source = 'webhook'
          and observation.producer = 'ofapi:webhook'
         join domain_events event on event.observation_id = observation.id
        where webhook.id = $1`,
      [journalId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_seq: 1,
      status: "pending",
      fanout_seq: null,
      projection_status: "pending",
      archive_status: "none",
    });

    const before = await server.inject({
      method: "GET",
      url: "/api/v1/events/v2/snapshot",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json().accounts).toEqual([{
      accountId: rows[0]!.page_id,
      accountRef: ACCOUNT_ONE,
      currentSeq: 1,
    }]);
    const beforeCursor = decodeDomainEventCursor(before.json().cursor);
    expect(beforeCursor.ok).toBe(true);
    if (!beforeCursor.ok) {
      throw new Error(beforeCursor.reason);
    }
    expect(beforeCursor.watermarks.get(rows[0]!.page_id)).toBe(0);

    // The durable snapshot cannot yet contain the message. Installing the raw
    // v2 high-water here used to lose it; the lowered cursor makes it the first
    // v2 replay row instead.
    const stateBefore = await server.inject({
      method: "GET",
      url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=0`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(stateBefore.statusCode, stateBefore.body).toBe(200);
    expect(stateBefore.json()).toMatchObject({ snapshotCursor: 0, threads: [] });
    const replay = await listEventsSince(appContext.db, {
      accountId: rows[0]!.page_id,
      afterSeq: beforeCursor.watermarks.get(rows[0]!.page_id)!,
    });
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ accountSeq: 1, type: "message.received" });

    // barrier - 1 is exactly the accepted v2 replay floor, so reconnecting
    // with this cursor cannot bounce into another snapshot-required loop.
    const bounds = await listDomainEventAccountBounds(appContext.db, [rows[0]!.page_id]);
    expect(bounds.get(rows[0]!.page_id)?.oldestRetainedSeq).toBe(1);
    expect(beforeCursor.watermarks.get(rows[0]!.page_id)).toBe(
      bounds.get(rows[0]!.page_id)!.oldestRetainedSeq! - 1,
    );

    // Once the independent state work completes, both the state snapshot and
    // the v2 cursor may advance through the event.
    await processOfapiWebhookEvent(appContext, journalId);
    const stateAfter = await server.inject({
      method: "GET",
      url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=0`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(stateAfter.statusCode, stateAfter.body).toBe(200);
    expect(stateAfter.json().snapshotCursor).toBeGreaterThanOrEqual(1);
    expect(stateAfter.json().threads[0].messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ messageId: "9910001" })]),
    );

    const after = await server.inject({
      method: "GET",
      url: "/api/v1/events/v2/snapshot",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    const afterCursor = decodeDomainEventCursor(after.json().cursor);
    expect(afterCursor.ok).toBe(true);
    if (!afterCursor.ok) {
      throw new Error(afterCursor.reason);
    }
    expect(afterCursor.watermarks.get(rows[0]!.page_id)).toBe(1);
  });

  it("bounds v2 recovery at the rejected source cursor without skipping a later incomplete OFAPI event", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const subscription = await loadFixture("subscriptions_new.json");
    subscription.account_id = ACCOUNT_ONE;
    const subscriptionId = await deliver(subscription);
    await processOfapiWebhookEvent(appContext, subscriptionId);
    // The settled receipt already produced its canonical fact. The later
    // pending message below still exercises the competing sweep path.
    expect(await runCanonicalization(appContext, {
      kinds: ["subscriptions.new"],
    })).toMatchObject({ scanned: 0, appended: 0, errored: 0 });

    const message = await loadReceivedFixture();
    message.payload.id = 9_915_001;
    const pendingMessageId = await deliver(message);
    expect(await runCanonicalization(appContext, {
      kinds: ["messages.received"],
    })).toMatchObject({ appended: 1, errored: 0 });

    const { rows } = await testDb.pool.query<{
      page_id: number;
      account_seq: number;
      event_type: string;
    }>(
      `select event.account_id::int as page_id,
              event.account_seq::int,
              webhook.event_type
         from domain_events event
         join observations observation on observation.id = event.observation_id
         join ofapi_webhook_events webhook
           on webhook.idempotency_key = observation.idempotency_key
        order by event.account_seq`,
    );
    expect(rows.map((row) => [row.account_seq, row.event_type])).toEqual([
      [1, "subscriptions.new"],
      [2, "messages.received"],
    ]);
    const pageId = rows[0]!.page_id;

    // Compatibility callers that omit sourceCursor retain the conservative
    // all-history barrier. The completed subscription is intentionally one of
    // the legacy behavioral classes that would otherwise pin every recovery.
    const unbounded = await server.inject({
      method: "GET",
      url: "/api/v1/events/v2/snapshot",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    const unboundedCursor = decodeDomainEventCursor(unbounded.json().cursor);
    expect(unboundedCursor.ok).toBe(true);
    if (!unboundedCursor.ok) {
      throw new Error(unboundedCursor.reason);
    }
    expect(unboundedCursor.watermarks.get(pageId)).toBe(0);

    const sourceCursor = encodeDomainEventCursor(new Map([[pageId, 1]]), {
      scope: "granted",
    });
    const malformed = await server.inject({
      method: "GET",
      url: "/api/v1/events/v2/snapshot?sourceCursor=garbage",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(malformed.statusCode, malformed.body).toBe(400);

    for (const untrustedSource of [
      // A subset cursor that omits this account does not prove any applied
      // history. Only an exact-grant cursor may classify an absent account as
      // newly granted and intentionally baseline it at the current head.
      encodeDomainEventCursor(new Map()),
      // A corrupt/rolled-back ahead cursor was rejected by the stream and is
      // likewise not evidence that the intervening blockers were applied.
      encodeDomainEventCursor(new Map([[pageId, 999_999]])),
    ]) {
      const conservative = await server.inject({
        method: "GET",
        url: `/api/v1/events/v2/snapshot?sourceCursor=${encodeURIComponent(untrustedSource)}`,
        headers: { authorization: `Bearer ${chatterKey}` },
      });
      expect(conservative.statusCode, conservative.body).toBe(200);
      const conservativeCursor = decodeDomainEventCursor(conservative.json().cursor);
      expect(conservativeCursor.ok).toBe(true);
      if (!conservativeCursor.ok) {
        throw new Error(conservativeCursor.reason);
      }
      expect(conservativeCursor.watermarks.get(pageId)).toBe(0);
    }

    const bounded = await server.inject({
      method: "GET",
      url: `/api/v1/events/v2/snapshot?sourceCursor=${encodeURIComponent(sourceCursor)}`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(bounded.statusCode, bounded.body).toBe(200);
    const boundedCursor = decodeDomainEventCursor(bounded.json().cursor);
    expect(boundedCursor.ok).toBe(true);
    if (!boundedCursor.ok) {
      throw new Error(boundedCursor.reason);
    }
    // Seq 1 was already applied by the caller and no longer pins recovery;
    // seq 2 is still absent from durable state and therefore remains exactly
    // the bounded replay tail.
    expect(boundedCursor.watermarks.get(pageId)).toBe(1);
    expect(await listEventsSince(appContext.db, {
      accountId: pageId,
      afterSeq: boundedCursor.watermarks.get(pageId)!,
    })).toEqual([
      expect.objectContaining({ accountSeq: 2, type: "message.received" }),
    ]);

    // Crash-before-persist retry: the same rejected source and unchanged
    // server state reproduce the same target cursor. Reapplying the state
    // snapshot is idempotent and cannot widen the replay interval.
    const retried = await server.inject({
      method: "GET",
      url: `/api/v1/events/v2/snapshot?sourceCursor=${encodeURIComponent(sourceCursor)}`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json().cursor).toBe(bounded.json().cursor);

    await processOfapiWebhookEvent(appContext, pendingMessageId);
    const completed = await server.inject({
      method: "GET",
      url: `/api/v1/events/v2/snapshot?sourceCursor=${encodeURIComponent(sourceCursor)}`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    const completedCursor = decodeDomainEventCursor(completed.json().cursor);
    expect(completedCursor.ok).toBe(true);
    if (!completedCursor.ok) {
      throw new Error(completedCursor.reason);
    }
    expect(completedCursor.watermarks.get(pageId)).toBe(2);
  });

  it("keeps presence and non-OFAPI events at the v2 head while subscription/account barriers remain grant-scoped", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const { rows: pages } = await testDb.pool.query<{
      id: number;
      ofapi_account_id: string;
    }>(
      `select id::int, ofapi_account_id
         from pages
        where ofapi_account_id in ($1, $2)
        order by ofapi_account_id`,
      [ACCOUNT_ONE, ACCOUNT_TWO],
    );
    const pageOneId = pages.find((page) => page.ofapi_account_id === ACCOUNT_ONE)!.id;
    const pageTwoId = pages.find((page) => page.ofapi_account_id === ACCOUNT_TWO)!.id;

    const pullObservation = await insertObservation(appContext.db, {
      source: "pull",
      producer: "ofapi:pull-test",
      platform: "onlyfans",
      accountId: pageOneId,
      nativeAccountRef: ACCOUNT_ONE,
      kind: "messages.received",
      payload: {},
      payloadHash: Buffer.alloc(32, 3),
      idempotencyKey: "snapshot_non_webhook_observation",
    });
    await appendDomainEvents(appContext.db, pageOneId, [{
      type: "message.received",
      occurredAt: new Date(),
      data: { source: "pull" },
      schemaVersion: 1,
      observationId: pullObservation.observationId,
      dedupKey: "snapshot:non-webhook",
    }]);

    const presence = await loadFixture("users_online.json");
    presence.account_id = ACCOUNT_ONE;
    await deliver(presence);
    const canonicalizedPresence = await runCanonicalization(appContext, {
      kinds: ["users.online"],
    });
    expect(canonicalizedPresence).toMatchObject({ appended: 1, errored: 0 });

    const uncovered = await server.inject({
      method: "GET",
      url: "/api/v1/events/v2/snapshot",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(uncovered.statusCode, uncovered.body).toBe(200);
    expect(uncovered.json().accounts).toEqual([{
      accountId: pageOneId,
      accountRef: ACCOUNT_ONE,
      currentSeq: 2,
    }]);
    const uncoveredCursor = decodeDomainEventCursor(uncovered.json().cursor);
    expect(uncoveredCursor.ok).toBe(true);
    if (!uncoveredCursor.ok) {
      throw new Error(uncoveredCursor.reason);
    }
    expect(uncoveredCursor.watermarks.get(pageOneId)).toBe(2);

    const subscription = await loadFixture("subscriptions_new.json");
    subscription.account_id = ACCOUNT_ONE;
    const subscriptionJournalId = await deliver(subscription);
    const canonicalizedSubscription = await runCanonicalization(appContext, {
      kinds: ["subscriptions.new"],
    });
    expect(canonicalizedSubscription).toMatchObject({ appended: 1, errored: 0 });

    const subscriptionBarrier = await server.inject({
      method: "GET",
      url: "/api/v1/events/v2/snapshot",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(subscriptionBarrier.statusCode, subscriptionBarrier.body).toBe(200);
    expect(subscriptionBarrier.json().accounts).toEqual([{
      accountId: pageOneId,
      accountRef: ACCOUNT_ONE,
      currentSeq: 3,
    }]);
    const subscriptionCursor = decodeDomainEventCursor(subscriptionBarrier.json().cursor);
    expect(subscriptionCursor.ok).toBe(true);
    if (!subscriptionCursor.ok) {
      throw new Error(subscriptionCursor.reason);
    }
    expect(subscriptionCursor.watermarks.get(pageOneId)).toBe(2);
    expect(await listEventsSince(appContext.db, {
      accountId: pageOneId,
      afterSeq: subscriptionCursor.watermarks.get(pageOneId)!,
    })).toEqual([
      expect.objectContaining({ accountSeq: 3, type: "subscription.started" }),
    ]);

    // Even a completed Core subscription projection cannot replace Desktop's
    // awaited chat-head refresh, so this behavioral barrier stays replayable.
    await processOfapiWebhookEvent(appContext, subscriptionJournalId);
    const completedSubscription = await server.inject({
      method: "GET",
      url: "/api/v1/events/v2/snapshot",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    const completedSubscriptionCursor = decodeDomainEventCursor(
      completedSubscription.json().cursor,
    );
    expect(completedSubscriptionCursor.ok).toBe(true);
    if (!completedSubscriptionCursor.ok) {
      throw new Error(completedSubscriptionCursor.reason);
    }
    expect(completedSubscriptionCursor.watermarks.get(pageOneId)).toBe(2);

    const renewed = await loadFixture("unverified_subscriptions_renewed.json");
    renewed.account_id = ACCOUNT_TWO;
    await deliver(renewed);
    const canonicalizedRenewed = await runCanonicalization(appContext, {
      kinds: ["subscriptions.renewed"],
    });
    expect(canonicalizedRenewed).toMatchObject({ appended: 1, errored: 0 });

    await createUserAccount(appContext, {
      username: "chatter-two",
      role: "chatter",
    }, { source: "cli" });
    const chatterTwoKey = (await issueChatterApiKey(appContext, {
      userId: await fixtureUserId(appContext, "chatter-two"),
      pageLabel: "lora-vip-of",
    }, { source: "cli" })).key;
    const renewalBarrier = await server.inject({
      method: "GET",
      url: "/api/v1/events/v2/snapshot",
      headers: { authorization: `Bearer ${chatterTwoKey}` },
    });
    expect(renewalBarrier.statusCode, renewalBarrier.body).toBe(200);
    expect(renewalBarrier.json().accounts).toEqual([{
      accountId: pageTwoId,
      accountRef: ACCOUNT_TWO,
      currentSeq: 1,
    }]);
    const renewalCursor = decodeDomainEventCursor(renewalBarrier.json().cursor);
    expect(renewalCursor.ok).toBe(true);
    if (!renewalCursor.ok) {
      throw new Error(renewalCursor.reason);
    }
    expect([...renewalCursor.watermarks.entries()]).toEqual([[pageTwoId, 0]]);
    expect(await listEventsSince(appContext.db, {
      accountId: pageTwoId,
      afterSeq: 0,
    })).toEqual([
      expect.objectContaining({ accountSeq: 1, type: "subscription.renewed" }),
    ]);

    // A covered account-auth event on the other account must also remain
    // grant-scoped and must not become visible to the first chatter.
    await deliver({
      event: "accounts.authentication_failed",
      account_id: ACCOUNT_TWO,
      payload: {},
    });
    const canonicalizedAccount = await runCanonicalization(appContext, {
      kinds: ["accounts.authentication_failed"],
    });
    expect(canonicalizedAccount).toMatchObject({ appended: 1, errored: 0 });

    const stillScoped = await server.inject({
      method: "GET",
      url: "/api/v1/events/v2/snapshot",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(stillScoped.statusCode, stillScoped.body).toBe(200);
    expect(stillScoped.json().accounts).toEqual([{
      accountId: pageOneId,
      accountRef: ACCOUNT_ONE,
      currentSeq: 3,
    }]);
    const stillScopedCursor = decodeDomainEventCursor(stillScoped.json().cursor);
    expect(stillScopedCursor.ok).toBe(true);
    if (!stillScopedCursor.ok) {
      throw new Error(stillScopedCursor.reason);
    }
    expect([...stillScopedCursor.watermarks.entries()]).toEqual([[pageOneId, 2]]);

    const accountBarrier = await server.inject({
      method: "GET",
      url: "/api/v1/events/v2/snapshot",
      headers: { authorization: `Bearer ${chatterTwoKey}` },
    });
    expect(accountBarrier.statusCode, accountBarrier.body).toBe(200);
    expect(accountBarrier.json().accounts).toEqual([{
      accountId: pageTwoId,
      accountRef: ACCOUNT_TWO,
      currentSeq: 2,
    }]);
    const accountCursor = decodeDomainEventCursor(accountBarrier.json().cursor);
    expect(accountCursor.ok).toBe(true);
    if (!accountCursor.ok) {
      throw new Error(accountCursor.reason);
    }
    expect([...accountCursor.watermarks.entries()]).toEqual([[pageTwoId, 0]]);
  });

  it("keeps post-settle projection gaps replayable across every snapshot-covered event family", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const replayRequiredEnvelopes = [
      await loadReceivedFixture(),
      await loadFixture("messages_sent.json"),
      await loadFixture("messages_deleted.json"),
      await loadFixture("messages_ppv_unlocked.json"),
      await loadFixture("tips_received.json"),
      await loadFixture("subscriptions_new.json"),
      await loadFixture("unverified_subscriptions_renewed.json"),
      {
        event: "accounts.authentication_failed",
        account_id: ACCOUNT_ONE,
        payload: {},
      },
    ];

    for (const [index, envelope] of replayRequiredEnvelopes.entries()) {
      envelope.account_id = ACCOUNT_ONE;
      const settled = await settleWithoutPostSettleProjection(envelope);
      const afterSeq = settled.fanoutSeq - 1;
      const response = await server.inject({
        method: "GET",
        url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=${afterSeq}`,
        headers: { authorization: `Bearer ${chatterKey}` },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        requestedAfterSeq: afterSeq,
        snapshotCursor: afterSeq,
        resumeAllowed: true,
      });

      const replay = await listOfapiSyncEventsForReplay(appContext.db, {
        afterSeq: response.json().snapshotCursor,
        pageIds: [settled.pageId],
        limit: 10,
      });
      expect(replay.map((row) => row.id)).toContain(settled.fanoutSeq);

      if (
        envelope.event === "messages.ppv.unlocked"
        || envelope.event === "tips.received"
      ) {
        // These annotations update the hot row, while snapshot serialization
        // deliberately lets an archive twin win. No journal marker proves the
        // archive row carries the annotation, so even a successful projection
        // must remain in the SSE tail.
        await testDb.pool.query(
          `update ofapi_webhook_events
             set projection_status = 'projected', archive_status = 'archived'
           where id = $1`,
          [settled.id],
        );
        const projectedAnnotation = await server.inject({
          method: "GET",
          url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=${afterSeq}`,
          headers: { authorization: `Bearer ${chatterKey}` },
        });
        expect(projectedAnnotation.statusCode, projectedAnnotation.body).toBe(200);
        expect(projectedAnnotation.json().snapshotCursor).toBe(afterSeq);
      }

      if (
        envelope.event === "subscriptions.new"
        || envelope.event === "subscriptions.renewed"
      ) {
        // A terminal Core audience projection still does not perform the
        // Desktop chat-head refresh represented by this notification.
        await testDb.pool.query(
          `update ofapi_webhook_events
             set projection_status = 'projected'
           where id = $1`,
          [settled.id],
        );
        const projectedSubscription = await server.inject({
          method: "GET",
          url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=${afterSeq}`,
          headers: { authorization: `Bearer ${chatterKey}` },
        });
        expect(projectedSubscription.statusCode, projectedSubscription.body).toBe(200);
        expect(projectedSubscription.json().snapshotCursor).toBe(afterSeq);
      }

      if (index === 0) {
        // The caller cannot override the barrier with the raw sequence high-water.
        const unsafe = await server.inject({
          method: "GET",
          url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=${afterSeq}`
            + `&snapshotCursor=${settled.fanoutSeq}`,
          headers: { authorization: `Bearer ${chatterKey}` },
        });
        expect(unsafe.statusCode, unsafe.body).toBe(400);

        await testDb.pool.query(
          `update ofapi_webhook_events
             set projection_status = 'failed', archive_status = 'failed'
           where id = $1`,
          [settled.id],
        );
        const failed = await server.inject({
          method: "GET",
          url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=${afterSeq}`,
          headers: { authorization: `Bearer ${chatterKey}` },
        });
        expect(failed.statusCode, failed.body).toBe(200);
        expect(failed.json().snapshotCursor).toBe(afterSeq);

        // A skipped create has no guaranteed thread/hot material. It remains
        // replay-required instead of being mistaken for a completed snapshot.
        await testDb.pool.query(
          `update ofapi_webhook_events
             set projection_status = 'skipped', archive_status = 'skipped'
           where id = $1`,
          [settled.id],
        );
        const skipped = await server.inject({
          method: "GET",
          url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=${afterSeq}`,
          headers: { authorization: `Bearer ${chatterKey}` },
        });
        expect(skipped.statusCode, skipped.body).toBe(200);
        expect(skipped.json().snapshotCursor).toBe(afterSeq);
      }
    }

    // Ephemeral presence remains outside durable snapshot coverage and does
    // not pin the cursor forever.
    for (const fixture of ["users_online.json"]) {
      const envelope = await loadFixture(fixture);
      envelope.account_id = ACCOUNT_ONE;
      const settled = await settleWithoutPostSettleProjection(envelope);
      const afterSeq = settled.fanoutSeq - 1;
      const response = await server.inject({
        method: "GET",
        url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=${afterSeq}`,
        headers: { authorization: `Bearer ${chatterKey}` },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().snapshotCursor).toBe(settled.fanoutSeq);
    }

    // A real create whose hot projection and cold archive both completed can
    // safely advance the snapshot cursor through its fanout sequence.
    const completed = await loadReceivedFixture();
    completed.payload.id = 9_900_001;
    completed.payload.createdAt = "2026-06-10T22:00:00.000Z";
    completed.payload.changedAt = completed.payload.createdAt;
    const completedId = await deliverAndProcess(completed);
    const { rows: completedRows } = await testDb.pool.query<{ fanout_seq: number }>(
      "select fanout_seq::int from ofapi_webhook_events where id = $1",
      [completedId],
    );
    const completedSeq = completedRows[0]!.fanout_seq;
    const completedResponse = await server.inject({
      method: "GET",
      url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=${completedSeq - 1}`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(completedResponse.statusCode, completedResponse.body).toBe(200);
    expect(completedResponse.json().snapshotCursor).toBe(completedSeq);
  });

  it("does not expose fanout sequence values from an uncommitted settle", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const envelope = await loadReceivedFixture();
    const eventId = await deliver(envelope);
    const mapped = mapOfapiEventToSyncEvent(envelope);
    expect(mapped).not.toBeNull();
    const { rows: pages } = await testDb.pool.query<{ id: number }>(
      "select id::int from pages where ofapi_account_id = $1",
      [ACCOUNT_ONE],
    );
    const { rows: highWaterRows } = await testDb.pool.query<{ fanout_seq: number }>(
      "select coalesce(max(fanout_seq), 0)::int as fanout_seq from ofapi_webhook_events",
    );
    const previousCommittedSeq = highWaterRows[0]!.fanout_seq;
    const client = await testDb.pool.connect();
    try {
      await client.query("begin");
      const { rows } = await client.query<{ fanout_seq: number }>(
        `update ofapi_webhook_events
            set status = 'processed',
                platform_account_id = $2,
                sync_event = $3::jsonb,
                fanout_seq = nextval('ofapi_webhook_events_fanout_seq'),
                processed_at = now()
          where id = $1 and status = 'pending'
          returning fanout_seq::int`,
        [eventId, pages[0]!.id, JSON.stringify(mapped)],
      );
      const uncommittedSeq = rows[0]!.fanout_seq;
      expect(uncommittedSeq).toBeGreaterThan(previousCommittedSeq);

      // PostgreSQL sequences are non-transactional: last_value already exposes
      // this number, but the journal row and its state are still invisible.
      const response = await server.inject({
        method: "GET",
        url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=${previousCommittedSeq}`,
        headers: { authorization: `Bearer ${chatterKey}` },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().snapshotCursor).toBe(previousCommittedSeq);

      await client.query("commit");

      const replay = await listOfapiSyncEventsForReplay(appContext.db, {
        afterSeq: previousCommittedSeq,
        pageIds: [pages[0]!.id],
        limit: 10,
      });
      expect(replay.map((row) => row.id)).toContain(uncommittedSeq);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("advances a signed bounded continuation when its current thread was erased", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const first = await loadReceivedFixture();
    first.payload.id = 9_920_001;
    first.payload.fromUser.id = 9_921_001;
    first.payload.fromUser.username = "snapshot_erased_thread";
    first.payload.createdAt = "2026-06-10T22:10:00.000Z";
    first.payload.changedAt = first.payload.createdAt;
    await deliverAndProcess(first);

    const second = await loadReceivedFixture();
    second.payload.id = 9_920_002;
    second.payload.fromUser.id = 9_921_002;
    second.payload.fromUser.username = "snapshot_surviving_thread";
    second.payload.createdAt = "2026-06-10T22:11:00.000Z";
    second.payload.changedAt = second.payload.createdAt;
    await deliverAndProcess(second);

    const query = new URLSearchParams({
      accountId: ACCOUNT_ONE,
      afterSeq: "0",
      pageCursor: "0",
      limit: "1",
      pageMode: "bounded_v1",
      messageLimit: "1",
    });
    const firstPage = await server.inject({
      method: "GET",
      url: `/api/v1/events/snapshot?${query.toString()}`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(firstPage.statusCode, firstPage.body).toBe(200);
    const firstBody = firstPage.json();
    expect(firstBody.threads).toHaveLength(1);
    expect(firstBody.nextStateCursor).toEqual(expect.any(String));
    const erasedChatId = firstBody.threads[0].chatId as string;

    const erased = await testDb.pool.query<{ id: number }>(
      `delete from page_dm_threads
        where platform_account_id = (
          select id from pages where ofapi_account_id = $1
        )
          and platform_conversation_id = $2
      returning id::int`,
      [ACCOUNT_ONE, erasedChatId],
    );
    expect(erased.rows).toHaveLength(1);

    // A caller cannot turn the tolerant missing-thread branch into arbitrary
    // keyset seeking: mutating the signed phase still fails integrity checks.
    const signedEnvelope = JSON.parse(
      Buffer.from(firstBody.nextStateCursor, "base64url").toString("utf8"),
    );
    signedEnvelope.payload.phase.threadId += 10_000;
    const tamperedCursor = Buffer.from(
      JSON.stringify(signedEnvelope),
      "utf8",
    ).toString("base64url");
    const tamperedQuery = new URLSearchParams(query);
    tamperedQuery.set("snapshotCursor", String(firstBody.snapshotCursor));
    tamperedQuery.set("stateCursor", tamperedCursor);
    const tampered = await server.inject({
      method: "GET",
      url: `/api/v1/events/snapshot?${tamperedQuery.toString()}`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(tampered.statusCode, tampered.body).toBe(400);

    const seenAfterErasure = new Set<string>();
    let stateCursor: string | null = firstBody.nextStateCursor;
    let continuationPages = 0;
    while (stateCursor !== null) {
      const continuationQuery = new URLSearchParams(query);
      continuationQuery.set("snapshotCursor", String(firstBody.snapshotCursor));
      continuationQuery.set("stateCursor", stateCursor);
      const continuation = await server.inject({
        method: "GET",
        url: `/api/v1/events/snapshot?${continuationQuery.toString()}`,
        headers: { authorization: `Bearer ${chatterKey}` },
      });
      expect(continuation.statusCode, continuation.body).toBe(200);
      const body = continuation.json();
      for (const thread of body.threads as Array<{
        messages: Array<{ messageId: string }>;
      }>) {
        for (const message of thread.messages) {
          seenAfterErasure.add(message.messageId);
        }
      }
      stateCursor = body.nextStateCursor;
      continuationPages += 1;
      expect(continuationPages).toBeLessThan(10);
    }

    expect(seenAfterErasure).toContain("9920002");
    expect(seenAfterErasure).not.toContain("9920001");
  });

  it("bounds resumable state pages without truncating messages or unresolved tombstones", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const expectedMessageIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const message = await loadReceivedFixture();
      const messageId = String(1_000_006 + index);
      message.payload.id = Number(messageId);
      message.payload.createdAt = `2026-06-10T18:35:3${index}+00:00`;
      message.payload.changedAt = message.payload.createdAt;
      expectedMessageIds.push(messageId);
      await deliverAndProcess(message);
    }
    const hotOnlyMessageId = "1000099";
    const hotThread = await testDb.pool.query<{
      id: number;
      platform_account_id: number;
    }>(
      "select id::int, platform_account_id::int from page_dm_threads where platform_conversation_id = '1000005'",
    );
    await testDb.pool.query(
      `insert into page_dm_messages
         (conversation_id, platform_account_id, platform_message_id, sender_role, created_at, content)
       values ($1, $2, $3, 'fan', '2026-06-10T18:36:00Z', 'hot-only snapshot row')`,
      [hotThread.rows[0]!.id, hotThread.rows[0]!.platform_account_id, hotOnlyMessageId],
    );
    expectedMessageIds.push(hotOnlyMessageId);

    const expectedTombstoneIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const tombstone = await loadFixture("messages_deleted.json");
      const messageId = String(9_000_001 + index);
      (tombstone.payload as Record<string, unknown>).id = messageId;
      expectedTombstoneIds.push(messageId);
      await deliverAndProcess(tombstone);
    }

    // Compatibility contract: callers that do not opt into bounded paging
    // retain the original response shape and receive the complete thread page.
    const legacy = await server.inject({
      method: "GET",
      url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=0&limit=1`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(legacy.statusCode, legacy.body).toBe(200);
    expect(legacy.json().threads[0].messages).toHaveLength(expectedMessageIds.length);
    expect(legacy.json().unresolvedTombstones).toHaveLength(expectedTombstoneIds.length);
    expect(legacy.json()).not.toHaveProperty("nextStateCursor");

    const seenMessageIds = new Set<string>();
    const seenTombstoneIds = new Set<string>();
    let stateCursor: string | null | undefined;
    let snapshotCursor: number | undefined;
    let stateAt: string | undefined;
    let pageCount = 0;
    do {
      const query = new URLSearchParams({
        accountId: ACCOUNT_ONE,
        afterSeq: "0",
        pageCursor: "0",
        limit: "1",
        pageMode: "bounded_v1",
        messageLimit: "2",
      });
      if (snapshotCursor !== undefined) {
        query.set("snapshotCursor", String(snapshotCursor));
      }
      if (stateCursor) {
        query.set("stateCursor", stateCursor);
      }

      const response = await server.inject({
        method: "GET",
        url: `/api/v1/events/snapshot?${query.toString()}`,
        headers: { authorization: `Bearer ${chatterKey}` },
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      const durableRows = body.unresolvedTombstones.length
        + body.threads.reduce(
          (count: number, thread: { messages: unknown[] }) => count + thread.messages.length,
          0,
        );
      expect(durableRows).toBeLessThanOrEqual(2);
      expect(body).toHaveProperty("nextStateCursor");
      snapshotCursor ??= body.snapshotCursor;
      stateAt ??= body.stateAt;
      expect(body.snapshotCursor).toBe(snapshotCursor);
      expect(body.stateAt).toBe(stateAt);

      for (const thread of body.threads as Array<{ messages: Array<{ messageId: string }> }>) {
        for (const message of thread.messages) {
          expect(seenMessageIds.has(message.messageId)).toBe(false);
          seenMessageIds.add(message.messageId);
        }
      }
      for (const tombstone of body.unresolvedTombstones as Array<{ messageId: string }>) {
        expect(seenTombstoneIds.has(tombstone.messageId)).toBe(false);
        seenTombstoneIds.add(tombstone.messageId);
      }

      stateCursor = body.nextStateCursor;
      pageCount += 1;
      expect(pageCount).toBeLessThan(20);
    } while (stateCursor !== null);

    expect([...seenMessageIds].sort()).toEqual(expectedMessageIds.sort());
    expect([...seenTombstoneIds].sort()).toEqual(expectedTombstoneIds.sort());

    // The opaque state cursor is bound to the initial recovery scope.
    const firstPage = await server.inject({
      method: "GET",
      url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=0`
        + "&pageCursor=0&limit=1&pageMode=bounded_v1&messageLimit=1",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(firstPage.statusCode, firstPage.body).toBe(200);
    const firstBody = firstPage.json();
    expect(firstBody.nextStateCursor).toEqual(expect.any(String));
    const mismatched = await server.inject({
      method: "GET",
      url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=1`
        + `&snapshotCursor=${firstBody.snapshotCursor}`
        + "&pageCursor=0&limit=1&pageMode=bounded_v1&messageLimit=1"
        + `&stateCursor=${encodeURIComponent(firstBody.nextStateCursor)}`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(mismatched.statusCode, mismatched.body).toBe(400);
    const malformed = await server.inject({
      method: "GET",
      url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=0`
        + `&snapshotCursor=${firstBody.snapshotCursor}`
        + "&pageCursor=0&limit=1&pageMode=bounded_v1&messageLimit=1"
        + "&stateCursor=AAAA",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(malformed.statusCode, malformed.body).toBe(400);
  });

  it("pins a finite bounded walk while later hot rows remain replayable", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await deliverAndProcess(await loadReceivedFixture());
    const first = await server.inject({
      method: "GET",
      url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=0`
        + "&pageCursor=0&limit=1&pageMode=bounded_v1&messageLimit=1",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(first.statusCode, first.body).toBe(200);
    const firstBody = first.json();
    expect(firstBody.nextStateCursor).toEqual(expect.any(String));

    const { rows: threads } = await testDb.pool.query<{
      id: number;
      platform_account_id: number;
      platform_conversation_id: string;
    }>(
      `select id::int, platform_account_id::int, platform_conversation_id
         from page_dm_threads
        where platform_account_id = (
          select id from pages where ofapi_account_id = $1
        )`,
      [ACCOUNT_ONE],
    );
    expect(threads).toHaveLength(1);
    const thread = threads[0]!;

    const lateMessageIds: string[] = [];
    const boundedMessageIds = new Set<string>();
    let stateCursor: string | null = firstBody.nextStateCursor;
    let continuationCount = 0;
    while (stateCursor !== null) {
      // Keep adding two rows ahead of a one-row keyset page. Without signed
      // row high-waters the producer outruns the walk forever; with them these
      // post-capture rows are excluded and the continuation terminates.
      for (let offset = 0; offset < 2; offset += 1) {
        const messageId = `bounded-late-${continuationCount}-${offset}`;
        lateMessageIds.push(messageId);
        await testDb.pool.query(
          `insert into page_dm_messages
             (conversation_id, platform_account_id, platform_message_id,
              sender_role, created_at, content)
           values ($1, $2, $3, 'fan', $4, 'late hot-only row')`,
          [
            thread.id,
            thread.platform_account_id,
            messageId,
            new Date(Date.UTC(2026, 6, 13, 12, 0, continuationCount * 2 + offset)),
          ],
        );
        const journal = await insertOfapiWebhookEvent(appContext.db, {
          idempotencyKey: `bounded_late_${continuationCount}_${offset}`,
          eventType: "messages.received",
          ofapiAccountId: ACCOUNT_ONE,
          payload: { event: "messages.received", id: messageId },
        });
        expect(journal).not.toBeNull();
        expect(await settleOfapiWebhookEvent(appContext.db, {
          id: journal!.id,
          status: "processed",
          platformAccountId: thread.platform_account_id,
          syncEvent: {
            type: "messageReceived",
            accountId: ACCOUNT_ONE,
            chatId: thread.platform_conversation_id,
            messageId,
          },
          processedAt: new Date(),
        })).toBe(true);
      }

      const query = new URLSearchParams({
        accountId: ACCOUNT_ONE,
        afterSeq: "0",
        snapshotCursor: String(firstBody.snapshotCursor),
        pageCursor: "0",
        limit: "1",
        pageMode: "bounded_v1",
        messageLimit: "1",
        stateCursor,
      });
      const continuation = await server.inject({
        method: "GET",
        url: `/api/v1/events/snapshot?${query.toString()}`,
        headers: { authorization: `Bearer ${chatterKey}` },
      });
      expect(continuation.statusCode, continuation.body).toBe(200);
      const body = continuation.json();
      for (const snapshotThread of body.threads as Array<{
        messages: Array<{ messageId: string }>;
      }>) {
        for (const message of snapshotThread.messages) {
          boundedMessageIds.add(message.messageId);
        }
      }
      stateCursor = body.nextStateCursor;
      continuationCount += 1;
      expect(continuationCount).toBeLessThan(6);
    }

    expect(continuationCount).toBe(1);
    expect(lateMessageIds.every((messageId) => !boundedMessageIds.has(messageId))).toBe(true);

    const replay = await listOfapiSyncEventsForReplay(appContext.db, {
      afterSeq: firstBody.snapshotCursor,
      pageIds: [thread.platform_account_id],
      limit: 100,
    });
    expect(replay.map((row) => row.syncEvent.messageId)).toEqual(lateMessageIds);
  });

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
