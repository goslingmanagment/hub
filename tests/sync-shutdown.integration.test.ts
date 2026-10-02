import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { upsertDemand, type Database } from "@agency_hub_core/db";

import { startFanslyWsLiveTimer } from "../apps/runtime/src/services/fansly-ws/live-apply.ts";
import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { wsCreated } from "./helpers/fansly-ws-capture.ts";
import {
  CountingConnectProxy,
  ensureHarnessSettingTable,
  FakeChats,
  FakeFanslyServer,
  harnessConfig,
  harnessRng,
  harnessRoutes,
  HARNESS_KEY,
  seedChatThread,
  seedHarnessPage,
  spawnSyncChild,
  until,
  type FakeChat,
  type FakeWsPeer,
} from "./helpers/sync-engine.ts";
import { quietLogger } from "./helpers/sync-engine-host.ts";
import { speakFansly, wsHostOptions } from "./helpers/sync-ws.ts";

// SIGTERM of the `sync` process with a live page (S2 §3.6, step-3 design §3.3
// item 2, J6, I18), on the production socket timing: a real process holding
// the page's socket with 128 frames in its receiver queue and a REST request
// in flight whose body drips. The request finishes within its 20 s budget
// while, in parallel, the receiver captures every frame it already received
// and the overlay drain applies what it can in 10 s; what is left is acked —
// and routed — by the worker timer. The connection row closes at the instant
// intake stopped (the next connection's `gap_since`), the socket lock is free
// and the connection closed before the safe release is written, and the
// process exits within the container's 45 s stop grace.

const S = 300;
const FRAMES = 128;

let testDb: StartedTestDatabase | null = null;
let server: FakeFanslyServer | null = null;
let proxy: CountingConnectProxy | null = null;
const children: Array<ReturnType<typeof spawnSyncChild>> = [];
const hosts: SyncEngineHost[] = [];

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (!testDb) return;
  await resetIntegrationDatabase(testDb.pool);
  await ensureHarnessSettingTable(testDb.pool, S);
  // Whether the page's socket lock was held and a connection open at the
  // instant each safe release was written.
  await testDb.pool.query(`
    create table if not exists sync_test_release_log (
      page_id bigint not null, released_at timestamptz not null, ws_lock_held boolean not null, open_connections int not null);
    create or replace function sync_test_release_log() returns trigger language plpgsql as $$
    begin
      if new.owner_released_at is not null and new.owner_released_at is distinct from old.owner_released_at then
        insert into sync_test_release_log values (
          new.page_id, new.owner_released_at,
          exists (select 1 from pg_locks l
                   where l.locktype = 'advisory' and l.classid = 58213 and l.objid = new.page_id::oid
                     and l.objsubid = 2 and l.granted
                     and l.database = (select oid from pg_database where datname = current_database())),
          (select count(*)::int from fansly_ws_connections c where c.page_id = new.page_id and c.closed_at is null));
      end if;
      return new;
    end $$;
    drop trigger if exists sync_test_release_log on sync_pages;
    create trigger sync_test_release_log after update on sync_pages for each row execute function sync_test_release_log();
  `);
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  await server?.close();
  await proxy?.close();
  server = null;
  proxy = null;
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

async function scalar(text: string, values: unknown[] = []): Promise<number> {
  const result = await testDb!.pool.query<{ n: number }>(text, values);
  return Number(result.rows[0]?.n ?? 0);
}

describe("SIGTERM of the sync process with a live page", () => {
  it("128 queued frames all captured, applied or left to the worker timer and routed once; the drip-fed request finishes; exit within 45 s; release after the socket closed", async (context) => {
    if (!testDb) return context.skip();
    server = await FakeFanslyServer.start();
    proxy = await CountingConnectProxy.start();
    const chats = new FakeChats();
    // The REST read in flight at SIGTERM: its answer drips for longer than
    // its 20 s budget.
    server.route((request) => (request.url.pathname === "/api/v1/trackinglinks"
      ? { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ success: true, response: [], pad: "x".repeat(64) }), drip: { everyMs: 500 } }
      : null));
    for (const route of harnessRoutes(chats)) server.route(route);
    const page = await seedHarnessPage({ db: db(), pool: testDb.pool }, { mode: "live", proxyUrl: proxy.url });
    const threads: FakeChat[] = [];
    for (let n = 0; n < 4; n += 1) {
      const chat = chats.add({ count: 2, ageMs: 3_600_000 });
      await seedChatThread({ db: db(), pool: testDb.pool }, page.pageId, chat, { stored: chat.messages, chain: true });
      threads.push(chat);
    }
    let socket: FakeWsPeer | null = null;
    server.onWebSocket = (peer) => speakFansly(peer, {
      onSession: (session) => {
        socket = session;
      },
    });

    const child = spawnSyncChild("ws-live", {
      DATABASE_URL: testDb.connectionString,
      FANSLY_BASE_URL: server.apiBaseUrl,
      WS_ORIGIN: server.origin,
      PAGE_ID: String(page.pageId),
      RNG_SEED: "3",
    });
    children.push(child);
    await child.ready;
    await until(async () => socket !== null && (await scalar(
      "select count(*)::int as n from fansly_ws_connections where page_id = $1 and verified_at is not null and closed_at is null",
      [page.pageId],
    )) === 1, 30_000, "the socket up and verified");
    await upsertDemand(db(), { pageId: page.pageId, shadow: false, resource: HARNESS_KEY.urgent, subject: "drip", kind: "trigger", class: "urgent" });
    await until(async () => server!.arrivalsAt("/api/v1/trackinglinks").length === 1, 30_000, "the dripping request on the wire");

    // 128 fan messages in four chats, in one burst: the receiver queues them
    // (its bound is 128 frames) and captures them one by one.
    const ids: string[] = [];
    for (let n = 0; n < FRAMES; n += 1) {
      const chat = threads[n % threads.length]!;
      const [message] = chats.append(chat.groupId, 1, "fan");
      ids.push(message!.id);
      socket!.send(wsCreated(chats.wire(chat.groupId, message!)));
    }
    await until(async () => (await scalar("select count(*)::int as n from fansly_ws_decode_receipts where page_id = $1", [page.pageId])) >= 1,
      10_000, "the first frame captured");
    const sigtermAt = Date.now();
    child.kill("SIGTERM");
    const exit = await child.exited;
    const stopMs = Date.now() - sigtermAt;
    expect(exit).toEqual({ code: 0, signal: null });
    expect(stopMs).toBeLessThan(45_000);

    // Every queued frame was captured.
    expect(await scalar("select count(*)::int as n from fansly_ws_decode_receipts where page_id = $1", [page.pageId])).toBe(FRAMES);
    // The drip-fed request ended on its own budget and was journaled.
    const drip = await testDb.pool.query<{ outcome: string }>(
      "select outcome from sync_attempts where page_id = $1 and resource = $2", [page.pageId, HARNESS_KEY.urgent],
    );
    expect(drip.rows.map((row) => row.outcome)).toEqual(["timeout"]);
    // The connection closed at the instant intake stopped, not later.
    const closed = await testDb.pool.query<{ id: string; closed_at: Date; stop_reason: string }>(
      "select id::text, closed_at, stop_reason from fansly_ws_connections where page_id = $1", [page.pageId],
    );
    expect(closed.rows).toEqual([expect.objectContaining({ stop_reason: "disabled" })]);
    expect(closed.rows[0]!.closed_at.getTime()).toBeLessThanOrEqual(sigtermAt + 1_000);
    // J6: no socket lock and no open connection when the release was written.
    const releases = await testDb.pool.query<{ ws_lock_held: boolean; open_connections: number; released_at: Date }>(
      "select ws_lock_held, open_connections, released_at from sync_test_release_log where page_id = $1", [page.pageId],
    );
    expect(releases.rows).toEqual([expect.objectContaining({ ws_lock_held: false, open_connections: 0 })]);
    expect(releases.rows[0]!.released_at.getTime()).toBeGreaterThanOrEqual(closed.rows[0]!.closed_at.getTime());

    // What the 10 s overlay drain left pending, the worker timer acks — with
    // the same routing hook (I18).
    const timer = startFanslyWsLiveTimer({ db: db(), logger: quietLogger as never }, {
      timing: { intervalMs: 200, replayMinAgeMs: 0, replayBatch: 100, parityBatch: 10 },
    });
    try {
      await until(async () => (await scalar(
        "select count(*)::int as n from fansly_ws_decode_receipts where page_id = $1 and live_state = 'pending'", [page.pageId],
      )) === 0, 30_000, "every receipt acked");
    } finally {
      await timer.stop();
    }
    expect(await scalar(
      "select count(*)::int as n from fansly_ws_decode_receipts where page_id = $1 and live_state <> 'applied'", [page.pageId],
    )).toBe(0);
    const routed = await testDb.pool.query<{ ids: string[] }>(
      `select coalesce(jsonb_agg(e.v order by e.v), '[]'::jsonb) as ids
         from sync_work w, jsonb_array_elements_text(w.demand->'messageIds') as e(v)
        where w.page_id = $1 and not w.shadow and w.resource = 'dm-messages.head'`,
      [page.pageId],
    );
    expect(routed.rows[0]!.ids).toEqual([...ids].sort());

    // The next owner's connection starts its gap where the previous one
    // stopped (the dripping read is not asked again).
    await testDb.pool.query(
      "update sync_work set state = 'cancelled', closed_at = clock_timestamp(), close_reason = 'test' where page_id = $1 and resource = $2",
      [page.pageId, HARNESS_KEY.urgent],
    );
    let host: SyncEngineHost | null = null;
    host = new SyncEngineHost(wsHostOptions({
      db: db(),
      pool: testDb.pool,
      connectionString: testDb.connectionString,
      config: harnessConfig(testDb.connectionString, server.apiBaseUrl),
      rng: harnessRng(5),
      wsOrigin: server.origin,
      sourceOf: () => host?.wsSource(page.pageId) ?? null,
    }));
    hosts.push(host);
    // The dead process's owner record is its own safe release: the takeover is immediate.
    await host.start();
    await until(async () => (await scalar(
      "select count(*)::int as n from fansly_ws_connections where page_id = $1", [page.pageId],
    )) === 2, 30_000, "the next connection");
    const next = await testDb.pool.query<{ gap_since: Date }>(
      "select gap_since from fansly_ws_connections where page_id = $1 and id <> $2::uuid", [page.pageId, closed.rows[0]!.id],
    );
    expect(next.rows[0]!.gap_since).toEqual(closed.rows[0]!.closed_at);
  }, 120_000);
});
