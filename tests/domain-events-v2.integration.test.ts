import { fixtureUserId } from "./helpers/user-identity.ts";
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
import { createLogger } from "@agency_hub_core/shared";
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

/** Polls collected stream state until the expected frames are in, instead of
 * sleeping a fixed collection window. */
async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await sleep(25);
  }
}

/** After the expected frames arrived, how long a "no extra or foreign frame"
 * assertion keeps listening. There is no positive signal for absence. */
const NO_EXTRA_FRAME_SETTLE_MS = 250;

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

    // Replay reaches seq 2 only after the domain hub is listening, so appends
    // from here on are live. Then append on both pages: lana must arrive, lily
    // must not.
    await waitUntil(
      () => frames.some((frame) => frame.event.accountId === lanaId && frame.event.accountSeq === 2),
      "the lana replay to reach seq 2",
    );
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
    await waitUntil(() => resumed.includes(3), "the resumed seq 3");
    await sleep(NO_EXTRA_FRAME_SETTLE_MS);
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
    await waitUntil(() => seen.length >= 1, "the unknown-type frame");
    await sleep(NO_EXTRA_FRAME_SETTLE_MS);
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
    await waitUntil(
      () => v2Frames.includes(5) && v1Frames.length >= 1,
      "a v1 frame and the v2 seq 5",
    );
    await sleep(NO_EXTRA_FRAME_SETTLE_MS);

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
    await waitUntil(() => seqs.at(-1) === 522, "the replay to reach seq 522");
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
    await waitUntil(() => seqs.includes(522), "the resumed replay to reach seq 522");
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
      userId: await fixtureUserId(seedContext, "scope-race"),
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
    await waitUntil(() => replayed.length >= 1, "the replayed after-b-snapshot frame");
    await sleep(NO_EXTRA_FRAME_SETTLE_MS);
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
    await waitUntil(() => replayed.includes(4), "the post-snapshot seq 4");
    await sleep(NO_EXTRA_FRAME_SETTLE_MS);
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
    await assignPageToUser(seedContext, { userId: await fixtureUserId(seedContext, "anton"), pageLabel: "kate-of-24" }, { source: "cli" });
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
    await waitUntil(() => frames.length >= 1, "the enriched message frame");
    await sleep(NO_EXTRA_FRAME_SETTLE_MS);
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

    // A module-emitted, non-webhook type (the OFAPI command executor's
    // settlement) — not enrichable, so the frame must stay thin.
    const moduleEvent = await appendDomainEvents(testDb!.db, pageId, [{
      type: "command.settled",
      occurredAt: new Date("2026-07-06T11:00:00.000Z"),
      data: { outcome: "succeeded" },
      schemaVersion: 1,
      observationId: 0,
      dedupKey: "stage24:command:1",
    }]);
    const fansly = await appendDomainEvents(testDb!.db, lanaId, [event("message.received", { text: "fansly side" })]);

    const cookie = await ownerCookie();
    const frames: Array<DomainEventFrame & { accountRef?: string | null; payload?: unknown }> = [];
    const handle = subscribeDomainEvents({ baseUrl, headers: { cookie } }, {
      // Resume exactly one event behind each account's head (the appends above).
      cursor: encodeDomainEventCursor(new Map([
        [pageId, moduleEvent.highWater - 1],
        [lanaId, fansly.highWater - 1],
      ])),
      onFrame: (frame) => frames.push(frame.event as typeof frames[number]),
    });
    await waitUntil(
      () => frames.some((frame) => frame.type === "command.settled")
        && frames.some((frame) => frame.accountId === lanaId),
      "the command.settled and lana frames",
    );
    handle.close();
    await handle.done;

    const moduleFrame = frames.find((frame) => frame.type === "command.settled");
    expect(moduleFrame).toBeDefined();
    expect(moduleFrame!.accountRef).toBe(OFAPI_ACCOUNT);
    expect(moduleFrame!.payload).toBeUndefined();

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

    // Ready the shared sync hub's LISTEN (and its baseline) the way the v1
    // route does, then wait for this stream's replay to complete: its ephemeral
    // subscription is registered before that marker. The v2 route never awaits
    // the sync hub itself, so without the v1 connect a typing row committed in
    // the hub's connect window would sit below the baseline when this test runs
    // alone.
    const v1Abort = new AbortController();
    const v1 = await fetch(`${baseUrl}/api/v1/events/stream`, {
      headers: { authorization: `Bearer ${chatterKey}`, accept: "text/event-stream" },
      signal: v1Abort.signal,
    });
    expect(v1.status).toBe(200);
    v1Abort.abort();
    await v1.body?.cancel().catch(() => undefined);
    await waitUntil(() => wire.includes("replay_completed"), "the v2 replay_completed marker");

    // Push a typing event through the v1 fanout: journal row -> settle with
    // the mapped sync event -> NOTIFY (in prod the worker settles+notifies; the
    // repo settle deliberately does not).
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
    await waitUntil(
      () => wire.split("\n\n").some((block) =>
        block.includes("event: ephemeral") && block.includes(OFAPI_ACCOUNT)),
      "this account's ephemeral typing frame",
      5_000,
    );
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

// ── INC-001: message.ppv_unlocked is an ordinary cursor-bearing frame ───────

describe("event stream v2 — message.ppv_unlocked delivery (INC-001)", () => {
  // Desktop-shaped access: the chatter's device token, granted the page. (The
  // owner-cookie tests above already spend the per-IP login budget.)
  async function seedOfapiPage(label: string, ofapiAccountId: string) {
    const seedContext = createTestAppContext(testDb!);
    const model = await createModel(testDb!.db, { slug: `${label}-model`, name: label });
    const page = await createOnlyFansPage(testDb!.db, { modelId: model!.id, label });
    if (!page) {
      throw new Error(`failed to create ${label} OFAPI page`);
    }
    await setPageOfapiAccountId(testDb!.db, { pageId: page.id, ofapiAccountId });
    await assignPageToUser(seedContext, {
      userId: await fixtureUserId(seedContext, "anton"),
      pageLabel: label,
    }, { source: "cli" });
    return page.id;
  }

  /** Journals the OFAPI webhook envelope, then appends the canonical event the
   * webhook canonicalizer derives from it (fan-keyed refs, never the creator). */
  async function appendObservedWebhookEvent(input: {
    pageId: number;
    ofapiAccountId: string;
    kind: "messages.received" | "messages.ppv.unlocked";
    payload: Record<string, unknown>;
    type: string;
    fanRef: string;
    messageRef: string;
    data: unknown;
    dedupKey: string;
  }) {
    const envelope = { event: input.kind, account_id: input.ofapiAccountId, payload: input.payload };
    const observation = await insertObservation(testDb!.db, {
      source: "webhook",
      producer: "ofapi:webhook",
      platform: "onlyfans",
      accountId: input.pageId,
      nativeAccountRef: input.ofapiAccountId,
      kind: input.kind,
      payload: envelope,
      payloadHash: createHash("sha256").update(JSON.stringify(envelope)).digest(),
      idempotencyKey: `inc001:${input.dedupKey}`,
    });
    return appendDomainEvents(testDb!.db, input.pageId, [{
      type: input.type,
      occurredAt: new Date("2026-09-26T12:00:00.000Z"),
      fanIdentityRef: input.fanRef,
      conversationRef: input.fanRef,
      messageRef: input.messageRef,
      data: input.data,
      schemaVersion: 1,
      observationId: observation.observationId,
      dedupKey: input.dedupKey,
    }]);
  }

  const appendMessage = (pageId: number, ofapiAccountId: string, fanRef: string, messageId: string) =>
    appendObservedWebhookEvent({
      pageId,
      ofapiAccountId,
      kind: "messages.received",
      payload: { id: messageId, fromUser: { id: fanRef } },
      type: "message.received",
      fanRef,
      messageRef: messageId,
      data: { messageId },
      dedupKey: `msg:received:${messageId}`,
    });

  const ppvMessageLink = (fanRef: string, messageId: string) =>
    `https://onlyfans.com/my/chats/chat/${fanRef}/?firstId=${messageId}`;

  const appendPpvUnlocked = (
    pageId: number,
    ofapiAccountId: string,
    fanRef: string,
    messageId: string,
    notificationId: string,
  ) => appendObservedWebhookEvent({
    pageId,
    ofapiAccountId,
    kind: "messages.ppv.unlocked",
    payload: {
      id: notificationId,
      user: { id: fanRef },
      replacePairs: {
        "{AMOUNT}": "$45.00",
        "{MESSAGE_LINK}": ppvMessageLink(fanRef, messageId),
      },
    },
    type: "message.ppv_unlocked",
    fanRef,
    messageRef: messageId,
    data: { amountText: "$45.00", messageLink: ppvMessageLink(fanRef, messageId) },
    dedupKey: `ppv:${notificationId}`,
  });

  it("delivers message.ppv_unlocked in order with its refs and a cursor past it", async (context) => {
    if (!requireSetup(context)) return;
    const ofapiAccountId = "acct_inc001_delivery";
    const pageId = await seedOfapiPage("inc001-delivery", ofapiAccountId);
    const fanRef = "991779001";
    await appendMessage(pageId, ofapiAccountId, fanRef, "991779101");
    await appendPpvUnlocked(pageId, ofapiAccountId, fanRef, "991779102", "991779900");
    await appendMessage(pageId, ofapiAccountId, fanRef, "991779103");

    // Collects until the expected last seq arrives, then listens a short settle
    // for anything extra. With nothing expected there is no positive signal, so
    // the settle is a plain window.
    const collect = async (cursor: string, lastSeq: number | null) => {
      const frames: Array<{ cursor: string; event: DomainEventFrame }> = [];
      const handle = subscribeDomainEvents(bearerOptions(), {
        cursor,
        onFrame: (frame) => {
          if (frame.event.accountId === pageId) {
            frames.push(frame);
          }
        },
      });
      if (lastSeq !== null) {
        await waitUntil(
          () => frames.some((frame) => frame.event.accountSeq === lastSeq),
          `seq ${lastSeq}`,
        );
        await sleep(NO_EXTRA_FRAME_SETTLE_MS);
      } else {
        await sleep(300);
      }
      handle.close();
      await handle.done;
      return frames;
    };

    const frames = await collect(encodeDomainEventCursor(new Map([[pageId, 0]])), 3);
    expect(frames.map((frame) => [frame.event.accountSeq, frame.event.type])).toEqual([
      [1, "message.received"],
      [2, "message.ppv_unlocked"],
      [3, "message.received"],
    ]);
    const ppv = frames[1]!.event;
    expect(ppv).toMatchObject({
      accountId: pageId,
      accountRef: ofapiAccountId,
      fanRef,
      conversationRef: fanRef,
      messageRef: "991779102",
      data: { amountText: "$45.00", messageLink: ppvMessageLink(fanRef, "991779102") },
    });
    expect(ppv.payload).toBeUndefined();
    // Each frame's id line carries that frame's own seq: the PPV is a cursor
    // position like any other, not a watermark hidden in the next frame.
    for (const frame of frames) {
      const decoded = decodeDomainEventCursor(frame.cursor);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) {
        throw new Error(decoded.reason);
      }
      expect(decoded.watermarks.get(pageId)).toBe(frame.event.accountSeq);
    }

    const afterPpv = await collect(frames[1]!.cursor, 3);
    expect(afterPpv.map((frame) => [frame.event.accountSeq, frame.event.type]))
      .toEqual([[3, "message.received"]]);
    expect(await collect(frames[2]!.cursor, null)).toEqual([]);
  });

  it("PPV as the last frame before an erased hole hands out its own cursor, so reconnect makes progress", async (context) => {
    if (!requireSetup(context)) return;
    const ofapiAccountId = "acct_inc001_hole";
    const pageId = await seedOfapiPage("inc001-hole", ofapiAccountId);
    await appendMessage(pageId, ofapiAccountId, "991780001", "991780101");
    await appendPpvUnlocked(pageId, ofapiAccountId, "991780002", "991780102", "991780900");
    const erasedFan = "991780003";
    await appendMessage(pageId, ofapiAccountId, erasedFan, "991780103");

    const { rows: owners } = await testDb!.pool.query<{ id: number }>(
      "select id::int from users where username = 'dima'",
    );
    await executeErasure(
      createTestAppContext(testDb!),
      { scopeType: "fan", platform: "onlyfans", fanRef: erasedFan },
      { initiatedBy: owners[0]!.id, auditSource: "test" },
    );
    const { rows: retained } = await testDb!.pool.query<{ account_seq: number }>(
      "select account_seq::int from domain_events where account_id = $1 order by account_seq",
      [pageId],
    );
    expect(retained.map((row) => row.account_seq)).toEqual([1, 2]);

    // The retained prefix after seq=1 is the PPV alone; the tail hole at seq=3
    // closes the stream with no ordinary frame after it. The PPV frame is the
    // only carrier of the progress cursor.
    const frames: Array<{ cursor: string; event: DomainEventFrame }> = [];
    const snapshots: DomainEventsSnapshotRequired[] = [];
    const prefix = subscribeDomainEvents(bearerOptions(), {
      cursor: encodeDomainEventCursor(new Map([[pageId, 1]])),
      onFrame: (frame) => {
        if (frame.event.accountId === pageId) {
          frames.push(frame);
        }
      },
      onSnapshotRequired: (details) => { snapshots.push(details); },
    });
    await Promise.race([
      prefix.done,
      sleep(3_000).then(() => { throw new Error("prefix stream did not close at the hole"); }),
    ]);
    expect(snapshots).toEqual([]);
    expect(frames.map((frame) => [frame.event.accountSeq, frame.event.type]))
      .toEqual([[2, "message.ppv_unlocked"]]);
    const ppvCursor = decodeDomainEventCursor(frames[0]!.cursor);
    expect(ppvCursor.ok).toBe(true);
    if (!ppvCursor.ok) {
      throw new Error(ppvCursor.reason);
    }
    expect(ppvCursor.watermarks.get(pageId)).toBe(2);

    // Reconnecting from the PPV's cursor reaches the hole itself (409 at
    // seq=2) instead of replaying the same prefix from seq=1 forever.
    const resumed: DomainEventFrame[] = [];
    const resume = subscribeDomainEvents(bearerOptions(), {
      cursor: frames[0]!.cursor,
      onFrame: (frame) => {
        if (frame.event.accountId === pageId) {
          resumed.push(frame.event);
        }
      },
      onSnapshotRequired: (details) => { snapshots.push(details); },
    });
    await Promise.race([
      resume.done,
      sleep(3_000).then(() => { throw new Error("resume from the PPV cursor did not answer"); }),
    ]);
    expect(resumed).toEqual([]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.accounts).toContainEqual(expect.objectContaining({
      accountId: pageId,
      requestedSeq: 2,
      currentSeq: 3,
    }));

    const recovery = await fetch(
      `${baseUrl}/api/v1/events/v2/snapshot?accounts=${pageId}`
        + `&sourceCursor=${encodeURIComponent(frames[0]!.cursor)}`,
      { headers: { authorization: `Bearer ${chatterKey}` } },
    );
    expect(recovery.status).toBe(200);
    const recovered = decodeDomainEventCursor(
      (await recovery.json() as { cursor: string }).cursor,
    );
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) {
      throw new Error(recovered.reason);
    }
    expect(recovered.watermarks.get(pageId)).toBe(3);
  });

  it("logs ledger-to-wire latency for money frames on replay and on the live tail", async (context) => {
    if (!requireSetup(context)) return;
    const ofapiAccountId = "acct_inc001_latency";
    const pageId = await seedOfapiPage("inc001-latency", ofapiAccountId);
    const fanRef = "991781001";
    await appendMessage(pageId, ofapiAccountId, fanRef, "991781101");
    await appendPpvUnlocked(pageId, ofapiAccountId, fanRef, "991781102", "991781900");
    // Weeks-old provider timestamps: the latency must come from the ledger
    // row's created_at, not occurred_at.
    await appendDomainEvents(testDb!.db, pageId, [{
      type: "tip.received",
      occurredAt: new Date("2026-07-01T00:00:00.000Z"),
      fanIdentityRef: fanRef,
      data: { amountText: "$5.00" },
      schemaVersion: 1,
      observationId: 0,
      dedupKey: "inc001:tip:991781901",
    }, {
      type: "transaction.posted",
      occurredAt: new Date("2026-07-01T00:00:00.000Z"),
      fanIdentityRef: fanRef,
      transactionRef: "991781902",
      data: { amountMills: 5_000 },
      schemaVersion: 1,
      observationId: 0,
      dedupKey: "inc001:tx:991781902",
    }]);

    const lines: string[] = [];
    const loggedServer = await buildApiServer(createTestAppContext(testDb!, {
      logger: createLogger("info", {
        write(message: string) {
          lines.push(message);
        },
      }),
    }));
    // A failed wait must still release the stream, or close() hangs on it.
    const abort = new AbortController();
    try {
      await loggedServer.listen({ port: 0, host: "127.0.0.1" });
      const address = loggedServer.server.address();
      if (typeof address !== "object" || !address) {
        throw new Error("logged server has no address");
      }
      const loggedOptions = {
        baseUrl: `http://127.0.0.1:${address.port}`,
        auth: { mode: "bearer" as const, token: () => chatterKey },
      };

      const seen: number[] = [];
      let resolveReplayed: (() => void) | null = null;
      const replayed = new Promise<void>((resolve) => { resolveReplayed = resolve; });
      let resolveLive: (() => void) | null = null;
      const live = new Promise<void>((resolve) => { resolveLive = resolve; });
      const handle = subscribeDomainEvents(loggedOptions, {
        cursor: encodeDomainEventCursor(new Map([[pageId, 0]])),
        signal: abort.signal,
        onFrame: (frame) => {
          if (frame.event.accountId !== pageId) return;
          seen.push(frame.event.accountSeq);
          if (frame.event.accountSeq === 4) resolveReplayed?.();
          if (frame.event.accountSeq === 5) resolveLive?.();
        },
      });
      await Promise.race([
        replayed,
        sleep(3_000).then(() => { throw new Error("replay did not reach seq=4"); }),
      ]);
      await appendPpvUnlocked(pageId, ofapiAccountId, fanRef, "991781103", "991781903");
      await Promise.race([
        live,
        sleep(3_000).then(() => { throw new Error("live PPV frame did not arrive"); }),
      ]);
      handle.close();
      await handle.done;
      expect(seen).toEqual([1, 2, 3, 4, 5]);
    } finally {
      abort.abort();
      await loggedServer.close();
    }

    const records = lines
      .join("")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.msg === "v2 money frame written" && record.accountId === pageId);
    expect(records.map((record) => [record.type, record.accountSeq, record.replay])).toEqual([
      ["message.ppv_unlocked", 2, true],
      ["tip.received", 3, true],
      ["transaction.posted", 4, true],
      ["message.ppv_unlocked", 5, false],
    ]);
    for (const record of records) {
      expect(record.level).toBe(30);
      expect(Number.isInteger(record.ledgerToWireMs)).toBe(true);
      // Seconds, not the months since occurred_at: measured from created_at.
      // Absolute bound tolerates host/container clock skew in either direction.
      expect(Math.abs(record.ledgerToWireMs as number)).toBeLessThan(60_000);
    }
  });
});
