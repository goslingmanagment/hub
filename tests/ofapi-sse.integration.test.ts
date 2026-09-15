import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  deleteExpiredOfapiWebhookEvents,
  getOfapiFanoutReplayWindow,
  getOfapiSyncReplayFloor,
  insertOfapiWebhookEvent,
  listOfapiSyncEventsForReplay,
  setPageOfapiAccountId,
  settleOfapiWebhookEvent,
  upsertOfapiWebhookConfig,
} from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";
import { PgBoss } from "pg-boss";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { issueChatterDeviceToken } from "./helpers/device-credentials.ts";
import {
  ensureOfapiQueues,
  startOfapiEventWorker,
} from "../apps/runtime/src/services/ofapi-events.ts";
import { OFAPI_WEBHOOK_EVENTS } from "../apps/runtime/src/services/ofapi-webhooks.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

const FIXTURES_DIR = path.resolve("tests/fixtures/ofapi-webhooks");
const SIGNING_SECRET = "sse-test-signing-secret";
const ENCRYPTION_KEY = Buffer.alloc(32, 7);
// Live in the fixtures: acct_01… is loravie's page, acct_02… is loravievip's.
const ACCOUNT_ONE = "acct_01000000000000000000000000000000";
const ACCOUNT_TWO = "acct_02000000000000000000000000000000";

const E2E_TIMEOUT_MS = 120_000;

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let workerBoss: PgBoss | null = null;
let releaseWorkerLock: (() => Promise<void>) | null = null;
let baseUrl = "";
let chatterKey = "";

interface SseFrame {
  id: number | null;
  event: string | null;
  data: Record<string, unknown>;
}

/** Minimal streaming SSE reader over fetch (Node 22 web streams). */
class SseClient {
  readonly frames: SseFrame[] = [];
  private buffer = "";
  private readonly abort = new AbortController();
  private readPromise: Promise<void> | null = null;
  response: Response | null = null;

  async connect(input: { lastEventId?: number; authorization?: string }) {
    const headers: Record<string, string> = {
      accept: "text/event-stream",
      authorization: input.authorization ?? `Bearer ${chatterKey}`,
    };
    if (input.lastEventId !== undefined) {
      headers["last-event-id"] = String(input.lastEventId);
    }

    this.response = await fetch(`${baseUrl}/api/v1/events/stream`, {
      headers,
      signal: this.abort.signal,
    });
    if (this.response.status === 200 && this.response.body) {
      const reader = this.response.body.getReader();
      const decoder = new TextDecoder();
      this.readPromise = (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              return;
            }
            this.buffer += decoder.decode(value, { stream: true });
            this.drainBuffer();
          }
        } catch {
          // Aborted or server closed; frames already drained.
        }
      })();
    }
    return this.response;
  }

  private drainBuffer() {
    for (;;) {
      const boundary = this.buffer.indexOf("\n\n");
      if (boundary === -1) {
        return;
      }
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);

      let id: number | null = null;
      let event: string | null = null;
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) {
          id = Number(line.slice(4));
        } else if (line.startsWith("event: ")) {
          event = line.slice(7);
        } else if (line.startsWith("data: ")) {
          dataLines.push(line.slice(6));
        }
      }
      // Comments (heartbeats) and the retry directive produce no data lines.
      if (dataLines.length > 0) {
        this.frames.push({
          id,
          event,
          data: JSON.parse(dataLines.join("\n")) as Record<string, unknown>,
        });
      }
    }
  }

  async waitForFrames(count: number, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (this.frames.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${count} SSE frames; got ${this.frames.length}: ${JSON.stringify(this.frames)}`);
      }
      await sleep(50);
    }
    return this.frames;
  }

  async close() {
    this.abort.abort();
    await this.readPromise?.catch(() => undefined);
  }
}

async function fixtureBody(name: string) {
  const raw = JSON.parse(await readFile(path.join(FIXTURES_DIR, name), "utf8")) as Record<string, unknown>;
  delete raw._meta;
  return JSON.stringify(raw);
}

let idempotencyCounter = 0;

async function deliverWebhook(body: string, options?: { idempotencyKey?: string }) {
  idempotencyCounter += 1;
  const idempotencyKey = options?.idempotencyKey
    ?? `evt_${String(idempotencyCounter).padStart(40, "0")}`;
  const response = await fetch(`${baseUrl}/api/v1/ofapi/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "OnlyFansAPI.com/Webhook-Client",
      signature: createHmac("sha256", SIGNING_SECRET).update(body).digest("hex"),
      "x-ofapi-idempotency-key": idempotencyKey,
    },
    body,
  });
  return { response, idempotencyKey, ack: await response.json() as Record<string, unknown> };
}

async function waitForSettledEvents(count: number, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await testDb!.pool.query<{ settled: string }>(
      "select count(*) as settled from ofapi_webhook_events where status <> 'pending'",
    );
    if (Number(rows[0]?.settled ?? 0) >= count) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${count} settled OFAPI events`);
    }
    await sleep(100);
  }
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await workerBoss?.stop();
  workerBoss = null;
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
  appContext = createTestAppContext(testDb, { databaseUrl: testDb.connectionString });

  // Pages mapped to the two captured OFAPI accounts; the chatter only sees the first.
  const model = await createModel(appContext.db, { slug: "lora", name: "Lora" });
  const pageOne = await createOnlyFansPage(appContext.db, { modelId: model.id, label: "lora-of" });
  await setPageOfapiAccountId(appContext.db, { pageId: pageOne.id, ofapiAccountId: ACCOUNT_ONE });
  const pageTwo = await createOnlyFansPage(appContext.db, { modelId: model.id, label: "lora-vip-of" });
  await setPageOfapiAccountId(appContext.db, { pageId: pageTwo.id, ofapiAccountId: ACCOUNT_TWO });

  await upsertOfapiWebhookConfig(appContext.db, {
    externalWebhookId: "wh_e2e",
    endpointUrl: "https://hub.example.com/api/v1/ofapi/webhook",
    accountScope: "global",
    events: [...OFAPI_WEBHOOK_EVENTS],
    encryptedSigningSecret: JSON.stringify(encryptJson(SIGNING_SECRET, ENCRYPTION_KEY, 1)),
  });

  await createUserAccount(appContext, {
    username: "dima",
    role: "owner",
    password: "owner-secret",
  }, { source: "cli" });
  await createUserAccount(appContext, { username: "anton", role: "chatter" }, { source: "cli" });
  const issued = await issueChatterDeviceToken(appContext, {
    username: "anton",
    pageLabel: "lora-of",
  }, { source: "cli" });
  chatterKey = issued.key;

  if (server) {
    await server.close();
  }
  server = await buildApiServer(appContext);
  await server.listen({ port: 0, host: "127.0.0.1" });
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP listen address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;

  if (workerBoss) {
    await workerBoss.stop();
  }
  // The real async-processing path: a pg-boss worker on the same database, exactly
  // as registered by startWorkerServices in the worker role.
  workerBoss = new PgBoss({ connectionString: testDb.connectionString });
  await workerBoss.start();
  await ensureOfapiQueues(workerBoss);
  releaseWorkerLock = await startOfapiEventWorker(appContext, workerBoss);
}, 60_000);

afterEach(async () => {
  if (releaseWorkerLock) {
    await releaseWorkerLock();
    releaseWorkerLock = null;
  }
  if (workerBoss) {
    await workerBoss.stop();
    workerBoss = null;
  }
  if (server) {
    await server.close();
    server = null;
  }
});

describe("OFAPI webhook → SSE end-to-end", () => {
  it("delivers captured webhook fixtures as page-filtered SSE frames with dedupe and Last-Event-ID resume", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const client = new SseClient();
    try {
      const response = await client.connect({});
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      // 1. Live delivery: captured messages.received → messageReceived frame.
      const messageBody = await fixtureBody("messages_received.json");
      const first = await deliverWebhook(messageBody);
      expect(first.response.status).toBe(200);
      expect(first.ack).toEqual({ received: true, duplicate: false });

      await client.waitForFrames(1);
      const messageFrame = client.frames[0]!;
      expect(messageFrame.event).toBe("sync");
      expect(messageFrame.id).toBeGreaterThan(0);
      expect(messageFrame.data).toMatchObject({
        type: "messageReceived",
        accountId: ACCOUNT_ONE,
        chatId: "1000005",
        messageId: "1000006",
      });
      expect(messageFrame.data.message).toMatchObject({
        id: "1000006",
        isSentByMe: false,
        text: expect.any(String),
        createdAt: expect.any(String),
        price: 0,
      });

      // 2. Dedupe: redelivering the same idempotency key is acked but not re-fanned-out.
      const redelivery = await deliverWebhook(messageBody, { idempotencyKey: first.idempotencyKey });
      expect(redelivery.ack).toEqual({ received: true, duplicate: true });

      // 3. Page ACL: presence for acct_02 (not assigned to this chatter) must not
      // arrive; the typing event for acct_01 delivered afterwards proves the
      // pipeline kept flowing past it (single worker processes in order).
      await deliverWebhook(await fixtureBody("users_online.json"));
      await deliverWebhook(await fixtureBody("users_typing.json"));

      await client.waitForFrames(2);
      // Give the (deduped) redelivery and any stray fanout a moment to misbehave.
      await sleep(500);
      expect(client.frames).toHaveLength(2);
      const typingFrame = client.frames[1]!;
      expect(typingFrame.data).toEqual({
        type: "typing",
        accountId: ACCOUNT_ONE,
        chatId: "1000034",
      });
      expect(typingFrame.id).toBeGreaterThan(messageFrame.id!);
      expect(client.frames.some((frame) => frame.data.type === "presence")).toBe(false);

      // 4. Last-Event-ID resume: drop the connection, deliver while offline,
      // reconnect from the last seen id and receive the missed frames in order.
      // messages_sent was captured on acct_02 (loravievip) — it must be replayed
      // to nobody on this chatter's stream, proving the ACL filter on the
      // journal-replay path too.
      const lastSeenId = typingFrame.id!;
      await client.close();

      await deliverWebhook(await fixtureBody("messages_sent.json")); // acct_02, filtered
      await deliverWebhook(await fixtureBody("subscriptions_new.json"));
      await deliverWebhook(await fixtureBody("users_online.json")); // acct_02, filtered
      // Same payload, fresh idempotency key = a new delivery, not a duplicate.
      await deliverWebhook(messageBody);
      await waitForSettledEvents(7);

      const resumed = new SseClient();
      try {
        const resumeResponse = await resumed.connect({ lastEventId: lastSeenId });
        expect(resumeResponse.status).toBe(200);

        await resumed.waitForFrames(2);
        expect(resumed.frames[0]!.data).toEqual({
          type: "chatListUpdated",
          accountId: ACCOUNT_ONE,
        });
        expect(resumed.frames[1]!.data).toMatchObject({
          type: "messageReceived",
          accountId: ACCOUNT_ONE,
          chatId: "1000005",
          messageId: "1000006",
        });
        expect(resumed.frames[1]!.data.message).toMatchObject({
          id: "1000006",
          isSentByMe: false,
        });
        expect(resumed.frames[0]!.id).toBeGreaterThan(lastSeenId);
        expect(resumed.frames[1]!.id).toBeGreaterThan(resumed.frames[0]!.id!);
        expect(resumed.frames.some((frame) => frame.data.type === "messageSent")).toBe(false);

        // 5. The resumed stream keeps receiving live frames.
        await deliverWebhook(await fixtureBody("messages_deleted.json"));
        await resumed.waitForFrames(3);
        expect(resumed.frames[2]!.data).toEqual({
          type: "messageDeleted",
          accountId: ACCOUNT_ONE,
          messageId: "1000001",
        });

        await sleep(300);
        expect(resumed.frames).toHaveLength(3);

        // Audit B3/P-6: ids on each connection are strictly increasing — no
        // duplicate or out-of-order frame ever reaches the wire, so the strict
        // `> Last-Event-ID` resume can never skip frames.
        for (const frames of [client.frames, resumed.frames]) {
          for (let i = 1; i < frames.length; i += 1) {
            expect(frames[i]!.id!).toBeGreaterThan(frames[i - 1]!.id!);
          }
        }
      } finally {
        await resumed.close();
      }
    } finally {
      await client.close();
    }
  }, E2E_TIMEOUT_MS);

  it("paginates the replay past rows orphaned by page deletion (audit P-7)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // Six processed frames; the third orphaned (null platform_account_id — the
    // shape page deletion leaves behind). The orphan must be excluded in SQL:
    // a post-fetch filter would shrink a full LIMIT batch, the pagination loop
    // would read it as "no more rows" and every later frame in the gap is lost.
    const model = await createModel(appContext.db, { slug: "p7", name: "P7" });
    const page = await createOnlyFansPage(appContext.db, { modelId: model.id, label: "p7-of" });

    for (let i = 0; i < 6; i++) {
      const created = await insertOfapiWebhookEvent(appContext.db, {
        idempotencyKey: `evt_p7_${i}`,
        eventType: "users.typing",
        ofapiAccountId: ACCOUNT_ONE,
        payload: { event: "users.typing" },
      });
      await settleOfapiWebhookEvent(appContext.db, {
        id: created!.id,
        status: "processed",
        platformAccountId: i === 2 ? null : page.id,
        syncEvent: { type: "typing", accountId: ACCOUNT_ONE, chatId: String(i) },
        processedAt: new Date(),
      });
    }

    const { rows: seqRows } = await testDb.pool.query<{ seq: string; orphan: boolean }>(
      `select fanout_seq as seq, platform_account_id is null as orphan
         from ofapi_webhook_events order by fanout_seq`,
    );
    const allSeqs = seqRows.map((row) => Number(row.seq));
    const expected = seqRows.filter((row) => !row.orphan).map((row) => Number(row.seq));
    expect(expected).toHaveLength(5);

    // The same pagination loop the hub drain and the SSE replay run: limit 4
    // puts the orphan inside the first batch.
    const collected: number[] = [];
    let cursor = allSeqs[0]! - 1;
    for (;;) {
      const rows = await listOfapiSyncEventsForReplay(appContext.db, { afterSeq: cursor, limit: 4 });
      for (const row of rows) {
        collected.push(row.id);
        cursor = row.id;
      }
      if (rows.length < 4) {
        break;
      }
    }

    expect(collected).toEqual(expected);

    const replayCeiling = expected[2]!;
    const bounded = await listOfapiSyncEventsForReplay(appContext.db, {
      afterSeq: allSeqs[0]! - 1,
      throughSeq: replayCeiling,
      limit: 10,
    });
    expect(bounded.map((row) => row.id)).toEqual(
      expected.filter((seq) => seq <= replayCeiling),
    );
  }, 60_000);

  it("deletes only a replayable prefix and lets an empty-journal snapshot clear the floor", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const { rows: pageRows } = await testDb.pool.query<{ id: number }>(
      "select id::int from pages where ofapi_account_id = $1",
      [ACCOUNT_ONE],
    );
    const pageId = pageRows[0]!.id;

    const beforeUncommitted = await getOfapiFanoutReplayWindow(appContext.db);
    const uncommitted = await testDb.pool.connect();
    try {
      await uncommitted.query("begin");
      await uncommitted.query("select nextval('ofapi_webhook_events_fanout_seq')");
      const duringUncommitted = await getOfapiFanoutReplayWindow(appContext.db);
      expect(duringUncommitted.latestSeq).toBe(beforeUncommitted.latestSeq);
    } finally {
      await uncommitted.query("rollback");
      uncommitted.release();
    }

    // A lower committed fanout row with no v1 frame must not mask the oldest
    // replayable bound used by Last-Event-ID validation.
    const journalOnly = await insertOfapiWebhookEvent(appContext.db, {
      idempotencyKey: "continuity_non_replayable",
      eventType: "journal.only",
      ofapiAccountId: ACCOUNT_ONE,
      payload: { event: "journal.only" },
    });
    await settleOfapiWebhookEvent(appContext.db, {
      id: journalOnly!.id,
      status: "processed",
      platformAccountId: null,
      syncEvent: null,
      processedAt: new Date(),
    });
    for (let index = 0; index < 3; index += 1) {
      const created = await insertOfapiWebhookEvent(appContext.db, {
        idempotencyKey: `continuity_floor_${index}`,
        eventType: "users.typing",
        ofapiAccountId: ACCOUNT_ONE,
        payload: { event: "users.typing", index },
      });
      await settleOfapiWebhookEvent(appContext.db, {
        id: created!.id,
        status: "processed",
        platformAccountId: pageId,
        syncEvent: { type: "typing", accountId: ACCOUNT_ONE, chatId: String(index) },
        processedAt: new Date(),
      });
    }
    const { rows: seqRows } = await testDb.pool.query<{ fanout_seq: string }>(
      `select fanout_seq from ofapi_webhook_events
       where sync_event is not null and platform_account_id is not null
       order by fanout_seq`,
    );
    const firstSeq = Number(seqRows[0]!.fanout_seq);
    const blockerSeq = Number(seqRows[1]!.fanout_seq);
    const laterSeq = Number(seqRows[2]!.fanout_seq);
    expect((await getOfapiFanoutReplayWindow(appContext.db)).oldestRetainedSeq).toBe(firstSeq);
    await testDb.pool.query(
      `update ofapi_webhook_events
          set received_at = '2020-01-01T00:00:00Z',
              projection_status = case when fanout_seq = $1 then 'failed' else projection_status end
        where fanout_seq in ($2, $1, $3)`,
      [blockerSeq, firstSeq, laterSeq],
    );
    await testDb.pool.query(
      "update ofapi_webhook_events set received_at = '2020-01-01T00:00:00Z' where id = $1",
      [journalOnly!.id],
    );

    const listener = await testDb.pool.connect();
    await listener.query("listen ofapi_sync_events");
    const floorNotification = new Promise<string | null>((resolve) => {
      listener.once("notification", (message) => resolve(message.payload ?? null));
    });
    await deleteExpiredOfapiWebhookEvents(appContext.db, new Date("2021-01-01T00:00:00Z"));
    expect(await Promise.race([
      floorNotification,
      sleep(2_000).then(() => null),
    ])).toBe(`replay-floor:${firstSeq}`);
    await listener.query("unlisten ofapi_sync_events");
    listener.release();
    await deleteExpiredOfapiWebhookEvents(appContext.db, new Date("2021-01-01T00:00:00Z"));
    const { rows: blockedRows } = await testDb.pool.query<{ fanout_seq: string }>(
      `select fanout_seq from ofapi_webhook_events
       where sync_event is not null and platform_account_id is not null
       order by fanout_seq`,
    );
    // The failed row blocks the later old/otherwise-eligible replay frame.
    expect(blockedRows.map((row) => Number(row.fanout_seq))).toEqual([blockerSeq, laterSeq]);
    const { rows: stateRows } = await testDb.pool.query<{ replay_floor: string }>(
      "select replay_floor from ofapi_fanout_replay_state where singleton",
    );
    expect(Number(stateRows[0]!.replay_floor)).toBe(firstSeq);
    expect(await getOfapiSyncReplayFloor(appContext.db)).toBe(firstSeq);

    const stale = await fetch(`${baseUrl}/api/v1/events/stream`, {
      headers: {
        authorization: `Bearer ${chatterKey}`,
        "last-event-id": "0",
      },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: "sync_snapshot_required",
      requestedSeq: 0,
    });

    await testDb.pool.query(
      "update ofapi_webhook_events set projection_status = 'none' where fanout_seq = $1",
      [blockerSeq],
    );
    await deleteExpiredOfapiWebhookEvents(appContext.db, new Date("2021-01-01T00:00:00Z"));
    expect(await getOfapiSyncReplayFloor(appContext.db)).toBe(laterSeq);
    const { rows: floorRows } = await testDb.pool.query<{ count: string }>(
      "select count(*)::text as count from ofapi_fanout_replay_state",
    );
    expect(Number(floorRows[0]!.count)).toBe(1);

    const snapshot = await server.inject({
      method: "GET",
      url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=0`,
      headers: {
        authorization: `Bearer ${chatterKey}`,
      },
    });
    expect(snapshot.statusCode, snapshot.body).toBe(200);
    expect(snapshot.json()).toMatchObject({
      snapshotCursor: laterSeq,
    });

    const staleContinuation = await server.inject({
      method: "GET",
      url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=0&snapshotCursor=0`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(staleContinuation.statusCode, staleContinuation.body).toBe(409);
    expect(staleContinuation.json()).toMatchObject({
      error: "sync_snapshot_restart_required",
      replayFloor: laterSeq,
      snapshotPath: "/api/v1/events/snapshot",
    });

    // The empty journal still reports the durable floor as its committed head;
    // reconnecting from the snapshot cursor must not loop back into 409.
    const resumed = await fetch(`${baseUrl}/api/v1/events/stream`, {
      headers: {
        authorization: `Bearer ${chatterKey}`,
        "last-event-id": String(snapshot.json().snapshotCursor),
      },
    });
    expect(resumed.status).toBe(200);
    await resumed.body?.cancel();
  }, 60_000);

  it("preserves a valid pre-0094 cursor above the retained journal tail", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const { rows: pageRows } = await testDb.pool.query<{ id: number }>(
      "select id::int from pages where ofapi_account_id = $1",
      [ACCOUNT_ONE],
    );
    const retained = await insertOfapiWebhookEvent(appContext.db, {
      idempotencyKey: "legacy_high_water_retained_tail",
      eventType: "users.typing",
      ofapiAccountId: ACCOUNT_ONE,
      payload: { event: "users.typing" },
    });
    await settleOfapiWebhookEvent(appContext.db, {
      id: retained!.id,
      status: "processed",
      platformAccountId: pageRows[0]!.id,
      syncEvent: { type: "typing", accountId: ACCOUNT_ONE, chatId: "legacy" },
      processedAt: new Date(),
    });
    const retainedWindow = await getOfapiFanoutReplayWindow(appContext.db);
    const retainedSeq = retainedWindow.oldestRetainedSeq;
    if (retainedSeq === null) {
      throw new Error("Expected one retained replay row");
    }
    const legacyHighWater = retainedSeq + 37;
    // This is the post-migration shape of a legacy database whose old cleanup
    // pruned a settled tail after the one retained row. Future nextval values
    // remain above the captured cursor, exactly as the migration's table lock
    // guarantees while it reads the sequence.
    await testDb.pool.query(
      "select setval('ofapi_webhook_events_fanout_seq', $1, true)",
      [legacyHighWater],
    );
    await testDb.pool.query(
      `insert into ofapi_fanout_replay_state (singleton, replay_floor, legacy_high_water)
       values (true, 0, $1)
       on conflict (singleton) do update set legacy_high_water = excluded.legacy_high_water`,
      [legacyHighWater],
    );

    expect(await getOfapiFanoutReplayWindow(appContext.db)).toMatchObject({
      oldestRetainedSeq: retainedSeq,
      latestSeq: legacyHighWater,
    });
    const snapshot = await server.inject({
      method: "GET",
      url: `/api/v1/events/snapshot?accountId=${ACCOUNT_ONE}&afterSeq=${legacyHighWater}`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(snapshot.statusCode, snapshot.body).toBe(200);
    expect(snapshot.json().snapshotCursor).toBe(legacyHighWater);

    const resumed = await fetch(`${baseUrl}/api/v1/events/stream`, {
      headers: {
        authorization: `Bearer ${chatterKey}`,
        "last-event-id": String(legacyHighWater),
      },
    });
    expect(resumed.status).toBe(200);
    await resumed.body?.cancel();

    const manufacturedAhead = await fetch(`${baseUrl}/api/v1/events/stream`, {
      headers: {
        authorization: `Bearer ${chatterKey}`,
        "last-event-id": String(legacyHighWater + 1),
      },
    });
    expect(manufacturedAhead.status).toBe(409);
    expect(await manufacturedAhead.json()).toMatchObject({
      currentSeq: legacyHighWater,
      requestedSeq: legacyHighWater + 1,
    });
  }, 60_000);

  it("requires chatter API-key auth on the stream", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const unauthenticated = await fetch(`${baseUrl}/api/v1/events/stream`);
    expect(unauthenticated.status).toBe(401);
    await unauthenticated.body?.cancel();

    const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "dima", password: "owner-secret" }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();

    const ownerSession = await fetch(`${baseUrl}/api/v1/events/stream`, {
      headers: { cookie: cookie! },
    });
    expect(ownerSession.status).toBe(403);
    await ownerSession.body?.cancel();
  }, 60_000);
});
