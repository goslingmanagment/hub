// Stage 16 v3 (parse side): earnings observation → fan.earnings_observed
// events → fan_earnings_stats rows; each observation has stable identity.
// Re-fetches remain projection-only; rebuild reproduces the rows.

import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  insertObservation,
  upsertFanEarningsStat,
  upsertFans,
} from "@agency_hub_core/db";

import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import {
  rebuildFanEarningsProjection,
  runFanEarningsProjection,
} from "../apps/runtime/src/services/projections/fan-earnings.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
});

function appStub() {
  return {
    db: testDb!.db,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

// Extension-proven EarningsRow shape (chatgoose shared/types.ts); mills.
const STATS_SNAPSHOT = [
  { type: 2110, totalGross: 10_000, totalNet: 8_000, accountId: "model-1", correlationAccountId: "fan-e-1", timestamp: 1_750_000_000_000 },
  { type: 15001, totalGross: 5_000, totalNet: 4_000, accountId: "model-1", correlationAccountId: "fan-e-1", timestamp: 1_750_000_000_000 },
  { type: 2110, totalGross: 2_000, totalNet: 1_600, accountId: "model-1", correlationAccountId: "fan-e-2", timestamp: 1_750_000_000_000 },
];

async function seedStatsObservation(page: { id: number }, key: string) {
  return insertObservation(testDb!.db, {
    source: "pull",
    producer: "sync:fansly:fan_earnings",
    platform: "fansly",
    accountId: page.id,
    kind: "fan_earnings_stats",
    payload: STATS_SNAPSHOT,
    payloadHash: createHash("sha256").update(JSON.stringify(STATS_SNAPSHOT)).digest(),
    idempotencyKey: key,
  });
}

describe("fan earnings parse side (Stage 16 v3)", () => {
  it("observation → projection-only events → rows; re-fetch and rebuild preserve amounts", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const model = await createModel(testDb.db, { slug: "earn", name: "E" });
    const page = await createFanslyPage(testDb.db, { modelId: model.id, label: "earn-page" });

    await seedStatsObservation(page, "run-1");
    const first = await runCanonicalization(appStub());
    expect(first.appended).toBe(3); // two fans and their atomic checkpoint

    const projected = await runFanEarningsProjection(appStub());
    expect(projected.upserted).toBe(2);
    const rows = await testDb.pool.query<{
      window: string; gross_mills: string; net_mills: string; fan_user: string;
    }>(
      `select fes."window", fes.gross_mills::text as gross_mills,
              fes.net_mills::text as net_mills, f.platform_user_id as fan_user
       from fan_earnings_stats fes join fans f on f.id = fes.fan_id
       where fes.account_id = $1 order by f.platform_user_id`,
      [page.id],
    );
    expect(rows.rows).toEqual([
      { window: "lifetime", gross_mills: "15000", net_mills: "12000", fan_user: "fan-e-1" },
      { window: "lifetime", gross_mills: "2000", net_mills: "1600", fan_user: "fan-e-2" },
    ]);

    // The same snapshot is a new receipt; it must not suppress a later A → B → A.
    await seedStatsObservation(page, "run-2");
    const second = await runCanonicalization(appStub());
    expect(second.appended).toBe(3);
    expect(second.deduped).toBe(0);

    // PPV order-history: composite-key events (rows carry no order id).
    await insertObservation(testDb.db, {
      source: "pull",
      producer: "sync:fansly:purchase_history",
      platform: "fansly",
      accountId: page.id,
      kind: "purchase_history",
      payload: {
        accountMediaOrderHistory: [
          { accountId: "fan-e-1", accountMediaId: "media-9", type: 1, createdAt: 1_750_100_000_000 },
        ],
      },
      payloadHash: createHash("sha256").update("ppv-1").digest(),
      idempotencyKey: "ppv-run-1",
    });
    const third = await runCanonicalization(appStub());
    // THREE rows at sync-pull v5 (WP-F0(b)), and the count is the mechanism:
    // the deliverable `message.ppv_unlocked`, the projection-only
    // `media.order_observed` that now rides the same family, and the atomic
    // checkpoint covering exactly that one hidden row (§3.2a). Before v5 this
    // observation yielded the PPV event alone.
    expect(third.appended).toBe(3);
    const ppv = await testDb.pool.query<{ type: string; dedup_key: string }>(
      "select type, dedup_key from domain_events where type = 'message.ppv_unlocked'",
    );
    expect(ppv.rows[0]!.dedup_key).toMatch(/^ppv:fan-e-1:media-9:/);
    // The order-identity lane keys on the composite (the live shape carries no
    // order id) and is NEVER summed with the PPV event above.
    const orders = await testDb.pool.query<{ dedup_key: string }>(
      "select dedup_key from domain_events where type = 'media.order_observed'",
    );
    expect(orders.rows).toHaveLength(1);
    expect(orders.rows[0]!.dedup_key).toMatch(/^mediaorder:v1:\d+:media-9:fan-e-1:\d+$/);
    // …and the checkpoint covers exactly the hidden row, so v2 replay sees a
    // one-seq gap it can account for.
    const checkpoint = await testDb.pool.query<{ data: { hiddenCount: number } }>(
      "select data from domain_events where type = 'stream.projection_checkpoint' order by account_seq desc limit 1",
    );
    expect(checkpoint.rows).toHaveLength(1);
    expect(checkpoint.rows[0]!.data.hiddenCount).toBe(1);

    // Rebuild reproduces identical projection rows.
    const rebuilt = await rebuildFanEarningsProjection(appStub(), { accountId: page.id });
    expect(rebuilt.upserted).toBe(4);
    const after = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from fan_earnings_stats where account_id = $1",
      [page.id],
    );
    expect(after.rows[0]!.n).toBe("2");
  });
});

describe("fan_earnings_stats writer", () => {
  it("stores every month window beside the capped lifetime row, and an unknown net as NULL", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const model = await createModel(testDb.db, { slug: "m-capped", name: "M Capped" });
    const page = await createFanslyPage(testDb.db, { modelId: model.id, label: "capped-1" });
    const fans = await upsertFans(testDb.db, [
      { platform: "fansly", platformUserId: "fan-c-capped" },
      { platform: "fansly", platformUserId: "fan-c-whole" },
      { platform: "fansly", platformUserId: "fan-c-lifetime-only" },
      { platform: "fansly", platformUserId: "fan-c-stale-month" },
      { platform: "fansly", platformUserId: "fan-c-net-unknown" },
      { platform: "fansly", platformUserId: "fan-c-monthly-only" },
    ]);
    const [capped, whole, lifetimeOnly, staleMonth, netUnknown, monthlyOnly] = fans;
    const t1 = new Date("2026-07-01T00:00:00Z");
    const t2 = new Date("2026-07-02T00:00:00Z");
    let sourceEventId = 0;
    const seed = async (
      fan: { id: number },
      window: string,
      grossMills: number,
      netMills: number | null,
      observedAt: Date,
    ) => {
      sourceEventId += 1;
      await upsertFanEarningsStat(testDb!.db, {
        accountId: page.id, fanId: fan.id, window, grossMills, netMills, observedAt, sourceEventId,
      });
    };
    // The prod shape: Fansly's lifetime answer hit its 100-row cap, so the
    // stored lifetime row is a slice (835_450) of what the months add up to.
    await seed(capped!, "lifetime", 835_450, 668_360, t2);
    await seed(capped!, "2026-05", 1_000_000, 800_000, t2);
    await seed(capped!, "2026-06", 1_481_980, 1_185_584, t2);
    await seed(capped!, "2026-07", 1_000_000, 800_000, t2);
    // Uncapped: lifetime and Σmonthly agree.
    await seed(whole!, "lifetime", 3_103_980, 2_483_184, t2);
    await seed(whole!, "2026-06", 3_000_000, 2_400_000, t2);
    await seed(whole!, "2026-07", 103_980, 83_184, t2);
    // No month rows: the stored lifetime row is all there is.
    await seed(lifetimeOnly!, "lifetime", 5_000, 4_000, t1);
    // 2026-05 came from an OLDER monthly answer: it keeps that answer's time.
    await seed(staleMonth!, "lifetime", 150_000, 120_000, t2);
    await seed(staleMonth!, "2026-05", 900_000, 720_000, t1);
    await seed(staleMonth!, "2026-06", 150_000, 120_000, t2);
    // One month without a net.
    await seed(netUnknown!, "lifetime", 60_000, 48_000, t2);
    await seed(netUnknown!, "2026-06", 40_000, 32_000, t2);
    await seed(netUnknown!, "2026-07", 20_000, null, t2);
    // Month rows without a lifetime row.
    await seed(monthlyOnly!, "2026-07", 7_000, 5_600, t2);

    const stored = await testDb.pool.query<{
      fan: string; window: string; gross_mills: string; net_mills: string | null;
      currency: string; observed_at: Date;
    }>(
      `select f.platform_user_id as fan, s."window", s.gross_mills::text as gross_mills,
              s.net_mills::text as net_mills, s.currency, s.observed_at
       from fan_earnings_stats s join fans f on f.id = s.fan_id
       where s.account_id = $1
       order by f.platform_user_id collate "C", s."window" collate "C"`,
      [page.id],
    );
    const T1 = t1.toISOString();
    const T2 = t2.toISOString();
    // One row per (fan, window): each month is its own row under its period,
    // the lifetime row stays the capped slice as served.
    expect(stored.rows.map((row) => [
      row.fan, row.window, row.gross_mills, row.net_mills, row.observed_at.toISOString(),
    ])).toEqual([
      ["fan-c-capped", "2026-05", "1000000", "800000", T2],
      ["fan-c-capped", "2026-06", "1481980", "1185584", T2],
      ["fan-c-capped", "2026-07", "1000000", "800000", T2],
      ["fan-c-capped", "lifetime", "835450", "668360", T2],
      ["fan-c-lifetime-only", "lifetime", "5000", "4000", T1],
      ["fan-c-monthly-only", "2026-07", "7000", "5600", T2],
      ["fan-c-net-unknown", "2026-06", "40000", "32000", T2],
      ["fan-c-net-unknown", "2026-07", "20000", null, T2],
      ["fan-c-net-unknown", "lifetime", "60000", "48000", T2],
      ["fan-c-stale-month", "2026-05", "900000", "720000", T1],
      ["fan-c-stale-month", "2026-06", "150000", "120000", T2],
      ["fan-c-stale-month", "lifetime", "150000", "120000", T2],
      ["fan-c-whole", "2026-06", "3000000", "2400000", T2],
      ["fan-c-whole", "2026-07", "103980", "83184", T2],
      ["fan-c-whole", "lifetime", "3103980", "2483184", T2],
    ]);
    expect(new Set(stored.rows.map((row) => row.currency))).toEqual(new Set(["USD"]));
    // An unknown net is stored unknown (NULL), never as 0: a lifetime summed
    // from the months must come out unknown, not smaller.
    expect(stored.rows.filter((row) => row.net_mills === null).map((row) => [row.fan, row.window]))
      .toEqual([["fan-c-net-unknown", "2026-07"]]);
  });
});
