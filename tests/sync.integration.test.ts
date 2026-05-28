import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
  getCurrentSubscribers,
  getFollowersForPage,
  listPageSyncStates,
  pageFollows,
  pageSubscriptions,
  requestPageSync as requestPageSyncRows,
  resolvePageSyncPriority,
  resolveSyncRequestPriority,
  storeFanslySession,
  storePlatformCredentials,
  storeProxyConfig,
  syncRuns,
  updatePageMetadata,
} from "@agency_hub_core/db";
import { buildProxyEgressKey, buildSyncPageExecuteGroupId, encryptJson } from "@agency_hub_core/shared";
import { PgBoss } from "pg-boss";

import { startSyncPageExecutor } from "../apps/runtime/src/services/sync/executor.ts";
import { runSyncPlannerCycle } from "../apps/runtime/src/services/sync/planner.ts";
import { requestPageSync, waitForRequestedSyncRequests } from "../apps/runtime/src/services/sync-control.ts";
import { ensureSyncQueues, sendSyncPageWakeup, SYNC_PAGE_EXECUTE_QUEUE } from "../apps/runtime/src/services/sync-queue.ts";
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
    async getEarningsAccountsPage(_context: unknown, params: { after?: Date | null; before?: Date | null }) {
      return {
        items: [],
        after: params.after ?? null,
        before: params.before ?? null,
        done: true,
        raw: [],
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
    async getMessagingGroupsPage() {
      return {
        total: 0,
        items: [],
        accounts: [],
        groups: [],
        offset: 0,
        done: true,
        raw: {
          data: [],
          aggregationData: {
            total: 0,
            accounts: [],
            groups: [],
          },
        },
      };
    },
    async getGroupDetail(_context: unknown, groupId: string) {
      const parsed = {
        id: groupId,
        type: 1,
        groupFlags: 0,
        users: [],
        lastMessage: null,
      };

      return {
        parsed,
        raw: parsed,
      };
    },
    async getMessagesPage(_context: unknown, params: { groupId: string; before?: string | null }) {
      return {
        items: [],
        groupId: params.groupId,
        before: params.before ?? null,
        done: true,
        raw: {
          messages: [],
        },
      };
    },
  };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createConcurrencyProbe() {
  let inFlight = 0;
  let maxInFlight = 0;

  return {
    async run<T>(work: () => Promise<T>) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await work();
      } finally {
        inFlight -= 1;
      }
    },
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

function buildFanslyAccountPayload(accountId: string) {
  return {
    parsed: {
      account: {
        id: accountId,
        username: `user_${accountId}`,
        displayName: `User ${accountId}`,
        createdAt: 1_770_000_000_000,
        followCount: 0,
        subscriberCount: 0,
        earningsWallet: null,
        walls: [],
        subscriptionTiers: [],
      },
    },
    raw: {},
  };
}

function createInstrumentedFanslyLightAdapter(probe: ReturnType<typeof createConcurrencyProbe>) {
  return {
    async verifySession(context: { session: { authorization: string } }) {
      return buildFanslyAccountPayload(`acct-${context.session.authorization}`);
    },
    async getAccountMe(context: { session: { authorization: string } }) {
      return probe.run(async () => {
        await sleep(75);
        return buildFanslyAccountPayload(`acct-${context.session.authorization}`);
      });
    },
  };
}

function createInstrumentedOnlyFansLightAdapter(probe: ReturnType<typeof createConcurrencyProbe>) {
  return {
    async getAccount(_context: unknown, accountId: number) {
      return probe.run(async () => {
        await sleep(75);
        return {
          parsed: {
            account: {
              id: accountId,
              platform_account_id: `of-${accountId}`,
              platform: "onlyfans" as const,
              name: `OnlyFans ${accountId}`,
              email: `of-${accountId}@example.com`,
              avatar: "https://example.com/avatar.png",
              username: `of_${accountId}`,
              organisation_id: "org-1",
              subscribe_price: 10,
              subscription_expiration_date: "2026-04-01T00:00:00.000Z",
            },
          },
          raw: {},
        };
      });
    },
  };
}

async function createFanslyLightPage(
  testDb: StartedTestDatabase,
  input: {
    modelId: number;
    label: string;
    authorization: string;
    proxyUrl?: string | null;
    rateLimitScopeKey?: string | null;
  },
) {
  const page = await createFanslyPage(testDb.db, {
    modelId: input.modelId,
    label: input.label,
  });
  const session = {
    authorization: input.authorization,
    fanslyClientId: "client-id",
    fanslyClientCheck: "client-check",
    fanslySessionId: `session-${input.authorization}`,
  };

  await storeFanslySession(
    testDb.db,
    page.id,
    JSON.stringify(encryptJson(session, Buffer.alloc(32, 7), 1)),
    1,
  );

  if (input.proxyUrl) {
    await storeProxyConfig(testDb.db, page.id, {
      url: input.proxyUrl,
      encryptedAuth: null,
      keyVersion: null,
      rateLimitScopeKey: input.rateLimitScopeKey,
    });
  }

  return page;
}

async function createOnlyFansLightPage(
  testDb: StartedTestDatabase,
  input: {
    modelId: number;
    label: string;
    token: string;
    accountId: number;
    proxyUrl?: string | null;
    rateLimitScopeKey?: string | null;
  },
) {
  const page = await createOnlyFansPage(testDb.db, {
    modelId: input.modelId,
    label: input.label,
  });

  await storePlatformCredentials(testDb.db, {
    platformAccountId: page.id,
    encryptedSession: JSON.stringify(encryptJson({ token: input.token }, Buffer.alloc(32, 7), 1)),
    keyVersion: 1,
  });

  if (input.proxyUrl) {
    await storeProxyConfig(testDb.db, page.id, {
      url: input.proxyUrl,
      encryptedAuth: null,
      keyVersion: null,
      rateLimitScopeKey: input.rateLimitScopeKey,
    });
  }

  await updatePageMetadata(testDb.db, page.id, {
    platformAccountIdValue: `of-${input.accountId}`,
    username: `of_${input.accountId}`,
    displayName: `OnlyFans ${input.accountId}`,
    followerCount: 0,
    subscriberCount: 0,
    earningsBalanceMills: 0n,
    metadata: {
      onlyMonsterAccountId: input.accountId,
      accountCreatedAt: "2026-01-01T00:00:00.000Z",
    },
    syncType: "light",
  });

  return page;
}

async function requestLightSync(
  app: ReturnType<typeof createTestAppContext>,
  boss: Pick<PgBoss, "send">,
  input: {
    platformAccountId: number;
    provider: "fansly" | "onlyfans";
    proxyUrl?: string | null;
    egressKey?: string | null;
  },
) {
  await ensurePageSyncStates(app.db, {
    pageId: input.platformAccountId,
    now: new Date(),
  });

  const requests = await requestPageSyncRows(app.db, {
    pageId: input.platformAccountId,
    streams: ["light"],
    source: "manual",
  });

  await sendSyncPageWakeup(boss, {
    platformAccountId: input.platformAccountId,
    priority: resolvePageSyncPriority("light", "manual"),
    provider: input.provider,
    egressKey: input.egressKey ?? buildProxyEgressKey(input.proxyUrl ? { url: input.proxyUrl } : null),
  });

  return requests;
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

  it("queues sync revisions when the page already has a follower sync timestamp", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const { page } = await seedFanslyPage(testDb.db, Buffer.alloc(32, 7));
    await updatePageMetadata(testDb.db, page.id, {
      platformAccountIdValue: "acct-sync",
      username: "sync_user",
      displayName: "Sync User",
      followerCount: 1,
      subscriberCount: 1,
      earningsBalanceMills: 0n,
      metadata: {},
      syncType: "followers",
    });

    const app = createTestAppContext(testDb, {
      databaseUrl: testDb.connectionString,
      adapter: createFanslySyncAdapter() as never,
    });

    try {
      const request = await requestPageSync(app, {
        send: async () => "job-1",
      }, {
        pageLabel: page.label,
        scope: "light",
        reason: "manual",
      });

      expect(request.page.id).toBe(page.id);
      expect(request.requests).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("runs the planner query through joined sync state rows without ambiguous column errors", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "planner-regression",
      name: "Planner Regression",
    });
    const proxyUrl = "socks5://planner-proxy.example";
    const egressKey = "planner-shared-proxy";
    const page = await createFanslyLightPage(testDb, {
      modelId: model.id,
      label: "planner-regression-page",
      authorization: "planner-regression",
      proxyUrl,
      rateLimitScopeKey: egressKey,
    });
    const app = createTestAppContext(testDb, {
      databaseUrl: testDb.connectionString,
    });
    const now = new Date("2026-03-20T12:00:00.000Z");

    await ensurePageSyncStates(app.db, {
      pageId: page.id,
      now,
    });
    await requestPageSyncRows(app.db, {
      pageId: page.id,
      streams: ["light"],
      source: "manual",
      now,
    });

    const boss = {
      send: vi.fn(async () => "planner-job-1"),
    };

    const pages = await runSyncPlannerCycle(app, boss as never, now);

    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({
      pageId: page.id,
      platform: "fansly",
      priority: resolvePageSyncPriority("light", "manual"),
      proxyUrl,
      egressKey,
    });
    expect(pages[0]?.requestedAt?.toISOString()).toBe(now.toISOString());
    expect(boss.send).toHaveBeenCalledWith(
      SYNC_PAGE_EXECUTE_QUEUE,
      { platformAccountId: page.id },
      {
        singletonKey: String(page.id),
        priority: resolvePageSyncPriority("light", "manual"),
        group: {
          id: buildSyncPageExecuteGroupId("fansly", egressKey),
        },
      },
    );

    const stateRows = await listPageSyncStates(app.db, {
      pageId: page.id,
      streams: ["light"],
    });
    expect(stateRows).toHaveLength(1);
    expect(stateRows[0]?.enqueuedAt?.toISOString()).toBe(now.toISOString());
  });

  it("uses canonical egress keys for legacy proxy rows without stored scope keys", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "planner-legacy-proxy",
      name: "Planner Legacy Proxy",
    });
    const cases = [
      {
        label: "planner-legacy-proxy-page",
        url: "socks5://legacy-user:p@ss@planner-proxy.example:1080",
        expectedEgressKey: "socks5://planner-proxy.example:1080",
      },
      {
        label: "planner-legacy-leading-zero-port-page",
        url: "socks5://legacy-user:legacy-pass@proxy.example:01080",
        expectedEgressKey: "socks5://proxy.example:1080",
      },
      {
        label: "planner-legacy-ipv6-page",
        url: "socks5://legacy-user:legacy-pass@[2001:0db8:0:0:0:0:0:1]",
        expectedEgressKey: "socks5://[2001:db8::1]:1080",
      },
      {
        label: "planner-legacy-mapped-ipv6-page",
        url: "socks5://legacy-user:legacy-pass@[::ffff:192.0.2.1]:1080",
        expectedEgressKey: "socks5://[::ffff:c000:201]:1080",
      },
      {
        label: "planner-legacy-invalid-port-page",
        url: "socks5://legacy-user:legacy-pass@proxy.example:999999999999999999",
        expectedEgressKey: "direct",
      },
    ] as const;
    const pagesById = new Map<number, { expectedEgressKey: string }>();
    for (const testCase of cases) {
      const page = await createFanslyLightPage(testDb, {
        modelId: model.id,
        label: testCase.label,
        authorization: testCase.label,
        proxyUrl: "socks5://planner-proxy.example:1080",
      });
      await testDb.pool.query(
        `
          update egress_endpoints
          set url = $1,
              rate_limit_scope_key = null
          where platform_account_id = $2
        `,
        [testCase.url, page.id],
      );
      pagesById.set(page.id, { expectedEgressKey: testCase.expectedEgressKey });
    }
    const app = createTestAppContext(testDb, {
      databaseUrl: testDb.connectionString,
    });
    const now = new Date("2026-03-20T12:05:00.000Z");

    for (const pageId of pagesById.keys()) {
      await ensurePageSyncStates(app.db, {
        pageId,
        now,
      });
      await requestPageSyncRows(app.db, {
        pageId,
        streams: ["light"],
        source: "manual",
        now,
      });
    }

    const boss = {
      send: vi.fn(async (_queue: string, payload: { platformAccountId: number }) =>
        `planner-job-${payload.platformAccountId}`),
    };

    const pages = await runSyncPlannerCycle(app, boss as never, now);

    expect(pages).toHaveLength(cases.length);
    for (const page of pages) {
      const expected = pagesById.get(page.pageId);
      expect(expected).toBeDefined();
      expect(page.egressKey).toBe(expected?.expectedEgressKey);
      expect(boss.send).toHaveBeenCalledWith(
        SYNC_PAGE_EXECUTE_QUEUE,
        { platformAccountId: page.pageId },
        expect.objectContaining({
          group: {
            id: buildSyncPageExecuteGroupId("fansly", expected?.expectedEgressKey ?? ""),
          },
        }),
      );
    }
  });

  it("converges a Fansly all-scope sync through page sync state and executor wakeups", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const { page } = await seedFanslyPage(testDb.db, Buffer.alloc(32, 7));
    const app = createTestAppContext(testDb, {
      databaseUrl: testDb.connectionString,
      adapter: createFanslySyncAdapter() as never,
      syncSharedRateLimitEnabled: true,
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

      await waitForRequestedSyncRequests(app, {
        pageId: page.id,
        requests: request.requests,
        timeoutMs: 20_000,
        pollMs: 100,
      });

      const stateRows = await listPageSyncStates(app.db, {
        pageId: page.id,
      });
      expect(stateRows.map((row) => row.stream)).toEqual([
        "light",
        "transactions",
        "top_spenders",
        "subscribers",
        "followers",
        "followers_reconcile",
        "dm_conversations",
        "dm_messages",
      ]);
      expect(stateRows.every((row) => row.requestSeq === row.appliedSeq)).toBe(true);

      const subscribers = await getCurrentSubscribers(app.db, page.id);
      const followers = await getFollowersForPage(app.db, page.id);
      expect(subscribers.rows).toHaveLength(1);
      expect(followers.rows).toHaveLength(1);

      const runRows = await testDb.db.select({
        stream: syncRuns.stream,
        status: syncRuns.outcome,
        startedAt: syncRuns.startedAt,
      }).from(syncRuns).orderBy(syncRuns.startedAt);
      expect(runRows).toHaveLength(8);
      expect(runRows.every((row) => row.status === "succeeded")).toBe(true);
      expect(runRows.map((row) => row.stream)).toEqual([
        "light",
        "transactions",
        "top_spenders",
        "subscribers",
        "followers",
        "followers_reconcile",
        "dm_conversations",
        "dm_messages",
      ]);
    } finally {
      abortController.abort();
      await executorPromise;
      await boss.stop();
      await app.close();
    }
  }, 30_000);

  it("serializes two direct Fansly pages on the same egress even with parallel workers", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "serial-fansly",
      name: "Serial Fansly",
    });
    const firstPage = await createFanslyLightPage(testDb, {
      modelId: model.id,
      label: "serial-a",
      authorization: "serial-a",
    });
    const secondPage = await createFanslyLightPage(testDb, {
      modelId: model.id,
      label: "serial-b",
      authorization: "serial-b",
    });
    const probe = createConcurrencyProbe();
    const app = createTestAppContext(testDb, {
      adapter: createInstrumentedFanslyLightAdapter(probe) as never,
      fanslyDefaultDelayMs: 1,
      syncPageExecutorConcurrency: 4,
      syncSharedRateLimitEnabled: true,
    });
    const boss = new PgBoss({ connectionString: testDb.connectionString });
    const abortController = new AbortController();

    await boss.start();
    await ensureSyncQueues(boss);
    const executorPromise = startSyncPageExecutor(app, boss, {
      signal: abortController.signal,
    });

    try {
      const firstRevisions = await requestLightSync(app, boss, {
        platformAccountId: firstPage.id,
        provider: "fansly",
      });
      const secondRevisions = await requestLightSync(app, boss, {
        platformAccountId: secondPage.id,
        provider: "fansly",
      });

      await Promise.all([
        waitForRequestedSyncRequests(app, {
          pageId: firstPage.id,
          requests: firstRevisions,
          timeoutMs: 10_000,
          pollMs: 50,
        }),
        waitForRequestedSyncRequests(app, {
          pageId: secondPage.id,
          requests: secondRevisions,
          timeoutMs: 10_000,
          pollMs: 50,
        }),
      ]);

      expect(probe.maxInFlight).toBe(1);
    } finally {
      abortController.abort();
      await executorPromise;
      await boss.stop();
      await app.close();
    }
  }, 20_000);

  it("overlaps pages on different egresses and across direct Fansly vs direct OnlyFans", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const fanslyModel = await createModel(testDb.db, {
      slug: "parallel-fansly",
      name: "Parallel Fansly",
    });
    const onlyFansModel = await createModel(testDb.db, {
      slug: "parallel-onlyfans",
      name: "Parallel OnlyFans",
    });
    const directFanslyPage = await createFanslyLightPage(testDb, {
      modelId: fanslyModel.id,
      label: "parallel-direct",
      authorization: "parallel-direct",
    });
    const proxiedFanslyPage = await createFanslyLightPage(testDb, {
      modelId: fanslyModel.id,
      label: "parallel-proxy",
      authorization: "parallel-proxy",
      proxyUrl: "socks5://proxy-parallel.example",
    });
    const onlyFansPage = await createOnlyFansLightPage(testDb, {
      modelId: onlyFansModel.id,
      label: "parallel-onlyfans",
      token: "parallel-onlyfans",
      accountId: 42,
    });
    const probe = createConcurrencyProbe();
    const app = createTestAppContext(testDb, {
      adapter: createInstrumentedFanslyLightAdapter(probe) as never,
      onlyFansAdapter: createInstrumentedOnlyFansLightAdapter(probe) as never,
      fanslyDefaultDelayMs: 1,
      onlyFansDefaultDelayMs: 1,
      syncPageExecutorConcurrency: 4,
      syncSharedRateLimitEnabled: true,
    });
    const boss = new PgBoss({ connectionString: testDb.connectionString });
    const abortController = new AbortController();

    await boss.start();
    await ensureSyncQueues(boss);
    const executorPromise = startSyncPageExecutor(app, boss, {
      signal: abortController.signal,
    });

    try {
      const directFanslyRevisions = await requestLightSync(app, boss, {
        platformAccountId: directFanslyPage.id,
        provider: "fansly",
      });
      const proxiedFanslyRevisions = await requestLightSync(app, boss, {
        platformAccountId: proxiedFanslyPage.id,
        provider: "fansly",
        proxyUrl: "socks5://proxy-parallel.example",
      });
      const onlyFansRevisions = await requestLightSync(app, boss, {
        platformAccountId: onlyFansPage.id,
        provider: "onlyfans",
      });

      await Promise.all([
        waitForRequestedSyncRequests(app, {
          pageId: directFanslyPage.id,
          requests: directFanslyRevisions,
          timeoutMs: 10_000,
          pollMs: 50,
        }),
        waitForRequestedSyncRequests(app, {
          pageId: proxiedFanslyPage.id,
          requests: proxiedFanslyRevisions,
          timeoutMs: 10_000,
          pollMs: 50,
        }),
        waitForRequestedSyncRequests(app, {
          pageId: onlyFansPage.id,
          requests: onlyFansRevisions,
          timeoutMs: 10_000,
          pollMs: 50,
        }),
      ]);

      expect(probe.maxInFlight).toBeGreaterThanOrEqual(2);
    } finally {
      abortController.abort();
      await executorPromise;
      await boss.stop();
      await app.close();
    }
  }, 20_000);
});
