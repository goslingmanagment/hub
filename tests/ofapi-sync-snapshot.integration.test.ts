import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  decodeDomainEventCursor,
} from "@agency_hub_core/contracts";
import {
  createModel,
  createOnlyFansPage,
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
} from "../apps/runtime/src/services/auth.ts";
import { issueChatterDeviceToken } from "./helpers/device-credentials.ts";
import {
  mapOfapiEventToSyncEvent,
  processOfapiWebhookEvent,
} from "../apps/runtime/src/services/ofapi-events.ts";
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
    username: "chatter",
    role: "chatter",
  }, { source: "cli" });
  chatterKey = (await issueChatterDeviceToken(appContext, {
    username: "chatter",
    pageLabel: "lora-of",
  }, { source: "cli" })).key;

  await server?.close();
  server = await buildApiServer(appContext);
  await server.ready();
});

describe("OFAPI sync snapshot", () => {
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
});
