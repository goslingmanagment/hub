import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ensurePollRows,
  getSyncPage,
  readDmFindSharedRead,
  setPageHold,
  writeSyncRouteState,
  upsertDemand,
  upsertFans,
  type Database,
} from "@agency_hub_core/db";
import type { FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";
import {
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
} from "@agency_hub_core/shared";

import type { Wake } from "../apps/runtime/src/sync/engine/ports.ts";
import {
  createEngineRegistry,
  pollsFor,
  type EngineRegistry,
  type ResourceModule,
} from "../apps/runtime/src/sync/engine/resource.ts";
import { FANSLY_RESOURCE_SPECS, fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { DM_LIST_READ_KEYS } from "../apps/runtime/src/sync/fansly/resources/dm-conversations.ts";
import { FAMILY_BUDGETS, intervalMsOf, routeBudget } from "../apps/runtime/src/sync/fansly/routes.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  countRows,
  makeTestActor,
  okResponse,
  RecordingAlerts,
  RecordingMetrics,
  routeTestScale,
  ScriptedLiveTransport,
  seedSyncPage,
  statusResponse,
  testSpec,
  waitFor,
} from "./helpers/sync-engine-host.ts";
import { pageHoldKindOf, resourceBreakersOf, routeEntryOf, seedRouteState } from "./helpers/sync-holds.ts";

// The conversation list of the Fansly Sync Engine (design §5.3) through the
// real actor and commits against a real database: a scripted live transport
// answers `/messaging/groups` and `/group/:id`. What is pinned: the list writes only its own fields (never the
// stored window, the coverage verdict or the chain, never an unbinding), a
// head walk stops at the first page it already knows, a full walk stamps its
// generation and hides nothing, a list head newer than the message reads asks
// for exactly one read, an unknown chat is found through its detail, a burst
// of unknown chats shares one read of the list head (inside the 12 s at the
// production ratios).

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

const pad = (n: number, width: number) => String(n).padStart(width, "0");
/** A chat's group id, its partner and a message id (decimal snowflakes). */
const groupOf = (n: number) => `71000000000${pad(n, 7)}`;
const fanOf = (n: number) => `51000000000${pad(n, 7)}`;
const messageOf = (n: number, k = 0) => `91${pad(k, 3)}00000${pad(n, 8)}`;

interface Chat {
  n: number;
  /** The partner the list row names (default: the chat's fan); null: none. */
  partner?: string | null;
  /** The aggregation group with its members and head; false: absent. */
  group?: boolean;
  headId: string | null;
  headAtMs: number | null;
  unread?: number;
}

function fanAccount(id: string) {
  return { id, username: `fan${id.slice(-4)}`, displayName: `Fan ${id.slice(-4)}`, createdAt: Date.UTC(2025, 0, 1) };
}

/** One `/messaging/groups` answer for these chats. */
function listPage(chats: readonly Chat[], total?: number) {
  const partnerOf = (chat: Chat) => (chat.partner === undefined ? fanOf(chat.n) : chat.partner);
  return {
    data: chats.map((chat) => ({
      account_id: OWN_ID,
      groupId: groupOf(chat.n),
      partnerAccountId: partnerOf(chat),
      partnerUsername: partnerOf(chat) === null ? null : `fan${partnerOf(chat)!.slice(-4)}`,
      flags: 0,
      unreadCount: chat.unread ?? 0,
      subscriptionTierId: null,
      lastMessageId: chat.headId,
      lastUnreadMessageId: null,
    })),
    aggregationData: {
      ...(total === undefined ? {} : { total }),
      accounts: chats.flatMap((chat) => (partnerOf(chat) === null ? [] : [fanAccount(partnerOf(chat)!)])),
      groups: chats.filter((chat) => chat.group !== false).map((chat) => ({
        id: groupOf(chat.n),
        type: 1,
        groupFlags: 0,
        createdBy: OWN_ID,
        users: [
          { groupId: groupOf(chat.n), userId: OWN_ID, type: 0, permissionFlags: 0 },
          ...(partnerOf(chat) === null ? [] : [{ groupId: groupOf(chat.n), userId: partnerOf(chat)!, type: 0, permissionFlags: 0 }]),
        ],
        lastMessage: chat.headId === null ? null : {
          id: chat.headId,
          type: 1,
          dataVersion: 1,
          content: `message ${chat.headId}`,
          groupId: groupOf(chat.n),
          senderId: partnerOf(chat) ?? OWN_ID,
          correlationId: null,
          inReplyTo: null,
          inReplyToRoot: null,
          createdAt: chat.headAtMs,
          attachments: [],
          embeds: [],
          interactions: [],
          likes: [],
        },
      })),
    },
  };
}

function groupDetail(n: number, members: readonly string[], head: { id: string; atMs: number; senderId: string } | null) {
  return {
    id: groupOf(n),
    type: 1,
    groupFlags: 0,
    createdBy: OWN_ID,
    users: [OWN_ID, ...members].map((userId) => ({ groupId: groupOf(n), userId, type: 0, permissionFlags: 0 })),
    lastMessage: head === null ? null : {
      id: head.id, type: 1, dataVersion: 1, content: "hello", groupId: groupOf(n), senderId: head.senderId,
      correlationId: null, inReplyTo: null, inReplyToRoot: null, createdAt: head.atMs,
      attachments: [], embeds: [], interactions: [], likes: [],
    },
  };
}

interface SeedThread {
  n: number;
  partner?: string | null;
  bound?: boolean;
  headId: string | null;
  headAtMs: number | null;
  newestStored?: string | null;
  storedCount?: number;
  metadata?: Record<string, unknown>;
}

/** Thread rows as legacy left them (written straight, the census reads src only). */
async function seedThreads(pageId: number, threads: readonly SeedThread[]): Promise<void> {
  const partners = threads.flatMap((thread) => {
    const partner = thread.partner === undefined ? fanOf(thread.n) : thread.partner;
    return partner !== null && thread.bound !== false ? [partner] : [];
  });
  const fans = await upsertFans(db(), partners.map((platformUserId) => ({ platform: "fansly" as const, platformUserId })));
  const fanIds = new Map(fans.map((fan) => [fan.platformUserId, fan.id] as const));
  for (const thread of threads) {
    const partner = thread.partner === undefined ? fanOf(thread.n) : thread.partner;
    await testDb!.pool.query(
      `insert into page_dm_threads (platform_account_id, platform_conversation_id, fan_id, partner_platform_user_id,
              partner_username, conversation_flags, unread_count, last_message_id, last_message_at, last_message_sender_id,
              last_message_sender_role, last_message_preview, newest_stored_message_id, stored_message_count,
              message_coverage_status, last_message_sync_at, is_visible, metadata)
       values ($1, $2, $3, $4, $5, 0, 0, $6, to_timestamp($7::double precision / 1000), $4,
               case when $4::text is null then 'unknown' else 'fan' end::dm_sender_role, 'stored preview', $8, $9,
               'partial_window', timestamptz '2026-09-01T00:00:00Z', true, $10::jsonb)`,
      [
        pageId, groupOf(thread.n), partner === null || thread.bound === false ? null : fanIds.get(partner) ?? null, partner,
        partner === null ? null : `fan${partner.slice(-4)}`, thread.headId, thread.headAtMs, thread.newestStored ?? null,
        thread.storedCount ?? 0, JSON.stringify(thread.metadata ?? {}),
      ],
    );
  }
}

/** A registry of every Fansly entry whose standing polls are parked far
 *  ahead, so only the work a test makes due runs. */
async function quietRegistry(pageId: number): Promise<EngineRegistry> {
  const registry = createEngineRegistry(FANSLY_RESOURCE_SPECS);
  const page = await getSyncPage(db(), pageId);
  await ensurePollRows(db(), {
    pageId,
    polls: pollsFor(registry, page!).map((poll) => ({ ...poll, phase: 0.999 })),
  });
  return registry;
}

async function makeDue(pageId: number, resource: string, subject?: string) {
  const spec = fanslyResourceSpec(resource)!;
  await upsertDemand(db(), {
    pageId,
    resource,
    kind: spec.kind,
    class: spec.class,
    ...(subject === undefined ? {} : { subject }),
    demand: { reasons: ["test"] },
  });
}

async function seedPage(engineStartedAgoMs = 24 * HOUR) {
  const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" });
  await testDb!.pool.query("update pages set external_page_id = $2 where id = $1", [pageId, OWN_ID]);
  await testDb!.pool.query(
    `update sync_pages set legacy_imported_at = clock_timestamp() - $2::double precision * interval '1 millisecond',
            mode_changed_at = clock_timestamp() - $2::double precision * interval '1 millisecond'
      where page_id = $1`,
    [pageId, engineStartedAgoMs],
  );
  return pageId;
}

type Responder = (req: FanslyWireRequest) => FanslyWireOutcome;

async function drive(
  pageId: number,
  registry: EngineRegistry,
  respond: Responder,
  until: () => Promise<boolean>,
  options: { alerts?: RecordingAlerts; metrics?: RecordingMetrics } = {},
) {
  const transport = new ScriptedLiveTransport();
  transport.respond = (req) => respond(req);
  const { actor, stop, abort } = await makeTestActor({
    db: db(),
    pageId,
    registry,
    alerts: options.alerts ?? new RecordingAlerts(),
    metrics: options.metrics ?? new RecordingMetrics(),
    transport,
  });
  const run = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => ((await until()) ? true : null), 30_000, "the work to settle");
  } finally {
    stop.abort();
    await run;
  }
  return { hits: transport.hits.map((hit) => hit.spec) };
}

async function runLive(pageId: number, respond: Responder, until: () => Promise<boolean>, options: { metrics?: RecordingMetrics } = {}) {
  const registry = await quietRegistry(pageId);
  return drive(pageId, registry, respond, until, options);
}

function offsetOf(req: FanslyWireRequest): number {
  return Number(new URL(req.url).searchParams.get("offset"));
}

async function workRow(pageId: number, resource: string, options: { subject?: string } = {}) {
  const result = await testDb!.pool.query<{
    state: string; class: string; cursor: Record<string, unknown>; proof: Record<string, unknown> | null;
    result: Record<string, unknown> | null; demand: { messageIds: string[] }; params: Record<string, unknown>;
    due_at: Date; close_reason: string | null; failure_count: number; breaker_until: Date | null; waiting_reason: string | null;
  }>(
    `select state, class, cursor, proof, result, demand, params, due_at, close_reason, failure_count, breaker_until, waiting_reason
       from sync_work
      where page_id = $1 and resource = $2 and not shadow and ($3::text is null or subject = $3)
      order by id desc limit 1`,
    [pageId, resource, options.subject ?? null],
  );
  return result.rows[0] ?? null;
}

async function subjectsOf(pageId: number, resource: string): Promise<string[]> {
  const result = await testDb!.pool.query<{ subject: string }>(
    "select subject from sync_work where page_id = $1 and resource = $2 and not shadow order by subject",
    [pageId, resource],
  );
  return result.rows.map((row) => row.subject);
}

async function thread(pageId: number, n: number) {
  const result = await testDb!.pool.query<{
    fan_id: string | null; partner: string | null; last_message_id: string | null; last_message_at: Date | null;
    last_message_sender_role: string; last_message_preview: string | null; metadata: Record<string, unknown>;
    last_seen_generation: string | null; is_visible: boolean; stored_message_count: number;
    newest_stored_message_id: string | null; message_coverage_status: string; last_message_sync_at: Date | null;
    history_state: string; head_confirmed_id: string | null;
  }>(
    `select fan_id, partner_platform_user_id as partner, last_message_id, last_message_at, last_message_sender_role::text,
            last_message_preview, metadata, last_seen_generation, is_visible, stored_message_count, newest_stored_message_id,
            message_coverage_status::text, last_message_sync_at, history_state, head_confirmed_id
       from page_dm_threads where platform_account_id = $1 and platform_conversation_id = $2`,
    [pageId, groupOf(n)],
  );
  return result.rows[0] ?? null;
}

describe("dm-conversations.head", () => {
  it("walks to the first page it already knows, writes only the list's fields, and asks for exactly the reads it needs", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const recent = NOW_MS - 10 * 60_000;
    const old = NOW_MS - 3 * 24 * HOUR;
    // Page 2: one hundred chats exactly as stored.
    const known = Array.from({ length: 100 }, (_, index) => ({ n: 200 + index, headId: messageOf(200 + index), headAtMs: old }));
    // Page 1: the chats that moved.
    const moved = Array.from({ length: 94 }, (_, index) => ({ n: 106 + index, headId: messageOf(106 + index, 1), headAtMs: recent }));
    await seedThreads(pageId, [
      ...known.map((chat) => ({ ...chat, newestStored: chat.headId })),
      // Read already (the newest stored message is the served head).
      ...moved.map((chat) => ({ n: chat.n, headId: messageOf(chat.n), headAtMs: old, newestStored: chat.headId })),
      // 100: a head newer than what the reads reached.
      { n: 100, headId: messageOf(100), headAtMs: old, newestStored: messageOf(100), storedCount: 7 },
      // 103: never bound, no partner.
      { n: 103, partner: null, headId: null, headAtMs: null, metadata: { unresolvedIdentity: true, keep: "me" } },
      // 104: bound; this answer names no partner.
      { n: 104, headId: messageOf(104), headAtMs: old, newestStored: messageOf(104) },
      // 105: excluded as unresolvable, no probe answer yet.
      {
        n: 105, headId: messageOf(105), headAtMs: old, newestStored: messageOf(105),
        metadata: { messageSyncExcludedReason: FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP },
      },
    ]);
    const first = listPage([
      { n: 100, headId: messageOf(100, 1), headAtMs: recent },
      // 101: a new chat that began under the engine; 102: one older than it.
      { n: 101, headId: messageOf(101), headAtMs: recent },
      { n: 102, headId: messageOf(102), headAtMs: old },
      { n: 103, partner: null, group: false, headId: null, headAtMs: null },
      { n: 104, partner: null, group: false, headId: messageOf(104), headAtMs: null },
      { n: 105, headId: messageOf(105), headAtMs: old },
      ...moved,
    ]);
    const second = listPage(known);
    await makeDue(pageId, "dm-conversations.head");
    const { hits } = await runLive(pageId, (req) => {
      if (req.spec === "messaging.groups") return okResponse(offsetOf(req) === 0 ? first : second);
      if (req.spec === "group.detail") return okResponse(groupDetail(103, [fanOf(103)], null));
      if (req.spec === "accounts.by_ids") return okResponse([]);
      throw new Error(`unexpected ${req.spec}`);
    }, async () => (await workRow(pageId, "dm-conversations.head"))?.cursor.last != null
      && (await workRow(pageId, "dm-conversations.detail"))?.state === "done"
      && (await workRow(pageId, "fan-profiles.probe"))?.state === "done");

    expect(hits.filter((spec) => spec === "messaging.groups")).toHaveLength(2);
    expect(hits.filter((spec) => spec !== "messaging.groups").sort()).toEqual(["accounts.by_ids", "group.detail"]);
    const head = await workRow(pageId, "dm-conversations.head");
    expect(head!.state).toBe("open");
    expect(head!.cursor).toMatchObject({ walk: null, last: { stop: "unchanged_page", pageCount: 2, knownChats: 100 } });
    expect(head!.due_at.getTime() - Date.now()).toBeGreaterThan(20 * 60_000);

    // One planned read per chat whose head is newer than the reads: the moved
    // head, and the new chat that began under the engine — not the older one.
    expect(await subjectsOf(pageId, "dm-messages.catchup")).toEqual([groupOf(100), groupOf(101)]);
    const catchup = await workRow(pageId, "dm-messages.catchup", { subject: groupOf(100) });
    expect(catchup).toMatchObject({ class: "planned", demand: expect.objectContaining({ messageIds: [messageOf(100, 1)] }) });
    expect(await subjectsOf(pageId, "dm-messages.head")).toEqual([]);

    // The list's fields moved; the reads' own did not.
    const t100 = await thread(pageId, 100);
    expect(t100).toMatchObject({
      last_message_id: messageOf(100, 1),
      last_message_sender_role: "fan",
      last_message_preview: `message ${messageOf(100, 1)}`,
      stored_message_count: 7,
      newest_stored_message_id: messageOf(100),
      message_coverage_status: "partial_window",
      last_seen_generation: null,
      head_confirmed_id: null,
    });
    expect(t100!.last_message_at!.getTime()).toBe(recent);
    expect(t100!.last_message_sync_at).toEqual(new Date("2026-09-01T00:00:00Z"));
    // New chats are created bound to their fans.
    for (const n of [101, 102]) {
      const created = await thread(pageId, n);
      expect(created).toMatchObject({ partner: fanOf(n), is_visible: true, stored_message_count: 0, message_coverage_status: "pending_backfill" });
      expect(created!.fan_id).not.toBeNull();
    }
    // A pass that names no partner keeps the bound one.
    const t104 = await thread(pageId, 104);
    expect(t104).toMatchObject({ partner: fanOf(104), last_message_id: messageOf(104), metadata: {} });
    expect(t104!.fan_id).not.toBeNull();
    // The detail named the partner of the unbound chat; other metadata stays.
    const t103 = await thread(pageId, 103);
    expect(t103).toMatchObject({ partner: fanOf(103), metadata: { keep: "me" } });
    expect(t103!.fan_id).not.toBeNull();
    // The unresolvable partner was probed (the answer `[]` keeps it excluded).
    expect((await workRow(pageId, "fan-profiles.probe"))!.params).toEqual({ conversationId: expect.any(Number) });
    expect((await thread(pageId, 105))!.metadata).toEqual({
      messageSyncExcludedReason: FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
    });
    const kinds = await testDb.pool.query("select kind, count(*)::int as n from observations where account_id = $1 group by 1 order by 1", [pageId]);
    expect(kinds.rows).toEqual([
      { kind: "account_lookup", n: 1 },
      { kind: "dm_conversations", n: 2 },
      { kind: "group_detail", n: 1 },
    ]);
  });

  it("lifts an unresolvable exclusion on a resolved answer of the day, and asks nothing of a chat already read", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const at = NOW_MS - HOUR;
    await seedThreads(pageId, [{
      n: 1, headId: messageOf(1), headAtMs: at, newestStored: messageOf(1),
      metadata: { messageSyncExcludedReason: FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP },
    }]);
    await testDb.pool.query(
      `insert into page_fans (fan_id, platform_account_id, account_probe_at, account_probe_resolved)
       select f.id, $1, clock_timestamp() - interval '1 hour', true from fans f where f.platform_user_id = $2`,
      [pageId, fanOf(1)],
    );
    await makeDue(pageId, "dm-conversations.head");
    const { hits } = await runLive(pageId, () => okResponse(listPage([{ n: 1, headId: messageOf(1), headAtMs: at }])),
      async () => (await workRow(pageId, "dm-conversations.head"))?.cursor.last != null);
    expect(hits).toEqual(["messaging.groups"]);
    expect((await thread(pageId, 1))!.metadata).toEqual({});
    expect((await workRow(pageId, "dm-conversations.head"))!.cursor).toMatchObject({ last: { stop: "short_page", pageCount: 1 } });
    expect(await subjectsOf(pageId, "fan-profiles.probe")).toEqual([]);
    expect(await subjectsOf(pageId, "dm-messages.catchup")).toEqual([]);
  });
});

describe("dm-conversations.full", () => {
  it("the first full walk over 500 chats whose heads equal their stored newest ids: 0 follow-ups, 0 head reads, nothing hidden", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage(HOUR);
    const at = NOW_MS - 2 * HOUR;
    const chats = Array.from({ length: 500 }, (_, index) => ({ n: 1000 + index, headId: messageOf(1000 + index), headAtMs: at }));
    // 9999: visible, never listed by this walk.
    await seedThreads(pageId, [...chats.map((chat) => ({ ...chat, newestStored: chat.headId })), { n: 9999, headId: null, headAtMs: null }]);
    await makeDue(pageId, "dm-conversations.full");
    const offsets: number[] = [];
    const { hits } = await runLive(pageId, (req) => {
      const offset = offsetOf(req);
      offsets.push(offset);
      return okResponse(listPage(chats.slice(offset, offset + 100)));
    }, async () => (await workRow(pageId, "dm-conversations.full"))?.cursor.last != null);

    // Five full pages and the empty one after them; not a single head read.
    expect(hits).toEqual(Array(6).fill("messaging.groups"));
    expect(offsets).toEqual([0, 100, 200, 300, 400, 500]);
    const work = await workRow(pageId, "dm-conversations.full");
    expect(work!.state).toBe("open");
    expect(work!.cursor).toMatchObject({
      generation: 1,
      walk: null,
      restartCount: 0,
      last: { generation: 1, pageCount: 6, observedCount: 500, generationSetCount: 500, repeatsCountedOnce: 0, providerReportedTotal: null },
    });
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_work where page_id = $1 and resource like 'dm-messages.%'", [pageId])).toBe(0);
    expect(await countRows(testDb.pool,
      "select count(*)::int as n from page_dm_threads where platform_account_id = $1 and last_seen_generation = 1 and fan_id is not null", [pageId])).toBe(500);
    expect(await thread(pageId, 9999)).toMatchObject({ is_visible: true, last_seen_generation: null });
  });

  it("restarts a walk the provider serves repeats to, under a new generation after a minute; past the bound it closes withheld", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const at = NOW_MS - 2 * HOUR;
    const chats = Array.from({ length: 100 }, (_, index) => ({ n: 3000 + index, headId: messageOf(3000 + index), headAtMs: at }));
    await makeDue(pageId, "dm-conversations.full");
    // An offset the provider ignores: the same page at every offset.
    const first = await runLive(pageId, () => okResponse(listPage(chats)),
      async () => (await workRow(pageId, "dm-conversations.full"))?.result?.restartReason != null);
    expect(first.hits).toEqual(["messaging.groups", "messaging.groups", "messaging.groups"]);
    const restarted = await workRow(pageId, "dm-conversations.full");
    expect(restarted!.result).toMatchObject({ restartReason: "repeat_only_pages", restartCount: 1, pageCount: 2 });
    expect(restarted!.cursor).toMatchObject({ generation: 1, walk: null, restartCount: 1 });
    expect(restarted!.due_at.getTime() - Date.now()).toBeGreaterThan(45_000);

    // Past the bound: a page with an id served twice closes the walk withheld
    // and writes nothing of it.
    await testDb.pool.query(
      `update sync_work set cursor = '{"generation": 1, "restartCount": 2}'::jsonb, due_at = clock_timestamp()
        where page_id = $1 and resource = 'dm-conversations.full' and state = 'open'`,
      [pageId],
    );
    const doubled = listPage([chats[0]!, { n: 4000, headId: messageOf(4000), headAtMs: at }, chats[0]!]);
    const second = await drive(pageId, createEngineRegistry(FANSLY_RESOURCE_SPECS), () => okResponse(doubled),
      async () => (await workRow(pageId, "dm-conversations.full"))?.cursor.last != null);
    expect(second.hits).toEqual(["messaging.groups"]);
    const withheld = await workRow(pageId, "dm-conversations.full");
    expect(withheld!.state).toBe("open");
    expect(withheld!.cursor).toMatchObject({
      generation: 2, walk: null, restartCount: 0, last: { withheldReason: "duplicate_ids_in_page", generation: 2, restartCount: 2, duplicates: 1 },
    });
    expect(await thread(pageId, 4000)).toBeNull();
    expect(withheld!.due_at.getTime() - Date.now()).toBeGreaterThan(20 * HOUR);
  });
});

describe("dm-conversations.find and .detail", () => {
  it("finds a chat the list head does not show through its group detail, creates its thread and reads it now", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const at = NOW_MS - 2 * HOUR;
    await seedThreads(pageId, [{ n: 1, headId: messageOf(1), headAtMs: at, newestStored: messageOf(1) }]);
    const newMessage = { id: messageOf(2, 7), atMs: NOW_MS - 30_000, senderId: fanOf(2) };
    await makeDue(pageId, "dm-conversations.find", groupOf(2));
    const { hits } = await runLive(pageId, (req) => {
      if (req.spec === "messaging.groups") return okResponse(listPage([{ n: 1, headId: messageOf(1), headAtMs: at }]));
      if (req.spec === "group.detail") return okResponse(groupDetail(2, [fanOf(2)], newMessage));
      throw new Error(`unexpected ${req.spec}`);
    }, async () => (await workRow(pageId, "dm-conversations.find"))?.state === "done");

    expect(hits).toEqual(["messaging.groups", "group.detail"]);
    expect((await workRow(pageId, "dm-conversations.find"))).toMatchObject({
      close_reason: "found_by_detail",
      result: expect.objectContaining({ groupId: groupOf(2), created: true, partner: fanOf(2) }),
    });
    const created = await thread(pageId, 2);
    expect(created).toMatchObject({ partner: fanOf(2), last_message_id: newMessage.id, last_message_sender_role: "fan", metadata: {} });
    expect(created!.fan_id).not.toBeNull();
    const read = await workRow(pageId, "dm-messages.head", { subject: groupOf(2) });
    expect(read).toMatchObject({ class: "urgent", demand: expect.objectContaining({ messageIds: [newMessage.id] }) });
    expect(await subjectsOf(pageId, "dm-messages.catchup")).toEqual([]);
  });

  it("a group detail that is no direct chat (the page's own mass-message container) creates nothing (D5)", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const at = NOW_MS - 2 * HOUR;
    await seedThreads(pageId, [{ n: 1, headId: messageOf(1), headAtMs: at, newestStored: messageOf(1) }]);
    const fansBefore = await countRows(testDb.pool, "select count(*)::int as n from fans");
    // Production shape (lilly-1/lilly-2): type 3, the page alone, recipients
    // lists, the page's own broadcast (type 3, correlated to the group) as head.
    const container = {
      ...groupDetail(9, [], { id: messageOf(9, 3), atMs: NOW_MS - 60_000, senderId: OWN_ID }),
      type: 3,
      groupFlags: 62,
      recipients: [{ id: "920000000000000001", type: 30001 }],
    };
    container.lastMessage = { ...container.lastMessage!, type: 3, correlationId: groupOf(9) as never };
    await makeDue(pageId, "dm-conversations.find", groupOf(9));
    const { hits } = await runLive(pageId, (req) => {
      if (req.spec === "messaging.groups") return okResponse(listPage([{ n: 1, headId: messageOf(1), headAtMs: at }]));
      if (req.spec === "group.detail") return okResponse(container);
      throw new Error(`unexpected ${req.spec}`);
    }, async () => (await workRow(pageId, "dm-conversations.find"))?.state === "done");

    expect(hits).toEqual(["messaging.groups", "group.detail"]);
    expect(await workRow(pageId, "dm-conversations.find")).toMatchObject({
      close_reason: "not_a_chat",
      result: { groupId: groupOf(9), threadId: null, created: false, notAChat: true, type: 3, members: 0 },
    });
    expect(await thread(pageId, 9)).toBeNull();
    expect(await countRows(testDb.pool, "select count(*)::int as n from fans")).toBe(fansBefore);
    expect(await subjectsOf(pageId, "dm-messages.head")).toEqual([]);
    expect(await subjectsOf(pageId, "dm-messages.catchup")).toEqual([]);
  });

  it("a group detail naming several members besides the page creates nothing either (D5)", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const fansBefore = await countRows(testDb.pool, "select count(*)::int as n from fans");
    const group = groupDetail(10, [fanOf(10), fanOf(11)], { id: messageOf(10, 2), atMs: NOW_MS - 60_000, senderId: fanOf(10) });
    await makeDue(pageId, "dm-conversations.detail", groupOf(10));
    const { hits } = await runLive(pageId, (req) => {
      if (req.spec === "group.detail") return okResponse(group);
      throw new Error(`unexpected ${req.spec}`);
    }, async () => (await workRow(pageId, "dm-conversations.detail"))?.state === "done");

    expect(hits).toEqual(["group.detail"]);
    expect(await workRow(pageId, "dm-conversations.detail")).toMatchObject({
      close_reason: "not_a_chat",
      result: { groupId: groupOf(10), threadId: null, created: false, notAChat: true, type: 1, members: 2 },
    });
    expect(await thread(pageId, 10)).toBeNull();
    expect(await countRows(testDb.pool, "select count(*)::int as n from fans")).toBe(fansBefore);
    expect(await subjectsOf(pageId, "dm-messages.head")).toEqual([]);
  });

  it("a chat on the list head is found with one read, and only its own read is urgent", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const recent = NOW_MS - 60_000;
    await seedThreads(pageId, [{ n: 1, headId: messageOf(1), headAtMs: recent - HOUR, newestStored: messageOf(1) }]);
    await makeDue(pageId, "dm-conversations.find", groupOf(2));
    const { hits } = await runLive(pageId, () => okResponse(listPage([
      { n: 2, headId: messageOf(2), headAtMs: recent },
      { n: 1, headId: messageOf(1, 1), headAtMs: recent },
    ])), async () => (await workRow(pageId, "dm-conversations.find"))?.state === "done");
    expect(hits).toEqual(["messaging.groups"]);
    expect((await workRow(pageId, "dm-conversations.find"))!.close_reason).toBe("found_in_list");
    expect(await subjectsOf(pageId, "dm-messages.head")).toEqual([groupOf(2)]);
    expect(await subjectsOf(pageId, "dm-messages.catchup")).toEqual([groupOf(1)]);
  });

  it("a group detail that keeps failing breaks only its own chat", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    await seedThreads(pageId, [{ n: 5, partner: null, headId: null, headAtMs: null, metadata: { unresolvedIdentity: true } }]);
    await makeDue(pageId, "dm-conversations.detail", groupOf(5));
    const { hits } = await runLive(pageId, () => statusResponse(500, { success: false, error: { code: 500 } }),
      async () => ((await workRow(pageId, "dm-conversations.detail"))?.failure_count ?? 0) >= 1);
    expect(hits).toEqual(["group.detail"]);
    const detail = await workRow(pageId, "dm-conversations.detail");
    expect(detail).toMatchObject({ state: "open", failure_count: 1 });
    expect(detail!.breaker_until!.getTime()).toBeGreaterThan(Date.now());
    // Nothing else is held: the page's hold set is empty.
    expect((await getSyncPage(db(), pageId))!.holds).toEqual([]);
    expect(await thread(pageId, 5)).toMatchObject({ partner: null, metadata: { unresolvedIdentity: true } });
  });
});

const FIND = "dm-conversations.find";

async function findRows(pageId: number) {
  const result = await testDb!.pool.query<{
    subject: string; state: string; close_reason: string | null; result: Record<string, unknown> | null;
    first_demand_at: Date; closed_at: Date | null;
  }>(
    `select subject, state, close_reason, result, first_demand_at, closed_at from sync_work
      where page_id = $1 and resource = $2 and not shadow order by subject`,
    [pageId, FIND],
  );
  return result.rows;
}

async function attemptsOf(pageId: number) {
  const result = await testDb!.pool.query<{ id: number; resource: string; subject: string; operation: string; admitted_at: Date; sent_at: Date | null }>(
    `select id::int as id, resource, subject, operation, admitted_at, sent_at from sync_attempts
      where page_id = $1 and not shadow order by id`,
    [pageId],
  );
  return result.rows;
}

async function openFinds(pageId: number): Promise<number> {
  return countRows(testDb!.pool,
    "select count(*)::int as n from sync_work where page_id = $1 and resource = $2 and not shadow and state in ('open', 'running')",
    [pageId, FIND]);
}

describe("the shared list-head read of .find (step 3b, plan PR 1-3)", () => {
  /** A journaled list read of the page (no request: the row only); `shadow`
   *  makes it a row shadow mode left behind. */
  async function journalListRead(pageId: number, input: {
    resource: string; offset: number; shadow?: boolean; applyState?: string; outcome?: string; workId?: number;
  }): Promise<number> {
    const result = await testDb!.pool.query<{ id: string }>(
      `insert into sync_attempts (page_id, shadow, work_id, resource, subject, class, owner_generation, setting_ms, jitter_u, pause_ms,
                                  sent_at, send_mark, operation, request, outcome, apply_state)
       values ($1, $2, $3, $4, '', 'planned', 1, 2000, 0, 2000, clock_timestamp(), $5, 'messaging.groups',
               jsonb_build_object('spec', 'messaging.groups', 'params', jsonb_build_object('offset', $6::int)), $7, $8)
       returning id`,
      [pageId, input.shadow ?? false, input.workId ?? null, input.resource, input.shadow === true ? "shadow" : "request_start",
        input.offset, input.outcome ?? (input.shadow === true ? "shadow" : "response"), input.applyState ?? (input.shadow === true ? "skipped" : "applied")],
    );
    return Number(result.rows[0]!.id);
  }

  async function findWorkId(pageId: number, n: number): Promise<number> {
    const result = await testDb!.pool.query<{ id: string }>(
      "select id from sync_work where page_id = $1 and resource = $2 and subject = $3 and not shadow and state = 'open'",
      [pageId, FIND, groupOf(n)],
    );
    return Number(result.rows[0]!.id);
  }

  async function sharedRead(pageId: number, n: number) {
    return readDmFindSharedRead(db(), {
      workId: await findWorkId(pageId, n),
      pageId,
      platformConversationId: groupOf(n),
      listOperation: "messaging.groups",
      listKeys: DM_LIST_READ_KEYS,
    });
  }

  it("counts only an applied read of the list head by a list key admitted since the find's first demand; a chat a write since served is found", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const at = NOW_MS - HOUR;
    // Admitted before the demand: it may have been served before the chat existed.
    await journalListRead(pageId, { resource: "dm-conversations.head", offset: 0 });
    // Chat 2's thread was listed before the demand too.
    await seedThreads(pageId, [{ n: 2, headId: messageOf(2), headAtMs: at }]);
    await testDb.pool.query("update page_dm_threads set last_seen_at = clock_timestamp() - interval '1 minute' where platform_account_id = $1", [pageId]);
    await makeDue(pageId, FIND, groupOf(1));
    await makeDue(pageId, FIND, groupOf(2));
    expect(await sharedRead(pageId, 1)).toEqual({ found: false, headRead: null });
    expect(await sharedRead(pageId, 2)).toEqual({ found: false, headRead: null });

    // Since the demand, none of these answers it: an answer not applied, a
    // page past the head, a read no list key made (an owner probe).
    await journalListRead(pageId, { resource: "dm-conversations.ws-down", offset: 0, applyState: "captured" });
    await journalListRead(pageId, { resource: "dm-conversations.full", offset: 100 });
    await journalListRead(pageId, { resource: "probe.manual", offset: 0 });
    await journalListRead(pageId, { resource: "dm-conversations.head", offset: 0, outcome: "unknown", applyState: "none" });
    // … nor an estimate shadow mode left in the journal.
    await journalListRead(pageId, { resource: "dm-conversations.head", offset: 0, shadow: true, applyState: "applied" });
    expect(await sharedRead(pageId, 1)).toEqual({ found: false, headRead: null });

    // An applied head read of any list key (here the socket repair's) does;
    // the first one counts.
    const repair = await journalListRead(pageId, { resource: "repair.ws-gap", offset: 0 });
    await journalListRead(pageId, { resource: FIND, offset: 0 });
    expect(await sharedRead(pageId, 1)).toEqual({
      found: false,
      headRead: { attemptId: repair, resource: "repair.ws-gap", subject: "", admittedAt: expect.any(Date) },
    });
    // A write of the chat's thread since the demand (the list's writer) finds it.
    await testDb.pool.query("update page_dm_threads set last_seen_at = clock_timestamp() where platform_account_id = $1", [pageId]);
    expect(await sharedRead(pageId, 2)).toMatchObject({ found: true });
  });

  it("a burst: one list head read answers every find — the chats it shows close with no request before the HTTP gate, the one it does not show reads its detail, every found chat is read urgently", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const old = NOW_MS - 2 * HOUR;
    const recent = NOW_MS - 30_000;
    await seedThreads(pageId, [{ n: 1, headId: messageOf(1), headAtMs: old, newestStored: messageOf(1) }]);
    const listed = [2, 3, 4, 5, 6];
    const hidden = 7;
    for (const n of [...listed, hidden]) await makeDue(pageId, FIND, groupOf(n));
    const metrics = new RecordingMetrics();
    const { hits } = await runLive(pageId, (req) => {
      if (req.spec === "messaging.groups") {
        return okResponse(listPage([...listed.map((n) => ({ n, headId: messageOf(n, 7), headAtMs: recent })), { n: 1, headId: messageOf(1), headAtMs: old }]));
      }
      if (req.spec === "group.detail") return okResponse(groupDetail(hidden, [fanOf(hidden)], { id: messageOf(hidden, 7), atMs: recent, senderId: fanOf(hidden) }));
      return okResponse({ messages: [] });
    }, async () => (await openFinds(pageId)) === 0, { metrics });

    // One list read for the burst, one detail for the chat it did not show.
    expect(hits.filter((spec) => spec !== "messages.page")).toEqual(["messaging.groups", "group.detail"]);
    const attempts = await attemptsOf(pageId);
    const listRead = attempts.find((attempt) => attempt.operation === "messaging.groups")!;
    expect(listRead).toMatchObject({ resource: FIND, subject: groupOf(2) });
    const finds = new Map((await findRows(pageId)).map((row) => [row.subject, row]));
    expect(finds.get(groupOf(2))).toMatchObject({ state: "done", close_reason: "found_in_list" });
    for (const n of [3, 4, 5, 6]) {
      expect(finds.get(groupOf(n)), `find ${n}`).toMatchObject({
        state: "done",
        close_reason: "found_by_shared_read",
        result: { groupId: groupOf(n), sharedRead: { attemptId: listRead.id, resource: FIND, subject: groupOf(2) } },
      });
    }
    expect(finds.get(groupOf(hidden))).toMatchObject({ state: "done", close_reason: "found_by_detail" });
    expect(attempts.filter((attempt) => attempt.resource === FIND).map((attempt) => [attempt.operation, attempt.subject]))
      .toEqual([["messaging.groups", groupOf(2)], ["group.detail", groupOf(hidden)]]);
    // Closed before the gate, with no slot.
    expect(metrics.get("sync_steps_before_gate")).toBeGreaterThanOrEqual(4);
    // Every found chat's message is read urgently, never a planned catch-up.
    for (const n of [...listed, hidden]) {
      expect(await workRow(pageId, "dm-messages.head", { subject: groupOf(n) }), `head ${n}`).toMatchObject({
        class: "urgent",
        demand: expect.objectContaining({ messageIds: [messageOf(n, 7)] }),
      });
    }
    expect(await subjectsOf(pageId, "dm-messages.catchup")).toEqual([]);
    expect(await thread(pageId, hidden)).toMatchObject({ partner: fanOf(hidden) });
  });

  it("a list head read before the find's demand answers nothing: the find reads the list itself, not the detail", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const recent = NOW_MS - 30_000;
    // The planned head poll reads the list before the chat's first message.
    await makeDue(pageId, "dm-conversations.head");
    await runLive(pageId, () => okResponse(listPage([{ n: 1, headId: messageOf(1), headAtMs: recent }])),
      async () => (await workRow(pageId, "dm-conversations.head"))?.cursor.last != null);
    await makeDue(pageId, FIND, groupOf(8));
    const { hits } = await runLive(pageId, (req) => {
      if (req.spec === "messaging.groups") {
        return okResponse(listPage([{ n: 8, headId: messageOf(8), headAtMs: recent }, { n: 1, headId: messageOf(1), headAtMs: recent }]));
      }
      return okResponse({ messages: [] });
    }, async () => (await openFinds(pageId)) === 0);
    expect(hits.filter((spec) => spec !== "messages.page")).toEqual(["messaging.groups"]);
    expect((await findRows(pageId))[0]).toMatchObject({ close_reason: "found_in_list" });
  });

  it("while a 429 holds the list route (the page's route state), a find reads its detail alone", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    await seedRouteState(testDb, { pageId, route: "messaging.groups", holdSeconds: 5 * 60, ladderStep: 1, effectivePerMin: 6 });
    await makeDue(pageId, FIND, groupOf(8));
    const { hits } = await runLive(pageId, (req) => {
      if (req.spec === "group.detail") return okResponse(groupDetail(8, [fanOf(8)], { id: messageOf(8), atMs: NOW_MS - 10_000, senderId: fanOf(8) }));
      return okResponse({ messages: [] });
    }, async () => (await openFinds(pageId)) === 0);
    expect(hits.filter((spec) => spec !== "messages.page")).toEqual(["group.detail"]);
    expect((await findRows(pageId))[0]).toMatchObject({ close_reason: "found_by_detail" });
  });

  it("under a page hold, a find a list read answered still closes before the gate, asking its chat's urgent read unless one is open; one it did not answer waits for its detail's slot", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const at = NOW_MS - HOUR;
    for (const n of [1, 2, 3, 4]) await makeDue(pageId, FIND, groupOf(n));
    // The socket repair's head read since the demands served chats 1, 3 and
    // 4 (its apply wrote the threads) but did not see their finds — their
    // demands committed while it applied, so it asked no urgent read; chat 3
    // has one open anyway (a socket frame of it since), chat 4's head was
    // confirmed since. Chat 2 was not on it.
    await journalListRead(pageId, { resource: "repair.ws-gap", offset: 0 });
    await seedThreads(pageId, [
      { n: 1, headId: messageOf(1), headAtMs: at },
      { n: 3, headId: messageOf(3), headAtMs: at },
      { n: 4, headId: messageOf(4), headAtMs: at },
    ]);
    await testDb.pool.query("update page_dm_threads set last_seen_at = clock_timestamp() where platform_account_id = $1", [pageId]);
    await testDb.pool.query("update page_dm_threads set head_confirmed_id = last_message_id where platform_account_id = $1 and platform_conversation_id = $2", [pageId, groupOf(4)]);
    await upsertDemand(db(), {
      pageId, resource: "dm-messages.head", subject: groupOf(3), kind: "trigger", class: "urgent",
      demand: { messageIds: [messageOf(3)], reasons: ["ws:message_created"] },
    });
    await setPageHold(db(), { pageId, kind: "network", until: new Date(Date.now() + 5 * 60_000) });
    const metrics = new RecordingMetrics();
    const { hits } = await runLive(pageId, () => {
      throw new Error("nothing is sent under the hold");
    }, async () => (await findRows(pageId)).filter((row) => row.state === "done").length === 3, { metrics });
    expect(hits).toEqual([]);
    const finds = await findRows(pageId);
    expect(finds.map((row) => [row.subject, row.state, row.close_reason])).toEqual([
      [groupOf(1), "done", "found_by_shared_read"],
      [groupOf(2), "open", null],
      [groupOf(3), "done", "found_by_shared_read"],
      [groupOf(4), "done", "found_by_shared_read"],
    ]);
    expect(finds[0]!.result).toMatchObject({ groupId: groupOf(1), sharedRead: { resource: "repair.ws-gap", subject: "" } });
    expect(metrics.get("sync_steps_before_gate")).toBe(3);
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_attempts where page_id = $1 and resource = $2", [pageId, FIND])).toBe(0);
    // Chat 1's urgent read is the closure's; chat 3's open one is untouched;
    // chat 4 needs none.
    expect(await subjectsOf(pageId, "dm-messages.head")).toEqual([groupOf(1), groupOf(3)]);
    expect(await workRow(pageId, "dm-messages.head", { subject: groupOf(1) })).toMatchObject({
      class: "urgent",
      demand: expect.objectContaining({ messageIds: [messageOf(1)] }),
    });
    const three = await testDb.pool.query<{ demand_revision: number }>(
      "select demand_revision from sync_work where page_id = $1 and resource = 'dm-messages.head' and subject = $2",
      [pageId, groupOf(3)],
    );
    expect(three.rows.map((row) => Number(row.demand_revision))).toEqual([1]);
    expect(await subjectsOf(pageId, "dm-messages.catchup")).toEqual([]);
  });
});

describe("a burst of .find under saturated history at the production ratios (A1: ≤ 12 s)", () => {
  // The route budgets scaled with the pause (`routeTestScale`): S = 250 ms
  // stands for 2.5 s, so the 12 s target is 1.2 s here. The messaging family
  // (4 s → 400 ms) is kept busy by an endless history read in the requests
  // class, the media statistics by an endless planned walk.
  const SETTING_MS = 250;
  const SCALE = routeTestScale(SETTING_MS);

  function busy(spec: "messages.page" | "media.offer_stats"): ResourceModule {
    const request = spec === "messages.page"
      ? { spec, params: { groupId: groupOf(999), before: null, after: null } }
      : { spec, params: { mediaOfferId: "777", beforeMs: 2_000_000_000_000, afterMs: 1_990_000_000_000, periodMs: 86_400_000 } };
    return {
      async plan() {
        return { kind: "request", request: request as never };
      },
      async apply(_tx, input) {
        return { work: { satisfiesRevision: false, nextDueAt: input.now }, followups: [] };
      },
    };
  }

  it("every find of the burst a head read shows closes within 12 s (scaled), one list read; the chat it does not show reads its detail", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const registry = createEngineRegistry([
      ...FANSLY_RESOURCE_SPECS,
      testSpec("history.busy", busy("messages.page"), { kind: "goal", class: "requests", operations: ["messages.page"] }),
      testSpec("media.busy", busy("media.offer_stats"), { kind: "goal", class: "planned", operations: ["media.offer_stats"] }),
    ]);
    const page = await getSyncPage(db(), pageId);
    await ensurePollRows(db(), { pageId, polls: pollsFor(registry, page!).map((poll) => ({ ...poll, phase: 0.999 })) });
    // The history request whose endless read keeps the requests class busy.
    for (const key of ["history.busy", "media.busy"]) {
      await upsertDemand(db(), { pageId, resource: key, kind: "goal", class: key === "history.busy" ? "requests" : "planned", demand: { reasons: ["test"] } });
    }
    const request = await testDb.pool.query<{ id: string }>(
      `insert into history_requests (request_ref, page_id, requester_kind, idempotency_key, request_fingerprint, depth_kind,
                                     reason_sha256, reason_length, items_total, estimate_at_submit)
       values (gen_random_uuid(), $1, 'owner_cli', gen_random_uuid(), repeat('a', 64), 'all', repeat('b', 64), 4, 1, '{}'::jsonb) returning id`,
      [pageId],
    );
    await testDb.pool.query(
      `insert into history_request_items (request_id, page_id, ordinal, input_kind, input_ref, state, work_id)
       select $1, $2, 1, 'conversation_ref', 'busy', 'queued', w.id from sync_work w
        where w.page_id = $2 and w.resource = 'history.busy' and w.state = 'open'`,
      [Number(request.rows[0]!.id), pageId],
    );

    const recent = NOW_MS - 30_000;
    const listed = [2, 3, 4, 5, 6];
    const hidden = 7;
    const transport = new ScriptedLiveTransport();
    transport.respond = (req) => {
      if (req.spec === "messaging.groups") return okResponse(listPage(listed.map((n) => ({ n, headId: messageOf(n, 7), headAtMs: recent }))));
      if (req.spec === "group.detail") return okResponse(groupDetail(hidden, [fanOf(hidden)], { id: messageOf(hidden, 7), atMs: recent, senderId: fanOf(hidden) }));
      if (req.spec === "messages.page") return okResponse({ messages: [] });
      return okResponse();
    };
    const { actor, stop, abort } = await makeTestActor({
      db: db(), pageId, registry, transport, settingMs: SETTING_MS, routeTimeScale: SCALE, ownRef: OWN_ID,
    });
    const run = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      // History saturates the family first; then the burst arrives.
      await waitFor(async () => (transport.hits.filter((hit) => hit.spec === "messages.page").length >= 8 ? true : null), 30_000, "history");
      for (const n of [...listed, hidden]) await makeDue(pageId, FIND, groupOf(n));
      await waitFor(async () => ((await openFinds(pageId)) === 0 ? true : null), 30_000, "the burst's finds");
      // History goes on beside it.
      const before = transport.hits.length;
      await waitFor(async () => (transport.hits.length >= before + 4 ? true : null), 30_000, "more reads");
    } finally {
      stop.abort();
      await run;
    }

    const finds = await findRows(pageId);
    const slo = fanslyResourceSpec(FIND)!.slo!.resultMs! * SCALE;
    for (const row of finds.filter((candidate) => candidate.subject !== groupOf(hidden))) {
      expect(row.state, row.subject).toBe("done");
      expect(row.closed_at!.getTime() - row.first_demand_at.getTime(), row.subject).toBeLessThanOrEqual(slo);
    }
    const hiddenFind = finds.find((row) => row.subject === groupOf(hidden))!;
    expect(hiddenFind).toMatchObject({ state: "done", close_reason: "found_by_detail" });
    expect(hiddenFind.closed_at!.getTime() - hiddenFind.first_demand_at.getTime()).toBeLessThanOrEqual(25_000 * SCALE);
    const attempts = await attemptsOf(pageId);
    const sent = attempts.filter((attempt) => attempt.sent_at !== null);
    expect(sent.filter((attempt) => attempt.resource === FIND).map((attempt) => attempt.operation)).toEqual(["messaging.groups", "group.detail"]);
    // History was not starved by the burst: it kept its turns from the
    // burst's first demand on.
    const burstFrom = Math.min(...finds.map((row) => row.first_demand_at.getTime()));
    expect(sent.filter((attempt) => attempt.resource === "history.busy" && attempt.sent_at!.getTime() >= burstFrom).length).toBeGreaterThanOrEqual(2);
    // The route and family budgets held throughout (scaled).
    const gaps = (operations: readonly string[]) => {
      const times = sent.filter((attempt) => operations.includes(attempt.operation)).map((attempt) => attempt.sent_at!.getTime());
      return times.slice(1).map((time, index) => time - times[index]!);
    };
    const family = Math.ceil(intervalMsOf(FAMILY_BUDGETS.messaging.currentPerMin) * SCALE);
    for (const gap of gaps(["messages.page", "messaging.groups", "group.detail"])) expect(gap).toBeGreaterThanOrEqual(family);
    const media = Math.ceil(intervalMsOf(routeBudget("media.offer_stats").currentPerMin) * SCALE);
    for (const gap of gaps(["media.offer_stats"])) expect(gap).toBeGreaterThanOrEqual(media);
    for (const gap of gaps(sent.map((attempt) => attempt.operation))) expect(gap).toBeGreaterThanOrEqual(SETTING_MS);
  }, 90_000);
});

describe("a 429 on the conversation list (owner decisions №14, №22)", () => {
  function accountMe() {
    return { account: { id: OWN_ID, username: "model", displayName: "Model", followCount: 0, subscriberCount: 0 } };
  }

  /** The list route as the page's hold set has it: the page's own hold (none),
   *  the breaker of the list's file (none), the route's entry. */
  async function listRoute(pageId: number) {
    const page = (await getSyncPage(db(), pageId))!;
    return {
      pageHold: pageHoldKindOf(page),
      listBreaker: resourceBreakersOf(page)["dm-conversations"] ?? null,
      entry: routeEntryOf(page, "messaging.groups"),
    };
  }

  /** The list route held for 5 more minutes (the test's stand-in for a long Retry-After). */
  async function holdListLonger(pageId: number): Promise<void> {
    const entry = routeEntryOf((await getSyncPage(db(), pageId))!, "messaging.groups")!;
    expect(await writeSyncRouteState(db(), {
      pageId,
      route: "messaging.groups",
      expectRevision: entry.revision,
      entry: {
        holdUntil: new Date(Date.now() + 5 * 60_000),
        ladderStep: entry.ladderStep,
        effectivePerMin: entry.effectivePerMin,
        policyVersion: entry.policyVersion,
        last429AttemptId: entry.last429AttemptId,
        last429At: entry.last429At === null ? null : new Date(entry.last429At),
      },
    })).toMatchObject({ kind: "written" });
  }

  it("holds only the list's route: the page and every other resource go on, and .find goes straight to the group detail", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    await testDb.pool.query("update pages set last_verified_at = clock_timestamp() - interval '3 hours' where id = $1", [pageId]);
    await makeDue(pageId, "dm-conversations.head");
    await makeDue(pageId, "account.poll");
    const metrics = new RecordingMetrics();
    const first = await runLive(pageId, (req) => {
      if (req.spec === "messaging.groups") return statusResponse(429, { success: false });
      if (req.spec === "account.me") return okResponse(accountMe());
      throw new Error(`unexpected ${req.spec}`);
    }, async () => (await countRows(testDb!.pool,
      "select count(*)::int as n from sync_attempts where page_id = $1 and resource = 'account.poll' and apply_state = 'applied'", [pageId])) === 1
      && (await countRows(testDb!.pool,
        "select count(*)::int as n from sync_attempts where page_id = $1 and resource = 'dm-conversations.head' and http_status = 429", [pageId])) === 1,
    { metrics });

    // One list read, no retry while held; the page's other work went out.
    expect(first.hits.filter((spec) => spec === "messaging.groups")).toHaveLength(1);
    expect(first.hits).toContain("account.me");
    const held = await listRoute(pageId);
    expect(held).toMatchObject({ pageHold: null, listBreaker: null, entry: { ladderStep: 1, effectivePerMin: 6 } });
    const untilMs = new Date(held.entry!.holdUntil!).getTime() - Date.now();
    // The ladder's first step: 5 s + ≤ 20 % jitter.
    expect(untilMs).toBeLessThanOrEqual(6_000);
    // Open and due: the route admission keeps it out of the pick while its only route is held.
    expect(await workRow(pageId, "dm-conversations.head")).toMatchObject({ state: "open", waiting_reason: null });
    expect(metrics.get("sync_route_held")).toBe(1);

    // While the list is held, a chat the socket names is found by its detail alone.
    await holdListLonger(pageId);
    await makeDue(pageId, "dm-conversations.find", groupOf(8));
    const second = await drive(pageId, createEngineRegistry(FANSLY_RESOURCE_SPECS), (req) => {
      if (req.spec === "group.detail") return okResponse(groupDetail(8, [fanOf(8)], { id: messageOf(8), atMs: NOW_MS - 10_000, senderId: fanOf(8) }));
      throw new Error(`unexpected ${req.spec}`);
    }, async () => (await workRow(pageId, "dm-conversations.find"))?.state === "done");
    expect(second.hits).toEqual(["group.detail"]);
    expect((await workRow(pageId, "dm-conversations.find"))!.close_reason).toBe("found_by_detail");
    expect(await subjectsOf(pageId, "dm-messages.head")).toEqual([groupOf(8)]);
  });

  it("holds only list work: dm-messages.head and transactions.head still go out while the list waits (design §5.3, §3.8)", async (context) => {
    if (!testDb) return context.skip();
    // Both run their own modules (S2-07b `transactions.head`, S2-08b
    // `dm-messages.head`): what is pinned is the engine's side — the pick, the
    // hold, the admission — and that each read still applies while held.
    const pageId = await seedPage();
    const registry = await quietRegistry(pageId);
    // The chat the message arrives in: bound, nothing stored, no chain yet.
    const headAtMs = NOW_MS - 60_000;
    await seedThreads(pageId, [{ n: 3, headId: messageOf(3), headAtMs }]);

    // The list read takes a 429.
    await makeDue(pageId, "dm-conversations.head");
    const first = await drive(pageId, registry, (req) => {
      if (req.spec === "messaging.groups") return statusResponse(429, { success: false });
      throw new Error(`unexpected ${req.spec}`);
    }, async () => (await listRoute(pageId)).entry !== null);
    expect(first.hits).toEqual(["messaging.groups"]);

    // While the list is held its walk is due, and a message and a money event arrive.
    await holdListLonger(pageId);
    await testDb.pool.query(
      `update sync_work set due_at = clock_timestamp() - interval '1 second'
        where page_id = $1 and shadow = false and resource = 'dm-conversations.head' and state = 'open'`,
      [pageId],
    );
    await makeDue(pageId, "dm-messages.head", groupOf(3));
    await makeDue(pageId, "transactions.head");
    const message = {
      id: messageOf(3), type: 1, dataVersion: 1, content: "hello", groupId: groupOf(3), senderId: fanOf(3),
      correlationId: null, inReplyTo: null, inReplyToRoot: null, createdAt: Math.floor(headAtMs / 1000),
      attachments: [], embeds: [], interactions: [], likes: [],
    };
    const second = await drive(pageId, registry, (req) => {
      if (req.spec === "messages.page") return okResponse({ messages: [message] });
      if (req.spec === "transactions.page") return okResponse({ total: 0, data: [] });
      throw new Error(`unexpected ${req.spec}`);
    }, async () => (await workRow(pageId, "dm-messages.head"))?.state === "done" &&
      (await workRow(pageId, "transactions.head"))?.state === "done");

    // Both went out; the list did not. The message read applied: its head
    // starts the chat's chain (one short page: partial, never complete).
    expect([...second.hits].sort()).toEqual(["messages.page", "transactions.page"]);
    expect((await workRow(pageId, "dm-messages.head"))!.close_reason).toBe("confirmed");
    expect(await thread(pageId, 3)).toMatchObject({ head_confirmed_id: messageOf(3), history_state: "partial", stored_message_count: 1 });
    expect(await listRoute(pageId)).toMatchObject({ pageHold: null, listBreaker: null, entry: { ladderStep: 1 } });
    expect(await workRow(pageId, "dm-conversations.head")).toMatchObject({ state: "open", waiting_reason: null });
    expect(await countRows(testDb.pool,
      "select count(*)::int as n from sync_attempts where page_id = $1 and resource = 'dm-conversations.head'", [pageId])).toBe(1);
  });

  it("keeps the idle actor asleep while the list is held: a held row is never due to it", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    // Both list walks due: one takes the 429, the other is held before it is sent.
    await makeDue(pageId, "dm-conversations.head");
    await makeDue(pageId, "dm-conversations.full");
    const registry = await quietRegistry(pageId);
    // The production wake answers a wait of 0 ms at once (host-ports.ts).
    const productionWake: Wake = {
      async wait(_pageId, ms, signal) {
        if (signal.aborted || !(ms > 0)) return "timeout";
        await sleep(ms, undefined, { signal }).catch(() => undefined);
        return "timeout";
      },
    };
    let statements = 0;
    const counted = new Proxy(db() as object, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        const bound = (value as (...args: unknown[]) => unknown).bind(target);
        if (prop !== "execute" && prop !== "transaction") return bound;
        return (...args: unknown[]) => {
          statements += 1;
          return bound(...args);
        };
      },
    }) as Database;
    const transport = new ScriptedLiveTransport();
    transport.respond = (req) => {
      if (req.spec === "messaging.groups") return statusResponse(429, { success: false });
      throw new Error(`unexpected ${req.spec}`);
    };
    const { actor, stop, abort } = await makeTestActor({
      db: counted, pageId, registry, transport, wake: productionWake, metrics: new RecordingMetrics(),
    });
    const run = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      await waitFor(async () => ((await countRows(testDb!.pool,
        "select count(*)::int as n from sync_attempts where page_id = $1 and http_status = 429", [pageId])) === 1 ? true : null),
      30_000, "the list 429");
      // Inside the first list hold (5 s): an idle lap a second, not a spin.
      const before = statements;
      await sleep(2_000);
      expect((statements - before) / 2).toBeLessThan(50);
    } finally {
      stop.abort();
      await run;
    }
    expect(transport.hits.map((hit) => hit.spec)).toEqual(["messaging.groups"]);
    const held = await testDb.pool.query<{ resource: string; waiting_reason: string | null }>(
      `select resource, waiting_reason from sync_work
        where page_id = $1 and shadow = false and resource in ('dm-conversations.head', 'dm-conversations.full') and state = 'open'
        order by resource`,
      [pageId],
    );
    // Both walks stay open and due: the route's hold keeps them out of every
    // pick (and out of the idle actor's next-due read) until it ends.
    expect(held.rows).toEqual([
      { resource: "dm-conversations.full", waiting_reason: null },
      { resource: "dm-conversations.head", waiting_reason: null },
    ]);
    expect((await listRoute(pageId)).entry).toMatchObject({ ladderStep: 1 });
  });
});
