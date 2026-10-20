import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@agency_hub_core/db";

import { applyFanslyWsLive } from "../apps/runtime/src/services/fansly-ws/live-apply.ts";
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
import { setModeDirect } from "./helpers/sync-engine-host.ts";

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
});
