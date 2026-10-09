import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  queryAgentDataset,
  type Database,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

/**
 * The agent dataset `followers_daily` against a real database: one row per
 * page and day of the follower rollup, with the day's new follows
 * (`daily_followers.new_followers`) beside the known total — the two numbers
 * traffic-control reads instead of its SSH psql query.
 */

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 180_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

describe("the followers_daily dataset", () => {
  it("serves each day's new followers and known total, windowed by the day", async () => {
    const model = await createModel(db(), { slug: "lora", name: "Lora" });
    const page = (await createFanslyPage(db(), { modelId: model!.id, label: "lora-1" }))!.id;
    const other = (await createFanslyPage(db(), { modelId: model!.id, label: "lora-2" }))!.id;
    await testDb!.pool.query(
      `insert into daily_followers (platform_account_id, business_date, new_followers, known_total_followers)
       values ($1, '2026-10-01', 4, null), ($1, '2026-10-02', 6, 9498), ($1, '2026-10-03', 0, 9495),
              ($2, '2026-10-02', 13, 8227)`,
      [page, other],
    );

    const result = await queryAgentDataset(db(), {
      dataset: "followers_daily",
      pageId: page,
      from: new Date("2026-10-02T00:00:00Z"),
      to: new Date("2026-10-04T00:00:00Z"),
      filters: [],
      sort: null,
      limit: 100,
    });

    expect(result.rows.map((row) => row.fields)).toEqual([
      { platform: "fansly", businessDate: "2026-10-03", followersCount: 9495, newFollowers: 0 },
      { platform: "fansly", businessDate: "2026-10-02", followersCount: 9498, newFollowers: 6 },
    ]);
  });
});
