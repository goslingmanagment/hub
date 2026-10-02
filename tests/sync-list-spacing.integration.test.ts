import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensurePollRows, getSyncPage, upsertDemand, upsertFans, type Database } from "@agency_hub_core/db";
import type { FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";

import { LIST_SPACING_MS, LIST_SPACING_URGENT_HEAD_START_MS } from "../apps/runtime/src/sync/engine/errors.ts";
import { createEngineRegistry, pollsFor, type EngineRegistry, type ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { fanslyCaptureCodec } from "../apps/runtime/src/sync/fansly/capture.ts";
import { FANSLY_RESOURCE_SPECS, fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import {
  makeTestActor,
  okResponse,
  RecordingAlerts,
  RecordingMetrics,
  ScriptedLiveTransport,
  seedSyncPage,
  testSpec,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// Owner decision №14 («редко + мягкий 429»), 2026-10-03: the daily full walk
// and the 30-min head walk went page to page at the page pace (prod shadow:
// lora-1 80 list pages at p50 2.82 s), the 2026-10-01 pattern that drew three
// 429s on `/messaging/groups`. Through the real actor, the real list module
// and commits against a real database, pinned: two requests on the list route
// of one page are never admitted closer than 5 s, whatever key reads it,
// while other work keeps the page pace in between; a new fan's `.find`
// arriving during the walk takes the list before the walk's next page (urgent
// first), waits one spacing at most and is found inside its 12 s; a burst of
// `.find`s shares one list read; a walk page whose P slot comes up while a
// `.find` is due yields the list to it.

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
const NOW_MS = Date.now();
const HOUR = 3_600_000;
const FULL = "dm-conversations.full";
const FIND = "dm-conversations.find";

const pad = (n: number, width: number) => String(n).padStart(width, "0");
const groupOf = (n: number) => `72000000000${pad(n, 7)}`;
const fanOf = (n: number) => `52000000000${pad(n, 7)}`;
const messageOf = (n: number, k = 0) => `92${pad(k, 3)}00000${pad(n, 8)}`;

interface Chat {
  n: number;
  headId: string;
  headAtMs: number;
}

function fanAccount(id: string) {
  return { id, username: `fan${id.slice(-4)}`, displayName: `Fan ${id.slice(-4)}`, createdAt: Date.UTC(2025, 0, 1) };
}

/** One `/messaging/groups` answer for these chats. */
function listPage(chats: readonly Chat[]) {
  return {
    data: chats.map((chat) => ({
      account_id: OWN_ID,
      groupId: groupOf(chat.n),
      partnerAccountId: fanOf(chat.n),
      partnerUsername: `fan${fanOf(chat.n).slice(-4)}`,
      flags: 0,
      unreadCount: 0,
      subscriptionTierId: null,
      lastMessageId: chat.headId,
      lastUnreadMessageId: null,
    })),
    aggregationData: {
      accounts: chats.map((chat) => fanAccount(fanOf(chat.n))),
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

function groupDetail(n: number, head: { id: string; atMs: number }) {
  return {
    id: groupOf(n),
    type: 1,
    groupFlags: 0,
    createdBy: OWN_ID,
    users: [OWN_ID, fanOf(n)].map((userId) => ({ groupId: groupOf(n), userId, type: 0, permissionFlags: 0 })),
    lastMessage: {
      id: head.id, type: 1, dataVersion: 1, content: "hello", groupId: groupOf(n), senderId: fanOf(n),
      correlationId: null, inReplyTo: null, inReplyToRoot: null, createdAt: head.atMs,
      attachments: [], embeds: [], interactions: [], likes: [],
    },
  };
}

async function seedPage(): Promise<number> {
  const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" });
  await testDb!.pool.query(
    "update pages set external_page_id = $2, last_verified_at = clock_timestamp() - interval '1 minute' where id = $1",
    [pageId, OWN_ID],
  );
  await testDb!.pool.query(
    `update sync_pages set legacy_imported_at = clock_timestamp() - interval '1 hour',
            mode_changed_at = clock_timestamp() - interval '1 hour'
      where page_id = $1`,
    [pageId],
  );
  return pageId;
}

/** Threads exactly as the list serves them: the walk asks for no reads. */
async function seedThreads(pageId: number, chats: readonly Chat[]): Promise<void> {
  const fans = await upsertFans(db(), chats.map((chat) => ({ platform: "fansly" as const, platformUserId: fanOf(chat.n) })));
  const fanIds = new Map(fans.map((fan) => [fan.platformUserId, fan.id] as const));
  for (const chat of chats) {
    await testDb!.pool.query(
      `insert into page_dm_threads (platform_account_id, platform_conversation_id, fan_id, partner_platform_user_id,
              partner_username, conversation_flags, unread_count, last_message_id, last_message_at, last_message_sender_id,
              last_message_sender_role, last_message_preview, newest_stored_message_id, stored_message_count,
              message_coverage_status, last_message_sync_at, is_visible, metadata)
       values ($1, $2, $3, $4, $5, 0, 0, $6, to_timestamp($7::double precision / 1000), $4,
               'fan'::dm_sender_role, 'stored preview', $6, 1, 'partial_window', timestamptz '2026-09-01T00:00:00Z', true, '{}'::jsonb)`,
      [pageId, groupOf(chat.n), fanIds.get(fanOf(chat.n)) ?? null, fanOf(chat.n), `fan${fanOf(chat.n).slice(-4)}`, chat.headId, chat.headAtMs],
    );
  }
}

/** A stand-in that reads `/polls` once, then is done. */
function oneRead(): ResourceModule {
  return {
    async plan() {
      return { kind: "request", request: { spec: "polls", params: {} } };
    },
    async apply() {
      return { work: { satisfiesRevision: true, close: "done", closeReason: "stand_in" }, followups: [] };
    },
    async shadow() {
      return { work: { satisfiesRevision: true, close: "done" }, followups: [] };
    },
  };
}

/** A stand-in that keeps reading `/polls` as fast as the page pace lets it. */
function busy(): ResourceModule {
  return {
    async plan() {
      return { kind: "request", request: { spec: "polls", params: {} } };
    },
    async apply(_tx, input) {
      return { work: { satisfiesRevision: false, nextDueAt: input.now }, followups: [] };
    },
    async shadow(_work, _request, ctx) {
      return { work: { satisfiesRevision: false, nextDueAt: ctx.now }, followups: [] };
    },
  };
}

/** Every Fansly entry with its standing polls parked far ahead; the money
 *  head is a busy planned stand-in and a chat's message read a one-read
 *  stand-in. */
async function registry(pageId: number): Promise<EngineRegistry> {
  const reg = createEngineRegistry([
    ...FANSLY_RESOURCE_SPECS.filter((spec) => spec.key !== "transactions.head" && spec.key !== "dm-messages.head"),
    // Planned: an urgent stand-in that is always due would take every slot
    // from `.find` (urgent picks go by deadline, then the oldest demand).
    testSpec("transactions.head", busy(), { kind: "goal", class: "planned", fence: "dm_archive" }),
    testSpec("dm-messages.head", oneRead(), { fence: "dm_archive" }),
  ]);
  const page = await getSyncPage(db(), pageId);
  await ensurePollRows(db(), { pageId, shadow: false, polls: pollsFor(reg, page!, false).map((poll) => ({ ...poll, phase: 0.999 })) });
  return reg;
}

async function demand(reg: EngineRegistry, pageId: number, resource: string, subject = ""): Promise<void> {
  const spec = reg.spec(resource)!;
  await upsertDemand(db(), { pageId, shadow: false, resource, subject, kind: spec.kind, class: spec.class, demand: { reasons: ["test"] } });
}

interface Attempt {
  id: number;
  resource: string;
  subject: string;
  operation: string;
  admitted_at: Date;
  sent_at: Date | null;
  completed_at: Date | null;
  http_status: number | null;
}

async function attemptsOf(pageId: number): Promise<Attempt[]> {
  const result = await testDb!.pool.query<Attempt>(
    `select id::int as id, resource, subject, operation, admitted_at, sent_at, completed_at, http_status
       from sync_attempts where page_id = $1 order by id`,
    [pageId],
  );
  return result.rows;
}

async function workRow(pageId: number, resource: string) {
  const result = await testDb!.pool.query<{
    state: string; cursor: Record<string, unknown>; close_reason: string | null; first_demand_at: Date; closed_at: Date | null;
  }>(
    `select state, cursor, close_reason, first_demand_at, closed_at
       from sync_work where page_id = $1 and resource = $2 and not shadow order by id desc limit 1`,
    [pageId, resource],
  );
  return result.rows[0] ?? null;
}

async function workRowOf(pageId: number, resource: string, subject: string) {
  const result = await testDb!.pool.query<{
    state: string; class: string; close_reason: string | null; first_demand_at: Date; closed_at: Date | null;
    demand: { reasons?: string[] };
  }>(
    `select state, class, close_reason, first_demand_at, closed_at, demand
       from sync_work where page_id = $1 and resource = $2 and subject = $3 and not shadow order by id desc limit 1`,
    [pageId, resource, subject],
  );
  return result.rows[0] ?? null;
}

function offsetOf(req: FanslyWireRequest): number {
  return Number(new URL(req.url).searchParams.get("offset"));
}

/** Every pair of consecutive list attempts is ≥ the spacing apart: the next
 *  admission after the previous one's last instant (database clock), and the
 *  sends (the engine's clock). */
function expectSpaced(list: readonly Attempt[]): void {
  for (let i = 1; i < list.length; i += 1) {
    const previous = list[i - 1]!;
    const previousLast = Math.max(previous.admitted_at.getTime(), previous.completed_at?.getTime() ?? 0);
    expect(list[i]!.admitted_at.getTime() - previousLast, `admission ${i}`).toBeGreaterThanOrEqual(LIST_SPACING_MS);
    if (list[i]!.sent_at !== null && previous.sent_at !== null) {
      expect(list[i]!.sent_at!.getTime() - previous.sent_at.getTime(), `send ${i}`).toBeGreaterThanOrEqual(LIST_SPACING_MS);
    }
  }
}

describe("list spacing (owner decision №14)", () => {
  it("a full walk reads the list ≥ 5 s apart, other work at the page pace between; a .find during it takes the list first, inside its 12 s", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const at = NOW_MS - 2 * HOUR;
    // Two full pages and a short one.
    const chats = Array.from({ length: 250 }, (_, index) => ({ n: 1000 + index, headId: messageOf(1000 + index), headAtMs: at }));
    await seedThreads(pageId, chats);
    const reg = await registry(pageId);
    await demand(reg, pageId, FULL);
    await demand(reg, pageId, "transactions.head");

    const NEW_CHAT = 5000;
    const newMessage = { id: messageOf(NEW_CHAT, 7), atMs: NOW_MS - 30_000 };
    let findAsked = false;
    const transport = new ScriptedLiveTransport();
    transport.respond = (req): FanslyWireOutcome => {
      if (req.spec === "messaging.groups") {
        const offset = offsetOf(req);
        return okResponse(listPage(chats.slice(offset, offset + 100)));
      }
      if (req.spec === "group.detail") return okResponse(groupDetail(NEW_CHAT, newMessage));
      return okResponse();
    };
    // A message in a chat nobody knows arrives while the walk's second page
    // is in flight.
    transport.onHit = async (req) => {
      if (req.spec === "messaging.groups" && offsetOf(req) === 100 && !findAsked) {
        findAsked = true;
        await demand(reg, pageId, FIND, groupOf(NEW_CHAT));
      }
    };
    const metrics = new RecordingMetrics();
    const { actor, stop, abort } = await makeTestActor({
      db: db(), pageId, mode: "live", registry: reg, transport, ownRef: OWN_ID, capture: fanslyCaptureCodec, alerts: new RecordingAlerts(), metrics,
    });
    const running = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      await waitFor(async () => {
        const walk = await workRow(pageId, FULL);
        const find = await workRow(pageId, FIND);
        return walk?.cursor.last != null && find?.state === "done" ? true : null;
      }, 60_000, "the walk and the find to settle");
    } finally {
      stop.abort();
      await running;
    }

    const all = await attemptsOf(pageId);
    const list = all.filter((attempt) => attempt.operation === "messaging.groups");
    // The find took the list before the walk's next page.
    expect(list.map((attempt) => attempt.resource)).toEqual([FULL, FULL, FIND, FULL]);
    expect(list.every((attempt) => attempt.http_status === 200)).toBe(true);
    expectSpaced(list);
    // A walk page the spacing put off came due the head start later than an
    // urgent read would (the database clock; a few ms of the step's own reads).
    for (const i of [1, 3]) {
      const previous = list[i - 1]!;
      const previousLast = Math.max(previous.admitted_at.getTime(), previous.completed_at?.getTime() ?? 0);
      expect(list[i]!.admitted_at.getTime() - previousLast, `walk page ${i}`)
        .toBeGreaterThanOrEqual(LIST_SPACING_MS + LIST_SPACING_URGENT_HEAD_START_MS - 50);
    }
    // Other work went out between every two list reads at the page pace (the
    // test pause is 30 ms): never a 5 s stall of the page.
    for (let i = 1; i < list.length; i += 1) {
      const between = all.filter((attempt) => attempt.id > list[i - 1]!.id && attempt.id < list[i]!.id);
      expect(between.length, `other reads between list reads ${i - 1} and ${i}`).toBeGreaterThanOrEqual(5);
    }
    const polls = transport.hits.filter((hit) => hit.spec === "polls");
    const gaps = polls.slice(1).map((hit, i) => hit.mono - polls[i]!.mono);
    expect(Math.max(...gaps)).toBeLessThan(LIST_SPACING_MS / 2);
    expect(metrics.get("sync_endpoint_spaced")).toBeGreaterThan(0);

    // The walk went to its short page and hid nothing.
    const walk = await workRow(pageId, FULL);
    expect(walk!.cursor).toMatchObject({ walk: null, last: { pageCount: 3, observedCount: 250 } });

    // The find waited one spacing at most, then its group detail went out at
    // the page pace (not spaced), all inside its 12 s.
    const find = await workRow(pageId, FIND);
    expect(find).toMatchObject({ state: "done", close_reason: "found_by_detail" });
    const findList = list[2]!;
    const waitedMs = findList.admitted_at.getTime() - find!.first_demand_at.getTime();
    expect(waitedMs).toBeLessThanOrEqual(LIST_SPACING_MS + 1_000);
    const detail = all.find((attempt) => attempt.resource === FIND && attempt.operation === "group.detail");
    expect(detail).toBeDefined();
    expect(detail!.admitted_at.getTime() - findList.completed_at!.getTime()).toBeLessThan(LIST_SPACING_MS / 2);
    expect(find!.closed_at!.getTime() - find!.first_demand_at.getTime()).toBeLessThan(fanslyResourceSpec(FIND)!.slo!.resultMs!);
  }, 90_000);
  it("a burst of .finds shares one list read: every chat it listed is found with no request, the rest go to their detail, all inside 12 s", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const at = NOW_MS - 2 * HOUR;
    const known = Array.from({ length: 30 }, (_, index) => ({ n: 1000 + index, headId: messageOf(1000 + index), headAtMs: at }));
    await seedThreads(pageId, known);
    const reg = await registry(pageId);
    await demand(reg, pageId, "dm-conversations.head");
    await demand(reg, pageId, "transactions.head");

    // Three new fans write while the head walk's list read is in flight: two
    // chats the list serves on top from then on, one it does not show.
    const listedNew = [5001, 5002].map((n) => ({ n, headId: messageOf(n, 7), headAtMs: NOW_MS - 30_000 }));
    const hidden = 5003;
    const burst = [...listedNew.map((chat) => chat.n), hidden];
    let newChatsFrom = Number.POSITIVE_INFINITY;
    const transport = new ScriptedLiveTransport();
    transport.respond = (req, index): FanslyWireOutcome => {
      if (req.spec === "messaging.groups") {
        const served = index >= newChatsFrom ? [...listedNew, ...known] : known;
        const offset = offsetOf(req);
        return okResponse(listPage(served.slice(offset, offset + 100)));
      }
      if (req.spec === "group.detail") {
        const groupId = new URL(req.url).pathname.split("/").pop()!;
        const n = burst.find((candidate) => groupOf(candidate) === groupId)!;
        return okResponse(groupDetail(n, { id: messageOf(n, 7), atMs: NOW_MS - 30_000 }));
      }
      return okResponse();
    };
    transport.onHit = async (req) => {
      if (req.spec === "messaging.groups" && newChatsFrom === Number.POSITIVE_INFINITY) {
        newChatsFrom = transport.hits.length;
        for (const n of burst) await demand(reg, pageId, FIND, groupOf(n));
      }
    };
    const { actor, stop, abort } = await makeTestActor({
      db: db(), pageId, mode: "live", registry: reg, transport, ownRef: OWN_ID, capture: fanslyCaptureCodec, alerts: new RecordingAlerts(),
    });
    const running = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      await waitFor(async () => {
        const finds = await Promise.all(burst.map((n) => workRowOf(pageId, FIND, groupOf(n))));
        return finds.every((find) => find?.state === "done") ? true : null;
      }, 30_000, "the burst's finds to settle");
    } finally {
      stop.abort();
      await running;
    }

    const all = await attemptsOf(pageId);
    const list = all.filter((attempt) => attempt.operation === "messaging.groups");
    // One list read for the whole burst, after the head walk's, spaced.
    expect(list.map((attempt) => attempt.resource)).toEqual(["dm-conversations.head", FIND]);
    expectSpaced(list);
    // Whichever find the pick served first read the list (the three came due
    // together); the hidden chat's find read its detail, nothing else.
    const reader = list[1]!.subject;
    const findAttempts = all.filter((attempt) => attempt.resource === FIND);
    expect(findAttempts.map((attempt) => [attempt.operation, attempt.subject])).toEqual([
      ["messaging.groups", reader],
      ["group.detail", groupOf(hidden)],
    ]);

    const slo = fanslyResourceSpec(FIND)!.slo!.resultMs!;
    for (const n of burst) {
      const find = await workRowOf(pageId, FIND, groupOf(n));
      const reason = n === hidden ? "found_by_detail" : groupOf(n) === reader ? "found_in_list" : "found_by_other_read";
      expect(find, `find ${n}`).toMatchObject({ state: "done", close_reason: reason });
      expect(find!.closed_at!.getTime() - find!.first_demand_at.getTime(), `find ${n}`).toBeLessThan(slo);
      // Every new chat's message is read urgently — a chat found by another
      // `.find`'s read too, never a planned catch-up.
      const head = await workRowOf(pageId, "dm-messages.head", groupOf(n));
      expect(head, `head ${n}`).toMatchObject({ class: "urgent" });
      expect(head!.demand.reasons, `head ${n}`).toContain("list_head:dm-conversations.find");
      expect(await workRowOf(pageId, "dm-messages.catchup", groupOf(n)), `catchup ${n}`).toBeNull();
    }
  }, 60_000);

  it("a walk page whose P slot comes up while a .find is due yields the list to it", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const at = NOW_MS - 2 * HOUR;
    const known = Array.from({ length: 130 }, (_, index) => ({ n: 1000 + index, headId: messageOf(1000 + index), headAtMs: at }));
    await seedThreads(pageId, known);
    const reg = await registry(pageId);
    const NEW_CHAT = 5000;
    const fresh = { n: NEW_CHAT, headId: messageOf(NEW_CHAT, 7), headAtMs: NOW_MS - 30_000 };
    // The walk is past its first page (its next one, at offset 100, does not
    // show the new chat). Both are due on a free list and the cycle is at its
    // P slot: the planned class is asked first, and the walk is its
    // earliest-due poll.
    await demand(reg, pageId, FULL);
    await testDb!.pool.query(
      `update sync_work set cursor = $3::jsonb where page_id = $1 and resource = $2 and state = 'open'`,
      [pageId, FULL, JSON.stringify({
        generation: 1,
        walk: {
          generation: 1, startedAt: new Date(NOW_MS - 60_000).toISOString(), offset: 100, pageCount: 1, observedCount: 100,
          repeatsCountedOnce: 0, repeatOnlyPageStreak: 0, restartCount: 0,
        },
        restartCount: 0, last: null, shadow: null,
      })],
    );
    await demand(reg, pageId, FIND, groupOf(NEW_CHAT));
    await testDb!.pool.query("update sync_pages set cycle_pos = 9 where page_id = $1", [pageId]);

    const transport = new ScriptedLiveTransport();
    transport.respond = (req): FanslyWireOutcome => {
      if (req.spec === "messaging.groups") {
        const offset = offsetOf(req);
        return okResponse(listPage([fresh, ...known].slice(offset, offset + 100)));
      }
      return okResponse();
    };
    const metrics = new RecordingMetrics();
    const { actor, stop, abort } = await makeTestActor({
      db: db(), pageId, mode: "live", registry: reg, transport, ownRef: OWN_ID, capture: fanslyCaptureCodec, alerts: new RecordingAlerts(), metrics,
    });
    const running = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      await waitFor(async () => {
        const walk = await workRow(pageId, FULL);
        const find = await workRow(pageId, FIND);
        return walk?.cursor.last != null && find?.state === "done" ? true : null;
      }, 30_000, "the walk and the find to settle");
    } finally {
      stop.abort();
      await running;
    }

    const list = (await attemptsOf(pageId)).filter((attempt) => attempt.operation === "messaging.groups");
    expect(list.map((attempt) => attempt.resource)).toEqual([FIND, FULL]);
    expectSpaced(list);
    expect((await workRow(pageId, FULL))!.cursor).toMatchObject({ walk: null, last: { pageCount: 2 } });
    expect(metrics.get("sync_endpoint_yielded")).toBeGreaterThan(0);
    const find = await workRow(pageId, FIND);
    expect(find).toMatchObject({ state: "done", close_reason: "found_in_list" });
    // No spacing in front of the find: the walk never took the list first.
    expect(list[0]!.admitted_at.getTime() - find!.first_demand_at.getTime()).toBeLessThan(LIST_SPACING_MS);
    expect(find!.closed_at!.getTime() - find!.first_demand_at.getTime()).toBeLessThan(fanslyResourceSpec(FIND)!.slo!.resultMs!);
  }, 60_000);
});
