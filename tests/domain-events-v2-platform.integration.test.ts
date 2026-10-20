import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  appendDomainEvents,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  insertObservation,
  insertOfapiWebhookEvent,
  setPageOfapiAccountId,
  supersessionDedupKey,
} from "@agency_hub_core/db";
import {
  decodeDomainEventCursor,
  domainEventFactsResponseSchema,
  domainEventFrameSchema,
  type DomainEventFrame,
} from "@agency_hub_core/contracts";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { assignPageToUser, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { decodePreH3DomainEventCursor } from "./fixtures/legacy-v2-consumers/cursor-pre-h3.ts";
import {
  desktop0156DomainEventFrameSchema,
  PRE_H3_FRAME_KEYS,
  sdkPreH3DomainEventFrameSchema,
} from "./fixtures/legacy-v2-consumers/schemas.ts";
import { issueChatterDeviceToken } from "./helpers/device-credentials.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

// H3: the v2 stream/snapshot `platform=` filter (grants ∩ platform, bound
// v5/v6 cursors, one-time narrowing of unbound cursors, never widening), the
// frame additions (transactionRef, provenance live/redelivery/repair, money
// fact thread labels), GET /events/v2/facts, and proof that everything the
// hub now serves still decodes on ChatGoose Desktop 0.1.56 and the pre-H3 SDK.

let testDb: StartedTestDatabase | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let baseUrl = "";
let chatterKey = "";
let ofA = 0;
let ofB = 0;
let fsA = 0;
let fsB = 0;
let seedCounter = 0;
/** The original ledger event a repair supersedes on ofA, and its repair. */
let supersededSeq = 0;
let repairSeq = 0;

type SeedContext = ReturnType<typeof createTestAppContext>;

function seedContext(): SeedContext {
  return createTestAppContext(testDb!);
}

function plainEvent(type: string, data: unknown = {}) {
  seedCounter += 1;
  return {
    type,
    occurredAt: new Date("2026-09-20T12:00:00.000Z"),
    data,
    schemaVersion: 1,
    observationId: 0,
    dedupKey: `h3:${seedCounter}`,
  };
}

/** One OFAPI webhook fact end to end: receipt (optionally a provider
 * redelivery), its observation, and the canonical event. */
async function appendWebhookFact(pageId: number, input: {
  type: string;
  eventType: string;
  conversationRef?: string | null;
  messageRef?: string | null;
  transactionRef?: string | null;
  fanRef?: string | null;
  data?: Record<string, unknown>;
  redeliveryOf?: string;
}) {
  seedCounter += 1;
  const key = `evt_h3_${seedCounter}`;
  const envelope = { event: input.eventType, account_id: `acct_h3_${pageId}`, payload: { n: seedCounter } };
  const receipt = await insertOfapiWebhookEvent(testDb!.db, {
    idempotencyKey: key,
    eventType: input.eventType,
    ofapiAccountId: `acct_h3_${pageId}`,
    payload: envelope,
  });
  await testDb!.pool.query(
    "update ofapi_webhook_events set capture_headers = $2::jsonb where id = $1",
    [receipt!.id, JSON.stringify({
      idempotencyKey: key,
      identityStatus: "vendor",
      ...(input.redeliveryOf === undefined ? {} : { redeliveryOf: input.redeliveryOf }),
    })],
  );
  const observation = await insertObservation(testDb!.db, {
    source: "webhook",
    producer: "ofapi:webhook",
    platform: "onlyfans",
    accountId: pageId,
    nativeAccountRef: `acct_h3_${pageId}`,
    kind: input.eventType,
    payload: envelope,
    payloadHash: createHash("sha256").update(JSON.stringify(envelope)).digest(),
    idempotencyKey: key,
  });
  const appended = await appendDomainEvents(testDb!.db, pageId, [{
    type: input.type,
    occurredAt: new Date("2026-09-20T12:00:00.000Z"),
    fanIdentityRef: input.fanRef ?? input.conversationRef ?? null,
    conversationRef: input.conversationRef ?? null,
    messageRef: input.messageRef ?? null,
    transactionRef: input.transactionRef ?? null,
    data: input.data ?? {},
    schemaVersion: 1,
    observationId: observation.observationId,
    dedupKey: `h3:webhook:${key}`,
  }]);
  return { seq: appended.highWater, eventId: appended.events[0]!.eventId, observationId: observation.observationId };
}

/** A repair's superseding event (the H2 PPV ref repair shape). */
async function appendRepair(pageId: number, original: { eventId: number; observationId: number }, conversationRef: string) {
  const appended = await appendDomainEvents(testDb!.db, pageId, [{
    type: "message.ppv_unlocked",
    occurredAt: new Date("2026-09-20T12:00:00.000Z"),
    fanIdentityRef: conversationRef,
    conversationRef,
    messageRef: "msg-ppv-1",
    data: { amountUsd: 15, supersedesEventId: original.eventId, repair: "ofapi_ppv_conversation_ref" },
    schemaVersion: 2,
    observationId: original.observationId,
    dedupKey: supersessionDedupKey(original.eventId),
  }]);
  return appended.highWater;
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) {
    return;
  }
  const seed = seedContext();
  await createUserAccount(seed, { username: "h3owner", role: "owner", password: "owner-secret" }, { source: "cli" });
  await createUserAccount(seed, { username: "h3chatter", role: "chatter" }, { source: "cli" });
  const model = await createModel(testDb.db, { slug: "h3-model", name: "H3 Model" });
  const pageOfA = await createOnlyFansPage(testDb.db, { modelId: model!.id, label: "h3-of-a" });
  const pageOfB = await createOnlyFansPage(testDb.db, { modelId: model!.id, label: "h3-of-b" });
  const pageFsA = await createFanslyPage(testDb.db, { modelId: model!.id, label: "h3-fs-a" });
  const pageFsB = await createFanslyPage(testDb.db, { modelId: model!.id, label: "h3-fs-b" });
  ofA = pageOfA!.id;
  ofB = pageOfB!.id;
  fsA = pageFsA!.id;
  fsB = pageFsB!.id;
  await setPageOfapiAccountId(testDb.db, { pageId: ofA, ofapiAccountId: `acct_h3_${ofA}` });
  await setPageOfapiAccountId(testDb.db, { pageId: ofB, ofapiAccountId: `acct_h3_${ofB}` });

  // Chatter: ofA + fsA. ofB/fsB are someone else's.
  chatterKey = (await issueChatterDeviceToken(seed, { username: "h3chatter", pageLabel: "h3-of-a" }, { source: "cli" })).key;
  await assignPageToUser(seed, { userId: await fixtureUserId(seed, "h3chatter"), pageLabel: "h3-fs-a" }, { source: "cli" });

  // ofA ledger: a live message, a live PPV unlock (labelled thread), a
  // redelivered tip, a posted transaction, and a wrong-ref PPV unlock that a
  // repair supersedes.
  await appendWebhookFact(ofA, {
    type: "message.received",
    eventType: "messages.received",
    conversationRef: "fan-1",
    messageRef: "msg-1",
  });
  await appendWebhookFact(ofA, {
    type: "message.ppv_unlocked",
    eventType: "messages.ppv.unlocked",
    conversationRef: "fan-1",
    messageRef: "msg-ppv-0",
    data: { amountUsd: 89 },
  });
  await appendWebhookFact(ofA, {
    type: "tip.received",
    eventType: "tips.received",
    conversationRef: "fan-1",
    data: { amountUsd: 5 },
    redeliveryOf: "1110918155",
  });
  await appendWebhookFact(ofA, {
    type: "transaction.posted",
    eventType: "transactions.new",
    transactionRef: "tx-h3-1",
    fanRef: "fan-1",
    data: { amount: 89 },
  });
  const wrongRef = await appendWebhookFact(ofA, {
    type: "message.ppv_unlocked",
    eventType: "messages.ppv.unlocked",
    conversationRef: "creator-page-id",
    messageRef: "msg-ppv-1",
    data: { amountUsd: 15 },
  });
  supersededSeq = wrongRef.seq;
  repairSeq = await appendRepair(ofA, wrongRef, "fan-2");
  await testDb.pool.query(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_username, partner_display_name)
     values ($1, 'fan-1', 'alex_germany', 'Alex/Germany/37')`,
    [ofA],
  );

  await appendDomainEvents(testDb.db, ofB, [plainEvent("message.received", { page: "ofB" })]);
  await appendDomainEvents(testDb.db, fsA, [
    plainEvent("message.received", { page: "fsA" }),
    plainEvent("transaction.posted", { page: "fsA" }),
  ]);
  await appendDomainEvents(testDb.db, fsB, [plainEvent("message.received", { page: "fsB" })]);

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
    return false;
  }
  return true;
}

async function ownerCookie() {
  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "h3owner", password: "owner-secret" }),
  });
  return login.headers.get("set-cookie")!.split(";")[0]!;
}

function bearer(key = chatterKey) {
  return { authorization: `Bearer ${key}` };
}

interface RawSseFrame {
  event: string | null;
  id: string | null;
  data: string;
}

/** A raw SSE reader: frames exactly as the wire carries them, so the frozen
 * legacy decoders see what an old client would. */
async function openStream(query: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/v1/events/v2/stream${query}`, {
    headers: { accept: "text/event-stream", ...headers },
    signal: controller.signal,
  });
  const frames: RawSseFrame[] = [];
  let ended = false;
  const pump = (async () => {
    if (response.status !== 200 || response.body === null) {
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        return;
      }
      if (chunk.done) {
        return;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      for (let index = buffer.indexOf("\n\n"); index >= 0; index = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        let event: string | null = null;
        let id: string | null = null;
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("id: ")) id = line.slice(4);
          else if (line.startsWith("data: ")) data.push(line.slice(6));
        }
        if (data.length > 0) {
          frames.push({ event, id, data: data.join("\n") });
        }
      }
    }
  })().finally(() => {
    ended = true;
  });
  return {
    status: response.status,
    json: () => response.json() as Promise<unknown>,
    frames,
    domain(): Array<{ id: string; frame: DomainEventFrame; raw: unknown }> {
      return frames.filter((frame) => frame.event === "domain").map((frame) => {
        const raw: unknown = JSON.parse(frame.data);
        // Every frame satisfies the published (new) contract...
        return { id: frame.id!, frame: domainEventFrameSchema.parse(raw), raw };
      });
    },
    caughtUp() {
      return frames.some((frame) => frame.event === "control" && frame.data.includes("replay_completed"));
    },
    async waitFor(predicate: () => boolean, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) {
          throw new Error(`stream condition not met; frames: ${JSON.stringify(frames)}`);
        }
        if (ended) {
          // A closed stream can still satisfy the predicate on its last read.
          if (predicate()) return;
          throw new Error(`stream ended before condition; frames: ${JSON.stringify(frames)}`);
        }
        await sleep(25);
      }
    },
    async close() {
      controller.abort();
      await pump;
    },
  };
}

function decoded(cursor: string) {
  const result = decodeDomainEventCursor(cursor);
  if (!result.ok) {
    throw new Error(`undecodable cursor: ${result.reason}`);
  }
  return result;
}

/** Old clients keep exactly the pre-H3 keys: parse with every frozen frame
 * decoder and compare with the frame minus the H3 additions. */
function expectLegacyDecodable(raw: unknown) {
  const legacyView = Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter(([key]) => (PRE_H3_FRAME_KEYS as readonly string[]).includes(key)),
  );
  const desktop = desktop0156DomainEventFrameSchema.safeParse(raw);
  const sdk = sdkPreH3DomainEventFrameSchema.safeParse(raw);
  expect(desktop.success, JSON.stringify(desktop.error?.issues)).toBe(true);
  expect(sdk.success, JSON.stringify(sdk.error?.issues)).toBe(true);
  expect(desktop.data).toEqual(legacyView);
  expect(sdk.data).toEqual(legacyView);
}

describe("v2 stream platform filter (H3)", () => {
  it("serves only the platform's accounts on replay and live, with bound cursors an old Core rejects", async (context) => {
    if (!requireSetup(context)) return;

    const stream = await openStream("?platform=onlyfans", bearer());
    expect(stream.status).toBe(200);
    await stream.waitFor(() => stream.caughtUp());
    await appendDomainEvents(testDb!.db, fsA, [plainEvent("message.received", { live: "fansly" })]);
    await appendDomainEvents(testDb!.db, ofA, [plainEvent("message.received", { live: "onlyfans" })]);
    await stream.waitFor(() => stream.domain().some(({ frame }) => (frame.data as { live?: string }).live === "onlyfans"));
    await sleep(200);
    await stream.close();

    const domain = stream.domain();
    expect(domain.map(({ frame }) => frame.accountId)).toEqual([ofA]);
    for (const frame of stream.frames.filter((entry) => entry.id !== null)) {
      const cursor = decoded(frame.id!);
      expect(cursor.platform).toBe("onlyfans");
      expect([...cursor.watermarks.keys()]).toEqual([ofA]);
      expect(decodePreH3DomainEventCursor(frame.id!)).toEqual({ ok: false, reason: "unknown_version" });
    }
  });
});

describe("GET /api/v1/events/v2/facts (H3)", () => {
  async function facts(query: string, headers: Record<string, string> = bearer()) {
    const response = await fetch(`${baseUrl}/api/v1/events/v2/facts${query}`, { headers });
    return { status: response.status, body: await response.json() as unknown };
  }

  it("pages one account's money facts by account_seq, superseded events excluded", async (context) => {
    if (!requireSetup(context)) return;

    const { rows: before } = await testDb!.pool.query<{ next_seq: string }>(
      "select next_seq::text from domain_event_seq where account_id = $1",
      [ofA],
    );

    const first = await facts(`?accountId=${ofA}&limit=2`);
    expect(first.status).toBe(200);
    const page1 = domainEventFactsResponseSchema.parse(first.body);
    expect(page1.facts).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextAfterSeq).toBe(page1.facts[1]!.accountSeq);

    const collected = [...page1.facts];
    let afterSeq = page1.nextAfterSeq;
    let throughSeq = page1.throughSeq;
    for (let guard = 0; guard < 10; guard += 1) {
      const next = domainEventFactsResponseSchema.parse(
        (await facts(`?accountId=${ofA}&afterSeq=${afterSeq}&limit=2`)).body,
      );
      collected.push(...next.facts);
      afterSeq = next.nextAfterSeq;
      throughSeq = next.throughSeq;
      if (!next.hasMore) {
        expect(next.nextAfterSeq).toBe(next.throughSeq);
        break;
      }
    }
    const seqs = collected.map((fact) => fact.accountSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(collected.map((fact) => fact.type)))
      .toEqual(new Set(["message.ppv_unlocked", "tip.received", "transaction.posted"]));
    expect(seqs).not.toContain(supersededSeq);
    const repaired = collected.find((fact) => fact.accountSeq === repairSeq);
    expect(repaired).toMatchObject({ provenance: "repair", conversationRef: "fan-2" });
    expect(collected.find((fact) => fact.type === "transaction.posted")).toMatchObject({ transactionRef: "tx-h3-1" });
    expect(collected.every((fact) => fact.payload === undefined)).toBe(true);
    for (const fact of collected) {
      expectLegacyDecodable(fact);
    }

    // Caught up: nothing new, nextAfterSeq holds at the head.
    const idle = domainEventFactsResponseSchema.parse((await facts(`?accountId=${ofA}&afterSeq=${throughSeq}`)).body);
    expect(idle).toMatchObject({ facts: [], hasMore: false, nextAfterSeq: throughSeq });

    // A read, never a writer: no sequence moved.
    const { rows: after } = await testDb!.pool.query<{ next_seq: string }>(
      "select next_seq::text from domain_event_seq where account_id = $1",
      [ofA],
    );
    expect(after[0]!.next_seq).toBe(before[0]!.next_seq);
  });

  it("applies the stream's grants and refuses a cursor ahead of the head", async (context) => {
    if (!requireSetup(context)) return;

    expect((await facts(`?accountId=${ofB}`)).status).toBe(403);
    expect((await facts(`?accountId=${ofA}&afterSeq=999999`)).status).toBe(409);
    expect((await facts(`?accountId=${ofA}&limit=0`)).status).toBe(400);
    expect((await facts("")).status).toBe(400);

    const fansly = domainEventFactsResponseSchema.parse((await facts(`?accountId=${fsA}`)).body);
    expect(fansly.facts.map((fact) => [fact.type, fact.provenance])).toEqual([["transaction.posted", "live"]]);

    const cookie = await ownerCookie();
    const owner = await facts(`?accountId=${ofB}`, { cookie });
    expect(owner.status).toBe(200);
    expect(domainEventFactsResponseSchema.parse(owner.body).facts).toEqual([]);
  });
});
