import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendDomainEvents,
  createFanslyPage,
  createModel,
  insertOfapiWebhookEvent,
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
import {
  createUserAccount,
  issueChatterApiKey,
} from "../apps/runtime/src/services/auth.ts";
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
  const issued = await issueChatterApiKey(seedContext, {
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
    const chatterBody = await chatterSnapshot.json() as { cursor: string; accounts: Array<{ accountId: number; currentSeq: number }> };
    expect(chatterBody.accounts).toEqual([{ accountId: lanaId, currentSeq: 2 }]);
    const decoded = decodeDomainEventCursor(chatterBody.cursor);
    expect(decoded.ok && decoded.watermarks.get(lanaId)).toBe(2);

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
});
