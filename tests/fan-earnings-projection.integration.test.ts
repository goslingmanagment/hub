// Stage 16 v3 (parse side): earnings observation → fan.earnings_observed
// events → fan_earnings_stats rows; an UNCHANGED snapshot re-fetch dedupes
// to zero new events (content-hashed key); rebuild reproduces the rows.

import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  getFanEarningsSnapshotMeta,
  insertObservation,
  listTopFanEarnings,
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
  it("observation → events → projection rows; snapshot re-fetch dedupes; rebuild reproduces", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const model = await createModel(testDb.db, { slug: "earn", name: "E" });
    const page = await createFanslyPage(testDb.db, { modelId: model.id, label: "earn-page" });

    await seedStatsObservation(page, "run-1");
    const first = await runCanonicalization(appStub());
    expect(first.appended).toBe(2); // one per fan (lifetime window)

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

    // The SAME snapshot fetched again → new observation, ZERO new events.
    await seedStatsObservation(page, "run-2");
    const second = await runCanonicalization(appStub());
    expect(second.appended).toBe(0);
    expect(second.deduped).toBe(2);

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
      "select data from domain_events where type = 'stream.projection_checkpoint'",
    );
    expect(checkpoint.rows).toHaveLength(1);
    expect(checkpoint.rows[0]!.data.hiddenCount).toBe(1);

    // Rebuild reproduces identical projection rows.
    const rebuilt = await rebuildFanEarningsProjection(appStub(), { accountId: page.id });
    expect(rebuilt.upserted).toBe(2);
    const after = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from fan_earnings_stats where account_id = $1",
      [page.id],
    );
    expect(after.rows[0]!.n).toBe("2");
  });
});

// ── Stage 32: the board reads (top spenders over the projection) ──────────

describe("fan_earnings_stats board reads", () => {
  it("ranks spenders spend-descending, bounds by limit, and reports honest snapshot meta", async () => {
    if (!testDb) throw new Error("db not started");
    const model = await createModel(testDb.db, { slug: "m-reads", name: "M Reads" });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "reads-1",
    });

    const fans = await upsertFans(testDb.db, [
      { platform: "fansly", platformUserId: "fan-r-1", username: "alice", displayName: "Alice" },
      { platform: "fansly", platformUserId: "fan-r-2", username: null, displayName: null },
      { platform: "fansly", platformUserId: "fan-r-3", username: "carol", displayName: "Carol" },
    ]);
    const amounts = [
      { fan: fans[0]!, gross: 5_000, net: 4_000, at: new Date("2026-07-01T00:00:00Z") },
      { fan: fans[1]!, gross: 12_000, net: null, at: new Date("2026-07-03T00:00:00Z") },
      { fan: fans[2]!, gross: 0, net: 0, at: new Date("2026-07-02T00:00:00Z") },
    ];
    for (const [index, row] of amounts.entries()) {
      await upsertFanEarningsStat(testDb.db, {
        accountId: page.id,
        fanId: row.fan.id,
        window: "lifetime",
        grossMills: row.gross,
        netMills: row.net,
        observedAt: row.at,
        sourceEventId: index + 1,
      });
    }

    const entries = await listTopFanEarnings(testDb.db, {
      accountId: page.id,
      window: "lifetime",
      limit: 150,
    });
    // Zero-spend fans are excluded; order is spend-descending.
    expect(entries.map((entry) => entry.platformUserId)).toEqual(["fan-r-2", "fan-r-1"]);
    expect(entries[0]).toMatchObject({
      username: null,
      displayName: null,
      grossMills: 12_000,
      netMills: null,
      currency: "USD",
    });
    expect(entries[0]!.observedAt.toISOString()).toBe("2026-07-03T00:00:00.000Z");

    const limited = await listTopFanEarnings(testDb.db, {
      accountId: page.id,
      window: "lifetime",
      limit: 1,
    });
    expect(limited).toHaveLength(1);
    expect(limited[0]!.platformUserId).toBe("fan-r-2");

    const meta = await getFanEarningsSnapshotMeta(testDb.db, {
      accountId: page.id,
      window: "lifetime",
    });
    expect(meta.fanCount).toBe(2); // gross > 0 only
    expect(meta.builtAt?.toISOString()).toBe("2026-07-03T00:00:00.000Z");

    // A window with no rows reads as an honest empty snapshot.
    const empty = await getFanEarningsSnapshotMeta(testDb.db, {
      accountId: page.id,
      window: "2026-01",
    });
    expect(empty).toEqual({ fanCount: 0, builtAt: null });
    expect(await listTopFanEarnings(testDb.db, {
      accountId: page.id,
      window: "2026-01",
      limit: 10,
    })).toEqual([]);
  });
});
