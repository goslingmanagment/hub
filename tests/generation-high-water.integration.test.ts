import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  countPageFollowsByGeneration,
  createFanslyPage,
  createModel,
  deactivatePageFollowsByGeneration,
  maxPageDmThreadGeneration,
  maxPageFollowGeneration,
  maxPageSubscriptionGeneration,
  upsertFans,
  upsertPageFollow,
  upsertPageFollows,
  upsertPageSubscription,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

async function createGenerationPage(testDb: StartedTestDatabase, label: string) {
  const model = await createModel(testDb.db, {
    slug: `${label}-model`,
    name: `${label} model`,
  });
  if (!model) {
    throw new Error("test setup: model creation failed");
  }
  const page = await createFanslyPage(testDb.db, { modelId: model.id, label });
  if (!page) {
    throw new Error("test setup: page creation failed");
  }
  return page;
}

describe("projection generation high-water", () => {
  let testDb: StartedTestDatabase | null = null;

  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  beforeEach(async () => {
    if (testDb) {
      await resetIntegrationDatabase(testDb.pool);
    }
  });

  it("returns zero for empty projections so a first sweep can start at generation one", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createGenerationPage(testDb, "generation-empty");

    expect(await maxPageFollowGeneration(testDb.db, page.id)).toBe(0);
    expect(await maxPageSubscriptionGeneration(testDb.db, page.id)).toBe(0);
    expect(await maxPageDmThreadGeneration(testDb.db, page.id)).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("starts above a lora-shaped follower high-water and retires stale active rows", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createGenerationPage(testDb, "generation-lora");
    const fans = await upsertFans(testDb.db, [
      { platform: "fansly", platformUserId: "current" },
      { platform: "fansly", platformUserId: "stale-a" },
      { platform: "fansly", platformUserId: "stale-b" },
      { platform: "fansly", platformUserId: "junk-one" },
      { platform: "fansly", platformUserId: "junk-two" },
    ]);
    const rows = [
      { id: "current", fanId: fans[0]!.id, generation: 861 },
      { id: "stale-a", fanId: fans[1]!.id, generation: 860 },
      { id: "stale-b", fanId: fans[2]!.id, generation: 860 },
      { id: "junk-one", fanId: fans[3]!.id, generation: 1 },
      { id: "junk-two", fanId: fans[4]!.id, generation: 2 },
    ];
    for (const row of rows) {
      await upsertPageFollow(testDb.db, {
        platformAccountId: page.id,
        fanId: row.fanId,
        platformFollowId: row.id,
        followedAt: new Date("2026-07-01T00:00:00.000Z"),
        lastSeenGeneration: row.generation,
      });
    }
    await testDb.pool.query(
      `update page_follows
       set is_active = false
       where platform_account_id = $1
         and platform_follow_id in ('junk-one', 'junk-two')`,
      [page.id],
    );

    const generation = Math.max(0, await maxPageFollowGeneration(testDb.db, page.id)) + 1;
    expect(generation).toBe(862);

    await upsertPageFollow(testDb.db, {
      platformAccountId: page.id,
      fanId: fans[0]!.id,
      platformFollowId: "current",
      followedAt: new Date("2026-07-01T00:00:00.000Z"),
      lastSeenGeneration: generation,
    });
    expect(await countPageFollowsByGeneration(testDb.db, {
      platformAccountId: page.id,
      generation,
    })).toBe(1);

    await deactivatePageFollowsByGeneration(testDb.db, {
      platformAccountId: page.id,
      generation,
      lastSeenBefore: new Date("2099-01-01T00:00:00.000Z"),
    });
    const { rows: followRows } = await testDb.pool.query<{
      platform_follow_id: string;
      is_active: boolean;
    }>(
      `select platform_follow_id, is_active
       from page_follows
       where platform_account_id = $1
       order by platform_follow_id`,
      [page.id],
    );
    expect(Object.fromEntries(followRows.map((row) => [row.platform_follow_id, row.is_active])))
      .toEqual({
        current: true,
        "junk-one": false,
        "junk-two": false,
        "stale-a": false,
        "stale-b": false,
      });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("preserves follower generations across live upserts and spares rows touched during a sweep", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createGenerationPage(testDb, "generation-live-race");
    const fans = await upsertFans(testDb.db, [
      { platform: "fansly", platformUserId: "live-race" },
      { platform: "fansly", platformUserId: "touched-race" },
      { platform: "fansly", platformUserId: "stale-race" },
    ]);
    const followedAt = new Date("2026-07-01T00:00:00.000Z");
    await upsertPageFollow(testDb.db, {
      platformAccountId: page.id,
      fanId: fans[0]!.id,
      platformFollowId: "live-race",
      followedAt,
      lastSeenGeneration: 10,
    });
    await upsertPageFollow(testDb.db, {
      platformAccountId: page.id,
      fanId: fans[1]!.id,
      platformFollowId: "touched-race",
      followedAt,
      lastSeenGeneration: 9,
    });
    await upsertPageFollow(testDb.db, {
      platformAccountId: page.id,
      fanId: fans[2]!.id,
      platformFollowId: "stale-race",
      followedAt,
      lastSeenGeneration: 9,
    });

    // Incremental followers carries no generation; it may refresh liveness but
    // must not erase or regress the reconcile witness.
    await upsertPageFollows(testDb.db, [{
      platformAccountId: page.id,
      fanId: fans[0]!.id,
      platformFollowId: "live-race",
      followedAt,
    }]);
    await upsertPageFollows(testDb.db, [{
      platformAccountId: page.id,
      fanId: fans[0]!.id,
      platformFollowId: "live-race",
      followedAt,
      lastSeenGeneration: 8,
    }]);

    const sweepStartedAt = new Date("2026-08-24T20:00:00.000Z");
    await testDb.pool.query(
      `update page_follows
       set last_seen_at = case platform_follow_id
         when 'touched-race' then $2::timestamptz + interval '1 second'
         else $2::timestamptz - interval '1 second'
       end
       where platform_account_id = $1`,
      [page.id, sweepStartedAt],
    );
    await deactivatePageFollowsByGeneration(testDb.db, {
      platformAccountId: page.id,
      generation: 11,
      lastSeenBefore: sweepStartedAt,
    });

    const rows = await testDb.pool.query<{
      platform_follow_id: string;
      last_seen_generation: string | null;
      is_active: boolean;
    }>(
      `select platform_follow_id, last_seen_generation::text, is_active
       from page_follows
       where platform_account_id = $1
       order by platform_follow_id`,
      [page.id],
    );
    expect(rows.rows).toEqual([
      { platform_follow_id: "live-race", last_seen_generation: "10", is_active: true },
      { platform_follow_id: "stale-race", last_seen_generation: "9", is_active: false },
      { platform_follow_id: "touched-race", last_seen_generation: "9", is_active: true },
    ]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reads subscription and DM-thread high-waters from inactive and hidden rows", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createGenerationPage(testDb, "generation-other-projections");
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "projection-fan",
    }]);
    await upsertPageSubscription(testDb.db, {
      platformSubscriptionId: "old-subscription",
      platformAccountId: page.id,
      fanId: fan!.id,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: 0n,
      renewPriceMills: 0n,
      lastSeenGeneration: 861,
    });
    await testDb.pool.query(
      `update page_subscriptions
       set is_current = false
       where platform_account_id = $1`,
      [page.id],
    );
    await testDb.pool.query(
      `insert into page_dm_threads (
         platform_account_id,
         platform_conversation_id,
         is_visible,
         last_seen_generation
       ) values ($1, 'old-thread', false, 2144)`,
      [page.id],
    );

    expect(await maxPageSubscriptionGeneration(testDb.db, page.id)).toBe(861);
    expect(await maxPageDmThreadGeneration(testDb.db, page.id)).toBe(2_144);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
