import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getCurrentSubscribers,
  getFollowersForPage,
  listSyncStreamStateRows,
  pageFollows,
  pageSubscriptions,
  syncRuns,
} from "@agency_hub_core/db";
import { PgBoss } from "pg-boss";

import { startSyncPageExecutor } from "../apps/runtime/src/services/sync/executor.ts";
import { requestPageSync, waitForRequestedSyncRevisions } from "../apps/runtime/src/services/sync-control.ts";
import { ensureSyncQueues } from "../apps/runtime/src/services/sync-queue.ts";
import {
  resetIntegrationDatabase,
  seedFanslyPage,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

function createFanslySyncAdapter() {
  return {
    async verifySession() {
      return {
        parsed: {
          account: {
            id: "acct-sync",
            username: "sync_user",
            displayName: "Sync User",
            createdAt: 1_770_000_000_000,
            followCount: 1,
            subscriberCount: 1,
            earningsWallet: null,
            walls: [],
            subscriptionTiers: [],
          },
        },
        raw: {},
      };
    },
    async getAccountMe() {
      return {
        parsed: {
          account: {
            id: "acct-sync",
            username: "sync_user",
            displayName: "Sync User",
            createdAt: 1_770_000_000_000,
            followCount: 1,
            subscriberCount: 1,
            earningsWallet: null,
            walls: [],
            subscriptionTiers: [],
          },
        },
        raw: {},
      };
    },
    async getAccountsByIdsPage(_context: unknown, ids: string[]) {
      return {
        parsed: ids.map((id) => ({
          id,
          username: `fan_${id}`,
          displayName: `Fan ${id}`,
          createdAt: 1_770_000_000_000,
        })),
        raw: {},
      };
    },
    async getTransactionsPage() {
      return {
        total: 0,
        items: [],
        offset: 0,
        done: true,
        raw: {
          total: 0,
          data: [],
        },
      };
    },
    async getSubscribersPage() {
      return {
        total: 1,
        items: [{
          id: "sub-1",
          subscriberId: "fan-1",
          historyId: null,
          subscriptionTierId: null,
          subscriptionTierName: null,
          subscriptionTierColor: null,
          planId: null,
          status: 3,
          price: 5,
          renewPrice: 5,
          autoRenew: 1,
          billingCycle: 30,
          duration: 30,
          renewDate: "2026-03-20T00:00:00.000Z",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-10T00:00:00.000Z",
          endsAt: "2026-03-20T00:00:00.000Z",
        }],
        offset: 0,
        done: true,
        raw: {},
      };
    },
    async getFollowersPage() {
      return {
        items: [{
          id: "1710000000000000000",
          followerId: "fan-1",
        }],
        accounts: [{
          id: "fan-1",
          username: "fan_1",
          displayName: "Fan 1",
          createdAt: 1_770_000_000_000,
        }],
        done: true,
        raw: {},
      };
    },
  };
}

describe("sync integration", () => {
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

  afterEach(async () => {
    // PgBoss owns transient state in pgboss; resetIntegrationDatabase clears it between tests.
  });

  it("converges a Fansly all-scope sync through sync_stream_state and executor wakeups", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const { page } = await seedFanslyPage(testDb.db, Buffer.alloc(32, 7));
    const app = createTestAppContext(testDb, {
      databaseUrl: testDb.connectionString,
      adapter: createFanslySyncAdapter() as never,
    });
    const boss = new PgBoss({ connectionString: testDb.connectionString });
    const abortController = new AbortController();

    await boss.start();
    await ensureSyncQueues(boss);
    const executorPromise = startSyncPageExecutor(app, boss, {
      signal: abortController.signal,
    });

    try {
      const request = await requestPageSync(app, boss, {
        pageLabel: page.label,
        scope: "all",
        reason: "manual",
      });

      await waitForRequestedSyncRevisions(app, {
        platformAccountId: page.id,
        revisions: request.revisions,
        timeoutMs: 10_000,
        pollMs: 100,
      });

      const stateRows = await listSyncStreamStateRows(app.db, {
        platformAccountId: page.id,
      });
      expect(stateRows.map((row) => row.stream)).toEqual([
        "light",
        "transactions",
        "subscribers",
        "followers",
        "followers_reconcile",
      ]);
      expect(stateRows.every((row) => row.desiredRevision === row.satisfiedRevision)).toBe(true);

      const subscribers = await getCurrentSubscribers(app.db, page.id);
      const followers = await getFollowersForPage(app.db, page.id);
      expect(subscribers.rows).toHaveLength(1);
      expect(followers.rows).toHaveLength(1);

      const runRows = await testDb.db.select({
        stream: syncRuns.stream,
        status: syncRuns.status,
      }).from(syncRuns);
      expect(runRows).toHaveLength(5);
      expect(runRows.every((row) => row.status === "success")).toBe(true);
    } finally {
      abortController.abort();
      await executorPromise;
      await boss.stop();
      await app.close();
    }
  });
});
