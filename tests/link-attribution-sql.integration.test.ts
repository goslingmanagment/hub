// Hub's own money per link (traffic plan PR 13/15): the rule
// `ofapi_subscription_period_equal_split.v1` exists twice — in TypeScript for
// the «Ссылки OnlyFans» API (attributeHubLinkMoney) and in SQL for the Agent
// Read datasets (HUB_LINK_ALLOCATIONS_SQL). This pins the two to the same
// shares on a randomized ledger: overlapping periods, before-floor periods,
// closed ones, pending money, chargebacks with and without their purchase,
// negative remainders.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  HUB_LINK_ALLOCATIONS_SQL,
  readHubLinkAttribution,
  upsertTransaction,
} from "@agency_hub_core/db";

import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase;
let app: ReturnType<typeof createTestAppContext>;

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Integration database unavailable");
  testDb = started;
}, 120_000);
afterAll(async () => { await testDb?.stop(); });
beforeEach(async () => {
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
});

const T0 = Date.parse("2026-10-09T00:00:00Z");
const at = (hours: number) => new Date(T0 + hours * 3_600_000);

describe("the attribution rule in SQL", () => {
  it("gives a chargeback its purchase's shares even when a recipient's period closed in between", async () => {
    const model = await createModel(app.db, { slug: "lora", name: "Lora" });
    const pageId = (await createOnlyFansPage(app.db, { modelId: model!.id, label: "lora-vip-of" }))!.id;
    const { rows: fans } = await testDb.pool.query<{ id: string }>(
      "insert into fans (platform, platform_user_id) values ('onlyfans', '1') returning id::text");
    const fanId = Number(fans[0]!.id);
    await testDb.pool.query("insert into page_fans (fan_id, platform_account_id) values ($1, $2)", [fanId, pageId]);
    for (const [link, closedAt] of [["11170786", null], ["11170787", at(6)]] as const) {
      const { rows: walks } = await testDb.pool.query<{ id: string }>(`
        insert into page_link_fan_walks (platform_account_id, link_kind, platform_link_id, list_kind, request_seq,
          started_at, finished_at, last_offset, last_page_items, evidential, first_raw_payload_id, last_raw_payload_id)
        values ($1, 'trial', $2, 'subscribers', 1, $3, $3, 0, 1, true, 1, 1) returning id::text`, [pageId, link, at(0)]);
      const { rows: linkFans } = await testDb.pool.query<{ id: string }>(`
        insert into page_link_fans (platform_account_id, link_kind, platform_link_id, fan_id, in_subscriber_list,
          first_seen_at, last_seen_at, last_seen_walk_id, last_seen_active, first_raw_payload_id, last_raw_payload_id)
        values ($1, 'trial', $2, $3, true, $4, $4, $5, true, 1, 1) returning id::text`,
      [pageId, link, fanId, at(0), Number(walks[0]!.id)]);
      await testDb.pool.query(`
        insert into page_link_fan_periods (platform_account_id, link_kind, platform_link_id, fan_id, link_fan_id,
          period_start_source, opened_at, opened_walk_id, closed_at, close_reason, closed_walk_id)
        values ($1, 'trial', $2, $3, $4, 'before_floor', $5, $6, $7, $8, $9)`,
      [pageId, link, fanId, Number(linkFans[0]!.id), at(0), Number(walks[0]!.id),
        closedAt, closedAt === null ? null : "not_active", closedAt === null ? null : Number(walks[0]!.id)]);
    }
    const purchase = { platformAccountId: pageId, source: "ofapi:rest" as const, fanId, rawType: "x", rawStatus: "x" };
    await upsertTransaction(app.db, { ...purchase, transactionId: "p1", canonicalType: "message_purchase",
      transactionState: "posted", grossAmountMills: 1001n, sourceDestinationAmountMills: 1001n,
      creatorNetAmountMills: 1001n, occurredAt: at(1) });
    await upsertTransaction(app.db, { ...purchase, transactionId: "p1:chargeback", canonicalType: "chargeback",
      transactionState: "posted", grossAmountMills: -1001n, sourceDestinationAmountMills: -1001n,
      creatorNetAmountMills: -1001n, occurredAt: at(20) });

    const { rows } = await testDb.pool.query<{ link_ref: string; share_mills: string; occurred_at: Date; transaction_id: string }>(
      `select a.link_ref, a.share_mills::text, a.occurred_at, a.transaction_id::text
         from (${HUB_LINK_ALLOCATIONS_SQL}) a order by a.occurred_at, a.link_ref`);
    const shares = rows.map((row) => [row.link_ref, row.share_mills, row.occurred_at.toISOString()]);
    expect(shares).toEqual([
      ["11170786", "501", at(1).toISOString()],
      ["11170787", "500", at(1).toISOString()],
      // Not −1001 to the one link holding him at the chargeback.
      ["11170786", "-501", at(20).toISOString()],
      ["11170787", "-500", at(20).toISOString()],
    ]);
    const typescript = await readHubLinkAttribution(app.db, { pageIds: [pageId], to: at(1_000) });
    expect(typescript.allocations.map((row) => [row.linkRef, String(row.mills), row.occurredAt.toISOString()])).toEqual(shares);
  });


  it("gives every transaction the same shares as the TypeScript rule", async () => {
    let seed = 915;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const model = await createModel(app.db, { slug: "lora", name: "Lora" });
    const pages = [
      (await createOnlyFansPage(app.db, { modelId: model!.id, label: "lora-vip-of" }))!.id,
      (await createOnlyFansPage(app.db, { modelId: model!.id, label: "lora-of" }))!.id,
    ];
    const links = [["trial", "10802699"], ["trial", "11170786"], ["trial", "9"], ["tracking", "2099377"]] as const;
    const fanIds: number[] = [];
    for (let fan = 1; fan <= 30; fan += 1) {
      const { rows } = await testDb.pool.query<{ id: string }>(
        "insert into fans (platform, platform_user_id) values ('onlyfans', $1) returning id::text", [String(fan)]);
      fanIds.push(Number(rows[0]!.id));
    }
    let transactionSeq = 0;
    for (const pageId of pages) {
      for (const fanId of fanIds) {
        await testDb.pool.query("insert into page_fans (fan_id, platform_account_id) values ($1, $2)", [fanId, pageId]);
      }
      for (const [linkKind, linkRef] of links) {
        // One link of each page has no finished walk (no floor): its periods count for nothing.
        const finished = !(linkRef === "9");
        const floorHour = random(30);
        const { rows } = await testDb.pool.query<{ id: string }>(`
          insert into page_link_fan_walks (platform_account_id, link_kind, platform_link_id, list_kind, request_seq,
            started_at, finished_at, last_offset, last_page_items, evidential, next_offset,
            first_raw_payload_id, last_raw_payload_id)
          values ($1, $2, $3, 'subscribers', 1, $4, $5, 0, 1, $6, $7, 1, 1) returning id::text`,
        [pageId, linkKind, linkRef, at(floorHour), finished ? at(floorHour + 0.1) : null, finished ? true : null, finished ? null : 100]);
        const walkId = Number(rows[0]!.id);
        for (const fanId of fanIds) {
          if (random(3) === 0) continue;
          const { rows: linkFan } = await testDb.pool.query<{ id: string }>(`
            insert into page_link_fans (platform_account_id, link_kind, platform_link_id, fan_id, in_subscriber_list,
              first_seen_at, last_seen_at, last_seen_walk_id, last_seen_active, first_raw_payload_id, last_raw_payload_id)
            values ($1, $2, $3, $4, true, $5, $5, $6, true, 1, 1) returning id::text`,
          [pageId, linkKind, linkRef, fanId, at(floorHour), walkId]);
          // One or two periods per (link, fan): before the floor, or opened later; some closed.
          let start: number | null = random(3) === 0 ? null : floorHour + random(100);
          for (let period = 0; period < 1 + random(2); period += 1) {
            const end = random(3) === 0 ? null : (start ?? floorHour) + 1 + random(80);
            await testDb.pool.query(`
              insert into page_link_fan_periods (platform_account_id, link_kind, platform_link_id, fan_id, link_fan_id,
                period_start_at, period_start_source, opened_at, opened_walk_id, closed_at, close_reason, closed_walk_id)
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [pageId, linkKind, linkRef, fanId, Number(linkFan[0]!.id),
              start === null ? null : at(start), start === null ? "before_floor" : "first_seen",
              at(start ?? floorHour), walkId, end === null ? null : at(end), end === null ? null : "absent", end === null ? null : walkId]);
            if (end === null) break;
            start = end + 1 + random(20);
          }
        }
      }
      for (let n = 0; n < 300; n += 1) {
        const fanId = fanIds[random(fanIds.length)]!;
        const amount = BigInt(random(90_001) - 10_000);
        const transactionId = `t-${pageId}-${++transactionSeq}`;
        const hour = random(250);
        await upsertTransaction(app.db, {
          platformAccountId: pageId, source: "ofapi:rest", fanId, transactionId, rawType: "x",
          canonicalType: "message_purchase", transactionState: random(5) === 0 ? "pending" : "posted", rawStatus: "x",
          grossAmountMills: amount, sourceDestinationAmountMills: amount, creatorNetAmountMills: amount, occurredAt: at(hour),
        });
        if (random(8) === 0) {
          // A chargeback days later, sometimes of a purchase the ledger does not hold.
          const base = random(4) === 0 ? `missing-${transactionSeq}` : transactionId;
          await upsertTransaction(app.db, {
            platformAccountId: pageId, source: "ofapi:rest", fanId, transactionId: `${base}:chargeback`, rawType: "x",
            canonicalType: "chargeback", transactionState: "posted", rawStatus: "x",
            grossAmountMills: -amount, sourceDestinationAmountMills: -amount, creatorNetAmountMills: -amount,
            occurredAt: at(hour + 24 + random(72)),
          });
        }
      }
    }

    const typescript = await readHubLinkAttribution(app.db, { pageIds: pages, to: at(10_000), from: at(-10_000) });
    const { rows } = await testDb.pool.query<{ transaction_id: string; link_kind: string; link_ref: string; share_mills: string; state: string }>(
      `select transaction_id::text, link_kind, link_ref, share_mills::text, state from (${HUB_LINK_ALLOCATIONS_SQL}) a`);
    const key = (row: { transactionId: number | string; linkKind: string; linkRef: string; mills: bigint | string; state: string }) =>
      `${row.transactionId}:${row.linkKind}:${row.linkRef}:${row.mills}:${row.state}`;
    const fromSql = rows.map((row) => key({
      transactionId: row.transaction_id, linkKind: row.link_kind, linkRef: row.link_ref, mills: row.share_mills, state: row.state,
    })).sort();
    const fromTypescript = typescript.allocations.map((row) => key(row)).sort();
    expect(fromSql.length).toBeGreaterThan(300);
    expect(fromSql).toEqual(fromTypescript);
  }, 120_000);
});
