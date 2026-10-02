import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { upsertDemand, upsertFans, type Database } from "@agency_hub_core/db";
import type { FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";

import { createEngineRegistry, type EngineRegistry, type ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { DM_LIST_WS_DOWN_EVERY_MS } from "../apps/runtime/src/sync/fansly/resources/dm-conversations.ts";
import { REPAIR_LIST_SPACING_MS } from "../apps/runtime/src/sync/fansly/resources/repair.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import {
  makeTestActor,
  okResponse,
  ScriptedLiveTransport,
  seedSyncPage,
  statusResponse,
  testSpec,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// The socket-gap reads of a live page (design S3-04 items 5 and 8, G10, G17,
// E19): `repair.ws-gap` and `dm-conversations.ws-down` through the real actor
// and commits against a real database, a scripted transport answering the
// conversation list. The work a repair asks for (`dm-messages.head`,
// `transactions.head`, `subscribers.poll`) is served by stand-ins that read
// `/polls`, so only the repair's own walk is under test. Pinned: a pass takes
// its window from the unreconciled verified connections (or the work's first
// demand), reads the list down to the first chat older than the window with
// pages ≥ 5 s apart, asks for an urgent head read of every chat that moved and
// for money and subscribers, waits for them, stamps every connection it
// covered; a reconnect during a pass starts a new pass that stamps the new
// connection too; a list 429 holds only the list. `.ws-down` reads the list
// head while no live, verified socket exists — a row left open by a killed
// process (its guard stale) is not one.

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

function db(): Database {
  return testDb!.db as unknown as Database;
}

const OWN_ID = "300000000000000001";
const MINUTE = 60_000;
const GENERATION = "a".repeat(64);

const pad = (n: number, width: number) => String(n).padStart(width, "0");
const groupOf = (n: number) => `71000000000${pad(n, 7)}`;
const fanOf = (n: number) => `51000000000${pad(n, 7)}`;
const messageOf = (n: number, k = 0) => `91${pad(k, 3)}00000${pad(n, 8)}`;

interface Chat {
  n: number;
  headId: string;
  headAtMs: number;
}

/** One `/messaging/groups` answer for these chats (newest first, as served). */
function listPage(chats: readonly Chat[]) {
  return {
    data: chats.map((chat) => ({
      account_id: OWN_ID,
      groupId: groupOf(chat.n),
      partnerAccountId: fanOf(chat.n),
      partnerUsername: `fan${chat.n}`,
      flags: 0,
      unreadCount: 0,
      subscriptionTierId: null,
      lastMessageId: chat.headId,
      lastUnreadMessageId: null,
    })),
    aggregationData: {
      accounts: chats.map((chat) => ({ id: fanOf(chat.n), username: `fan${chat.n}`, displayName: null, createdAt: Date.UTC(2025, 0, 1) })),
      groups: chats.map((chat) => ({
        id: groupOf(chat.n),
        type: 1,
        groupFlags: 0,
        createdBy: OWN_ID,
        users: [
          { groupId: groupOf(chat.n), userId: OWN_ID, type: 0, permissionFlags: 0 },
          { groupId: groupOf(chat.n), userId: fanOf(chat.n), type: 0, permissionFlags: 0 },
        ],
        lastMessage: {
          id: chat.headId, type: 1, dataVersion: 1, content: `message ${chat.headId}`, groupId: groupOf(chat.n),
          senderId: fanOf(chat.n), correlationId: null, inReplyTo: null, inReplyToRoot: null, createdAt: chat.headAtMs,
          attachments: [], embeds: [], interactions: [], likes: [],
        },
      })),
    },
  };
}

/** Bound threads whose reads reached `messageOf(n)` (a list head with k > 0 moved). */
async function seedThreads(pageId: number, ns: readonly number[]): Promise<void> {
  const fans = await upsertFans(db(), ns.map((n) => ({ platform: "fansly" as const, platformUserId: fanOf(n) })));
  const fanIds = new Map(fans.map((fan) => [fan.platformUserId, fan.id] as const));
  for (const n of ns) {
    await testDb!.pool.query(
      `insert into page_dm_threads (platform_account_id, platform_conversation_id, fan_id, partner_platform_user_id,
              partner_username, conversation_flags, unread_count, last_message_id, last_message_at, last_message_sender_id,
              last_message_sender_role, last_message_preview, newest_stored_message_id, stored_message_count,
              message_coverage_status, is_visible, metadata)
       values ($1, $2, $3, $4, $5, 0, 0, $6, clock_timestamp() - interval '3 days', $4, 'fan', 'stored', $6, 3,
               'partial_window', true, '{}'::jsonb)`,
      [pageId, groupOf(n), fanIds.get(fanOf(n)), fanOf(n), `fan${n}`, messageOf(n)],
    );
  }
}

async function seedPage(): Promise<number> {
  const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" });
  await testDb!.pool.query("update pages set external_page_id = $2 where id = $1", [pageId, OWN_ID]);
  await testDb!.pool.query(
    "update sync_pages set legacy_imported_at = clock_timestamp() - interval '1 day', mode_changed_at = clock_timestamp() - interval '1 day' where page_id = $1",
    [pageId],
  );
  return pageId;
}

/** A socket connection row, `*AgoMs` before now (null: not set). */
async function connection(pageId: number, input: { gapAgoMs: number; verifiedAgoMs: number | null; closedAgoMs?: number | null; guardAgoMs?: number }) {
  const id = randomUUID();
  await testDb!.pool.query(
    `insert into fansly_ws_connections (id, page_id, generation, started_at, gap_since, verified_at, last_guard_at, closed_at, stop_reason)
     values ($1, $2, $3,
             clock_timestamp() - ($4::double precision - 500) * interval '1 millisecond',
             clock_timestamp() - $4::double precision * interval '1 millisecond',
             case when $5::double precision is null then null else clock_timestamp() - $5::double precision * interval '1 millisecond' end,
             clock_timestamp() - $6::double precision * interval '1 millisecond',
             case when $7::double precision is null then null else clock_timestamp() - $7::double precision * interval '1 millisecond' end,
             case when $7::double precision is null then null else 'closed' end)`,
    [id, pageId, GENERATION, input.gapAgoMs, input.verifiedAgoMs, input.guardAgoMs ?? 0, input.closedAgoMs ?? null],
  );
  return id;
}

async function connections(pageId: number) {
  const result = await testDb!.pool.query<{ id: string; reconciled: boolean; lower_is_gap: boolean; upper_is_verified: boolean; empty: boolean | null }>(
    `select id::text, state_reconciled_at is not null as reconciled,
            lower(transient_unknown) = gap_since as lower_is_gap,
            upper(transient_unknown) = verified_at as upper_is_verified,
            isempty(transient_unknown) as empty
       from fansly_ws_connections where page_id = $1 order by started_at`,
    [pageId],
  );
  return result.rows;
}

/** A stand-in for a key the repair asks for: one `/polls` read, then done. */
function oneRead(gate: () => boolean = () => true): ResourceModule {
  return {
    async plan(_work, ctx) {
      return gate()
        ? { kind: "request", request: { spec: "polls", params: {} } }
        : { kind: "wait", reason: "dependency", until: new Date(ctx.now.getTime() + 100) };
    },
    async apply() {
      return { work: { satisfiesRevision: true, close: "done", closeReason: "stand_in" }, followups: [] };
    },
    async shadow() {
      return { work: { satisfiesRevision: true, close: "done" }, followups: [] };
    },
  };
}

function registry(options: { moneyGate?: () => boolean } = {}): EngineRegistry {
  return createEngineRegistry([
    fanslyResourceSpec("repair.ws-gap")!,
    fanslyResourceSpec("dm-conversations.ws-down")!,
    testSpec("dm-messages.head", oneRead(), { fence: "dm_archive" }),
    testSpec("transactions.head", oneRead(options.moneyGate), { fence: "dm_archive" }),
    testSpec("subscribers.poll", oneRead(), { kind: "poll", class: "planned", period: { everyMs: 3_600_000 } }),
  ]);
}

async function demand(pageId: number, resource: string, subject = "") {
  const spec = fanslyResourceSpec(resource)!;
  await upsertDemand(db(), { pageId, shadow: false, resource, subject, kind: spec.kind, class: spec.class, demand: { reasons: ["test"] } });
}

async function workRow(pageId: number, resource: string) {
  const result = await testDb!.pool.query<{
    id: string; state: string; close_reason: string | null; result: Record<string, unknown> | null; cursor: Record<string, unknown>;
    first_demand_at: Date; due_at: Date; demand: { reasons: string[] }; class: string; waiting_reason: string | null;
  }>(
    `select id::text, state, close_reason, result, cursor, first_demand_at, due_at, demand, class, waiting_reason
       from sync_work where page_id = $1 and resource = $2 and not shadow order by id desc limit 1`,
    [pageId, resource],
  );
  return result.rows[0] ?? null;
}

async function listOffsets(pageId: number, resource: string) {
  const result = await testDb!.pool.query<{ offset: number; step: Record<string, unknown> | null; sent_at: Date; http_status: number }>(
    `select (request->'params'->>'offset')::int as offset, request->'step' as step, sent_at, http_status
       from sync_attempts where page_id = $1 and resource = $2 and sent_at is not null order by id`,
    [pageId, resource],
  );
  return result.rows;
}

type Responder = (req: FanslyWireRequest, index: number) => FanslyWireOutcome;

async function run(pageId: number, reg: EngineRegistry, respond: Responder, done: () => Promise<boolean>, timeoutMs = 30_000) {
  const transport = new ScriptedLiveTransport();
  transport.respond = respond;
  const { actor, stop, abort } = await makeTestActor({ db: db(), pageId, mode: "live", registry: reg, transport, ownRef: OWN_ID });
  const running = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => ((await done()) ? true : null), timeoutMs, "the repair to settle");
  } finally {
    stop.abort();
    await running;
  }
  return transport;
}

const offsetOf = (req: FanslyWireRequest) => Number(new URL(req.url).searchParams.get("offset"));
const polls = () => okResponse([]);

describe("repair.ws-gap", () => {
  it("reads the list down to the window's start, reads every moved chat now, bumps money and subscribers, waits, and stamps every gap", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const now = Date.now();
    // A connection that closed after its gap, and the one that came up since.
    const first = await connection(pageId, { gapAgoMs: 15 * MINUTE, verifiedAgoMs: 15 * MINUTE - 1_000, closedAgoMs: 10 * MINUTE });
    const second = await connection(pageId, { gapAgoMs: 10 * MINUTE, verifiedAgoMs: 1_000 });
    // The window starts 16 min ago. Page 1: 100 chats inside it, 3 moved.
    // Page 2: 100 chats, 2 moved inside it, then older ones: the walk stops.
    const page1: Chat[] = Array.from({ length: 100 }, (_, i) => ({ n: 100 + i, headId: messageOf(100 + i, i < 3 ? 1 : 0), headAtMs: now - (5 * MINUTE + i * 1_000) }));
    const page2: Chat[] = Array.from({ length: 100 }, (_, i) => ({
      n: 300 + i,
      headId: messageOf(300 + i, i < 2 ? 1 : 0),
      headAtMs: i < 50 ? now - 12 * MINUTE : now - 3 * 3_600_000,
    }));
    await seedThreads(pageId, [...page1, ...page2].map((chat) => chat.n));
    await demand(pageId, "repair.ws-gap");

    const transport = await run(pageId, registry(), (req) => {
      if (req.spec === "messaging.groups") return okResponse(listPage(offsetOf(req) === 0 ? page1 : page2));
      return polls();
    }, async () => (await workRow(pageId, "repair.ws-gap"))?.state === "done");

    const reads = await listOffsets(pageId, "repair.ws-gap");
    expect(reads.map((read) => read.offset)).toEqual([0, 100]);
    expect(reads[1]!.sent_at.getTime() - reads[0]!.sent_at.getTime()).toBeGreaterThanOrEqual(REPAIR_LIST_SPACING_MS);
    const listHits = transport.hits.filter((hit) => hit.spec === "messaging.groups");
    expect(listHits[1]!.mono - listHits[0]!.mono).toBeGreaterThanOrEqual(REPAIR_LIST_SPACING_MS);
    // The pass's window travels with its first step.
    const pass = (reads[0]!.step as { repair: { pass: { since: string; targets: string[] } } }).repair.pass;
    expect(pass.targets).toEqual([first, second]);
    expect(Math.abs(Date.parse(pass.since) - (now - 16 * MINUTE))).toBeLessThan(5_000);

    // Every moved chat was read at once (urgent), and money and subscribers.
    const heads = await testDb.pool.query<{ subject: string; class: string; state: string; reasons: string[] }>(
      `select subject, class, state, demand->'reasons' as reasons from sync_work
        where page_id = $1 and resource = 'dm-messages.head' order by subject`, [pageId]);
    expect(heads.rows.map((row) => row.subject)).toEqual([100, 101, 102, 300, 301].map(groupOf));
    for (const row of heads.rows) expect(row).toMatchObject({ class: "urgent", state: "done", reasons: ["list_head:repair.ws-gap"] });
    expect(await workRow(pageId, "transactions.head")).toMatchObject({ state: "done", demand: { reasons: ["ws_gap"] } });
    const subscribers = await testDb.pool.query<{ served: boolean }>(
      "select applied_revision = demand_revision and applied_revision > 1 as served from sync_work where page_id = $1 and resource = 'subscribers.poll'", [pageId]);
    expect(subscribers.rows).toEqual([{ served: true }]);

    expect(await connections(pageId)).toEqual([
      { id: first, reconciled: true, lower_is_gap: true, upper_is_verified: true, empty: false },
      { id: second, reconciled: true, lower_is_gap: true, upper_is_verified: true, empty: false },
    ]);
    expect(await workRow(pageId, "repair.ws-gap")).toMatchObject({
      close_reason: "gap_reconciled",
      result: { targets: 2, stamped: 2, listPages: 2, asked: 7 },
    });
  }, 60_000);

  it("a reconnect during a pass starts a new pass, which stamps the new connection too", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const now = Date.now();
    const first = await connection(pageId, { gapAgoMs: 5 * MINUTE, verifiedAgoMs: 4 * MINUTE });
    const chats: Chat[] = [{ n: 1, headId: messageOf(1), headAtMs: now - 10 * MINUTE }];
    await seedThreads(pageId, [1]);
    await demand(pageId, "repair.ws-gap");
    let released = false;
    let second: string | undefined;
    const transport = new ScriptedLiveTransport();
    transport.respond = (req) => (req.spec === "messaging.groups" ? okResponse(listPage(chats)) : polls());
    const { actor, stop, abort } = await makeTestActor({
      db: db(), pageId, mode: "live", registry: registry({ moneyGate: () => released }), transport, ownRef: OWN_ID,
    });
    const running = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      // The pass waits for the money head; the socket reconnects meanwhile.
      await waitFor(async () => ((await workRow(pageId, "repair.ws-gap"))?.cursor.phase === "wait" ? true : null), 30_000, "the first pass waiting");
      second = await connection(pageId, { gapAgoMs: 30_000, verifiedAgoMs: 1_000 });
      await demand(pageId, "repair.ws-gap");
      released = true;
      await waitFor(async () => ((await workRow(pageId, "repair.ws-gap"))?.state === "done" ? true : null), 30_000, "the second pass");
    } finally {
      stop.abort();
      await running;
    }
    const reads = await listOffsets(pageId, "repair.ws-gap");
    expect(reads.map((read) => (read.step as { repair: { pass: { targets: string[] } } }).repair.pass.targets)).toEqual([[first], [second]]);
    expect((await connections(pageId)).map((row) => [row.id, row.reconciled])).toEqual([[first, true], [second, true]]);
    expect(await workRow(pageId, "repair.ws-gap")).toMatchObject({ close_reason: "gap_reconciled", result: { targets: 1, stamped: 1 } });
  }, 60_000);

  it("a repair the router asked for without a connection reads back from its first demand − 60 s and stamps nothing", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const now = Date.now();
    const chats: Chat[] = Array.from({ length: 100 }, (_, i) => ({
      n: 500 + i,
      headId: messageOf(500 + i, i === 0 ? 1 : 0),
      headAtMs: i < 2 ? now - 20_000 : now - 3 * 3_600_000,
    }));
    await seedThreads(pageId, chats.map((chat) => chat.n));
    await demand(pageId, "repair.ws-gap");
    const row = await workRow(pageId, "repair.ws-gap");
    await run(pageId, registry(), (req) => (req.spec === "messaging.groups" ? okResponse(listPage(chats)) : polls()),
      async () => (await workRow(pageId, "repair.ws-gap"))?.state === "done");
    const reads = await listOffsets(pageId, "repair.ws-gap");
    expect(reads.map((read) => read.offset)).toEqual([0]);
    const pass = (reads[0]!.step as { repair: { pass: { since: string; targets: string[] } } }).repair.pass;
    expect(pass.targets).toEqual([]);
    expect(Date.parse(pass.since)).toBe(row!.first_demand_at.getTime() - 60_000);
    expect(await workRow(pageId, "repair.ws-gap")).toMatchObject({ close_reason: "gap_reconciled", result: { targets: 0, stamped: 0, listPages: 1 } });
    expect((await workRow(pageId, "dm-messages.head"))).toMatchObject({ state: "done" });
  }, 60_000);

  it("a list 429 holds only the list: the chat and money reads still go out, the repair goes on after the hold", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    await connection(pageId, { gapAgoMs: 2 * MINUTE, verifiedAgoMs: MINUTE });
    await seedThreads(pageId, [1]);
    await demand(pageId, "repair.ws-gap");
    let lists = 0;
    const transport = await run(pageId, registry(), (req) => {
      if (req.spec !== "messaging.groups") return polls();
      lists += 1;
      if (lists === 1) {
        // While the list is held, other reads of the page are asked for.
        void demand(pageId, "dm-messages.head", groupOf(1));
        void demand(pageId, "transactions.head");
        return statusResponse(429, { success: false, error: { code: 429 } });
      }
      return okResponse(listPage([{ n: 1, headId: messageOf(1), headAtMs: Date.now() - 3 * 3_600_000 }]));
    }, async () => (await workRow(pageId, "repair.ws-gap"))?.state === "done", 45_000);

    const order = transport.hits.map((hit) => hit.spec);
    const firstList = order.indexOf("messaging.groups");
    const secondList = order.indexOf("messaging.groups", firstList + 1);
    expect(secondList).toBeGreaterThan(firstList);
    // Both other reads went out inside the list's hold.
    expect(order.slice(firstList + 1, secondList).filter((spec) => spec === "polls").length).toBeGreaterThanOrEqual(2);
    const page = await testDb.pool.query<{ hold_kind: string | null; list_hold: string | null }>(
      "select hold_kind, resource_holds->'dm-conversations'->>'kind' as list_hold from sync_pages where page_id = $1", [pageId]);
    expect(page.rows).toEqual([{ hold_kind: null, list_hold: "rate_limit_list" }]);
    expect((await listOffsets(pageId, "repair.ws-gap")).map((read) => read.http_status)).toEqual([429, 200]);
  }, 60_000);
});

describe("dm-conversations.ws-down", () => {
  it("reads the list head every 30 s while no live, verified socket exists, and closes once one is up", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    // A row a killed process left open: verified, never closed, its guard stale.
    await connection(pageId, { gapAgoMs: 20 * MINUTE, verifiedAgoMs: 19 * MINUTE, guardAgoMs: 5 * MINUTE });
    await demand(pageId, "dm-conversations.ws-down");
    const before = Date.now();
    await run(pageId, registry(), (req) => (req.spec === "messaging.groups" ? okResponse(listPage([])) : polls()),
      async () => (await listOffsets(pageId, "dm-conversations.ws-down")).length === 1
        && (await workRow(pageId, "dm-conversations.ws-down"))?.state === "open");
    const down = await workRow(pageId, "dm-conversations.ws-down");
    expect(down!.due_at.getTime() - before).toBeGreaterThanOrEqual(DM_LIST_WS_DOWN_EVERY_MS - 1_000);
    expect(down!.due_at.getTime() - Date.now()).toBeLessThanOrEqual(DM_LIST_WS_DOWN_EVERY_MS);

    // The socket comes back (a fresh guard): the next turn closes the work
    // without a read.
    await connection(pageId, { gapAgoMs: 30_000, verifiedAgoMs: 1_000, guardAgoMs: 0 });
    await testDb.pool.query("update sync_work set due_at = clock_timestamp() where id = $1", [down!.id]);
    await run(pageId, registry(), () => {
      throw new Error("no read while the socket is up");
    }, async () => (await workRow(pageId, "dm-conversations.ws-down"))?.state === "done");
    expect(await workRow(pageId, "dm-conversations.ws-down")).toMatchObject({ close_reason: "socket_up" });
    expect(await listOffsets(pageId, "dm-conversations.ws-down")).toHaveLength(1);
  }, 60_000);
});
