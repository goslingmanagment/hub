import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  acquireSyncPageOwnership,
  getSyncPage,
  OwnershipLostError,
  type Database,
} from "@agency_hub_core/db";

import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import { createPacer } from "../apps/runtime/src/sync/engine/pacer.ts";
import { fixedShadowLatency } from "../apps/runtime/src/sync/engine/shadow.ts";
import { createFanslyRegistry } from "../apps/runtime/src/sync/fansly/registry.ts";
import {
  createFanslyShadowWsFeed,
  routeShadowReceipts,
  SHADOW_WS_ROUTE_HORIZON_MS,
} from "../apps/runtime/src/sync/fansly/ws/route-receipt.ts";
import { OwnBroadcastWindow } from "../apps/runtime/src/sync/fansly/ws/router.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { serviceFrame } from "./helpers/fansly-ws-fixtures.ts";
import {
  seedWsCapturePage,
  seedWsThread,
  wsCreated,
  wsDeleted,
  wsMessage,
  wsTransaction,
  type WsCapturePage,
} from "./helpers/fansly-ws-capture.ts";
import {
  changedTables,
  makeTestActor,
  quietLogger,
  RecordingMetrics,
  setModeDirect,
  tableCounts,
  testConfig,
  testOwner,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// The shadow WS feed (design §3.12 demand feed (2), §6.4): a shadow page's
// actor reads the receipts the legacy receiver captured past its cursor,
// decodes and routes them into SHADOW work and advances the cursor in the same
// generation-fenced transaction. It never acks a receipt, never writes the
// overlay or any domain table (I14), and routes only the live horizon.

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

const OWN = "100000000000000001";
const FAN = "200000000000000001";
const GROUP = "300000000000000001";

function db(): Database {
  return testDb!.db as unknown as Database;
}

function handles() {
  return { db: db(), pool: testDb!.pool };
}

async function query<T>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await testDb!.pool.query(text, values)).rows as T[];
}

async function shadowPage(): Promise<WsCapturePage> {
  const page = await seedWsCapturePage(handles(), { ownRef: OWN });
  await setModeDirect(testDb!.pool, page.pageId, "shadow");
  await seedWsThread(handles(), { pageId: page.pageId, groupId: GROUP, fanRef: FAN });
  return page;
}

async function shadowActor(page: WsCapturePage, metrics = new RecordingMetrics()) {
  const made = await makeTestActor({ db: db(), pageId: page.pageId, mode: "shadow", registry: createFanslyRegistry({ metrics }), metrics });
  return { deps: { ...made.deps, ownRef: OWN }, metrics, generation: made.generation };
}

async function work(pageId: number) {
  return query<{ shadow: boolean; resource: string; subject: string; state: string; revision: number; messageIds: string[]; txIds: string[] }>(
    `select shadow, resource, subject, state, demand_revision::int as revision,
            demand -> 'messageIds' as "messageIds", demand -> 'txIds' as "txIds"
       from sync_work where page_id = $1 and kind <> 'poll' order by resource, subject`,
    [pageId],
  );
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describe("the shadow WS feed (design §6.4)", () => {
  it("starts at the routing horizon, routes into shadow work, never acks a receipt or writes the overlay", async (context) => {
    if (!testDb) return context.skip();
    const page = await shadowPage();
    const history = await page.capture(wsCreated(wsMessage({ groupId: GROUP, senderId: FAN })), minutesAgo(20));
    const first = wsMessage({ groupId: GROUP, senderId: FAN });
    const fresh = [
      await page.capture(wsCreated(first), minutesAgo(1)),
      await page.capture(wsTransaction("700000000000000001", 1)),
      await page.capture(wsDeleted("600000000000000001", GROUP)),
    ];
    const { deps } = await shadowActor(page);
    const state = { window: new OwnBroadcastWindow() };

    const routed = await routeShadowReceipts(deps, state);
    expect(routed).toMatchObject({ routed: 3, stale: 0, unreadable: 0, cursor: fresh.at(-1) });
    expect(history).toBeLessThan(fresh[0]!);
    expect(await work(page.pageId)).toEqual([
      { shadow: true, resource: "dm-live.deletions", subject: GROUP, state: "open", revision: 1, messageIds: ["600000000000000001"], txIds: [] },
      { shadow: true, resource: "dm-messages.head", subject: GROUP, state: "open", revision: 1, messageIds: [first.id], txIds: [] },
      { shadow: true, resource: "transactions.head", subject: "", state: "open", revision: 1, messageIds: [], txIds: ["700000000000000001"] },
    ]);
    expect((await getSyncPage(db(), page.pageId))!.wsRouterCursor).toBe(fresh.at(-1));
    // The receipts are the legacy drivers' to ack; the overlay is theirs too.
    expect(await query("select distinct live_state from fansly_ws_decode_receipts")).toEqual([{ live_state: "pending" }]);
    expect(await query("select count(*)::int as n from dm_live_messages")).toEqual([{ n: 0 }]);

    // Nothing new: nothing written. New frames merge into the open rows.
    expect(await routeShadowReceipts(deps, state)).toMatchObject({ routed: 0, signals: 0 });
    const second = wsMessage({ groupId: GROUP, senderId: FAN });
    await page.capture(wsCreated(second));
    await routeShadowReceipts(deps, state);
    const head = (await work(page.pageId)).find((row) => row.resource === "dm-messages.head")!;
    expect(head.revision).toBe(2);
    expect([...head.messageIds].sort()).toEqual([first.id, second.id].sort());
  });

  it("after a pause, receipts past the horizon are passed over, not routed", async (context) => {
    if (!testDb) return context.skip();
    const page = await shadowPage();
    const { deps, metrics } = await shadowActor(page);
    const state = { window: new OwnBroadcastWindow() };
    const start = await page.capture(wsTransaction("700000000000000001", 1));
    await routeShadowReceipts(deps, state);
    const late = SHADOW_WS_ROUTE_HORIZON_MS / 60_000 + 5;
    for (let i = 0; i < 5; i++) await page.capture(wsTransaction(`70000000000000001${i}`, 1), minutesAgo(late));
    const fresh = await page.capture(wsTransaction("700000000000000099", 1));
    const routed = await routeShadowReceipts(deps, state, { batch: 2 });
    expect(start).toBeLessThan(fresh);
    expect(routed).toMatchObject({ stale: 5, routed: 1, cursor: fresh });
    expect((await work(page.pageId)).map((row) => [...row.txIds].sort())).toEqual([["700000000000000001", "700000000000000099"]]);
    expect(metrics.get("sync_shadow_ws_receipts")).toBeGreaterThanOrEqual(6);
  });

  it("own messages: chatter replies are confirmed until the rate fallback sees a broadcast; a marked broadcast never is", async (context) => {
    if (!testDb) return context.skip();
    const page = await shadowPage();
    const { deps } = await shadowActor(page);
    const state = { window: new OwnBroadcastWindow() };
    await routeShadowReceipts(deps, state);
    const groups = Array.from({ length: 25 }, (_, i) => String(320_000_000_000_000_000n + BigInt(i)));
    for (const groupId of groups) await seedWsThread(handles(), { pageId: page.pageId, groupId, fanRef: `2${groupId.slice(1)}` });
    // A marked mass message (type 2, one correlation id) in the first chat.
    await page.capture(wsCreated(wsMessage({ groupId: groups[0]!, senderId: OWN, type: 2, correlationId: "990000000000000001" })));
    // 25 unmarked own messages in 25 chats within a minute.
    for (const groupId of groups) await page.capture(wsCreated(wsMessage({ groupId, senderId: OWN })));
    await routeShadowReceipts(deps, state);
    const heads = (await work(page.pageId)).filter((row) => row.resource === "dm-messages.head");
    // The marked message counts in the window (it is own) but makes no work:
    // 20 distinct chats are allowed, the 21st engages the fallback.
    expect(heads.map((row) => row.subject)).toEqual(groups.slice(0, 20));
  });

  it("is fenced by the owner generation and drops what a shadow page does not run", async (context) => {
    if (!testDb) return context.skip();
    const page = await shadowPage();
    const { deps, metrics } = await shadowActor(page);
    const state = { window: new OwnBroadcastWindow() };
    const unreadable = await page.capture(wsCreated(wsMessage({ groupId: GROUP, senderId: FAN })));
    // A frame without a chat asks for `repair.ws-gap`, which runs live only.
    const garbage = await page.capture("not a frame");
    const failing = async (_db: Database, observationId: number, source: { payload: unknown }) => {
      if (observationId === unreadable) throw new Error("catalog copy out of reach");
      return source.payload;
    };
    const routed = await routeShadowReceipts(deps, state, { resolvePayload: failing });
    expect(routed).toMatchObject({ routed: 1, unreadable: 1, signals: 0, cursor: garbage });
    expect(await work(page.pageId)).toEqual([]);
    expect(metrics.get("sync_ws_route_dropped")).toBe(1);

    // A newer owner took the page: the old generation writes nothing.
    const taken = await acquireSyncPageOwnership(db(), { pageId: page.pageId, owner: testOwner(), judgePreviousOwner: () => "test_confirmed_dead" });
    expect(taken.kind).toBe("acquired");
    await page.capture(wsCreated(wsMessage({ groupId: GROUP, senderId: FAN })));
    await expect(routeShadowReceipts(deps, state)).rejects.toBeInstanceOf(OwnershipLostError);
    expect(await work(page.pageId)).toEqual([]);
    expect((await getSyncPage(db(), page.pageId))!.wsRouterCursor).toBe(garbage);
  });

  it("runs in the shadow actor's loop: real receipts become shadow work, a deletion closes without writes", async (context) => {
    if (!testDb) return context.skip();
    const page = await shadowPage();
    const deleted = wsMessage({ groupId: GROUP, senderId: FAN });
    const fan = wsMessage({ groupId: GROUP, senderId: FAN });
    const ids = [
      await page.capture(wsDeleted(deleted.id, GROUP)),
      await page.capture(wsCreated(fan)),
      await page.capture(serviceFrame({ type: 7, order: { orderId: "730000000000000001", accountMediaId: "740000000000000001" } }, 2)),
    ];
    const before = await tableCounts(testDb.pool);
    const metrics = new RecordingMetrics();
    const host = new SyncEngineHost({
      db: db(),
      connectionString: testDb.connectionString,
      config: testConfig(testDb.connectionString),
      rawConfig: testConfig(testDb.connectionString),
      logger: quietLogger,
      registry: createFanslyRegistry({ metrics }),
      metrics,
      pause: { readSettingMs: async () => 100 },
      pacerFactory: (deps) => createPacer({ ...deps, minSettingMs: 1 }),
      shadowLatency: () => fixedShadowLatency(10),
      shadowFeed: createFanslyShadowWsFeed(),
      liveTransportFactory: async () => {
        throw new Error("a shadow page never builds a live transport");
      },
      modeLoopIntervalMs: 200,
    });
    await host.start();
    try {
      await waitFor(async () => {
        const rows = await query<{ state: string; close_reason: string | null }>(
          "select state, close_reason from sync_work where resource = 'dm-live.deletions' and shadow",
        );
        return rows[0]?.state === "done" ? rows[0] : null;
      }, 30_000, "the shadow deletion work closed");
    } finally {
      await host.stop();
    }
    expect(await query("select state, close_reason from sync_work where resource = 'dm-live.deletions'"))
      .toEqual([{ state: "done", close_reason: "shadow_no_writes" }]);
    const rows = await work(page.pageId);
    expect(rows.find((row) => row.resource === "dm-messages.head")).toMatchObject({ shadow: true, subject: GROUP, messageIds: [fan.id] });
    expect(rows.find((row) => row.resource === "purchases.targets")).toMatchObject({ shadow: true });
    expect((await getSyncPage(db(), page.pageId))!.wsRouterCursor).toBe(ids.at(-1));
    // I14: the engine's own tables only; no ack, no overlay, no domain write.
    const changed = changedTables(before, await tableCounts(testDb.pool));
    expect(changed).toContain("sync_work");
    expect(changed.filter((table) => table !== "sync_work" && table !== "sync_attempts")).toEqual([]);
    expect(await query("select distinct live_state from fansly_ws_decode_receipts")).toEqual([{ live_state: "pending" }]);
  }, 60_000);
});
