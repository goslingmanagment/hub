import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  countActivePageFollows,
  countCurrentPageSubscriptionsByGeneration,
  countPageFollowsByGeneration,
  createFanslyPage,
  createModel,
  deactivatePageFollowsByGeneration,
  ensurePageSyncStates,
  findPageById,
  listPageFollowDeactivationCandidates,
  maxPageDmThreadGeneration,
  maxPageFollowGeneration,
  maxPageSubscriptionGeneration,
  readPageFollowDeactivationGenerationBuckets,
  startSyncRun,
  upsertCheckpointProgress,
  upsertFans,
  upsertPageFollow,
  upsertPageFollows,
  upsertPageSubscription,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { fanslySubscribersChunk } from "../apps/runtime/src/services/sync/executor-handlers.ts";
import type { StreamChunkResult } from "../apps/runtime/src/services/sync/executor-types.ts";
import { SyncRunTelemetry } from "../apps/runtime/src/services/sync/observability.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
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

  it("retires stale followers while preserving one-generation grace until the next absent sweep", async (context) => {
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
      { platform: "fansly", platformUserId: "grace" },
    ]);
    const rows = [
      { id: "current", fanId: fans[0]!.id, generation: 861 },
      { id: "stale-a", fanId: fans[1]!.id, generation: 860 },
      { id: "stale-b", fanId: fans[2]!.id, generation: 860 },
      { id: "junk-one", fanId: fans[3]!.id, generation: 1 },
      { id: "junk-two", fanId: fans[4]!.id, generation: 2 },
      { id: "grace", fanId: fans[5]!.id, generation: 861 },
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

    const deactivationInput = {
      platformAccountId: page.id,
      generation,
      fullSweepStartedAt: new Date("2099-01-01T00:00:00.000Z"),
    };
    const exactCandidates = await listPageFollowDeactivationCandidates(
      testDb.db,
      deactivationInput,
    );
    expect(await readPageFollowDeactivationGenerationBuckets(
      testDb.db,
      deactivationInput,
    )).toEqual([{ lastSeenGeneration: 860, count: 2 }]);
    const deactivatedIds = await deactivatePageFollowsByGeneration(testDb.db, {
      platformAccountId: page.id,
      generation,
      lastSeenBefore: deactivationInput.fullSweepStartedAt,
    });
    expect(deactivatedIds).toHaveLength(2);
    expect(deactivatedIds).toEqual(exactCandidates.map((candidate) => candidate.id));
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
        grace: true,
        "junk-one": false,
        "junk-two": false,
        "stale-a": false,
        "stale-b": false,
      });

    // Matching the provider roster does not yet retire a row seen by G-1.
    // A count mismatch after this repository finalization can still need repair.
    expect(await countActivePageFollows(testDb.db, page.id)).toBe(2);
    expect(await listPageFollowDeactivationCandidates(testDb.db, deactivationInput)).toEqual([]);

    const nextGeneration = (await maxPageFollowGeneration(testDb.db, page.id)) + 1;
    expect(nextGeneration).toBe(863);
    await upsertPageFollow(testDb.db, {
      platformAccountId: page.id,
      fanId: fans[0]!.id,
      platformFollowId: "current",
      followedAt: new Date("2026-07-01T00:00:00.000Z"),
      lastSeenGeneration: nextGeneration,
    });
    expect(await countPageFollowsByGeneration(testDb.db, {
      platformAccountId: page.id,
      generation: nextGeneration,
    })).toBe(1);
    const graceCandidates = await listPageFollowDeactivationCandidates(testDb.db, {
      ...deactivationInput,
      generation: nextGeneration,
    });
    expect(graceCandidates).toEqual([expect.objectContaining({ lastSeenGeneration: 861 })]);
    expect(await deactivatePageFollowsByGeneration(testDb.db, {
      platformAccountId: page.id,
      generation: nextGeneration,
      lastSeenBefore: deactivationInput.fullSweepStartedAt,
    })).toEqual(graceCandidates.map((row) => row.id));
    expect(await countActivePageFollows(testDb.db, page.id)).toBe(1);
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

  it("counts only the current subscriptions one walk generation stamped", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createGenerationPage(testDb, "generation-subscription-count");
    const fans = await upsertFans(testDb.db, ["seen", "retired", "older"].map((platformUserId) => ({
      platform: "fansly" as const,
      platformUserId,
    })));
    for (const [index, generation] of [5, 5, 4].entries()) {
      await upsertPageSubscription(testDb.db, {
        platformSubscriptionId: `count-subscription-${index}`,
        platformAccountId: page.id,
        fanId: fans[index]!.id,
        rawStatus: 3,
        canonicalStatus: "active",
        priceMills: 0n,
        renewPriceMills: 0n,
        lastSeenGeneration: generation,
      });
    }
    await testDb.pool.query(
      `update page_subscriptions
       set is_current = false
       where platform_account_id = $1 and platform_subscription_id = 'count-subscription-1'`,
      [page.id],
    );

    expect(await countCurrentPageSubscriptionsByGeneration(testDb.db, {
      platformAccountId: page.id,
      generation: 5,
    })).toBe(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps a current subscription that overlapping offset pages never served", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createGenerationPage(testDb, "generation-subscriber-overlap");
    const [tailFan] = await upsertFans(testDb.db, [{ platform: "fansly", platformUserId: "tail-fan" }]);
    await upsertPageSubscription(testDb.db, {
      platformSubscriptionId: "tail-subscription",
      platformAccountId: page.id,
      fanId: tailFan!.id,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: 0n,
      renewPriceMills: 0n,
      lastSeenGeneration: 0,
    });
    const items = Array.from({ length: 100 }, (_, index) => ({
      id: `walk-subscription-${index}`,
      subscriberId: `walk-fan-${index}`,
      historyId: null,
      subscriptionTierId: null,
      subscriptionTierName: null,
      subscriptionTierColor: null,
      planId: null,
      status: 3,
      price: 5000,
      renewPrice: 5000,
      autoRenew: 1,
      billingCycle: 30,
      duration: 30,
      renewDate: null,
      createdAt: "2026-03-10T00:00:00.000Z",
      updatedAt: null,
      endsAt: "2026-04-09T00:00:00.000Z",
    }));
    // The provider total counts the tail subscription, but its second page
    // repeats a first-page row instead of serving it: page lengths still sum
    // to the total, so only distinct membership exposes the unseen row.
    const adapter = {
      getSubscribersPage: async (_context: unknown, params: { offset?: number }) => ({
        total: 101,
        items: params.offset === 0 ? items : [items[0]!],
        offset: params.offset ?? 0,
        done: params.offset !== 0,
        contractAccepted: true,
        raw: {},
      }),
      getAccountsByIdsPage: async () => ({ parsed: [], raw: {} }),
    } as unknown as AppContext["adapter"];
    const app = createTestAppContext(testDb, { adapter });
    const states = await ensurePageSyncStates(testDb.db, { pageId: page.id });
    const subscribersState = states.find((state) => state.stream === "subscribers");
    const stored = await findPageById(testDb.db, page.id);
    const run = await startSyncRun(testDb.db, {
      platformAccountId: page.id,
      stream: "subscribers",
      trigger: "manual",
    });
    if (!subscribersState || !stored || !run) {
      throw new Error("test setup: subscribers run seed failed");
    }
    // History is already backfilled, so the walk ends at the active finalization.
    await upsertCheckpointProgress(testDb.db, {
      platformAccountId: page.id,
      stream: "subscribers",
      state: { revision: 0, generation: 0, historyBackfilledAt: "2026-07-01T00:00:00.000Z" },
    });
    const telemetry = new SyncRunTelemetry(app, {
      runId: run.id,
      platformAccountId: page.id,
      pageLabel: page.label,
      provider: "fansly",
      stream: "subscribers",
      trigger: "manual",
      egressKey: "direct",
    });
    const runChunk = () => fanslySubscribersChunk(app, {
      pageContext: {
        platform: "fansly",
        page: { ...stored.page, platformAccountId: "account-1" },
        session: { authorization: "test-token" },
        proxy: null,
        egressKey: "direct",
      },
      streamState: { ...subscribersState, platform: "fansly", proxyUrl: null, egressKey: "direct" },
      syncRunId: run.id,
      telemetry,
      budget: new SyncChunkBudget(10),
    });

    const results: StreamChunkResult[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      results.push(await runChunk());
    }
    await telemetry.finish("success");

    expect(results.map((result) => [
      result.satisfied,
      result.stats?.restartReason ?? result.stats?.withheldReason,
    ])).toEqual([
      [false, "offset_duplicates"],
      [false, "offset_duplicates"],
      [true, "offset_duplicates"],
    ]);
    const current = await testDb.pool.query<{ platform_subscription_id: string; last_seen_generation: number }>(
      `select platform_subscription_id, last_seen_generation::int as last_seen_generation
       from page_subscriptions
       where platform_account_id = $1 and is_current = true`,
      [page.id],
    );
    expect(current.rows).toHaveLength(101);
    expect(current.rows).toContainEqual({ platform_subscription_id: "tail-subscription", last_seen_generation: 0 });
    // Each restart takes a fresh generation, so an abandoned walk's rows never count as seen.
    expect(await maxPageSubscriptionGeneration(testDb.db, page.id)).toBe(3);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
