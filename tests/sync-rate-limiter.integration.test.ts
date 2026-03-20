import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createSyncRateLimitWaiter } from "../apps/runtime/src/services/sync/rate-limiter.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

async function listFanslyRateLimitRows(testDb: StartedTestDatabase, egressKey: string) {
  const result = await testDb.pool.query<{
    scope: string;
    min_spacing_ms: number;
  }>(`
    select scope, min_spacing_ms
    from sync_provider_rate_limits
    where provider = 'fansly'
      and egress_key = $1
    order by scope asc
  `, [egressKey]);

  return result.rows.map((row) => ({
    scope: row.scope,
    minSpacingMs: row.min_spacing_ms,
  }));
}

describe("sync rate limiter integration", () => {
  let testDb: StartedTestDatabase | null = null;

  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  });

  afterAll(async () => {
    if (testDb) {
      await testDb.stop();
    }
  });

  beforeEach(async () => {
    if (!testDb) {
      return;
    }

    await resetIntegrationDatabase(testDb.pool);
  });

  it("updates seeded Fansly DM rate-limit rows from config after a worker restart", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const egressKey = "socks5://proxy.example:1080";
    const firstApp = createTestAppContext(testDb, {
      syncSharedRateLimitEnabled: true,
      fanslyDmConversationsDelayMs: 5_000,
      fanslyDmMessagesDelayMs: 7_500,
      followerPageDelayMs: 5_000,
    });
    const firstWaiter = createSyncRateLimitWaiter(firstApp, { egressKey });

    expect(firstWaiter).not.toBeNull();

    await firstWaiter!([{ provider: "fansly", scope: "dm_messages" }]);

    expect(await listFanslyRateLimitRows(testDb, egressKey)).toEqual([
      { scope: "dm_conversations", minSpacingMs: 5_000 },
      { scope: "dm_messages", minSpacingMs: 7_500 },
      { scope: "followers_page", minSpacingMs: 5_000 },
      { scope: "global", minSpacingMs: 2_600 },
    ]);

    await testDb.pool.query(`
      update sync_provider_rate_limits
      set next_available_at = now() - interval '1 second'
      where provider = 'fansly'
        and egress_key = $1
    `, [egressKey]);

    const restartedApp = createTestAppContext(testDb, {
      syncSharedRateLimitEnabled: true,
      fanslyDmConversationsDelayMs: 6_200,
      fanslyDmMessagesDelayMs: 8_300,
      followerPageDelayMs: 5_000,
    });
    const restartedWaiter = createSyncRateLimitWaiter(restartedApp, { egressKey });

    expect(restartedWaiter).not.toBeNull();

    await restartedWaiter!([{ provider: "fansly", scope: "dm_messages" }]);

    expect(await listFanslyRateLimitRows(testDb, egressKey)).toEqual([
      { scope: "dm_conversations", minSpacingMs: 6_200 },
      { scope: "dm_messages", minSpacingMs: 8_300 },
      { scope: "followers_page", minSpacingMs: 5_000 },
      { scope: "global", minSpacingMs: 2_600 },
    ]);
  }, 15_000);
});
