import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { listPendingFanslyWsLiveReceipts, type Database } from "@agency_hub_core/db";

import {
  applyFanslyWsLive,
  createFanslyWsLiveApplier,
  startFanslyWsLiveTimer,
} from "../apps/runtime/src/services/fansly-ws/live-apply.ts";
import { routeFanslyWsReceiptDemand } from "../apps/runtime/src/sync/fansly/ws/route-receipt.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import {
  seedWsCapturePage,
  seedWsThread,
  wsCreated,
  wsDeleted,
  wsMessage,
  wsTransaction,
  type WsCapturePage,
} from "./helpers/fansly-ws-capture.ts";
import { serviceFrame } from "./helpers/fansly-ws-fixtures.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { setModeDirect, waitFor } from "./helpers/sync-engine-host.ts";

// The post-ack hook (design §6.3 p.4, §14 F2, I18): every step-1 live-apply
// driver routes a receipt's demand in the transaction that acks it. On a page
// the engine does not own (`off`, `shadow`) it writes nothing; on a
// `handover`/`live` page every receipt is routed exactly once, whichever
// driver acks it. Step-3 behaviour is tested here by writing `live` into the
// test database directly; no actor runs.

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

function app() {
  return createTestAppContext(testDb!, { databaseUrl: testDb!.connectionString });
}

async function query<T>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await testDb!.pool.query(text, values)).rows as T[];
}

interface WorkRow {
  shadow: boolean;
  resource: string;
  subject: string;
  kind: string;
  class: string;
  state: string;
  demand_revision: string;
  demand: { messageIds: string[]; txIds: string[]; reasons: string[]; overflow: boolean };
  params: Record<string, unknown>;
  due_in_ms: number;
  deadline_in_ms: number | null;
}

async function work(pageId: number): Promise<WorkRow[]> {
  return query<WorkRow>(
    `select shadow, resource, subject, kind, class, state, demand_revision::text, demand, params,
            (extract(epoch from (due_at - first_demand_at)) * 1000)::float8 as due_in_ms,
            (extract(epoch from (deadline_at - first_demand_at)) * 1000)::float8 as deadline_in_ms
       from sync_work where page_id = $1 order by resource, subject`,
    [pageId],
  );
}

async function livePage(mode: "live" | "handover" | "off" | "shadow" = "live", ownRef = OWN): Promise<WsCapturePage> {
  const page = await seedWsCapturePage(handles(), { ownRef });
  await setModeDirect(testDb!.pool, page.pageId, mode);
  await seedWsThread(handles(), { pageId: page.pageId, groupId: GROUP, fanRef: FAN });
  return page;
}

describe("the post-ack routing hook (I18)", () => {
  it("writes nothing on an off or shadow page; the ack is unchanged", async (context) => {
    if (!testDb) return context.skip();
    for (const [mode, ownRef] of [["off", OWN], ["shadow", "100000000000000002"]] as const) {
      const page = await livePage(mode, ownRef);
      const ids = [
        await page.capture(wsCreated(wsMessage({ groupId: GROUP, senderId: FAN }))),
        await page.capture(wsDeleted("920000000000000001", GROUP)),
        await page.capture(wsTransaction("930000000000000001", 1)),
      ];
      for (const id of ids) expect(await applyFanslyWsLive(app(), id)).toMatchObject({ status: expect.stringMatching(/applied|skipped/) });
      expect(await work(page.pageId)).toEqual([]);
      expect(await query("select live_state from fansly_ws_decode_receipts where page_id = $1 order by observation_id", [page.pageId]))
        .toEqual([{ live_state: "applied" }, { live_state: "applied" }, { live_state: "skipped" }]);
    }
  });

  it("routes every receipt of a live page once, in the ack transaction, per the routing table", async (context) => {
    if (!testDb) return context.skip();
    const page = await livePage("live");
    const unknownGroup = "300000000000000009";
    const fan = wsMessage({ groupId: GROUP, senderId: FAN });
    const media = wsMessage({ groupId: GROUP, senderId: FAN, attachments: [{ contentType: 1, contentId: "940000000000000001" }] });
    const reply = wsMessage({ groupId: GROUP, senderId: OWN });
    const broadcast = wsMessage({ groupId: GROUP, senderId: OWN, type: 2, correlationId: "950000000000000001" });
    const stranger = wsMessage({ groupId: unknownGroup, senderId: "200000000000000009" });
    await testDb.pool.query(
      `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
         gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source)
       values ($1, '930000000000000002', '2110', 'tip', 'pending', '1', 5000, 5000, 4000, now(), 'fansly:rest')`,
      [page.pageId],
    );
    const frames = [
      wsCreated(fan, media), wsCreated(reply), wsCreated(broadcast), wsCreated(stranger),
      wsDeleted("920000000000000001", GROUP),
      wsTransaction("930000000000000001", 1), wsTransaction("930000000000000002", 2), wsTransaction("930000000000000003", 2),
      wsTransaction("930000000000000004", 2, 16012),
      serviceFrame({ type: 7, order: { orderId: "960000000000000001", accountMediaId: "970000000000000001" } }, 2),
      serviceFrame({ type: 5, subscription: { id: "980000000000000001", subscriberId: FAN, status: 3 } }, 15),
      serviceFrame({ type: 22, typingAnnounceEvent: { groupId: GROUP } }, 5),
    ];
    const ids: number[] = [];
    for (const frame of frames) ids.push(await page.capture(frame));
    for (const id of ids) expect(await applyFanslyWsLive(app(), id)).not.toBeNull();
    // A second ack attempt finds nothing pending and routes nothing again.
    const before = await work(page.pageId);
    for (const id of ids) expect(await applyFanslyWsLive(app(), id)).toEqual({ status: "not_pending" });
    expect(await work(page.pageId)).toEqual(before);

    const rows = before.map((row) => ({
      resource: row.resource, subject: row.subject, shadow: row.shadow, class: row.class, state: row.state,
      revision: Number(row.demand_revision), messageIds: [...row.demand.messageIds].sort(), txIds: row.demand.txIds,
    }));
    expect(rows).toEqual([
      { resource: "dm-conversations.find", subject: unknownGroup, shadow: false, class: "urgent", state: "open", revision: 1, messageIds: [], txIds: [] },
      { resource: "dm-live.deletions", subject: GROUP, shadow: false, class: "urgent", state: "open", revision: 1, messageIds: ["920000000000000001"], txIds: [] },
      // The fan's two messages (one frame) and the chatter's reply; the own broadcast none.
      { resource: "dm-messages.head", subject: GROUP, shadow: false, class: "urgent", state: "open", revision: 2, messageIds: [fan.id, media.id, reply.id].sort(), txIds: [] },
      { resource: "payouts.daily", subject: "", shadow: false, class: "planned", state: "open", revision: 1, messageIds: [], txIds: [] },
      // The PPV order's target, one walk row of its own (never a subject-less row).
      { resource: "purchases.targets", subject: "media:970000000000000001", shadow: false, class: "planned", state: "open", revision: 1, messageIds: [], txIds: [] },
      { resource: "subscribers.poll", subject: "", shadow: false, class: "planned", state: "open", revision: 1, messageIds: [], txIds: [] },
      { resource: "transactions.head", subject: "", shadow: false, class: "urgent", state: "open", revision: 3, messageIds: [], txIds: ["930000000000000001"] },
      // Only the settlement of a row the ledger holds as pending.
      { resource: "transactions.rescan", subject: "", shadow: false, class: "planned", state: "open", revision: 1, messageIds: [], txIds: ["930000000000000002"] },
    ]);
    const head = before.find((row) => row.resource === "dm-messages.head")!;
    // The fast window (attachments): due within its 6 s cap of the first
    // event, the result within 10 s.
    expect(head.due_in_ms).toBeLessThanOrEqual(6_100);
    expect(head.deadline_in_ms).toBeLessThanOrEqual(10_100);
    expect(before.find((row) => row.resource === "purchases.targets")!.params).toEqual({ target: { kind: "media", id: "970000000000000001" } });
  });

  it("own replies wait in a 5-min window; a fan message in the same chat does not (owner decision 09.10, У9)", async (context) => {
    if (!testDb) return context.skip();
    const page = await livePage("live");
    const otherGroup = "300000000000000002";
    await seedWsThread(handles(), { pageId: page.pageId, groupId: otherGroup, fanRef: "200000000000000002" });
    // The chat's head row: its due time and cap from now (the database
    // clock), its due time as such, and its demanded ids.
    const head = async (groupId: string) => (await query<{
      due_ms: number; cap_ms: number; due_at_ms: number; due_in_ms: number; deadline_in_ms: number; ids: string[];
    }>(
      `select (extract(epoch from (due_at - clock_timestamp())) * 1000)::float8 as due_ms,
              (extract(epoch from (coalesce_until - clock_timestamp())) * 1000)::float8 as cap_ms,
              (extract(epoch from due_at) * 1000)::float8 as due_at_ms,
              (extract(epoch from (due_at - first_demand_at)) * 1000)::float8 as due_in_ms,
              (extract(epoch from (deadline_at - first_demand_at)) * 1000)::float8 as deadline_in_ms,
              demand -> 'messageIds' as ids
         from sync_work where page_id = $1 and resource = 'dm-messages.head' and subject = $2 and state = 'open'`,
      [page.pageId, groupId],
    ))[0]!;

    // A chatter's reply: one read 5 min after it, the result due 30 s later.
    const reply = wsMessage({ groupId: GROUP, senderId: OWN });
    await applyFanslyWsLive(app(), await page.capture(wsCreated(reply)));
    let row = await head(GROUP);
    expect(row.due_in_ms).toBeGreaterThan(299_000);
    expect(row.due_in_ms).toBeLessThan(301_000);
    expect(row.deadline_in_ms).toBeGreaterThan(329_000);
    expect(row.deadline_in_ms).toBeLessThan(331_000);

    // The fan writes in the same chat: read on the fan's window (5 s quiet,
    // 20 s cap from its arrival), confirming both.
    const fan = wsMessage({ groupId: GROUP, senderId: FAN });
    await applyFanslyWsLive(app(), await page.capture(wsCreated(fan)));
    row = await head(GROUP);
    expect(row.due_ms).toBeLessThanOrEqual(6_000);
    expect(row.cap_ms).toBeLessThanOrEqual(21_000);
    expect(row.deadline_in_ms).toBeLessThan(40_000);
    expect([...row.ids].sort()).toEqual([reply.id, fan.id].sort());

    // A further reply moves nothing.
    const dueAt = row.due_at_ms;
    await applyFanslyWsLive(app(), await page.capture(wsCreated(wsMessage({ groupId: GROUP, senderId: OWN }))));
    row = await head(GROUP);
    expect(row.due_at_ms).toBe(dueAt);
    expect(row.ids).toHaveLength(3);

    // A reply and a fan's message in one frame: the fan's window.
    await applyFanslyWsLive(app(), await page.capture(wsCreated(
      wsMessage({ groupId: otherGroup, senderId: OWN }), wsMessage({ groupId: otherGroup, senderId: "200000000000000002" }),
    )));
    row = await head(otherGroup);
    expect(row.due_ms).toBeLessThanOrEqual(6_000);
    expect(row.cap_ms).toBeLessThanOrEqual(21_000);
  });

  it("PPV orders: one walk row per target across receipts; a subject-less quarantined row of an older build takes none", async (context) => {
    if (!testDb) return context.skip();
    const page = await livePage("live");
    // What the router wrote before it named the target (its ids in the params,
    // no subject), quarantined as `purchase_target_unknown`: it holds the key
    // (page, live, purchases.targets, '') and must absorb no new order.
    await testDb.pool.query(
      `insert into sync_work (page_id, shadow, resource, subject, kind, class, state, waiting_reason, params, last_error_class)
       values ($1, false, 'purchases.targets', '', 'goal', 'planned', 'quarantined', 'quarantined', $2::jsonb, 'quarantine:purchase_target_unknown')`,
      [page.pageId, JSON.stringify({ ids: ["media:970000000000000009"] })],
    );
    // Two orders of one media (two receipts, two ack transactions), then an
    // order naming another media and a bundle.
    const frames = [
      serviceFrame({ type: 7, order: { orderId: "960000000000000001", accountMediaId: "970000000000000001" } }, 2),
      serviceFrame({ type: 7, order: { orderId: "960000000000000002", accountMediaId: "970000000000000001" } }, 2),
      serviceFrame({ type: 7, order: { orderId: "960000000000000003", accountMediaId: "970000000000000002", accountMediaBundleId: "990000000000000001" } }, 2),
    ];
    for (const frame of frames) expect(await applyFanslyWsLive(app(), await page.capture(frame))).not.toBeNull();
    const targets = (await work(page.pageId))
      .filter((row) => row.resource === "purchases.targets")
      .map((row) => ({ subject: row.subject, state: row.state, revision: Number(row.demand_revision), params: row.params }));
    expect(targets).toEqual([
      { subject: "", state: "quarantined", revision: 1, params: { ids: ["media:970000000000000009"] } },
      { subject: "bundle:990000000000000001", state: "open", revision: 1, params: { target: { kind: "bundle", id: "990000000000000001" } } },
      { subject: "media:970000000000000001", state: "open", revision: 2, params: { target: { kind: "media", id: "970000000000000001" } } },
      { subject: "media:970000000000000002", state: "open", revision: 1, params: { target: { kind: "media", id: "970000000000000002" } } },
    ]);
  });

  it("a handover page is routed too; its work waits for the actor", async (context) => {
    if (!testDb) return context.skip();
    const page = await livePage("handover");
    const id = await page.capture(wsCreated(wsMessage({ groupId: GROUP, senderId: FAN })));
    await applyFanslyWsLive(app(), id);
    expect((await work(page.pageId)).map((row) => `${row.resource}/${row.subject}/${row.shadow}`)).toEqual([`dm-messages.head/${GROUP}/false`]);
  });

  it("delete before create: the overlay keeps the sticky mark, the deletion and the confirmation are demand", async (context) => {
    if (!testDb) return context.skip();
    const page = await livePage("live");
    const msg = wsMessage({ groupId: GROUP, senderId: FAN });
    await applyFanslyWsLive(app(), await page.capture(wsDeleted(msg.id, GROUP)));
    await applyFanslyWsLive(app(), await page.capture(wsCreated(msg)));
    expect(await query("select platform_message_id, deleted_at is not null as deleted, sender_platform_user_id from dm_live_messages"))
      .toEqual([{ platform_message_id: msg.id, deleted: true, sender_platform_user_id: FAN }]);
    expect((await work(page.pageId)).map((row) => [row.resource, row.demand.messageIds])).toEqual([
      ["dm-live.deletions", [msg.id]],
      ["dm-messages.head", [msg.id]],
    ]);
  });

  it("the rate fallback: past 20 own messages in distinct chats within 60 s, own messages make no work", async (context) => {
    if (!testDb) return context.skip();
    const page = await livePage("live");
    const groups = Array.from({ length: 25 }, (_, i) => String(330_000_000_000_000_000n + BigInt(i)));
    for (const groupId of groups) await seedWsThread(handles(), { pageId: page.pageId, groupId, fanRef: `2${groupId.slice(1)}` });
    // Unmarked own messages (type 1, no correlation id): the overlay counts
    // the distinct chats an own message became visible in, this frame's
    // own row included.
    for (const groupId of groups) {
      await applyFanslyWsLive(app(), await page.capture(wsCreated(wsMessage({ groupId, senderId: OWN }))));
    }
    const heads = (await work(page.pageId)).filter((row) => row.resource === "dm-messages.head");
    expect(heads.map((row) => row.subject)).toEqual(groups.slice(0, 20));
    // A fan's message is never a broadcast.
    await applyFanslyWsLive(app(), await page.capture(wsCreated(wsMessage({ groupId: groups[24]!, senderId: FAN }))));
    expect((await work(page.pageId)).filter((row) => row.resource === "dm-messages.head").map((row) => row.subject))
      .toEqual([...groups.slice(0, 20), groups[24]]);
  });

  it("a hook that throws rolls the ack back: the receipt stays pending, the next driver routes it", async (context) => {
    if (!testDb) return context.skip();
    const page = await livePage("live");
    const id = await page.capture(wsCreated(wsMessage({ groupId: GROUP, senderId: FAN })));
    const failing = async () => {
      throw new Error("routing refused");
    };
    expect(await applyFanslyWsLive(app(), id, undefined, failing)).toBeNull();
    expect(await query("select live_state from fansly_ws_decode_receipts where observation_id = $1", [id])).toEqual([{ live_state: "pending" }]);
    expect(await query("select count(*)::int as n from dm_live_messages")).toEqual([{ n: 0 }]);
    expect(await work(page.pageId)).toEqual([]);
    expect(await applyFanslyWsLive(app(), id)).toMatchObject({ status: "applied", created: 1 });
    expect((await work(page.pageId)).map((row) => row.resource)).toEqual(["dm-messages.head"]);
  });

  it("a 2 000-frame burst with the connection applier stalled is routed in full by the worker timer", async (context) => {
    if (!testDb) return context.skip();
    const page = await livePage("live");
    const groups = Array.from({ length: 40 }, (_, i) => String(310_000_000_000_000_000n + BigInt(i)));
    for (const groupId of groups) await seedWsThread(handles(), { pageId: page.pageId, groupId, fanRef: `2${groupId.slice(1)}` });
    const messageIds = new Map<string, string[]>();
    const txIds: string[] = [];
    for (let i = 0; i < 2_000; i++) {
      if (i % 20 === 0) {
        const txId = String(990_000_000_000_000_000n + BigInt(i));
        txIds.push(txId);
        await page.capture(wsTransaction(txId, 1));
        continue;
      }
      const groupId = groups[i % groups.length]!;
      const msg = wsMessage({ groupId, senderId: "220000000000000001" });
      messageIds.set(groupId, [...(messageIds.get(groupId) ?? []), msg.id]);
      await page.capture(wsCreated(msg));
    }
    // Nothing applies them on capture (the connection's applier is stalled);
    // the worker timer acks — and routes — every one.
    const timer = startFanslyWsLiveTimer(app(), {
      timing: { intervalMs: 50, replayMinAgeMs: 0, replayBatch: 200, parityBatch: 1 },
    });
    try {
      await waitFor(async () => (await listPendingFanslyWsLiveReceipts(db(), { limit: 1 })).length === 0 ? true : null,
        120_000, "every receipt acked");
    } finally {
      await timer.stop();
    }
    const rows = await work(page.pageId);
    const heads = new Map(rows.filter((row) => row.resource === "dm-messages.head").map((row) => [row.subject, row]));
    expect(heads.size).toBe(messageIds.size);
    for (const [groupId, ids] of messageIds) {
      expect([...heads.get(groupId)!.demand.messageIds].sort(), groupId).toEqual([...ids].sort());
      expect(Number(heads.get(groupId)!.demand_revision)).toBe(ids.length);
    }
    const money = rows.find((row) => row.resource === "transactions.head")!;
    expect([...money.demand.txIds].sort()).toEqual([...txIds].sort());
    expect(Number(money.demand_revision)).toBe(txIds.length);
  }, 180_000);

  it("the connection's applier and the worker timer produce identical work", async (context) => {
    if (!testDb) return context.skip();
    const viaConnection = await livePage("live");
    const viaTimer = await seedWsCapturePage(handles(), { ownRef: "100000000000000002" });
    await setModeDirect(testDb.pool, viaTimer.pageId, "live");
    await seedWsThread(handles(), { pageId: viaTimer.pageId, groupId: GROUP, fanRef: FAN });
    const frames = [
      wsCreated(wsMessage({ groupId: GROUP, senderId: FAN, id: "980000000000000101" })),
      wsCreated(wsMessage({ groupId: GROUP, senderId: FAN, id: "980000000000000102", attachments: [{ contentType: 1, contentId: "940000000000000001" }] })),
      wsCreated(wsMessage({ groupId: "300000000000000077", senderId: FAN, id: "980000000000000103" })),
      wsDeleted("980000000000000104", null),
      wsTransaction("980000000000000105", 1),
      serviceFrame({ type: 21, payoutRequest: { id: "980000000000000106", status: 2 } }, 16),
      "not a frame",
    ];
    const applier = createFanslyWsLiveApplier(app(), { afterAck: routeFanslyWsReceiptDemand });
    for (const frame of frames) {
      applier.enqueue(await viaConnection.capture(frame));
      await viaTimer.capture(frame);
    }
    await applier.drain(30_000);
    const timer = startFanslyWsLiveTimer(app(), {
      timing: { intervalMs: 50, replayMinAgeMs: 0, replayBatch: 50, parityBatch: 1 },
      afterAck: routeFanslyWsReceiptDemand,
    });
    try {
      await waitFor(async () => (await listPendingFanslyWsLiveReceipts(db(), { limit: 1 })).length === 0 ? true : null,
        60_000, "every receipt acked");
    } finally {
      await timer.stop();
    }
    const comparable = (rows: WorkRow[]) => rows.map((row) => ({
      resource: row.resource, subject: row.subject, kind: row.kind, class: row.class, state: row.state,
      revision: row.demand_revision, demand: row.demand, params: row.params, shadow: row.shadow,
    }));
    const connectionRows = comparable(await work(viaConnection.pageId));
    expect(connectionRows.length).toBeGreaterThanOrEqual(5);
    expect(comparable(await work(viaTimer.pageId))).toEqual(connectionRows);
  }, 120_000);
});
