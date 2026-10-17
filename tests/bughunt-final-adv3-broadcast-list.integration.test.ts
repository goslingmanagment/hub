import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensurePollRows, getSyncPage, upsertDemand, upsertFans, type Database } from "@agency_hub_core/db";
import type { FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";

import { createEngineRegistry, pollsFor, type EngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { FANSLY_RESOURCE_SPECS, fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import {
  makeTestActor,
  okResponse,
  RecordingAlerts,
  RecordingMetrics,
  ScriptedLiveTransport,
  seedSyncPage,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// Bug hunt 2026-10-09, final adversarial pass (adv-3), on Д8 / decision №9 /
// D22 ("own broadcasts create no work"). The router skips an own type-2
// broadcast frame in a KNOWN chat, but nothing on the list path recognises a
// broadcast: the next `dm-conversations.head` poll sees every recipient chat's
// list head moved to the broadcast message and asks one planned
// `dm-messages.catchup` per chat (and, for chats Hub had no thread for, it
// creates the thread and asks one too). Harness copied from
// tests/sync-resources-dm-list.integration.test.ts.

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
const BROADCAST_CORRELATION = "990000000000000001";

const pad = (n: number, width: number) => String(n).padStart(width, "0");
const groupOf = (n: number) => `71000000000${pad(n, 7)}`;
const fanOf = (n: number) => `51000000000${pad(n, 7)}`;
const messageOf = (n: number, k = 0) => `91${pad(k, 3)}00000${pad(n, 8)}`;

function fanAccount(id: string) {
  return { id, username: `fan${id.slice(-4)}`, displayName: `Fan ${id.slice(-4)}`, createdAt: Date.UTC(2025, 0, 1) };
}

/** One `/messaging/groups` answer whose every chat's head is the page's own
 *  mass message (type 2, one correlationId), as Fansly serves a broadcast. */
function broadcastListPage(ns: readonly number[], atMs: number) {
  return {
    data: ns.map((n) => ({
      account_id: OWN_ID,
      groupId: groupOf(n),
      partnerAccountId: fanOf(n),
      partnerUsername: `fan${fanOf(n).slice(-4)}`,
      flags: 0,
      unreadCount: 0,
      subscriptionTierId: null,
      lastMessageId: messageOf(n, 2),
      lastUnreadMessageId: null,
    })),
    aggregationData: {
      accounts: ns.map((n) => fanAccount(fanOf(n))),
      groups: ns.map((n) => ({
        id: groupOf(n),
        type: 1,
        groupFlags: 0,
        createdBy: OWN_ID,
        users: [
          { groupId: groupOf(n), userId: OWN_ID, type: 0, permissionFlags: 0 },
          { groupId: groupOf(n), userId: fanOf(n), type: 0, permissionFlags: 0 },
        ],
        lastMessage: {
          id: messageOf(n, 2),
          type: 2,
          dataVersion: 1,
          content: "new set!",
          groupId: groupOf(n),
          senderId: OWN_ID,
          correlationId: BROADCAST_CORRELATION,
          inReplyTo: null,
          inReplyToRoot: null,
          createdAt: atMs,
          attachments: [],
          embeds: [],
          interactions: [],
          likes: [],
        },
      })),
    },
  };
}

/** Known, bound threads whose reads reached their old head. */
async function seedKnownThreads(pageId: number, ns: readonly number[], oldAtMs: number): Promise<void> {
  const fans = await upsertFans(db(), ns.map((n) => ({ platform: "fansly" as const, platformUserId: fanOf(n) })));
  const fanIds = new Map(fans.map((fan) => [fan.platformUserId, fan.id] as const));
  for (const n of ns) {
    await testDb!.pool.query(
      `insert into page_dm_threads (platform_account_id, platform_conversation_id, fan_id, partner_platform_user_id,
              partner_username, conversation_flags, unread_count, last_message_id, last_message_at, last_message_sender_id,
              last_message_sender_role, last_message_preview, newest_stored_message_id, stored_message_count,
              message_coverage_status, last_message_sync_at, is_visible, metadata, head_confirmed_id)
       values ($1, $2, $3, $4, $5, 0, 0, $6, to_timestamp($7::double precision / 1000), $4,
               'fan'::dm_sender_role, 'stored preview', $6, 5, 'partial_window', timestamptz '2026-09-01T00:00:00Z', true, '{}'::jsonb, $6)`,
      [pageId, groupOf(n), fanIds.get(fanOf(n)) ?? null, fanOf(n), `fan${fanOf(n).slice(-4)}`, messageOf(n), oldAtMs],
    );
  }
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

async function quietRegistry(pageId: number): Promise<EngineRegistry> {
  const registry = createEngineRegistry(FANSLY_RESOURCE_SPECS);
  const page = await getSyncPage(db(), pageId);
  await ensurePollRows(db(), { pageId, polls: pollsFor(registry, page!).map((poll) => ({ ...poll, phase: 0.999 })) });
  return registry;
}

async function makeDue(pageId: number, resource: string) {
  const spec = fanslyResourceSpec(resource)!;
  await upsertDemand(db(), { pageId, resource, kind: spec.kind, class: spec.class, demand: { reasons: ["test"] } });
}

async function subjectsOf(pageId: number, resource: string): Promise<string[]> {
  const result = await testDb!.pool.query<{ subject: string }>(
    "select subject from sync_work where page_id = $1 and resource = $2 and not shadow order by subject",
    [pageId, resource],
  );
  return result.rows.map((row) => row.subject);
}

async function headCursor(pageId: number): Promise<Record<string, unknown> | null> {
  const result = await testDb!.pool.query<{ cursor: Record<string, unknown> }>(
    "select cursor from sync_work where page_id = $1 and resource = 'dm-conversations.head' and not shadow order by id desc limit 1",
    [pageId],
  );
  return result.rows[0]?.cursor ?? null;
}

/** One list answer: each chat's list `lastMessageId` and its embedded head. */
function listPageWith(chats: ReadonlyArray<{ n: number; listHead: string; embedded: { id: string; senderId: string; atMs: number } }>) {
  return {
    data: chats.map((chat) => ({
      account_id: OWN_ID, groupId: groupOf(chat.n), partnerAccountId: fanOf(chat.n), partnerUsername: `fan${fanOf(chat.n).slice(-4)}`,
      flags: 0, unreadCount: 1, subscriptionTierId: null, lastMessageId: chat.listHead, lastUnreadMessageId: null,
    })),
    aggregationData: {
      accounts: chats.map((chat) => fanAccount(fanOf(chat.n))),
      groups: chats.map((chat) => ({
        id: groupOf(chat.n), type: 1, groupFlags: 0, createdBy: OWN_ID,
        users: [
          { groupId: groupOf(chat.n), userId: OWN_ID, type: 0, permissionFlags: 0 },
          { groupId: groupOf(chat.n), userId: fanOf(chat.n), type: 0, permissionFlags: 0 },
        ],
        lastMessage: {
          id: chat.embedded.id, type: 1, dataVersion: 1, content: "hi", groupId: groupOf(chat.n), senderId: chat.embedded.senderId,
          correlationId: null, inReplyTo: null, inReplyToRoot: null, createdAt: chat.embedded.atMs,
          attachments: [], embeds: [], interactions: [], likes: [],
        },
      })),
    },
  };
}

describe("adv-3: Д7 through the real actor — a stale list lastMessageId asks no read", () => {
  it("a known chat whose list id is stale but whose embedded head is a newer fan message gets no catch-up", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const old = NOW_MS - 3 * 24 * HOUR;
    // Chat 3000: reads reached messageOf(3000) (== the stale list id); the fan's newer message is only embedded.
    // Chat 3001: control — list id and embedded head agree on the newer message.
    await seedKnownThreads(pageId, [3000, 3001], old);
    const page = listPageWith([
      { n: 3000, listHead: messageOf(3000), embedded: { id: messageOf(3000, 5), senderId: fanOf(3000), atMs: NOW_MS - 60_000 } },
      { n: 3001, listHead: messageOf(3001, 5), embedded: { id: messageOf(3001, 5), senderId: fanOf(3001), atMs: NOW_MS - 60_000 } },
    ]);
    await makeDue(pageId, "dm-conversations.head");
    const transport = new ScriptedLiveTransport();
    transport.respond = (req: FanslyWireRequest): FanslyWireOutcome => {
      if (req.spec === "messaging.groups") return okResponse(page);
      throw new Error(`unexpected ${req.spec}`);
    };
    const registry = await quietRegistry(pageId);
    const { actor, stop, abort } = await makeTestActor({
      db: db(), pageId, registry, alerts: new RecordingAlerts(), metrics: new RecordingMetrics(), transport,
    });
    const run = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      await waitFor(async () => ((await headCursor(pageId))?.last != null ? true : null), 60_000, "the head walk to finish");
    } finally {
      stop.abort();
      await run;
    }
    const catchups = await subjectsOf(pageId, "dm-messages.catchup");
    console.log(JSON.stringify({ catchups }));
    expect(catchups).toContain(groupOf(3001));
    // Expected (the embedded head is newer than what the reads reached): a read of 3000 too.
    expect(catchups).toContain(groupOf(3000));
  });
});

describe("adv-3: an own broadcast to KNOWN chats still costs one read per chat (the next head poll)", () => {
  it("the head poll after a 150-chat broadcast asks 150 planned catch-ups (D22 says: no work)", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const old = NOW_MS - 3 * 24 * HOUR;
    const sentAt = NOW_MS - 5 * 60_000;
    const known = Array.from({ length: 150 }, (_, i) => 1000 + i);
    // Ten recipients Hub has no thread for (they are on the list: fans wrote before).
    const unknown = Array.from({ length: 10 }, (_, i) => 2000 + i);
    await seedKnownThreads(pageId, known, old);
    const all = [...known, ...unknown];
    const pages = [all.slice(0, 100), all.slice(100)];
    await makeDue(pageId, "dm-conversations.head");
    const transport = new ScriptedLiveTransport();
    const hits: string[] = [];
    transport.respond = (req: FanslyWireRequest): FanslyWireOutcome => {
      hits.push(req.spec);
      if (req.spec === "messaging.groups") {
        const offset = Number(new URL(req.url).searchParams.get("offset"));
        return okResponse(broadcastListPage(pages[offset / 100] ?? [], sentAt));
      }
      throw new Error(`unexpected ${req.spec}`);
    };
    const registry = await quietRegistry(pageId);
    const { actor, stop, abort } = await makeTestActor({
      db: db(), pageId, registry, alerts: new RecordingAlerts(), metrics: new RecordingMetrics(), transport,
    });
    const run = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      await waitFor(async () => ((await headCursor(pageId))?.last != null ? true : null), 60_000, "the head walk to finish");
    } finally {
      stop.abort();
      await run;
    }
    const catchups = await subjectsOf(pageId, "dm-messages.catchup");
    const heads = await subjectsOf(pageId, "dm-messages.head");
    console.log(JSON.stringify({ listReads: hits.length, catchups: catchups.length, heads: heads.length,
      knownCaught: catchups.filter((s) => known.map(groupOf).includes(s)).length,
      unknownCaught: catchups.filter((s) => unknown.map(groupOf).includes(s)).length }));
    expect(hits).toEqual(["messaging.groups", "messaging.groups"]);
    // What decision №9 / D22 ask for: zero extra reads for an own broadcast.
    expect(catchups.length).toBe(0);
  });
});
