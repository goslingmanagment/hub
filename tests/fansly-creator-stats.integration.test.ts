import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createFanslyPage, createModel, upsertCreatorStatsRevenue, upsertCreatorStatsSummary } from "@agency_hub_core/db";
import { millsFromInteger } from "@agency_hub_core/shared";

import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// The creator statistics writers (0292): money stays exact, a re-applied
// older answer never overwrites a fresher one, and a key twice in one answer
// is written once.

let db: StartedTestDatabase;
beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Docker Postgres required");
  db = started;
}, 120_000);
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await resetIntegrationDatabase(db.pool);
});

async function page(): Promise<number> {
  const model = await createModel(db.db, { slug: "creator-stats", name: "Creator stats" });
  const created = model ? await createFanslyPage(db.db, { modelId: model.id, label: "creator-stats-page" }) : undefined;
  if (!created) throw new Error("page seed failed");
  return created.id;
}

const DAY = new Date("2026-10-21T00:00:00Z");

describe("creator statistics writers", () => {
  it("keeps revenue mills exact and lets only a newer answer replace a row", async () => {
    const pageId = await page();
    const row = (net: number) => ({
      bucketStart: DAY,
      productType: 7101,
      transactions: 2,
      grossMills: millsFromInteger(net + 1_000),
      netMills: millsFromInteger(net),
      refunds: 0,
      refundedGrossMills: millsFromInteger(0),
      refundedNetMills: millsFromInteger(0),
    });
    const newer = { pageId, observationId: 20, capturedAt: new Date("2026-10-22T10:00:00Z") };
    const older = { pageId, observationId: 10, capturedAt: new Date("2026-10-22T09:00:00Z") };

    await upsertCreatorStatsRevenue(db.db, newer, "day", [row(9_007_199_254_740)]);
    await upsertCreatorStatsRevenue(db.db, older, "day", [row(4_000)]);

    const stored = await db.pool.query<{ net_mills: string; gross_mills: string; observation_id: string }>(
      `select net_mills::text, gross_mills::text, observation_id::text from fansly_creator_stats_revenue where page_id = $1`,
      [pageId],
    );
    expect(stored.rows).toEqual([{ net_mills: "9007199254740", gross_mills: "9007199255740", observation_id: "20" }]);
  });

  it("writes a summary key the answer repeats once, the last occurrence", async () => {
    const pageId = await page();
    const written = await upsertCreatorStatsSummary(db.db, { pageId, observationId: 1, capturedAt: DAY }, {
      afterDay: "2026-09-22",
      beforeDay: "2026-10-21",
      levels: [
        { day: "2026-10-20", followerCount: 100, subscriberCount: 5 },
        { day: "2026-10-20", followerCount: 101, subscriberCount: 6 },
      ],
      tierLevels: [],
      tiers: [],
      engagement: [],
      windowTotals: [{ scope: "revenue", ref: "", metric: "payingFans", value: "143", previous: "32" }],
    });
    expect(written.levels).toBe(1);
    const levels = await db.pool.query<{ follower_count: string }>(
      `select follower_count::text from fansly_creator_stats_levels where page_id = $1`,
      [pageId],
    );
    expect(levels.rows).toEqual([{ follower_count: "101" }]);
  });
});
