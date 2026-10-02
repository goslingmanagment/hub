import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ensurePollRows,
  getSyncPage,
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
} from "../apps/runtime/src/sync/engine/resource.ts";
import { FANSLY_RESOURCE_SPECS, fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  changedTables,
  countRows,
  makeTestActor,
  okResponse,
  RecordingAlerts,
  RecordingMetrics,
  ScriptedLiveTransport,
  seedSyncPage,
  statusResponse,
  tableCounts,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// The conversation list of the Fansly Sync Engine (design §5.3) through the
// real actor and commits against a real database: a scripted live transport
// answers `/messaging/groups` and `/group/:id`; shadow runs the same registry
// without one. What is pinned: the list writes only its own fields (never the
// stored window, the coverage verdict or the chain, never an unbinding), a
// head walk stops at the first page it already knows, a full walk stamps its
// generation and hides nothing, a list head newer than the message reads asks
// for exactly one read, an unknown chat is found through its detail, and a
// shadow step writes only sync_work and sync_attempts.

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
async function quietRegistry(pageId: number, shadow: boolean): Promise<EngineRegistry> {
  const registry = createEngineRegistry(FANSLY_RESOURCE_SPECS);
  const page = await getSyncPage(db(), pageId);
  await ensurePollRows(db(), {
    pageId,
    shadow,
    polls: pollsFor(registry, page!, shadow).map((poll) => ({ ...poll, phase: 0.999 })),
  });
  return registry;
}

async function makeDue(pageId: number, shadow: boolean, resource: string, subject?: string) {
  const spec = fanslyResourceSpec(resource)!;
  await upsertDemand(db(), {
    pageId,
    shadow,
    resource,
    kind: spec.kind,
    class: spec.class,
    ...(subject === undefined ? {} : { subject }),
    demand: { reasons: ["test"] },
  });
}

async function seedPage(mode: "live" | "shadow", engineStartedAgoMs = 24 * HOUR) {
  const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, {
    mode,
    guard: mode === "live" ? "fansly_sync_engine" : null,
  });
  await testDb!.pool.query("update pages set external_page_id = $2 where id = $1", [pageId, OWN_ID]);
  await testDb!.pool.query(
    `update sync_pages set legacy_imported_at = case when mode = 'live' then clock_timestamp() - $2::double precision * interval '1 millisecond' end,
            mode_changed_at = clock_timestamp() - $2::double precision * interval '1 millisecond'
      where page_id = $1`,
    [pageId, engineStartedAgoMs],
  );
  return pageId;
}

type Responder = (req: FanslyWireRequest) => FanslyWireOutcome;

async function drive(
  pageId: number,
  mode: "live" | "shadow",
  registry: EngineRegistry,
  respond: Responder | null,
  until: () => Promise<boolean>,
  options: { alerts?: RecordingAlerts; metrics?: RecordingMetrics } = {},
) {
  const transport = respond === null ? undefined : new ScriptedLiveTransport();
  if (transport !== undefined && respond !== null) transport.respond = (req) => respond(req);
  const { actor, stop, abort } = await makeTestActor({
    db: db(),
    pageId,
    mode,
    registry,
    alerts: options.alerts ?? new RecordingAlerts(),
    metrics: options.metrics ?? new RecordingMetrics(),
    ...(transport === undefined ? {} : { transport }),
  });
  const run = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => ((await until()) ? true : null), 30_000, "the work to settle");
  } finally {
    stop.abort();
    await run;
  }
  return { hits: transport?.hits.map((hit) => hit.spec) ?? [] };
}

async function runLive(pageId: number, respond: Responder, until: () => Promise<boolean>, options: { metrics?: RecordingMetrics } = {}) {
  const registry = await quietRegistry(pageId, false);
  return drive(pageId, "live", registry, respond, until, options);
}

function offsetOf(req: FanslyWireRequest): number {
  return Number(new URL(req.url).searchParams.get("offset"));
}

async function workRow(pageId: number, resource: string, options: { shadow?: boolean; subject?: string } = {}) {
  const result = await testDb!.pool.query<{
    state: string; class: string; cursor: Record<string, unknown>; proof: Record<string, unknown> | null;
    result: Record<string, unknown> | null; demand: { messageIds: string[] }; params: Record<string, unknown>;
    due_at: Date; close_reason: string | null; failure_count: number; breaker_until: Date | null; waiting_reason: string | null;
  }>(
    `select state, class, cursor, proof, result, demand, params, due_at, close_reason, failure_count, breaker_until, waiting_reason
       from sync_work
      where page_id = $1 and resource = $2 and shadow = $3 and ($4::text is null or subject = $4)
      order by id desc limit 1`,
    [pageId, resource, options.shadow ?? false, options.subject ?? null],
  );
  return result.rows[0] ?? null;
}

async function subjectsOf(pageId: number, resource: string, shadow = false): Promise<string[]> {
  const result = await testDb!.pool.query<{ subject: string }>(
    "select subject from sync_work where page_id = $1 and resource = $2 and shadow = $3 order by subject",
    [pageId, resource, shadow],
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
    const pageId = await seedPage("live");
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
    await makeDue(pageId, false, "dm-conversations.head");
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
    const pageId = await seedPage("live");
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
    await makeDue(pageId, false, "dm-conversations.head");
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
    const pageId = await seedPage("live", HOUR);
    const at = NOW_MS - 2 * HOUR;
    const chats = Array.from({ length: 500 }, (_, index) => ({ n: 1000 + index, headId: messageOf(1000 + index), headAtMs: at }));
    // 9999: visible, never listed by this walk.
    await seedThreads(pageId, [...chats.map((chat) => ({ ...chat, newestStored: chat.headId })), { n: 9999, headId: null, headAtMs: null }]);
    await makeDue(pageId, false, "dm-conversations.full");
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
    const pageId = await seedPage("live");
    const at = NOW_MS - 2 * HOUR;
    const chats = Array.from({ length: 100 }, (_, index) => ({ n: 3000 + index, headId: messageOf(3000 + index), headAtMs: at }));
    await makeDue(pageId, false, "dm-conversations.full");
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
    const second = await drive(pageId, "live", createEngineRegistry(FANSLY_RESOURCE_SPECS), () => okResponse(doubled),
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
    const pageId = await seedPage("live");
    const at = NOW_MS - 2 * HOUR;
    await seedThreads(pageId, [{ n: 1, headId: messageOf(1), headAtMs: at, newestStored: messageOf(1) }]);
    const newMessage = { id: messageOf(2, 7), atMs: NOW_MS - 30_000, senderId: fanOf(2) };
    await makeDue(pageId, false, "dm-conversations.find", groupOf(2));
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
    const pageId = await seedPage("live");
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
    await makeDue(pageId, false, "dm-conversations.find", groupOf(9));
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
    const pageId = await seedPage("live");
    const fansBefore = await countRows(testDb.pool, "select count(*)::int as n from fans");
    const group = groupDetail(10, [fanOf(10), fanOf(11)], { id: messageOf(10, 2), atMs: NOW_MS - 60_000, senderId: fanOf(10) });
    await makeDue(pageId, false, "dm-conversations.detail", groupOf(10));
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
    const pageId = await seedPage("live");
    const recent = NOW_MS - 60_000;
    await seedThreads(pageId, [{ n: 1, headId: messageOf(1), headAtMs: recent - HOUR, newestStored: messageOf(1) }]);
    await makeDue(pageId, false, "dm-conversations.find", groupOf(2));
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
    const pageId = await seedPage("live");
    await seedThreads(pageId, [{ n: 5, partner: null, headId: null, headAtMs: null, metadata: { unresolvedIdentity: true } }]);
    await makeDue(pageId, false, "dm-conversations.detail", groupOf(5));
    const { hits } = await runLive(pageId, () => statusResponse(500, { success: false, error: { code: 500 } }),
      async () => ((await workRow(pageId, "dm-conversations.detail"))?.failure_count ?? 0) >= 1);
    expect(hits).toEqual(["group.detail"]);
    const detail = await workRow(pageId, "dm-conversations.detail");
    expect(detail).toMatchObject({ state: "open", failure_count: 1 });
    expect(detail!.breaker_until!.getTime()).toBeGreaterThan(Date.now());
    const page = await testDb.pool.query("select hold_kind, resource_holds from sync_pages where page_id = $1", [pageId]);
    expect(page.rows[0]).toEqual({ hold_kind: null, resource_holds: {} });
    expect(await thread(pageId, 5)).toMatchObject({ partner: null, metadata: { unresolvedIdentity: true } });
  });
});

describe("a 429 on the conversation list (owner decision 2026-10-02)", () => {
  function accountMe() {
    return { account: { id: OWN_ID, username: "model", displayName: "Model", followCount: 0, subscriberCount: 0 } };
  }

  it("holds only the list: the page and every other resource go on, and .find goes straight to the group detail", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("live");
    await testDb.pool.query("update pages set last_verified_at = clock_timestamp() - interval '3 hours' where id = $1", [pageId]);
    await makeDue(pageId, false, "dm-conversations.head");
    await makeDue(pageId, false, "account.poll");
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
    const page = await testDb.pool.query<{ hold_kind: string | null; hold: { kind: string; step: number; until: string } }>(
      "select hold_kind, resource_holds -> 'dm-conversations' as hold from sync_pages where page_id = $1",
      [pageId],
    );
    expect(page.rows[0]!.hold_kind).toBeNull();
    expect(page.rows[0]!.hold).toMatchObject({ kind: "rate_limit_list", step: 1 });
    const untilMs = new Date(page.rows[0]!.hold.until).getTime() - Date.now();
    expect(untilMs).toBeLessThanOrEqual(5_000);
    expect(await workRow(pageId, "dm-conversations.head")).toMatchObject({ state: "open", waiting_reason: "resource_hold" });
    expect(metrics.get("sync_list_rate_limited")).toBe(1);

    // While the list is held, a chat the socket names is found by its detail alone.
    await testDb.pool.query(
      `update sync_pages set resource_holds = jsonb_set(resource_holds, '{dm-conversations,until}',
              to_jsonb(clock_timestamp() + interval '5 minutes')) where page_id = $1`,
      [pageId],
    );
    await makeDue(pageId, false, "dm-conversations.find", groupOf(8));
    const second = await drive(pageId, "live", createEngineRegistry(FANSLY_RESOURCE_SPECS), (req) => {
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
    const pageId = await seedPage("live");
    const registry = await quietRegistry(pageId, false);
    // The chat the message arrives in: bound, nothing stored, no chain yet.
    const headAtMs = NOW_MS - 60_000;
    await seedThreads(pageId, [{ n: 3, headId: messageOf(3), headAtMs }]);

    // The list read takes a 429.
    await makeDue(pageId, false, "dm-conversations.head");
    const first = await drive(pageId, "live", registry, (req) => {
      if (req.spec === "messaging.groups") return statusResponse(429, { success: false });
      throw new Error(`unexpected ${req.spec}`);
    }, async () => (await workRow(pageId, "dm-conversations.head"))?.waiting_reason === "resource_hold");
    expect(first.hits).toEqual(["messaging.groups"]);

    // While the list is held its walk is due, and a message and a money event arrive.
    await testDb.pool.query(
      `update sync_pages set resource_holds = jsonb_set(resource_holds, '{dm-conversations,until}',
              to_jsonb(clock_timestamp() + interval '5 minutes')) where page_id = $1`,
      [pageId],
    );
    await testDb.pool.query(
      `update sync_work set due_at = clock_timestamp() - interval '1 second'
        where page_id = $1 and shadow = false and resource = 'dm-conversations.head' and state = 'open'`,
      [pageId],
    );
    await makeDue(pageId, false, "dm-messages.head", groupOf(3));
    await makeDue(pageId, false, "transactions.head");
    const message = {
      id: messageOf(3), type: 1, dataVersion: 1, content: "hello", groupId: groupOf(3), senderId: fanOf(3),
      correlationId: null, inReplyTo: null, inReplyToRoot: null, createdAt: Math.floor(headAtMs / 1000),
      attachments: [], embeds: [], interactions: [], likes: [],
    };
    const second = await drive(pageId, "live", registry, (req) => {
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
    const page = await testDb.pool.query<{ hold_kind: string | null; hold: { kind: string } }>(
      "select hold_kind, resource_holds -> 'dm-conversations' as hold from sync_pages where page_id = $1",
      [pageId],
    );
    expect(page.rows[0]!.hold_kind).toBeNull();
    expect(page.rows[0]!.hold).toMatchObject({ kind: "rate_limit_list" });
    expect(await workRow(pageId, "dm-conversations.head")).toMatchObject({ state: "open", waiting_reason: "resource_hold" });
    expect(await countRows(testDb.pool,
      "select count(*)::int as n from sync_attempts where page_id = $1 and resource = 'dm-conversations.head'", [pageId])).toBe(1);
  });

  it("keeps the idle actor asleep while the list is held: a held row is never due to it", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("live");
    // Both list walks due: one takes the 429, the other is held before it is sent.
    await makeDue(pageId, false, "dm-conversations.head");
    await makeDue(pageId, false, "dm-conversations.full");
    const registry = await quietRegistry(pageId, false);
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
      db: counted, pageId, mode: "live", registry, transport, wake: productionWake, metrics: new RecordingMetrics(),
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
    const held = await testDb.pool.query<{ resource: string; due_at: Date; waiting_reason: string | null }>(
      `select resource, due_at, waiting_reason from sync_work
        where page_id = $1 and shadow = false and resource in ('dm-conversations.head', 'dm-conversations.full') and state = 'open'`,
      [pageId],
    );
    const hold = await testDb.pool.query<{ until: string }>(
      "select resource_holds -> 'dm-conversations' ->> 'until' as until from sync_pages where page_id = $1",
      [pageId],
    );
    // The walk that met the 429 is due again at the hold's end, not at once.
    const answered = held.rows.find((row) => row.waiting_reason === "resource_hold");
    expect(answered).toBeDefined();
    expect(answered!.due_at.getTime()).toBe(new Date(hold.rows[0]!.until).getTime());
  });
});

describe("shadow", () => {
  it("estimates the walks and their reads from what the database holds, writing nothing but its own work and attempts", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("shadow");
    const at = NOW_MS - 2 * HOUR;
    await seedThreads(pageId, [
      ...Array.from({ length: 147 }, (_, index) => ({ n: 100 + index, headId: messageOf(100 + index), headAtMs: at - index * 1000, newestStored: messageOf(100 + index) })),
      // Two heads legacy listed but has not read yet, one chat without a partner.
      { n: 10, headId: messageOf(10, 1), headAtMs: at + 1000, newestStored: messageOf(10) },
      { n: 11, headId: messageOf(11, 1), headAtMs: at - 200_000, newestStored: messageOf(11) },
      { n: 12, partner: null, headId: messageOf(12), headAtMs: at - 300_000 },
    ]);
    const registry = await quietRegistry(pageId, true);
    await makeDue(pageId, true, "dm-conversations.full");
    await makeDue(pageId, true, "dm-conversations.head");
    const before = await tableCounts(testDb.pool);
    const threadsBefore = await testDb.pool.query("select max(updated_at) as at from page_dm_threads where platform_account_id = $1", [pageId]);
    await drive(pageId, "shadow", registry, null, async () =>
      (await workRow(pageId, "dm-conversations.full", { shadow: true }))?.cursor.shadow === null
      && (await countRows(testDb!.pool, "select count(*)::int as n from sync_attempts where page_id = $1 and resource = 'dm-conversations.full'", [pageId])) === 2
      && (await countRows(testDb!.pool, "select count(*)::int as n from sync_attempts where page_id = $1 and resource = 'dm-conversations.head'", [pageId])) === 1
      && (await workRow(pageId, "dm-conversations.detail", { shadow: true }))?.state === "done");

    const attempts = await testDb.pool.query<{ resource: string; operation: string; n: number }>(
      `select resource, operation, count(*)::int as n from sync_attempts
        where page_id = $1 and shadow and outcome = 'shadow' and apply_state = 'skipped' group by 1, 2 order by 1, 2`,
      [pageId],
    );
    // 150 visible chats, no stated total: two pages to the short one.
    expect(attempts.rows).toEqual([
      { resource: "dm-conversations.detail", operation: "group.detail", n: 1 },
      { resource: "dm-conversations.full", operation: "messaging.groups", n: 2 },
      { resource: "dm-conversations.head", operation: "messaging.groups", n: 1 },
    ]);
    expect(await subjectsOf(pageId, "dm-messages.catchup", true)).toEqual([groupOf(10), groupOf(11)]);
    expect(await subjectsOf(pageId, "dm-conversations.detail", true)).toEqual([groupOf(12)]);
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_work where page_id = $1 and not shadow and resource like 'dm-%'", [pageId])).toBe(0);
    const after = await tableCounts(testDb.pool);
    expect(changedTables(before, after)).toEqual(["sync_attempts", "sync_work"]);
    const threadsAfter = await testDb.pool.query("select max(updated_at) as at from page_dm_threads where platform_account_id = $1", [pageId]);
    expect(threadsAfter.rows[0].at).toEqual(threadsBefore.rows[0].at);
  });
});

describe("replay of legacy observations (shadow report B5)", () => {
  it("dm_conversations and group_detail against what legacy stored", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("live");
    const at = NOW_MS - 2 * HOUR;
    await seedThreads(pageId, [{ n: 1, headId: messageOf(1), headAtMs: at }, { n: 2, headId: messageOf(2), headAtMs: at }]);
    const registry = createEngineRegistry(FANSLY_RESOURCE_SPECS);
    const ctx = { db: db(), pageId };
    const later = new Date(Date.now() + HOUR);
    const observation = (kind: string, payload: unknown, receivedAt = later) => ({ id: 1, receivedAt, kind, pageId, payload });

    const list = await registry.module("dm-conversations.head");
    const served = listPage([{ n: 1, headId: messageOf(1), headAtMs: at }, { n: 2, headId: messageOf(2), headAtMs: at }]);
    expect(await list.replay!(observation("dm_conversations", served), ctx)).toEqual({ kind: "match", detail: { served: 2 } });
    expect(await list.replay!(observation("dm_conversations", listPage([{ n: 3, headId: null, headAtMs: null }])), ctx))
      .toMatchObject({ kind: "mismatch", reason: "threads_missing" });
    expect(await list.replay!(observation("dm_conversations", listPage([{ n: 1, partner: fanOf(9), headId: null, headAtMs: null }])), ctx))
      .toMatchObject({ kind: "mismatch", reason: "partner_differs" });
    // The row changed after an older observation: not a mismatch.
    expect(await list.replay!(observation("dm_conversations", listPage([{ n: 1, partner: fanOf(9), headId: null, headAtMs: null }]), new Date(at)), ctx))
      .toMatchObject({ kind: "match" });
    expect(await list.replay!(observation("dm_conversations", { contractAccepted: false, captured: {} }), ctx)).toMatchObject({ kind: "not_replayable" });
    expect(await list.replay!(observation("dm_conversations", { data: [{ nope: 1 }] }), ctx)).toMatchObject({ kind: "mismatch", reason: "contract_refused" });

    const find = await registry.module("dm-conversations.find");
    expect(await find.replay!(observation("group_detail", groupDetail(1, [fanOf(1)], null)), ctx)).toMatchObject({ kind: "match" });
    expect(await find.replay!(observation("group_detail", groupDetail(1, [fanOf(9)], null)), ctx))
      .toMatchObject({ kind: "mismatch", reason: "partner_differs" });
    expect(await find.replay!(observation("group_detail", groupDetail(7, [fanOf(7)], null)), ctx))
      .toMatchObject({ kind: "mismatch", reason: "thread_missing" });
    expect(await find.replay!(observation("group_detail", { contractAccepted: false, raw: { id: groupOf(1), users: [{}] } }), ctx))
      .toMatchObject({ kind: "match", detail: { legacyRefused: true } });
  });
});
