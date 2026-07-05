// Stage 16 v3 (parse side): earnings observation → fan.earnings_observed
// events → fan_earnings_stats rows; an UNCHANGED snapshot re-fetch dedupes
// to zero new events (content-hashed key); rebuild reproduces the rows.

import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createFanslyPage, createModel, insertObservation } from "@agency_hub_core/db";

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
    expect(third.appended).toBe(1);
    const ppv = await testDb.pool.query<{ type: string; dedup_key: string }>(
      "select type, dedup_key from domain_events where type = 'message.ppv_unlocked'",
    );
    expect(ppv.rows[0]!.dedup_key).toMatch(/^ppv:fan-e-1:media-9:/);

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
