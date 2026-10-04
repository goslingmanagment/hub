import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@agency_hub_core/db";

import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import { fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
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
  seedChatThread,
  seedHarnessPage,
  until,
  type FakeWsPeer,
} from "./helpers/sync-engine.ts";
import { speakFansly, wsHostOptions } from "./helpers/sync-ws.ts";

// The live path in one flow (step-3 design §3.3 items 5–6; plan §7 p.2–4): a
// fan's message arrives on the page's socket in the `sync` process → the
// frame is captured on the owning session → the connection's applier writes
// the overlay row and acks the receipt, and the post-ack hook routes an urgent
// `dm-messages.head` in that transaction (I18) → the actor reads the chat's
// head from the fake origin → the DM apply stores the message and confirms
// the overlay row (`confirmed_at`, `match`) in its own transaction.

const S = 300;

let testDb: StartedTestDatabase | null = null;
let server: FakeFanslyServer | null = null;
let proxy: CountingConnectProxy | null = null;
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
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  await server?.close();
  await proxy?.close();
  server = null;
  proxy = null;
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

describe("socket frame to confirmed overlay, in one flow", () => {
  it("a fan message on the engine's socket is shown from the overlay, read by an urgent head and confirmed `match`", async (context) => {
    if (!testDb) return context.skip();
    server = await FakeFanslyServer.start();
    proxy = await CountingConnectProxy.start();
    const chats = new FakeChats();
    for (const route of harnessRoutes(chats)) server.route(route);
    const page = await seedHarnessPage({ db: db(), pool: testDb.pool }, { mode: "live", proxyUrl: proxy.url });
    const chat = chats.add({ count: 4, ageMs: 3_600_000 });
    const threadId = await seedChatThread({ db: db(), pool: testDb.pool }, page.pageId, chat, { stored: chat.messages, chain: true });
    let socket: FakeWsPeer | null = null;
    server.onWebSocket = (peer) => speakFansly(peer, {
      onSession: (session) => {
        socket = session;
      },
    });

    let host: SyncEngineHost | null = null;
    host = new SyncEngineHost(wsHostOptions({
      db: db(),
      pool: testDb.pool,
      connectionString: testDb.connectionString,
      config: harnessConfig(testDb.connectionString, server.apiBaseUrl),
      rng: harnessRng(29),
      wsOrigin: server.origin,
      sourceOf: () => host?.wsSource(page.pageId) ?? null,
      extraSpecs: ["dm-messages.head", "dm-messages.catchup", "dm-messages.history"].map((key) => fanslyResourceSpec(key)!),
    }));
    hosts.push(host);
    await host.start();
    await until(async () => socket !== null && host.wsSource(page.pageId)?.state === "open"
      && host.wsSource(page.pageId)?.downSince === null, 30_000, "the socket up");

    // The fan writes; the socket shows it at once.
    const [message] = chats.append(chat.groupId, 1, "fan");
    const wire = chats.wire(chat.groupId, message!);
    socket!.send(wsCreated(wire));

    const overlay = async () => (await testDb!.pool.query<{
      deleted_at: Date | null; confirmed_at: Date | null; confirm_outcome: string | null; confirm_source: string | null;
      first_visible_at: Date | null;
    }>(
      `select deleted_at, confirmed_at, confirm_outcome, confirm_source, first_visible_at
         from dm_live_messages where page_id = $1 and platform_message_id = $2`,
      [page.pageId, message!.id],
    )).rows[0] ?? null;
    await until(async () => (await overlay())?.first_visible_at != null, 10_000, "the overlay row");
    const receipt = await testDb.pool.query<{ live_state: string }>(
      "select live_state from fansly_ws_decode_receipts where page_id = $1", [page.pageId],
    );
    expect(receipt.rows).toEqual([{ live_state: "applied" }]);
    // Routed in the ack transaction: one urgent head read of the chat, demanding the message.
    const head = await testDb.pool.query<{ class: string; message_ids: string[]; state: string }>(
      `select class, demand->'messageIds' as message_ids, state from sync_work
        where page_id = $1 and not shadow and resource = 'dm-messages.head' and subject = $2`,
      [page.pageId, chat.groupId],
    );
    expect(head.rows).toEqual([expect.objectContaining({ class: "urgent", message_ids: [message!.id] })]);

    await until(async () => (await overlay())?.confirmed_at != null, 30_000, "the overlay confirmed");
    expect(await overlay()).toMatchObject({ confirm_outcome: "match", confirm_source: "message_archive", deleted_at: null });
    // One head read at the origin; the message is stored and the chain's head moved to it.
    expect(server.arrivalsAt("/api/v1/message?")).toHaveLength(1);
    const stored = await testDb.pool.query<{ n: number }>(
      "select count(*)::int as n from page_dm_messages where conversation_id = $1 and platform_message_id = $2",
      [threadId, message!.id],
    );
    expect(stored.rows[0]!.n).toBe(1);
    const thread = await testDb.pool.query<{ head_confirmed_id: string | null }>(
      "select head_confirmed_id from page_dm_threads where id = $1", [threadId],
    );
    expect(thread.rows[0]!.head_confirmed_id).toBe(message!.id);
  }, 90_000);
});
