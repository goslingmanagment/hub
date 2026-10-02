import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@agency_hub_core/db";
import type { FanslyWireRequest } from "@agency_hub_core/fansly";

import { createEngineRegistry, type EngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import {
  cancelHistoryRequest,
  getHistoryRequest,
  submitHistoryRequest,
  type HistoryRequestView,
} from "../apps/runtime/src/sync/requests/history.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import {
  FakeChats,
  harnessConfig,
  runActorUntil,
  seedChatThread,
  seedHarnessPage,
  type FakeChat,
} from "./helpers/sync-engine.ts";
import { makeTestActor, ScriptedLiveTransport } from "./helpers/sync-engine-host.ts";

// History requests end to end (plan §4, §15 step 2: "заявки (20 фанов, 2 800
// чтений, параллельные, список 500 рядом со списком 20)"; design §7.1, §7.2):
// requests filed through the intake, served by the live actor's requests
// class through the production `dm-messages.history` resource, against
// synthetic Fansly chats (newest first, 25 a page). Pinned here: 20 ordinary
// fans all become ready in exactly Σ(⌈n/25⌉ + 1) reads; a long chat needs
// its ⌈n/25⌉ + 1 reads, which the request reports monotonically, its lower
// bound never exceeds the fact and its estimate lands near it; two requests
// share the class turn by turn, so a request of 20 fans next to one of 500
// finishes after about twice its own reads while the other goes on; a cancel
// stops the reads and keeps what was loaded; `latest N` reads exactly ⌈N/25⌉
// full pages. The intake's refusals, idempotency and the ETA formulas are
// pinned in tests/sync-history-intake.integration.test.ts and
// tests/sync-history-eta.test.ts.
//
// The long chat holds 7 000 messages (281 reads) by default. The plan's
// 70 000 (≈ 2 800 reads, the same code paths) costs 5–7 minutes against a
// local database, so it runs on request:
//   SYNC_HISTORY_LONG_CHAT=70000 pnpm exec vitest run tests/sync-history-requests.integration.test.ts

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

const DAY = 86_400_000;
const PAGE = 25;
/** Messages of the long chat (a multiple of 28 × 25; see the header). */
const LONG_CHAT = Number(process.env.SYNC_HISTORY_LONG_CHAT ?? "7000");
/** Status reads, as a client polls them (the views compute an ETA). */
const POLL_MS = 250;

function db(): Database {
  return testDb!.db as unknown as Database;
}

function handles() {
  return { db: db(), pool: testDb!.pool };
}

function ctx() {
  return { db: db(), rawConfig: harnessConfig(testDb!.connectionString) };
}

/** The DM keys only: no standing poll can come due during a long run. */
function dmRegistry(): EngineRegistry {
  return createEngineRegistry(["dm-messages.head", "dm-messages.catchup", "dm-messages.history"].map((key) => fanslyResourceSpec(key)!));
}

async function livePage(): Promise<number> {
  return (await seedHarnessPage(handles(), { mode: "live" })).pageId;
}

async function file(pageId: number, chats: readonly FakeChat[], depth: { kind: "all" } | { kind: "latest"; count: number }) {
  return submitHistoryRequest(ctx(), {
    pageId,
    requester: { kind: "owner_cli", userId: null },
    fans: chats.map((chat) => ({ kind: "fan" as const, platformUserId: chat.fanRef })),
    depth,
    reason: "history-requests test",
    idempotencyKey: randomUUID(),
  });
}

async function view(ref: string): Promise<HistoryRequestView> {
  return (await getHistoryRequest(ctx(), ref)).request;
}

/** A live actor over the chats: every read answered at once, S = 1 ms. */
async function liveActor(pageId: number, chats: FakeChats, onRead?: (req: FanslyWireRequest, index: number) => Promise<void>) {
  const transport = new ScriptedLiveTransport();
  const reads: FanslyWireRequest[] = [];
  transport.respond = (req) => chats.respond(req);
  transport.onHit = async (req) => {
    reads.push(req);
    await onRead?.(req, reads.length - 1);
  };
  const made = await makeTestActor({ db: db(), pageId, mode: "live", registry: dmRegistry(), transport, settingMs: 1 });
  return { made, reads };
}

async function historyReads(pageId: number): Promise<number> {
  const result = await testDb!.pool.query<{ n: number }>(
    "select count(*)::int as n from sync_attempts where page_id = $1 and resource = 'dm-messages.history' and class = 'requests' and sent_at is not null",
    [pageId],
  );
  return Number(result.rows[0]!.n);
}

const groupOf = (req: FanslyWireRequest) => new URL(req.url).searchParams.get("groupId")!;
const readsFor = (n: number) => Math.ceil(n / PAGE) + 1;

describe("history requests through the requests class", () => {
  it("20 ordinary fans, all: every fan ready by the empty page, in exactly Σ(⌈n/25⌉ + 1) reads", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await livePage();
    const chats = new FakeChats();
    const sizes = [0, 1, 7, 24, 25, 26, 40, 49, 50, 51, 60, 74, 75, 76, 99, 100, 101, 120, 149, 150];
    const fans = sizes.map((count) => chats.add({ count, ageMs: 30 * DAY }));
    for (const chat of fans) await seedChatThread(handles(), pageId, chat);
    const filed = await file(pageId, fans, { kind: "all" });
    expect(filed.request.counts).toMatchObject({ total: 20, queued: 20 });
    const lowerBound = filed.request.reads.remainingMin;

    const { made, reads } = await liveActor(pageId, chats);
    await runActorUntil(made, async () => (await view(filed.request.ref)).state === "done", 120_000, "the request done", POLL_MS);

    const expected = sizes.reduce((sum, n) => sum + readsFor(n), 0);
    expect(reads).toHaveLength(expected);
    expect(await historyReads(pageId)).toBe(expected);
    expect(lowerBound).toBeLessThanOrEqual(expected);
    const done = await getHistoryRequest(ctx(), filed.request.ref);
    expect(done.request).toMatchObject({ state: "done", counts: { total: 20, ready: 20 }, reads: { done: expected, remainingMin: 0 } });
    const byFan = new Map(done.items.map((item) => [item.fanPlatformUserId, item]));
    for (const [index, chat] of fans.entries()) {
      expect(byFan.get(chat.fanRef), `fan of ${sizes[index]} messages`).toMatchObject({
        state: "ready", satisfiedBy: "empty_page", readsSpent: readsFor(sizes[index]!), loadedMessages: sizes[index],
        historyState: "complete", historyProof: "empty_page",
      });
    }
    const stored = await testDb.pool.query<{ n: number }>("select count(*)::int as n from page_dm_messages where platform_account_id = $1", [pageId]);
    expect(stored.rows[0]!.n).toBe(sizes.reduce((sum, n) => sum + n, 0));
  }, 180_000);

  it(`a chat of ${LONG_CHAT} messages: ⌈n/25⌉ + 1 reads, reported monotonically; the lower bound holds and the estimate is near the fact`, async (context) => {
    if (!testDb) return context.skip();
    const pageId = await livePage();
    const chats = new FakeChats();
    // The hub holds the newest 1/28 of the chat (a legacy window, never
    // proven), spaced so that window spans more than the estimator's one-hour
    // density floor.
    const storedCount = LONG_CHAT / 28;
    const spacingMs = Math.max(2_000, Math.ceil(5_000_000 / storedCount));
    const chat = chats.add({ count: LONG_CHAT, ageMs: LONG_CHAT * spacingMs + DAY, spacingMs });
    await seedChatThread(handles(), pageId, chat, { stored: chat.messages.slice(-storedCount) });
    const filed = await file(pageId, [chat], { kind: "all" });
    const atSubmit = filed.request.reads;
    const expected = LONG_CHAT / PAGE + 1;
    // The stored window is re-read (unproven; the head read is its first
    // page), then the empty page.
    expect(atSubmit.remainingMin).toBe(storedCount / PAGE + 1);

    const progress: number[] = [];
    const { made } = await liveActor(pageId, chats);
    let lastLookMs = 0;
    await runActorUntil(made, async () => {
      // The status read every second, as a client would poll it.
      if (Date.now() - lastLookMs < 1_000) return false;
      lastLookMs = Date.now();
      const current = await view(filed.request.ref);
      progress.push(current.reads.done);
      return current.state === "done";
    }, 900_000, "the long request done", POLL_MS);

    expect(await historyReads(pageId)).toBe(expected);
    expect(progress.length).toBeGreaterThan(5);
    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index]!, `progress[${index}]`).toBeGreaterThanOrEqual(progress[index - 1]!);
    }
    expect(progress.at(-1)).toBe(expected);
    expect(atSubmit.remainingMin).toBeLessThanOrEqual(expected);
    // A uniform chat is the estimator's own model: within 5 % of the fact.
    expect(atSubmit.remainingEstimate).not.toBeNull();
    expect(Math.abs(atSubmit.remainingEstimate! - expected) / expected).toBeLessThanOrEqual(0.05);
    const [item] = (await getHistoryRequest(ctx(), filed.request.ref)).items;
    expect(item).toMatchObject({ state: "ready", satisfiedBy: "empty_page", readsSpent: expected, loadedMessages: LONG_CHAT });
  }, 960_000);

  it("a list of 20 next to a list of 500: turns alternate, the 20 finish after about twice their own reads, the 500 go on", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await livePage();
    const chats = new FakeChats();
    // Three reads a fan: the head, five below it, the empty page.
    const big = Array.from({ length: 500 }, () => chats.add({ count: 30, ageMs: 30 * DAY }));
    const small = Array.from({ length: 20 }, () => chats.add({ count: 30, ageMs: 30 * DAY }));
    for (const chat of [...big, ...small]) await seedChatThread(handles(), pageId, chat);
    const bigRequest = await file(pageId, big, { kind: "all" });
    const smallRequest = await file(pageId, small, { kind: "all" });
    const smallGroups = new Set(small.map((chat) => chat.groupId));
    const solo = small.length * readsFor(30);

    const { made, reads } = await liveActor(pageId, chats);
    await runActorUntil(made, async () => (await view(smallRequest.request.ref)).state === "done", 180_000, "the list of 20 done", POLL_MS);

    const owners = reads.map((req) => (smallGroups.has(groupOf(req)) ? "small" : "big"));
    const lastSmall = owners.lastIndexOf("small");
    // While both were open the class served them turn by turn.
    for (let index = 1; index <= lastSmall; index += 1) {
      expect(owners[index], `read ${index}`).not.toBe(owners[index - 1]);
    }
    expect(owners.filter((owner) => owner === "small")).toHaveLength(solo);
    expect(lastSmall + 1).toBeLessThanOrEqual(2 * solo + 1);
    expect(lastSmall + 1).toBeGreaterThanOrEqual(2 * solo - 1);
    const bigNow = await view(bigRequest.request.ref);
    expect(bigNow.state).toBe("open");
    expect(bigNow.reads.done).toBeGreaterThanOrEqual(solo - 1);
    expect(bigNow.reads.done).toBeLessThan(big.length * readsFor(30));
    // Alone now, the list of 500 keeps every turn.
    const before = bigNow.reads.done;
    const next = await liveActor(pageId, chats);
    await runActorUntil(next.made, async () => (await view(bigRequest.request.ref)).reads.done >= before + 50, 120_000, "50 more reads of the 500", POLL_MS);
    expect(next.reads.every((req) => !smallGroups.has(groupOf(req)))).toBe(true);
  }, 360_000);

  it("a cancel stops the reads to come and keeps every message and chain fact already loaded", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await livePage();
    const chats = new FakeChats();
    const chat = chats.add({ count: 500, ageMs: 30 * DAY });
    const threadId = await seedChatThread(handles(), pageId, chat);
    const filed = await file(pageId, [chat], { kind: "all" });
    let cancelled = false;
    // The cancel lands while the fifth read is on the wire.
    const { made, reads } = await liveActor(pageId, chats, async (_req, index) => {
      if (index !== 4) return;
      await cancelHistoryRequest(ctx(), filed.request.ref, { reason: "test cancel" });
      cancelled = true;
    });
    await runActorUntil(made, async () => {
      if (!cancelled) return false;
      // Give the actor time to pick again: nothing may be left to pick.
      await sleep(1_500);
      return true;
    }, 60_000, "the cancel and a quiet second and a half");

    expect(reads).toHaveLength(5);
    const after = await getHistoryRequest(ctx(), filed.request.ref);
    expect(after.request).toMatchObject({ state: "cancelled", counts: { cancelled: 1 } });
    const work = await testDb.pool.query<{ state: string }>(
      "select state from sync_work where page_id = $1 and resource = 'dm-messages.history'", [pageId]);
    expect(work.rows).toEqual([{ state: "cancelled" }]);
    // Five pages were read and applied; nothing of them was taken back.
    const thread = await testDb.pool.query<{ contiguous_count: number; stored: number }>(
      `select t.contiguous_count, (select count(*)::int from page_dm_messages m where m.conversation_id = t.id) as stored
         from page_dm_threads t where t.id = $1`,
      [threadId],
    );
    expect(thread.rows[0]).toEqual({ contiguous_count: 5 * PAGE, stored: 5 * PAGE });
  }, 90_000);

  it("latest N with full pages: exactly ⌈N/25⌉ reads, inside the request's own bounds", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await livePage();
    const chats = new FakeChats();
    const chat = chats.add({ count: 200, ageMs: 30 * DAY });
    await seedChatThread(handles(), pageId, chat);
    const filed = await file(pageId, [chat], { kind: "latest", count: 60 });
    const lowerBound = filed.request.reads.remainingMin;
    const { made, reads } = await liveActor(pageId, chats);
    await runActorUntil(made, async () => (await view(filed.request.ref)).state === "done", 60_000, "the request done", POLL_MS);

    expect(reads).toHaveLength(Math.ceil(60 / PAGE));
    expect(lowerBound).toBeLessThanOrEqual(reads.length);
    // The bound with full pages (design §7.2): the head, ⌈N/25⌉, the end check.
    expect(reads.length).toBeLessThanOrEqual(1 + Math.ceil(60 / PAGE) + 1);
    // The fan counts the N it asked for; the chat holds the three full pages.
    const [item] = (await getHistoryRequest(ctx(), filed.request.ref)).items;
    expect(item).toMatchObject({ state: "ready", satisfiedBy: "latest_n", readsSpent: 3, loadedMessages: 60, anchorMessageRef: chat.messages.at(-1)!.id });
    const stored = await testDb.pool.query<{ n: number }>("select count(*)::int as n from page_dm_messages where platform_account_id = $1", [pageId]);
    expect(stored.rows[0]!.n).toBe(3 * PAGE);
  }, 90_000);
});
