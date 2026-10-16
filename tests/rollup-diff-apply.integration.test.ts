import { describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  rebuildFollowerRollups,
  rebuildRevenueRollups,
  rebuildSpenderProjections,
  rebuildSubscriberRollups,
  upsertFanPage,
  upsertFans,
  upsertPageFollow,
  upsertPageSubscription,
  upsertTransaction,
} from "@agency_hub_core/db";

import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// The rollup rebuilds apply a diff instead of deleting and re-inserting their
// whole window (packages/db/src/repositories/spenders.ts, transactions.ts).
// Two properties pin it:
//   1. a rebuild that changes nothing writes no row (every xmin survives);
//   2. after real changes, the incremental result equals a rebuild from an
//      empty rollup — rows that moved are rewritten, rows the window no longer
//      produces are gone, and nothing else is touched.

const DAY_MS = 86_400_000;

const ROLLUPS = [
  {
    table: "fan_spend_daily",
    key: "fan_id, business_date, canonical_type, transaction_state",
    values: "transaction_count, gross_amount_mills, creator_net_amount_mills, last_transaction_at",
  },
  {
    table: "fan_spend_lifetime",
    key: "fan_id",
    values: "gross_amount_mills, creator_net_amount_mills, last_transaction_at",
  },
  {
    table: "revenue_daily",
    key: "business_date, canonical_type, transaction_state",
    values: "transaction_count, gross_amount_mills, creator_net_amount_mills",
  },
  {
    table: "daily_followers",
    key: "business_date",
    values: "new_followers, known_total_followers",
  },
  {
    table: "daily_subscribers",
    key: "business_date",
    values: "new_subscribers, active_subscribers",
  },
] as const;

type Snapshot = Record<string, { row: string; xmin: string }[]>;

async function snapshot(testDb: StartedTestDatabase, pageId: number): Promise<Snapshot> {
  const result: Snapshot = {};
  for (const rollup of ROLLUPS) {
    const rows = await testDb.pool.query<{ row: string; xmin: string }>(
      `select row(${rollup.key}, ${rollup.values})::text as row, xmin::text as xmin
       from ${rollup.table}
       where platform_account_id = $1
       order by ${rollup.key}`,
      [pageId],
    );
    result[rollup.table] = rows.rows;
  }
  const totals = await testDb.pool.query<{ row: string; xmin: string }>(
    `select row(fan_id, total_creator_net_mills)::text as row, xmin::text as xmin
     from page_fans where platform_account_id = $1 order by fan_id`,
    [pageId],
  );
  result.page_fans = totals.rows;
  return result;
}

const rowsOf = (snap: Snapshot) => Object.fromEntries(
  Object.entries(snap).map(([table, rows]) => [table, rows.map((entry) => entry.row)]),
);

async function rebuildAll(testDb: StartedTestDatabase, pageId: number, from: Date | null, knownTotal: number | null) {
  await rebuildSpenderProjections(testDb.db, pageId, from);
  await rebuildRevenueRollups(testDb.db, pageId, from);
  await rebuildFollowerRollups(testDb.db, pageId, knownTotal);
  await rebuildSubscriberRollups(testDb.db, pageId);
}

describe("rollup rebuilds apply a diff", () => {
  it("writes nothing when nothing changed, and converges on a from-scratch rebuild when it did", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    try {
      const model = await createModel(testDb.db, { slug: "diff-model", name: "Diff Model" });
      const page = await createFanslyPage(testDb.db, { modelId: model!.id, label: "diff-page" });
      const pageId = page!.id;
      const [fanA, fanB, fanC] = await upsertFans(testDb.db, [
        { platform: "fansly", platformUserId: "diff-fan-a" },
        { platform: "fansly", platformUserId: "diff-fan-b" },
        { platform: "fansly", platformUserId: "diff-fan-c" },
      ]);
      for (const fan of [fanA!, fanB!, fanC!]) {
        await upsertFanPage(testDb.db, { fanId: fan.id, platformAccountId: pageId, isFollower: true });
      }

      const now = Date.now();
      const at = (daysAgo: number, hour = 12) =>
        new Date(Math.floor((now - daysAgo * DAY_MS) / DAY_MS) * DAY_MS + hour * 3_600_000);
      const tx = async (
        transactionId: string,
        fanId: number,
        daysAgo: number,
        amount: bigint,
        canonicalType: "tip" | "subscription" = "tip",
      ) => upsertTransaction(testDb.db, {
        platformAccountId: pageId,
        source: "fansly:rest",
        fanId,
        transactionId,
        rawType: canonicalType === "tip" ? 20001 : 10001,
        canonicalType,
        transactionState: "posted",
        rawStatus: 2,
        grossAmountMills: amount,
        sourceDestinationAmountMills: amount,
        creatorNetAmountMills: amount,
        occurredAt: at(daysAgo),
      });

      await tx("diff-tx-1", fanA!.id, 40, 10_000n);
      await tx("diff-tx-2", fanA!.id, 5, 20_000n);
      await tx("diff-tx-3", fanB!.id, 5, 30_000n, "subscription");
      await tx("diff-tx-4", fanB!.id, 2, 40_000n);
      await tx("diff-tx-5", fanC!.id, 1, 50_000n);

      await upsertPageFollow(testDb.db, {
        platformAccountId: pageId, fanId: fanA!.id, platformFollowId: "diff-follow-a", followedAt: at(10),
      });
      await upsertPageFollow(testDb.db, {
        platformAccountId: pageId, fanId: fanB!.id, platformFollowId: "diff-follow-b", followedAt: at(3),
      });
      await upsertPageSubscription(testDb.db, {
        platformSubscriptionId: "diff-sub-b",
        platformAccountId: pageId,
        fanId: fanB!.id,
        platformHistoryId: "diff-sub-b-history",
        rawStatus: 3,
        canonicalStatus: "active",
        priceMills: 7000n,
        renewPriceMills: 7000n,
        autoRenew: true,
        lastSeenGeneration: 1,
      });

      await rebuildAll(testDb, pageId, null, 120);
      // A historical total the follower rebuild must preserve, and one on a
      // day it no longer produces (that row goes, as it always did).
      await testDb.pool.query(
        `update daily_followers set known_total_followers = 90
         where platform_account_id = $1 and business_date = $2::date`,
        [pageId, at(10).toISOString().slice(0, 10)],
      );
      const first = await snapshot(testDb, pageId);
      expect(first.fan_spend_daily).toHaveLength(5);
      expect(first.daily_followers!.length).toBeGreaterThanOrEqual(3);

      // 1. Nothing changed: no row is rewritten, by either window form.
      await rebuildAll(testDb, pageId, at(7), 120);
      await rebuildAll(testDb, pageId, null, 120);
      expect(await snapshot(testDb, pageId)).toEqual(first);

      // 2. Changes: an amount moves, a row goes inactive (its group vanishes),
      //    a new fan spends, a follow is added.
      await testDb.pool.query(
        `update transactions set gross_amount_mills = 25000, creator_net_amount_mills = 25000
         where platform_account_id = $1 and transaction_id = 'diff-tx-2'`,
        [pageId],
      );
      await testDb.pool.query(
        `update transactions set is_active = false
         where platform_account_id = $1 and transaction_id = 'diff-tx-5'`,
        [pageId],
      );
      await tx("diff-tx-6", fanC!.id, 0, 60_000n);
      await upsertPageFollow(testDb.db, {
        platformAccountId: pageId, fanId: fanC!.id, platformFollowId: "diff-follow-c", followedAt: at(1),
      });

      await rebuildAll(testDb, pageId, at(7), 121);
      const incremental = await snapshot(testDb, pageId);

      // Untouched rows keep their tuple: fanA's 40-day-old spend is outside
      // every window that moved.
      const oldSpend = (snap: Snapshot) => snap.fan_spend_daily!.find((entry) => entry.row.startsWith(`(${fanA!.id},`))!;
      expect(oldSpend(incremental)).toEqual(oldSpend(first));
      // The vanished group is gone; the moved one carries the new amount.
      expect(incremental.fan_spend_daily!.map((entry) => entry.row).join("\n")).not.toContain("50000");
      expect(incremental.fan_spend_daily!.map((entry) => entry.row).join("\n")).toContain("25000");

      // Converges on a rebuild from empty rollups. The preserved historical
      // follower total cannot be recreated from scratch, so it is compared
      // separately and then re-applied to the scratch copy.
      const preservedTotal = incremental.daily_followers!.find((entry) => entry.row.endsWith(",1,90)"));
      expect(preservedTotal).toBeDefined();
      for (const rollup of ROLLUPS) {
        await testDb.pool.query(`delete from ${rollup.table} where platform_account_id = $1`, [pageId]);
      }
      await testDb.pool.query(`update page_fans set total_creator_net_mills = 0 where platform_account_id = $1`, [pageId]);
      await rebuildAll(testDb, pageId, null, 121);
      await testDb.pool.query(
        `update daily_followers set known_total_followers = 90
         where platform_account_id = $1 and business_date = $2::date`,
        [pageId, at(10).toISOString().slice(0, 10)],
      );
      expect(rowsOf(incremental)).toEqual(rowsOf(await snapshot(testDb, pageId)));
    } finally {
      await testDb.stop();
    }
  });
});
