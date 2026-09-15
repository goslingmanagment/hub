import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import {
  appendDomainEvents,
  completeErasureLog,
  completeErasureLogAndSupersedeScope,
  ERASURE_EXECUTION_PROTOCOL,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  insertObservation,
  insertErasureLog,
  insertOfapiWebhookEvent,
  setPageOfapiAccountId,
  settleOfapiWebhookEvent,
} from "@agency_hub_core/db";
import {
  decodeDomainEventCursor,
  encodeDomainEventCursor,
  subscribeDomainEvents,
  subscribeSyncEvents,
  type DomainEventFrame,
  type DomainEventsSnapshotRequired,
} from "@agency_hub_core/contracts";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { executeErasure } from "../apps/runtime/src/services/erasure/index.ts";
import {
  assignPageToUser,
  createUserAccount,
} from "../apps/runtime/src/services/auth.ts";
import { issueChatterDeviceToken } from "./helpers/device-credentials.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Kernel Stage 21: event-stream v2 conformance against a real listening
// server — per-account ordering, opaque-cursor resume, grant scoping, the
// per-account 409 protocol, unknown-type tolerance, and dual-stream operation
// beside untouched v1.

let testDb: StartedTestDatabase | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let baseUrl = "";
let chatterKey = "";
let lanaId = 0;
let lilyId = 0;
let seedCounter = 0;

function event(type: string, data: unknown) {
  seedCounter += 1;
  return {
    type,
    occurredAt: new Date("2026-07-01T00:00:00.000Z"),
    data,
    schemaVersion: 1,
    observationId: seedCounter,
    dedupKey: `v2test:${seedCounter}`,
  };
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) {
    return;
  }
  const seedContext = createTestAppContext(testDb);

  await createUserAccount(seedContext, {
    username: "dima",
    role: "owner",
    password: "owner-secret",
  }, { source: "cli" });
  await createUserAccount(seedContext, {
    username: "anton",
    role: "chatter",
  }, { source: "cli" });
  const model = await createModel(testDb.db, { slug: "lana-model", name: "Lana Model" });
  const lana = await createFanslyPage(testDb.db, { modelId: model.id, label: "lana" });
  const lily = await createFanslyPage(testDb.db, { modelId: model.id, label: "lily1" });
  lanaId = lana.id;
  lilyId = lily.id;
  const issued = await issueChatterDeviceToken(seedContext, {
    username: "anton",
    pageLabel: "lana",
  }, { source: "cli" });
  chatterKey = issued.key;

  server = await buildApiServer(createTestAppContext(testDb));
  await server.listen({ port: 0, host: "127.0.0.1" });
  const address = server.server.address();
  if (typeof address === "object" && address) {
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
}, 120_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

function requireSetup(context: { skip: () => void }) {
  if (!server || !baseUrl) {
    context.skip();
    return null;
  }
  return true;
}

function bearerOptions() {
  return { baseUrl, auth: { mode: "bearer" as const, token: () => chatterKey } };
}

async function ownerCookie() {
  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "dima", password: "owner-secret" }),
  });
  const cookie = login.headers.get("set-cookie");
  return cookie!.split(";")[0]!;
}

describe("event stream v2", () => {
  it("snapshot hands out grant-scoped fresh cursors; foreign accounts 403", async (context) => {
    if (!requireSetup(context)) return;

    await appendDomainEvents(testDb!.db, lanaId, [
      event("message.received", { text: "one" }),
      event("message.received", { text: "two" }),
    ]);
    await appendDomainEvents(testDb!.db, lilyId, [event("message.received", { text: "other page" })]);

    const chatterSnapshot = await fetch(`${baseUrl}/api/v1/events/v2/snapshot`, {
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(chatterSnapshot.status).toBe(200);
    const chatterBody = await chatterSnapshot.json() as {
      cursor: string;
      accounts: Array<{ accountId: number; accountRef: string | null; currentSeq: number }>;
    };
    expect(chatterBody.accounts).toEqual([{
      accountId: lanaId,
      accountRef: null,
      currentSeq: 2,
    }]);
    const decoded = decodeDomainEventCursor(chatterBody.cursor);
    expect(decoded.ok && decoded.watermarks.get(lanaId)).toBe(2);
    expect(decoded.ok && decoded.scope).toBe("granted");

    const foreign = await fetch(`${baseUrl}/api/v1/events/v2/snapshot?accounts=${lilyId}`, {
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(foreign.status).toBe(403);

    const cookie = await ownerCookie();
    const ownerSnapshot = await fetch(`${baseUrl}/api/v1/events/v2/snapshot`, {
      headers: { cookie },
    });
    const ownerBody = await ownerSnapshot.json() as { accounts: Array<{ accountId: number }> };
    expect(ownerBody.accounts.map((a) => a.accountId).sort((x, y) => x - y))
      .toEqual([lanaId, lilyId].sort((x, y) => x - y));
  });

  it("replays from a cursor in per-account order, delivers live appends, and never leaks foreign accounts", async (context) => {
    if (!requireSetup(context)) return;

    const frames: Array<{ cursor: string; event: DomainEventFrame }> = [];
    let sawLive: (() => void) | null = null;
    const live = new Promise<void>((resolve) => { sawLive = resolve; });

    const handle = subscribeDomainEvents(bearerOptions(), {
      cursor: encodeDomainEventCursor(new Map([[lanaId, 0]])),
      onFrame: (frame) => {
        frames.push(frame);
        if (frame.event.data && (frame.event.data as { text?: string }).text === "live") {
          sawLive!();
        }
      },
    });

    // Give the replay a beat, then append live on both pages: lana must
    // arrive, lily must not.
    await sleep(400);
    await appendDomainEvents(testDb!.db, lilyId, [event("message.received", { text: "foreign live" })]);
    await appendDomainEvents(testDb!.db, lanaId, [event("message.received", { text: "live" })]);
    await live;
    handle.close();
    await handle.done;

    const lanaFrames = frames.filter((frame) => frame.event.accountId === lanaId);
    expect(frames).toHaveLength(lanaFrames.length); // zero foreign frames
    expect(lanaFrames.map((frame) => frame.event.accountSeq)).toEqual([1, 2, 3]);
    expect(lanaFrames[0].event.type).toBe("message.received");

    // Resume from the mid-stream cursor: only what followed it arrives.
    const resumeCursor = lanaFrames[1].cursor;
    const resumed: number[] = [];
    const resumeHandle = subscribeDomainEvents(bearerOptions(), {
      cursor: resumeCursor,
      onFrame: (frame) => resumed.push(frame.event.accountSeq),
    });
    await sleep(600);
    resumeHandle.close();
    await resumeHandle.done;
    expect(resumed).toEqual([3]);
  });

  it("tolerates unknown event types (forward-compat rule)", async (context) => {
    if (!requireSetup(context)) return;

    const before = encodeDomainEventCursor(new Map([[lanaId, 3]]));
    await appendDomainEvents(testDb!.db, lanaId, [
      event("totally.new_kind", { future: true }),
    ]);

    const seen: DomainEventFrame[] = [];
    const handle = subscribeDomainEvents(bearerOptions(), {
      cursor: before,
      onFrame: (frame) => seen.push(frame.event),
    });
    await sleep(500);
    handle.close();
    await handle.done;
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe("totally.new_kind");
    expect(seen[0].accountSeq).toBe(4);
  });

  it("answers 409 with per-account detail for a cursor ahead of the head", async (context) => {
    if (!requireSetup(context)) return;

    let snapshot: DomainEventsSnapshotRequired | null = null;
    const handle = subscribeDomainEvents(bearerOptions(), {
      cursor: encodeDomainEventCursor(new Map([[lanaId, 999_999]])),
      onFrame: () => undefined,
      onSnapshotRequired: (details) => { snapshot = details; },
    });
    await handle.done;
    expect(snapshot).not.toBeNull();
    expect(snapshot!.version).toBe(2);
    expect(snapshot!.snapshotPath).toBe("/api/v1/events/v2/snapshot");
    expect(snapshot!.accounts).toHaveLength(1);
    expect(snapshot!.accounts[0].accountId).toBe(lanaId);
    expect(snapshot!.accounts[0].requestedSeq).toBe(999_999);
  });

  it("rejects a cursor naming an account outside the grant with 403", async (context) => {
    if (!requireSetup(context)) return;

    const response = await fetch(`${baseUrl}/api/v1/events/v2/stream?cursor=${
      encodeURIComponent(encodeDomainEventCursor(new Map([[lilyId, 0]])))
    }`, { headers: { authorization: `Bearer ${chatterKey}` } });
    expect(response.status).toBe(403);
  });

  it("rejects a malformed cursor with 400", async (context) => {
    if (!requireSetup(context)) return;

    const response = await fetch(`${baseUrl}/api/v1/events/v2/stream?cursor=garbage`, {
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(response.status).toBe(400);
  });

  it("serves v1 and v2 in parallel: one server, both protocols live", async (context) => {
    if (!requireSetup(context)) return;

    // Both protocols fed BEFORE connecting (the v1 fanout NOTIFY is emitted by
    // the worker in production, not by the repo settle — replay is the honest
    // in-process path); each stream then serves its own replay in parallel.
    const created = await insertOfapiWebhookEvent(testDb!.db, {
      idempotencyKey: "v2test_dual",
      eventType: "users.typing",
      ofapiAccountId: "acct-dual",
      payload: { event: "users.typing" },
    });
    await settleOfapiWebhookEvent(testDb!.db, {
      id: created!.id,
      status: "processed",
      platformAccountId: lanaId,
      syncEvent: { type: "typing", accountId: "acct-dual", chatId: "d1" },
      processedAt: new Date(),
    });
    await appendDomainEvents(testDb!.db, lanaId, [event("message.received", { text: "dual" })]);

    const v1Frames: number[] = [];
    const v1Handle = subscribeSyncEvents(bearerOptions(), {
      lastEventId: 0,
      onFrame: (frame) => v1Frames.push(frame.id),
    });
    const v2Frames: number[] = [];
    const v2Handle = subscribeDomainEvents(bearerOptions(), {
      cursor: encodeDomainEventCursor(new Map([[lanaId, 4]])),
      onFrame: (frame) => v2Frames.push(frame.event.accountSeq),
    });
    await sleep(700);

    v1Handle.close();
    v2Handle.close();
    await v1Handle.done;
    await v2Handle.done;

    expect(v1Frames.length).toBeGreaterThanOrEqual(1);
    expect(v2Frames).toEqual([5]);
  });

  it("replays across batch boundaries without loss", async (context) => {
    if (!requireSetup(context)) return;

    // Fresh account (lily, chatter has no grant — use the owner) with more
    // rows than one replay batch.
    const cookie = await ownerCookie();
    const batch = Array.from({ length: 520 }, (_, index) =>
      event("message.received", { index }));
    await appendDomainEvents(testDb!.db, lilyId, batch);

    const seqs: number[] = [];
    const handle = subscribeDomainEvents({ baseUrl, headers: { cookie } }, {
      cursor: encodeDomainEventCursor(new Map([[lilyId, 0]])),
      onFrame: (frame) => {
        if (frame.event.accountId === lilyId) {
          seqs.push(frame.event.accountSeq);
        }
      },
    });
    await sleep(1_500);
    handle.close();
    await handle.done;

    expect(seqs.length).toBe(522); // 2 earlier rows + 520 batch rows
    expect(seqs).toEqual(Array.from({ length: 522 }, (_, index) => index + 1));
  });

  it("answers 409 when the cursor falls below the retained floor (synthetic pruning)", async (context) => {
    if (!requireSetup(context)) return;

    // Prune lily's first 100 rows — the retained floor becomes 101.
    await testDb!.pool.query(
      "delete from domain_events where account_id = $1 and account_seq <= 100",
      [lilyId],
    );

    const cookie = await ownerCookie();
    let snapshot: DomainEventsSnapshotRequired | null = null;
    const handle = subscribeDomainEvents({ baseUrl, headers: { cookie } }, {
      cursor: encodeDomainEventCursor(new Map([[lilyId, 50]])),
      onFrame: () => undefined,
      onSnapshotRequired: (details) => { snapshot = details; },
    });
    await handle.done;

    expect(snapshot).not.toBeNull();
    const entry = snapshot!.accounts.find((a) => a.accountId === lilyId);
    expect(entry).toBeDefined();
    expect(entry!.oldestAvailableSeq).toBe(101);
    expect(entry!.requestedSeq).toBe(50);

    // The floor itself is resumable: watermark 100 → next row 101 exists.
    const seqs: number[] = [];
    const okHandle = subscribeDomainEvents({ baseUrl, headers: { cookie } }, {
      cursor: encodeDomainEventCursor(new Map([[lilyId, 100]])),
      onFrame: (frame) => seqs.push(frame.event.accountSeq),
    });
    await sleep(1_200);
    okHandle.close();
    await okHandle.done;
    expect(seqs[0]).toBe(101);
    expect(seqs.at(-1)).toBe(522);
  });

  it("does not widen a grant-bound cursor at the new account head", async (context) => {
    if (!requireSetup(context)) return;

    const seedContext = createTestAppContext(testDb!);
    await createUserAccount(seedContext, {
      username: "scope-race",
      role: "chatter",
    }, { source: "cli" });
    const raceKey = (await issueChatterDeviceToken(seedContext, {
      username: "scope-race",
      pageLabel: "lana",
    }, { source: "cli" })).key;

    const beforeGrant = await fetch(`${baseUrl}/api/v1/events/v2/snapshot`, {
      headers: { authorization: `Bearer ${raceKey}` },
    });
    expect(beforeGrant.status).toBe(200);
    const beforeBody = await beforeGrant.json() as {
      cursor: string;
      accounts: Array<{ accountId: number; accountRef: string | null; currentSeq: number }>;
    };
    expect(beforeBody.accounts.map((account) => account.accountId)).toEqual([lanaId]);
    const beforeDecoded = decodeDomainEventCursor(beforeBody.cursor);
    expect(beforeDecoded.ok && beforeDecoded.scope).toBe("granted");

    // B appears after the A-only cursor is minted. Core must reject the stale
    // grant scope instead of inserting B at its current head.
    await assignPageToUser(seedContext, {
      username: "scope-race",
      pageLabel: "lily1",
    }, { source: "cli" });
    const stale = await fetch(`${baseUrl}/api/v1/events/v2/stream?cursor=${
      encodeURIComponent(beforeBody.cursor)
    }`, { headers: { authorization: `Bearer ${raceKey}` } });
    expect(stale.status).toBe(409);
    const staleBody = await stale.json() as DomainEventsSnapshotRequired;
    const lilyGap = staleBody.accounts.find((account) => account.accountId === lilyId);
    expect(lilyGap).toBeDefined();

    const rebound = await fetch(
      `${baseUrl}/api/v1/events/v2/snapshot?sourceCursor=${encodeURIComponent(beforeBody.cursor)}`,
      {
        headers: { authorization: `Bearer ${raceKey}` },
      },
    );
    expect(rebound.status).toBe(200);
    const reboundBody = await rebound.json() as {
      cursor: string;
      accounts: Array<{ accountId: number; accountRef: string | null; currentSeq: number }>;
    };
    expect(reboundBody.accounts.map((account) => account.accountId)).toEqual([lanaId, lilyId]);
    expect(reboundBody.accounts.every((account) => account.accountRef === null)).toBe(true);

    // This event commits after B's rebound baseline/state snapshot and before
    // reconnect. It must be replayed from the AB cursor rather than skipped.
    const appended = await appendDomainEvents(testDb!.db, lilyId, [
      event("message.received", { scopeRace: "after-b-snapshot" }),
    ]);
    expect(appended.highWater).toBe(lilyGap!.currentSeq + 1);
    const replayed: DomainEventFrame[] = [];
    const handle = subscribeDomainEvents({
      baseUrl,
      auth: { mode: "bearer", token: () => raceKey },
    }, {
      cursor: reboundBody.cursor,
      onFrame: (frame) => replayed.push(frame.event),
    });
    await sleep(600);
    handle.close();
    await handle.done;
    expect(replayed).toEqual([
      expect.objectContaining({
        accountId: lilyId,
        accountSeq: appended.highWater,
        data: { scopeRace: "after-b-snapshot" },
      }),
    ]);
  });

  it("recovers through the internal sequence hole produced by fan erasure", async (context) => {
    if (!requireSetup(context)) return;

    const model = await createModel(testDb!.db, {
      slug: "continuity-hole-model",
      name: "Continuity Hole",
    });
    const page = await createOnlyFansPage(testDb!.db, {
      modelId: model!.id,
      label: "continuity-hole",
    });
    if (!page) {
      throw new Error("failed to create continuity-hole OFAPI page");
    }
    await setPageOfapiAccountId(testDb!.db, {
      pageId: page.id,
      ofapiAccountId: "acct_continuity_hole",
    });

    const erasedFanRef = "991777002";
    const appendObservedFanEvent = async (fanRef: string, messageId: string) => {
      const envelope = {
        event: "messages.received",
        account_id: "acct_continuity_hole",
        payload: { id: messageId, fromUser: { id: fanRef } },
      };
      const observation = await insertObservation(testDb!.db, {
        source: "webhook",
        producer: "ofapi:webhook",
        platform: "onlyfans",
        accountId: page.id,
        nativeAccountRef: "acct_continuity_hole",
        kind: "messages.received",
        payload: envelope,
        payloadHash: createHash("sha256").update(JSON.stringify(envelope)).digest(),
        idempotencyKey: `continuity-hole:${messageId}`,
      });
      return appendDomainEvents(testDb!.db, page.id, [{
        type: "message.received",
        occurredAt: new Date("2026-07-13T12:00:00.000Z"),
        fanIdentityRef: fanRef,
        conversationRef: fanRef,
        messageRef: messageId,
        data: { messageId },
        schemaVersion: 1,
        observationId: observation.observationId,
        dedupKey: `continuity-hole:${messageId}`,
      }]);
    };

    await appendObservedFanEvent("991777001", "hole-survivor-1");
    await appendObservedFanEvent(erasedFanRef, "hole-erased-2");
    await appendObservedFanEvent("991777003", "hole-survivor-3");

    const { rows: owners } = await testDb!.pool.query<{ id: number }>(
      "select id::int from users where username = 'dima'",
    );
    await executeErasure(
      createTestAppContext(testDb!),
      { scopeType: "fan", platform: "onlyfans", fanRef: erasedFanRef },
      { initiatedBy: owners[0]!.id, auditSource: "test" },
    );
    const { rows: retained } = await testDb!.pool.query<{ account_seq: number }>(
      "select account_seq::int from domain_events where account_id = $1 order by account_seq",
      [page.id],
    );
    expect(retained.map((row) => row.account_seq)).toEqual([1, 3]);

    const cookie = await ownerCookie();
    const sourceCursor = encodeDomainEventCursor(new Map([[page.id, 1]]));
    const response = await fetch(`${baseUrl}/api/v1/events/v2/stream?cursor=${
      encodeURIComponent(sourceCursor)
    }`, { headers: { cookie } });
    expect(response.status).toBe(409);
    const body = await response.json() as DomainEventsSnapshotRequired;
    expect(body.accounts).toContainEqual(expect.objectContaining({
      accountId: page.id,
      requestedSeq: 1,
      currentSeq: 3,
    }));

    const recovery = await fetch(
      `${baseUrl}/api/v1/events/v2/snapshot?accounts=${page.id}`
        + `&sourceCursor=${encodeURIComponent(sourceCursor)}`,
      { headers: { cookie } },
    );
    expect(recovery.status).toBe(200);
    const recoveredBody = await recovery.json() as {
      cursor: string;
      accounts: Array<{ accountId: number; currentSeq: number }>;
    };
    expect(recoveredBody.accounts).toEqual([expect.objectContaining({
      accountId: page.id,
      currentSeq: 3,
    })]);
    const recovered = decodeDomainEventCursor(recoveredBody.cursor);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) {
      throw new Error(recovered.reason);
    }
    // The durable state walk replaces everything through the erased seq=2;
    // with no later replay barrier the fresh cursor may advance to the head.
    expect(recovered.watermarks.get(page.id)).toBe(3);

    // Legacy v0.1.41 does not send sourceCursor. It still needs an escape from
    // the exact same erasure hole, even though it cannot bound already-applied
    // history as tightly as a revision-aware client.
    const legacyRecovery = await fetch(
      `${baseUrl}/api/v1/events/v2/snapshot?accounts=${page.id}`,
      { headers: { cookie } },
    );
    expect(legacyRecovery.status).toBe(200);
    const legacyRecovered = decodeDomainEventCursor(
      ((await legacyRecovery.json()) as { cursor: string }).cursor,
    );
    expect(legacyRecovered.ok).toBe(true);
    if (!legacyRecovered.ok) {
      throw new Error(legacyRecovered.reason);
    }
    expect(legacyRecovered.watermarks.get(page.id)).toBe(3);

    await appendObservedFanEvent("991777004", "hole-post-snapshot-4");
    const replayed: number[] = [];
    let repeatedSnapshot: DomainEventsSnapshotRequired | null = null;
    const handle = subscribeDomainEvents({ baseUrl, headers: { cookie } }, {
      cursor: recoveredBody.cursor,
      onFrame: (frame) => {
        if (frame.event.accountId === page.id) {
          replayed.push(frame.event.accountSeq);
        }
      },
      onSnapshotRequired: (details) => { repeatedSnapshot = details; },
    });
    await sleep(700);
    handle.close();
    await handle.done;
    expect(repeatedSnapshot).toBeNull();
    expect(replayed).toEqual([4]);
  });

  it("drains unreplaced OFAPI events before internal and tail erasure holes", async (context) => {
    if (!requireSetup(context)) return;

    const model = await createModel(testDb!.db, {
      slug: "continuity-prefix-model",
      name: "Continuity Prefix",
    });
    const page = await createOnlyFansPage(testDb!.db, {
      modelId: model!.id,
      label: "continuity-prefix",
    });
    if (!page) {
      throw new Error("failed to create continuity-prefix OFAPI page");
    }
    const ofapiAccountId = "acct_continuity_prefix";
    await setPageOfapiAccountId(testDb!.db, {
      pageId: page.id,
      ofapiAccountId,
    });

    const appendObservedMessage = async (fanRef: string, messageId: string) => {
      const envelope = {
        event: "messages.received",
        account_id: ofapiAccountId,
        payload: { id: messageId, fromUser: { id: fanRef } },
      };
      const observation = await insertObservation(testDb!.db, {
        source: "webhook",
        producer: "ofapi:webhook",
        platform: "onlyfans",
        accountId: page.id,
        nativeAccountRef: ofapiAccountId,
        kind: "messages.received",
        payload: envelope,
        payloadHash: createHash("sha256").update(JSON.stringify(envelope)).digest(),
        idempotencyKey: `continuity-prefix:${messageId}`,
      });
      await appendDomainEvents(testDb!.db, page.id, [{
        type: "message.received",
        occurredAt: new Date("2026-07-13T12:10:00.000Z"),
        fanIdentityRef: fanRef,
        conversationRef: fanRef,
        messageRef: messageId,
        data: { messageId },
        schemaVersion: 1,
        observationId: observation.observationId,
        dedupKey: `continuity-prefix:${messageId}`,
      }]);
    };
    const appendUnsettledSubscription = async (fanRef: string, suffix: string) => {
      const idempotencyKey = `continuity-prefix:subscription:${suffix}`;
      const envelope = {
        event: "subscriptions.new",
        account_id: ofapiAccountId,
        payload: { id: `subscription-${suffix}`, user: { id: fanRef } },
      };
      const journal = await insertOfapiWebhookEvent(testDb!.db, {
        idempotencyKey,
        eventType: "subscriptions.new",
        ofapiAccountId,
        payload: envelope,
      });
      expect(journal).not.toBeNull();
      const observation = await insertObservation(testDb!.db, {
        source: "webhook",
        producer: "ofapi:webhook",
        platform: "onlyfans",
        accountId: page.id,
        nativeAccountRef: ofapiAccountId,
        kind: "subscriptions.new",
        payload: envelope,
        payloadHash: createHash("sha256").update(JSON.stringify(envelope)).digest(),
        idempotencyKey,
      });
      await appendDomainEvents(testDb!.db, page.id, [{
        type: "subscription.started",
        occurredAt: new Date("2026-07-13T12:10:00.000Z"),
        fanIdentityRef: fanRef,
        data: { fanRef },
        schemaVersion: 1,
        observationId: observation.observationId,
        dedupKey: idempotencyKey,
      }]);
    };
    const { rows: owners } = await testDb!.pool.query<{ id: number }>(
      "select id::int from users where username = 'dima'",
    );
    const eraseFan = async (fanRef: string) => executeErasure(
      createTestAppContext(testDb!),
      { scopeType: "fan", platform: "onlyfans", fanRef },
      { initiatedBy: owners[0]!.id, auditSource: "test" },
    );
    const drainPrefix = async (cursor: string) => {
      const frames: Array<{ cursor: string; accountSeq: number }> = [];
      let snapshot: DomainEventsSnapshotRequired | null = null;
      const handle = subscribeDomainEvents({ baseUrl, headers: { cookie: await ownerCookie() } }, {
        cursor,
        onFrame: (frame) => {
          if (frame.event.accountId === page.id) {
            frames.push({ cursor: frame.cursor, accountSeq: frame.event.accountSeq });
          }
        },
        onSnapshotRequired: (details) => { snapshot = details; },
      });
      // A tail hole has no later frame that could trip the sequence guard. The
      // replay ceiling itself must close promptly after the retained prefix.
      await Promise.race([
        handle.done,
        sleep(3_000).then(() => { throw new Error("prefix stream did not close at hole"); }),
      ]);
      expect(snapshot).toBeNull();
      return frames;
    };

    await appendObservedMessage("991778001", "prefix-source-1");
    await appendUnsettledSubscription("991778002", "internal-blocker-2");
    const internalErasedFan = "991778003";
    await appendObservedMessage(internalErasedFan, "prefix-erased-3");
    await appendObservedMessage("991778004", "prefix-survivor-4");
    await eraseFan(internalErasedFan);

    const sourceCursor = encodeDomainEventCursor(new Map([[page.id, 1]]));
    const internalPrefix = await drainPrefix(sourceCursor);
    expect(internalPrefix.map((frame) => frame.accountSeq)).toEqual([2]);
    const afterInternalPrefix = internalPrefix[0]!.cursor;

    const internalGap = await fetch(`${baseUrl}/api/v1/events/v2/stream?cursor=${
      encodeURIComponent(afterInternalPrefix)
    }`, { headers: { cookie: await ownerCookie() } });
    expect(internalGap.status).toBe(409);
    expect((await internalGap.json() as DomainEventsSnapshotRequired).accounts)
      .toContainEqual(expect.objectContaining({
        accountId: page.id,
        requestedSeq: 2,
        currentSeq: 4,
      }));

    // v0.1.41 cannot echo sourceCursor. The snapshot response therefore marks
    // its opaque cursor as proof that the client must complete its state walk
    // before persisting it. Core may then replay every retained behavior across
    // the erased seq=3 and must publish a normal cursor before entering live.
    const legacySnapshot = await fetch(
      `${baseUrl}/api/v1/events/v2/snapshot?accounts=${page.id}`,
      { headers: { cookie: await ownerCookie() } },
    );
    expect(legacySnapshot.status).toBe(200);
    const legacyTarget = (await legacySnapshot.json() as { cursor: string }).cursor;
    const decodedLegacyTarget = decodeDomainEventCursor(legacyTarget);
    expect(decodedLegacyTarget.ok).toBe(true);
    if (!decodedLegacyTarget.ok) {
      throw new Error(decodedLegacyTarget.reason);
    }
    expect(decodedLegacyTarget.watermarks.get(page.id)).toBe(1);
    expect(decodedLegacyTarget.recovery).toEqual(expect.objectContaining({ kind: "snapshot" }));

    // An erasure begins by durably advancing the global epoch before it deletes
    // either state or ledger rows. A marker minted before that point must not
    // authorize the changed topology, and no new marker may mint while the run
    // is incomplete.
    const epochBump = await insertErasureLog(testDb!.db, {
      scopeType: "fan",
      scopeRef: "fan:onlyfans:epoch-bump-only",
      initiatedBy: owners[0]!.id,
      dryRun: false,
      plan: { resolvedPageIds: [page.id], testOnly: true },
      executionProtocol: ERASURE_EXECUTION_PROTOCOL,
    });
    const invalidatedLegacy = await fetch(`${baseUrl}/api/v1/events/v2/stream?cursor=${
      encodeURIComponent(legacyTarget)
    }`, { headers: { cookie: await ownerCookie() } });
    expect(invalidatedLegacy.status).toBe(409);
    const blockedDuringErasure = await fetch(
      `${baseUrl}/api/v1/events/v2/snapshot?accounts=${page.id}`,
      { headers: { cookie: await ownerCookie() } },
    );
    expect(blockedDuringErasure.status).toBe(503);
    const retry = await insertErasureLog(testDb!.db, {
      scopeType: "fan",
      scopeRef: "fan:onlyfans:epoch-bump-only",
      initiatedBy: owners[0]!.id,
      dryRun: false,
      plan: { resolvedPageIds: [page.id], testOnly: true, retry: true },
      executionProtocol: ERASURE_EXECUTION_PROTOCOL,
    });
    const unrelatedIncomplete = await insertErasureLog(testDb!.db, {
      scopeType: "fan",
      scopeRef: "fan:onlyfans:unrelated-incomplete",
      initiatedBy: owners[0]!.id,
      dryRun: false,
      plan: { resolvedPageIds: [page.id], testOnly: true },
    });
    const resolved = await completeErasureLogAndSupersedeScope(testDb!.db, {
      id: retry.id,
      scopeType: "fan",
      scopeRef: retry.scopeRef,
      resolvedPageIds: [page.id],
      executionProtocol: ERASURE_EXECUTION_PROTOCOL,
      executedCounts: {},
    });
    expect(resolved?.supersededIds).toContain(epochBump.id);

    // The same-scope crash is resolved, but a different scope must continue to
    // fail recovery closed. Resolving by max(id) would incorrectly clear it.
    const stillBlockedByUnrelated = await fetch(
      `${baseUrl}/api/v1/events/v2/snapshot?accounts=${page.id}`,
      { headers: { cookie: await ownerCookie() } },
    );
    expect(stillBlockedByUnrelated.status).toBe(503);
    await completeErasureLog(testDb!.db, { id: unrelatedIncomplete.id, executedCounts: {} });

    const refreshedLegacySnapshot = await fetch(
      `${baseUrl}/api/v1/events/v2/snapshot?accounts=${page.id}`,
      { headers: { cookie: await ownerCookie() } },
    );
    expect(refreshedLegacySnapshot.status).toBe(200);
    const refreshedLegacyTarget = (await refreshedLegacySnapshot.json() as { cursor: string }).cursor;
    await appendObservedMessage("991778005", "post-snapshot-target-5");

    const legacyFrames: Array<{ cursor: string; event: DomainEventFrame }> = [];
    let resolveLegacyComplete: (() => void) | null = null;
    const legacyComplete = new Promise<void>((resolve) => { resolveLegacyComplete = resolve; });
    const legacyHandle = subscribeDomainEvents(
      { baseUrl, headers: { cookie: await ownerCookie() } },
      {
        cursor: refreshedLegacyTarget,
        onFrame: (frame) => {
          if (frame.event.accountId !== page.id) return;
          legacyFrames.push(frame);
          if (frame.event.accountSeq === 5 && frame.event.type === "message.received") {
            resolveLegacyComplete?.();
          }
        },
      },
    );
    await Promise.race([
      legacyComplete,
      sleep(3_000).then(() => { throw new Error("legacy recovery did not cross the internal hole"); }),
    ]);
    legacyHandle.close();
    await legacyHandle.done;
    expect(legacyFrames.map((frame) => [frame.event.accountSeq, frame.event.type])).toEqual([
      [2, "subscription.started"],
      [4, "message.received"],
      [4, "stream.snapshot_replay_completed"],
      [5, "message.received"],
    ]);
    const legacyCompletedCursor = decodeDomainEventCursor(legacyFrames.at(-1)!.cursor);
    expect(legacyCompletedCursor.ok).toBe(true);
    if (!legacyCompletedCursor.ok) {
      throw new Error(legacyCompletedCursor.reason);
    }
    expect(legacyCompletedCursor.watermarks.get(page.id)).toBe(5);
    expect(legacyCompletedCursor.recovery).toBeNull();

    const internalRecovery = await fetch(
      `${baseUrl}/api/v1/events/v2/snapshot?accounts=${page.id}`
        + `&sourceCursor=${encodeURIComponent(afterInternalPrefix)}`,
      { headers: { cookie: await ownerCookie() } },
    );
    expect(internalRecovery.status).toBe(200);
    const internalTarget = (await internalRecovery.json() as { cursor: string }).cursor;
    const decodedInternalTarget = decodeDomainEventCursor(internalTarget);
    expect(decodedInternalTarget.ok).toBe(true);
    if (!decodedInternalTarget.ok) {
      throw new Error(decodedInternalTarget.reason);
    }
    expect(decodedInternalTarget.watermarks.get(page.id)).toBe(5);

    await appendUnsettledSubscription("991778006", "tail-blocker-6");
    const tailErasedFan = "991778007";
    await appendObservedMessage(tailErasedFan, "prefix-erased-tail-7");
    await eraseFan(tailErasedFan);

    const tailPrefix = await drainPrefix(internalTarget);
    expect(tailPrefix.map((frame) => frame.accountSeq)).toEqual([6]);
    const afterTailPrefix = tailPrefix[0]!.cursor;
    const tailGap = await fetch(`${baseUrl}/api/v1/events/v2/stream?cursor=${
      encodeURIComponent(afterTailPrefix)
    }`, { headers: { cookie: await ownerCookie() } });
    expect(tailGap.status).toBe(409);
    expect((await tailGap.json() as DomainEventsSnapshotRequired).accounts)
      .toContainEqual(expect.objectContaining({
        accountId: page.id,
        requestedSeq: 6,
        currentSeq: 7,
      }));

    // A second legacy snapshot must cross both the earlier internal hole and
    // the new tail hole while retaining both behavioral barriers. The explicit
    // completion frame is the carrier for the head=7 cursor when no seq=7 row
    // remains to carry an SSE id.
    const legacyTailSnapshot = await fetch(
      `${baseUrl}/api/v1/events/v2/snapshot?accounts=${page.id}`,
      { headers: { cookie: await ownerCookie() } },
    );
    const legacyTailTarget = (await legacyTailSnapshot.json() as { cursor: string }).cursor;
    const legacyTailFrames: Array<{ cursor: string; event: DomainEventFrame }> = [];
    let resolveLegacyTail: (() => void) | null = null;
    const legacyTailComplete = new Promise<void>((resolve) => { resolveLegacyTail = resolve; });
    const legacyTailHandle = subscribeDomainEvents(
      { baseUrl, headers: { cookie: await ownerCookie() } },
      {
        cursor: legacyTailTarget,
        onFrame: (frame) => {
          if (frame.event.accountId !== page.id) return;
          legacyTailFrames.push(frame);
          if (frame.event.type === "stream.snapshot_replay_completed") {
            resolveLegacyTail?.();
          }
        },
      },
    );
    await Promise.race([
      legacyTailComplete,
      sleep(3_000).then(() => { throw new Error("legacy recovery did not cross the tail hole"); }),
    ]);
    legacyTailHandle.close();
    await legacyTailHandle.done;
    expect(legacyTailFrames.map((frame) => frame.event.accountSeq)).toEqual([2, 4, 5, 6, 7]);
    expect(legacyTailFrames.at(-1)!.event.type).toBe("stream.snapshot_replay_completed");
    const legacyTailCompletedCursor = decodeDomainEventCursor(legacyTailFrames.at(-1)!.cursor);
    expect(legacyTailCompletedCursor.ok).toBe(true);
    if (!legacyTailCompletedCursor.ok) {
      throw new Error(legacyTailCompletedCursor.reason);
    }
    expect(legacyTailCompletedCursor.watermarks.get(page.id)).toBe(7);
    expect(legacyTailCompletedCursor.recovery).toBeNull();

    const tailRecovery = await fetch(
      `${baseUrl}/api/v1/events/v2/snapshot?accounts=${page.id}`
        + `&sourceCursor=${encodeURIComponent(afterTailPrefix)}`,
      { headers: { cookie: await ownerCookie() } },
    );
    expect(tailRecovery.status).toBe(200);
    const decodedTailTarget = decodeDomainEventCursor(
      (await tailRecovery.json() as { cursor: string }).cursor,
    );
    expect(decodedTailTarget.ok).toBe(true);
    if (!decodedTailTarget.ok) {
      throw new Error(decodedTailTarget.reason);
    }
    expect(decodedTailTarget.watermarks.get(page.id)).toBe(7);
  });

  it("returns 503 before hijacking either stream when its initial LISTEN is unavailable", async (context) => {
    if (!requireSetup(context)) return;

    const healthyContext = createTestAppContext(testDb!);
    const brokenContext = {
      ...healthyContext,
      pool: {
        connect: async () => {
          throw new Error("LISTEN unavailable");
        },
      } as unknown as typeof healthyContext.pool,
    };
    const brokenServer = await buildApiServer(brokenContext);
    try {
      const v1 = await brokenServer.inject({
        method: "GET",
        url: "/api/v1/events/stream",
        headers: { authorization: `Bearer ${chatterKey}` },
      });
      expect(v1.statusCode, v1.body).toBe(503);
      expect(v1.headers["content-type"] ?? "").not.toContain("text/event-stream");

      const v2 = await brokenServer.inject({
        method: "GET",
        url: "/api/v1/events/v2/stream",
        headers: { authorization: `Bearer ${chatterKey}` },
      });
      expect(v2.statusCode, v2.body).toBe(503);
      expect(v2.headers["content-type"] ?? "").not.toContain("text/event-stream");
    } finally {
      await brokenServer.close();
    }
  });
});

// ── Stage 24: serve-time frame consumability for OFAPI-keyed clients ────────

describe("event stream v2 — Stage 24 serve-time enrichment", () => {
  const OFAPI_ACCOUNT = "acct_stage24test";
  let ofPageId = 0;

  async function seedOfPage() {
    if (ofPageId !== 0) {
      return ofPageId;
    }
    const seedContext = createTestAppContext(testDb!);
    const model = await createModel(testDb!.db, { slug: "kate-of-model", name: "Kate OF" });
    const page = await createOnlyFansPage(testDb!.db, { modelId: model.id, label: "kate-of-24" });
    await setPageOfapiAccountId(testDb!.db, { pageId: page.id, ofapiAccountId: OFAPI_ACCOUNT });
    await assignPageToUser(seedContext, { username: "anton", pageLabel: "kate-of-24" }, { source: "cli" });
    ofPageId = page.id;
    return ofPageId;
  }

  it("message frames carry refs, the OFAPI account ref, and the normalized payload from the source observation", async (context) => {
    if (!requireSetup(context)) return;
    const pageId = await seedOfPage();

    // The source observation: an OFAPI webhook messages.received envelope,
    // exactly as the Stage 7 producer journals it.
    const wireMessage = {
      id: "9001001",
      text: "hey there",
      createdAt: "2026-07-06T10:00:00.000Z",
      price: 0,
      isFree: true,
      isTip: false,
      mediaCount: 0,
      fromUser: { id: "777100" },
    };
    const envelope = {
      event: "messages.received",
      account_id: OFAPI_ACCOUNT,
      payload: wireMessage,
    };
    const inserted = await insertObservation(testDb!.db, {
      source: "webhook",
      producer: "ofapi:webhook",
      kind: "messages.received",
      accountId: pageId,
      payload: envelope,
      payloadHash: createHash("sha256").update(JSON.stringify(envelope)).digest(),
      idempotencyKey: "stage24:enrich:9001001",
    });
    expect(inserted.inserted).toBe(true);
    const observationId = inserted.observationId;

    await appendDomainEvents(testDb!.db, pageId, [{
      type: "message.received",
      occurredAt: new Date("2026-07-06T10:00:00.000Z"),
      fanIdentityRef: "777100",
      conversationRef: "777100",
      messageRef: "9001001",
      data: { text: "hey there", price: 0, isTip: false, isFree: true, mediaCount: 0 },
      schemaVersion: 1,
      observationId,
      dedupKey: "stage24:msg:9001001",
    }]);

    const frames: DomainEventFrame[] = [];
    const handle = subscribeDomainEvents(bearerOptions(), {
      cursor: encodeDomainEventCursor(new Map([[pageId, 0]])),
      onFrame: (frame) => frames.push(frame.event),
    });
    await sleep(800);
    handle.close();
    await handle.done;

    expect(frames).toHaveLength(1);
    const frame = frames[0]! as DomainEventFrame & {
      accountRef?: string | null;
      conversationRef?: string | null;
      messageRef?: string | null;
      fanRef?: string | null;
      payload?: { id: string; text: string; isSentByMe: boolean; createdAt: string };
    };
    expect(frame.type).toBe("message.received");
    expect(frame.accountRef).toBe(OFAPI_ACCOUNT);
    expect(frame.conversationRef).toBe("777100");
    expect(frame.messageRef).toBe("9001001");
    expect(frame.fanRef).toBe("777100");
    // The payload is the SAME normalized shape the v1 fanout serves.
    expect(frame.payload).toMatchObject({
      id: "9001001",
      text: "hey there",
      isSentByMe: false,
      createdAt: "2026-07-06T10:00:00.000Z",
    });
  });

  it("module-emitted and non-webhook events serve thin frames (no payload), Fansly pages carry accountRef null", async (context) => {
    if (!requireSetup(context)) return;
    const pageId = await seedOfPage();

    const wb = await appendDomainEvents(testDb!.db, pageId, [{
      type: "workboard.state_changed",
      occurredAt: new Date("2026-07-06T11:00:00.000Z"),
      data: { fromTab: null, toTab: "fresh_mass" },
      schemaVersion: 1,
      observationId: 0,
      dedupKey: "stage24:wb:1",
    }]);
    const fansly = await appendDomainEvents(testDb!.db, lanaId, [event("message.received", { text: "fansly side" })]);

    const cookie = await ownerCookie();
    const frames: Array<DomainEventFrame & { accountRef?: string | null; payload?: unknown }> = [];
    const handle = subscribeDomainEvents({ baseUrl, headers: { cookie } }, {
      // Resume exactly one event behind each account's head (the appends above).
      cursor: encodeDomainEventCursor(new Map([
        [pageId, wb.highWater - 1],
        [lanaId, fansly.highWater - 1],
      ])),
      onFrame: (frame) => frames.push(frame.event as typeof frames[number]),
    });
    await sleep(800);
    handle.close();
    await handle.done;

    const workboardFrame = frames.find((frame) => frame.type === "workboard.state_changed");
    expect(workboardFrame).toBeDefined();
    expect(workboardFrame!.accountRef).toBe(OFAPI_ACCOUNT);
    expect(workboardFrame!.payload).toBeUndefined();

    const fanslyFrame = frames.find((frame) => frame.accountId === lanaId);
    expect(fanslyFrame).toBeDefined();
    expect(fanslyFrame!.accountRef).toBeNull();
    expect(fanslyFrame!.payload).toBeUndefined();
  });

  it("forwards typing as an ephemeral frame that never advances the cursor", async (context) => {
    if (!requireSetup(context)) return;
    const pageId = await seedOfPage();

    // Connect raw (the ephemeral lane is not part of the SDK helper's
    // domain-frame surface) and watch the wire directly.
    const abort = new AbortController();
    const response = await fetch(`${baseUrl}/api/v1/events/v2/stream`, {
      headers: { authorization: `Bearer ${chatterKey}`, accept: "text/event-stream" },
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let wire = "";
    const consumed = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        wire += decoder.decode(value, { stream: true });
      }
    })().catch(() => undefined);

    // Give the subscription a beat, then push a typing event through the v1
    // fanout: journal row -> settle with the mapped sync event -> NOTIFY (in
    // prod the worker settles+notifies; the repo settle deliberately does not).
    await sleep(600);
    const created = await insertOfapiWebhookEvent(testDb!.db, {
      idempotencyKey: "stage24-typing-1",
      eventType: "users.typing",
      ofapiAccountId: OFAPI_ACCOUNT,
      payload: { event: "users.typing", payload: { id: "777100" } },
    });
    await settleOfapiWebhookEvent(testDb!.db, {
      id: created.id,
      status: "processed",
      platformAccountId: pageId,
      syncEvent: { type: "typing", accountId: OFAPI_ACCOUNT, chatId: "777100" },
      processedAt: new Date(),
    });
    await testDb!.pool.query("select pg_notify('ofapi_sync_events', '')");
    await sleep(1_500);
    abort.abort();
    await consumed;

    // Other tests' typing rows may drain on the same connection — find OURS.
    const ephemeralBlocks = wire
      .split("\n\n")
      .filter((block) => block.includes("event: ephemeral"));
    expect(ephemeralBlocks.length).toBeGreaterThan(0);
    const mine = ephemeralBlocks.find((block) => block.includes(OFAPI_ACCOUNT));
    expect(mine).toBeDefined();
    expect(mine).not.toContain("id:"); // never checkpointable
    const dataLine = mine!.split("\n").find((line) => line.startsWith("data: "))!;
    expect(JSON.parse(dataLine.slice("data: ".length))).toEqual({
      type: "typing",
      accountId: OFAPI_ACCOUNT,
      chatId: "777100",
    });
  });
});

describe("event stream v2 — incident 2026-07-15 tourniquet (#155)", () => {
  it("suppresses message.ppv_unlocked frames while the watermark advances past them", async (context) => {
    if (!requireSetup(context)) return;

    // Anchor on the current head so earlier tests' events stay out of frame.
    const snapshot = await fetch(`${baseUrl}/api/v1/events/v2/snapshot`, {
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    const { cursor } = await snapshot.json() as { cursor: string };

    await appendDomainEvents(testDb!.db, lanaId, [
      event("message.received", { text: "before ppv" }),
      event("message.ppv_unlocked", { amountText: "$45.00" }),
      event("message.received", { text: "after ppv" }),
    ]);

    const frames: Array<{ cursor: string; event: DomainEventFrame }> = [];
    const handle = subscribeDomainEvents(bearerOptions(), {
      cursor,
      onFrame: (frame) => frames.push(frame),
    });
    await sleep(600);
    handle.close();
    await handle.done;

    expect(frames.map((frame) => frame.event.type))
      .toEqual(["message.received", "message.received"]);
    const seqs = frames.map((frame) => frame.event.accountSeq);
    expect(seqs[1]! - seqs[0]!).toBe(2); // the ppv seq sits between, undelivered

    // The suppressed seq must ride the next frame's id line: resuming from the
    // last delivered frame replays nothing — no client can wedge on the hidden
    // event because no cursor ever points before it without also being before
    // a delivered frame.
    const resumed: DomainEventFrame[] = [];
    const resume = subscribeDomainEvents(bearerOptions(), {
      cursor: frames.at(-1)!.cursor,
      onFrame: (frame) => resumed.push(frame.event),
    });
    await sleep(500);
    resume.close();
    await resume.done;
    expect(resumed).toEqual([]);
  });
});
