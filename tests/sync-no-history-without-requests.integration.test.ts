import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureFanslyPageSendGuard, type Database } from "@agency_hub_core/db";

import { applyFanslyWsLive } from "../apps/runtime/src/services/fansly-ws/live-apply.ts";
import { createEngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { seedWsCapturePage, wsCreated, wsMessage } from "./helpers/fansly-ws-capture.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import {
  FakeChats,
  runActorUntil,
  seedChatThread,
  seededRandom,
  snowflakeAt,
  type FakeChat,
} from "./helpers/sync-engine.ts";
import { makeTestActor, setModeDirect, ScriptedLiveTransport } from "./helpers/sync-engine-host.ts";

// Owner decision №2, I12: no history request, no history walk. A live page
// with 200 chats whose history the hub holds only in part (a legacy window
// the journal rebuild proved as a chain) runs six simulated hours of socket
// traffic: new messages of fans and of the page, a burst of more than a page
// in one chat, ids the vendor does not show yet, chats nobody wrote in.
// Every frame goes through the step-1 live apply and its post-ack routing
// hook into the engine's demand; the live actor reads what that demand asks
// for. At the end: not one `dm-messages.history` row or attempt, no read
// below any chat's stored chain, no chain proven complete, and head reads only
// for the chats that had traffic. Requests are open on the page all along —
// nobody filed one.
//
// "An hour passes" moves every open work row's due time an hour back, so
// coalescing windows, not-found retries and breakers elapse as they would.

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

const OWN = "300000000000000001";
const DAY = 86_400_000;
const HOURS = 6;
const CHATS = 200;

function db(): Database {
  return testDb!.db as unknown as Database;
}

function handles() {
  return { db: db(), pool: testDb!.pool };
}

async function rows<T>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await testDb!.pool.query(text, values)).rows as T[];
}

async function count(text: string, values: unknown[] = []): Promise<number> {
  const [row] = await rows<{ n: number }>(text, values);
  return Number(row?.n ?? 0);
}

describe("I12: no history walk without a request", () => {
  it("six simulated hours of socket traffic over 200 partially stored chats: zero history work, reads only where demand was", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedWsCapturePage(handles(), { ownRef: OWN });
    const { pageId } = page;
    await setModeDirect(testDb.pool, pageId, "live");
    await testDb.pool.query(
      `update sync_pages set mode_changed_at = clock_timestamp() - interval '1 day',
              legacy_imported_at = clock_timestamp() - interval '1 hour',
              requests_enabled_at = clock_timestamp() - interval '1 hour'
        where page_id = $1`,
      [pageId],
    );
    await ensureFanslyPageSendGuard(db(), pageId);
    await testDb.pool.query("update fansly_page_send_guards set owner_engine = 'fansly_sync_engine' where page_id = $1", [pageId]);
    const random = seededRandom(20261002);
    const chats = new FakeChats(OWN);
    const seededOldest = new Map<string, string>();
    for (let n = 0; n < CHATS; n += 1) {
      const chat = chats.add({ count: 30 + Math.floor(random() * 270), ageMs: 20 * DAY });
      // Legacy holds the newest half; the rebuild proved it as a chain.
      const stored = chat.messages.slice(Math.floor(chat.messages.length / 2));
      await seedChatThread(handles(), pageId, chat, { stored, chain: true, ownRef: OWN });
      seededOldest.set(chat.groupId, stored[0]!.id);
    }
    const app = createTestAppContext(testDb, { databaseUrl: testDb.connectionString });
    const registry = createEngineRegistry(["dm-messages.head", "dm-messages.catchup", "dm-messages.history"].map((key) => fanslyResourceSpec(key)!));
    const transport = new ScriptedLiveTransport();
    transport.respond = (req) => chats.respond(req);

    const all = chats.all();
    const demanded = new Set<string>();
    const pick = (): FakeChat => all[Math.floor(random() * all.length)]!;
    const frame = async (chat: FakeChat, id: string, senderId: string, createdAtMs: number) => {
      const observationId = await page.capture(wsCreated(wsMessage({ id, groupId: chat.groupId, senderId, createdAt: createdAtMs / 1000 })));
      expect(await applyFanslyWsLive(app, observationId)).toMatchObject({ status: "applied" });
    };
    const anHourPasses = () => testDb!.pool.query(
      `update sync_work set due_at = due_at - interval '1 hour', coalesce_until = coalesce_until - interval '1 hour',
              breaker_until = breaker_until - interval '1 hour'
        where page_id = $1 and state = 'open'`,
      [pageId],
    );
    const nothingDue = async () => (await count(
      "select count(*)::int as n from sync_work where page_id = $1 and state in ('open', 'running') and due_at <= now()", [pageId],
    )) === 0;

    for (let hour = 0; hour < HOURS; hour += 1) {
      // Fans write, the page answers once an hour (well below the router's
      // broadcast fallback of 20 own messages a minute, which the whole run
      // fits in); one chat gets more than a page at once.
      for (let n = 0; n < 12; n += 1) {
        const chat = pick();
        const burst = n === 0 ? 30 : 1 + Math.floor(random() * 3);
        const added = chats.append(chat.groupId, burst, n === 11 ? "page" : "fan");
        const newest = added.at(-1)!;
        await frame(chat, newest.id, newest.senderId, newest.createdAtMs);
        demanded.add(chat.groupId);
      }
      // A message the vendor never shows (retried, then settled not found).
      const ghost = pick();
      await frame(ghost, snowflakeAt(Date.now() - 500, 4095), ghost.fanRef, Date.now() - 500);
      demanded.add(ghost.groupId);
      // The hour runs out: whatever came due in it is read.
      for (let tick = 0; tick < 4; tick += 1) {
        await anHourPasses();
        const made = await makeTestActor({ db: db(), pageId, registry, transport, settingMs: 1, ownRef: OWN });
        await runActorUntil(made, nothingDue, 60_000, `hour ${hour}: nothing left due`);
      }
    }

    // Not one history row, attempt or requests-class turn.
    expect(await count("select count(*)::int as n from sync_work where page_id = $1 and resource = 'dm-messages.history'", [pageId])).toBe(0);
    expect(await count("select count(*)::int as n from sync_attempts where page_id = $1 and (resource = 'dm-messages.history' or class = 'requests')", [pageId])).toBe(0);
    expect(await count("select count(*)::int as n from history_requests where page_id = $1", [pageId])).toBe(0);
    // Reads only for chats with traffic, and every one of them was read.
    const read = await rows<{ subject: string; n: number }>(
      "select subject, count(*)::int as n from sync_attempts where page_id = $1 and sent_at is not null group by subject", [pageId]);
    expect(read.filter((row) => !demanded.has(row.subject))).toEqual([]);
    expect(new Set(read.map((row) => row.subject))).toEqual(demanded);
    const headDemand = await rows<{ subject: string }>(
      "select distinct subject from sync_work where page_id = $1 and resource = 'dm-messages.head'", [pageId]);
    expect(new Set(headDemand.map((row) => row.subject))).toEqual(demanded);
    expect(transport.hits.length).toBe(read.reduce((sum, row) => sum + row.n, 0));
    // No read went below a chat's stored chain; no chain was walked to its end.
    const below = await rows<{ subject: string; before: string }>(
      `select subject, request->'params'->>'before' as before from sync_attempts
        where page_id = $1 and request->'params'->>'before' is not null`,
      [pageId],
    );
    expect(below.filter((row) => BigInt(row.before) <= BigInt(seededOldest.get(row.subject)!))).toEqual([]);
    const threads = await rows<{ group_id: string; history_state: string; contiguous_oldest_id: string }>(
      "select platform_conversation_id as group_id, history_state, contiguous_oldest_id from page_dm_threads where platform_account_id = $1",
      [pageId],
    );
    expect(threads).toHaveLength(CHATS);
    expect(threads.filter((thread) => thread.history_state === "complete")).toEqual([]);
    expect(threads.filter((thread) => thread.contiguous_oldest_id !== seededOldest.get(thread.group_id))).toEqual([]);
    // The burst was read down to the chain (more than one page of one chat).
    expect(read.some((row) => row.n >= 2)).toBe(true);
  }, 600_000);
});
