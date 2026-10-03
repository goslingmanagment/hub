import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
  listPageSyncStates,
  requestPageSync as requestPageSyncRows,
  resolvePageSyncPriority,
  storePlatformCredentials,
  storeProxyConfig,
  updatePageMetadata,
} from "@agency_hub_core/db";
import { buildSyncPageExecuteGroupId, encryptJson } from "@agency_hub_core/shared";
import { PgBoss, type Db as PgBossDb } from "pg-boss";

import { runSyncPlannerCycle } from "../apps/runtime/src/services/sync/planner.ts";
import { requestPageSync } from "../apps/runtime/src/services/sync-control.ts";
import {
  ensureSyncQueues,
  sendSyncPageWakeup,
  SYNC_PAGE_EXECUTE_EXPIRE_SECONDS,
  SYNC_PAGE_EXECUTE_QUEUE,
  SYNC_PAGE_EXECUTE_RETRY_LIMIT,
  type SyncPageExecutePayload,
} from "../apps/runtime/src/services/sync-queue.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

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

  it("reconciles a pre-existing execute queue and pins new job options", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const boss = new PgBoss({ connectionString: testDb.connectionString });
    await boss.start();
    try {
      await boss.createQueue(SYNC_PAGE_EXECUTE_QUEUE, {
        policy: "exclusive",
        expireInSeconds: 180,
        heartbeatSeconds: 30,
        retryLimit: 2,
      });

      await ensureSyncQueues(boss);

      expect(await boss.getQueue(SYNC_PAGE_EXECUTE_QUEUE)).toMatchObject({
        policy: "exclusive",
        expireInSeconds: SYNC_PAGE_EXECUTE_EXPIRE_SECONDS,
        heartbeatSeconds: 30,
        retryLimit: SYNC_PAGE_EXECUTE_RETRY_LIMIT,
      });

      const jobId = await sendSyncPageWakeup(boss, {
        platformAccountId: 55,
        priority: 25,
        provider: "onlyfans",
        egressKey: "direct",
      });
      if (!jobId) {
        throw new Error("Expected a queued wakeup id");
      }
      const jobs = await boss.findJobs(SYNC_PAGE_EXECUTE_QUEUE, { id: jobId });
      expect(jobs[0]).toMatchObject({
        singletonKey: "55",
        expireInSeconds: SYNC_PAGE_EXECUTE_EXPIRE_SECONDS,
        retryLimit: SYNC_PAGE_EXECUTE_RETRY_LIMIT,
      });
    } finally {
      await boss.stop();
    }
  }, 30_000);

  it("hands a fixed singleton from parent to child in one pg transaction", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const boss = new PgBoss({ connectionString: testDb.connectionString });
    await boss.start();
    try {
      await ensureSyncQueues(boss);
      const parentId = await sendSyncPageWakeup(boss, {
        platformAccountId: 55,
        priority: 25,
        provider: "onlyfans",
        egressKey: "direct",
      });
      expect(parentId).toEqual(expect.any(String));
      const [parent] = await boss.fetch<{ platformAccountId: number }>(SYNC_PAGE_EXECUTE_QUEUE, {
        includeMetadata: true,
      });
      if (!parent) {
        throw new Error("Expected to fetch the parent wakeup");
      }

      await expect(sendSyncPageWakeup(boss, {
        platformAccountId: 55,
        priority: 25,
        provider: "onlyfans",
        egressKey: "direct",
      })).resolves.toBeNull();

      const client = await testDb.pool.connect();
      let committed = false;
      try {
        await client.query("begin");
        const db: PgBossDb = {
          executeSql: (text, values) => client.query(text, values),
        };
        const completed = await boss.complete(SYNC_PAGE_EXECUTE_QUEUE, parent.id, null, { db }) as unknown as {
          affected: number;
        };
        expect(completed.affected).toBe(1);
        const childId = await sendSyncPageWakeup(boss, {
          platformAccountId: 55,
          priority: 25,
          provider: "onlyfans",
          egressKey: "direct",
          db,
        });
        if (!childId) {
          throw new Error("Expected an atomic child wakeup id");
        }
        await client.query("commit");
        committed = true;

        const parentRows = await boss.findJobs(SYNC_PAGE_EXECUTE_QUEUE, { id: parent.id });
        const childRows = await boss.findJobs(SYNC_PAGE_EXECUTE_QUEUE, { id: childId });
        expect(parentRows[0]?.state).toBe("completed");
        expect(childRows[0]).toMatchObject({ state: "created", singletonKey: "55" });
      } finally {
        if (!committed) {
          await client.query("rollback").catch(() => undefined);
        }
        client.release();
      }
    } finally {
      await boss.stop();
    }
  }, 30_000);

  it("bounds a boosted page to one chunk before a queued egress peer runs", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const boss = new PgBoss({ connectionString: testDb.connectionString });
    await boss.start();
    try {
      await ensureSyncQueues(boss);
      const boostedParentId = await sendSyncPageWakeup(boss, {
        platformAccountId: 55,
        priority: resolvePageSyncPriority("dm_messages", "manual"),
        provider: "onlyfans",
        egressKey: "direct",
      });
      const waitingPeerId = await sendSyncPageWakeup(boss, {
        platformAccountId: 56,
        priority: resolvePageSyncPriority("dm_conversations", "scheduled"),
        provider: "onlyfans",
        egressKey: "direct",
      });
      expect(boostedParentId).toEqual(expect.any(String));
      expect(waitingPeerId).toEqual(expect.any(String));

      const fetchOptions = {
        batchSize: 1,
        includeMetadata: true,
        priority: false,
        orderByCreatedOn: true,
        groupConcurrency: 1,
      } as const;
      const [boostedParent] = await boss.fetch<SyncPageExecutePayload>(
        SYNC_PAGE_EXECUTE_QUEUE,
        fetchOptions,
      );
      expect(boostedParent).toMatchObject({
        id: boostedParentId,
        data: { platformAccountId: 55 },
        priority: resolvePageSyncPriority("dm_messages", "manual"),
      });
      if (!boostedParent) {
        throw new Error("Expected to fetch the boosted parent wakeup");
      }

      const client = await testDb.pool.connect();
      let committed = false;
      let continuationId: string | null = null;
      try {
        await client.query("begin");
        const db: PgBossDb = {
          executeSql: (text, values) => client.query(text, values),
        };
        const completed = await boss.complete(
          SYNC_PAGE_EXECUTE_QUEUE,
          boostedParent.id,
          null,
          { db },
        ) as unknown as { affected: number };
        expect(completed.affected).toBe(1);
        continuationId = await sendSyncPageWakeup(boss, {
          platformAccountId: 55,
          priority: resolvePageSyncPriority("dm_messages", "scheduled"),
          provider: "onlyfans",
          egressKey: "direct",
          db,
        });
        expect(continuationId).toEqual(expect.any(String));
        await client.query("commit");
        committed = true;
      } finally {
        if (!committed) {
          await client.query("rollback").catch(() => undefined);
        }
        client.release();
      }

      const [next] = await boss.fetch<SyncPageExecutePayload>(
        SYNC_PAGE_EXECUTE_QUEUE,
        fetchOptions,
      );
      expect(next).toMatchObject({
        id: waitingPeerId,
        data: { platformAccountId: 56 },
        priority: resolvePageSyncPriority("dm_conversations", "scheduled"),
      });
      if (!continuationId) {
        throw new Error("Expected a demoted continuation id");
      }
      const continuationRows = await boss.findJobs(SYNC_PAGE_EXECUTE_QUEUE, { id: continuationId });
      expect(continuationRows[0]).toMatchObject({
        state: "created",
        singletonKey: "55",
        priority: resolvePageSyncPriority("dm_messages", "scheduled"),
      });
    } finally {
      await boss.stop();
    }
  }, 30_000);

  it("keeps an older fixed singleton runnable when its durable priority is promoted", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const boss = new PgBoss({ connectionString: testDb.connectionString });
    await boss.start();
    try {
      await ensureSyncQueues(boss);
      const stalePriorityId = await sendSyncPageWakeup(boss, {
        platformAccountId: 55,
        priority: resolvePageSyncPriority("dm_messages", "scheduled"),
        provider: "onlyfans",
        egressKey: "direct",
      });
      expect(stalePriorityId).toEqual(expect.any(String));

      // This is the real collision: durable page state may now be manual,
      // while the one queued pg-boss row still carries its original 25.
      await expect(sendSyncPageWakeup(boss, {
        platformAccountId: 55,
        priority: resolvePageSyncPriority("dm_messages", "manual"),
        provider: "onlyfans",
        egressKey: "direct",
      })).resolves.toBeNull();

      const repeatingLivePageId = await sendSyncPageWakeup(boss, {
        platformAccountId: 56,
        priority: resolvePageSyncPriority("dm_conversations", "scheduled"),
        provider: "onlyfans",
        egressKey: "direct",
      });
      expect(repeatingLivePageId).toEqual(expect.any(String));

      const [next] = await boss.fetch<SyncPageExecutePayload>(SYNC_PAGE_EXECUTE_QUEUE, {
        batchSize: 1,
        includeMetadata: true,
        priority: false,
        orderByCreatedOn: true,
        groupConcurrency: 1,
      });
      expect(next).toMatchObject({
        id: stalePriorityId,
        data: { platformAccountId: 55 },
        priority: resolvePageSyncPriority("dm_messages", "scheduled"),
      });
    } finally {
      await boss.stop();
    }
  }, 30_000);

  it("converges multiple grandfathered parent keys into one fixed child", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const boss = new PgBoss({ connectionString: testDb.connectionString });
    await boss.start();
    try {
      await ensureSyncQueues(boss);
      const legacyOptions = (singletonKey: string) => ({
        singletonKey,
        priority: 25,
        expireInSeconds: 180,
        retryLimit: 2,
        group: { id: buildSyncPageExecuteGroupId("onlyfans", "direct") },
      });
      const firstLegacyId = await boss.send(
        SYNC_PAGE_EXECUTE_QUEUE,
        { platformAccountId: 55 },
        legacyOptions("55:continuation:first"),
      );
      const secondLegacyId = await boss.send(
        SYNC_PAGE_EXECUTE_QUEUE,
        { platformAccountId: 55 },
        legacyOptions("55:continuation:second"),
      );
      expect(firstLegacyId).toEqual(expect.any(String));
      expect(secondLegacyId).toEqual(expect.any(String));

      const fetchOptions = {
        batchSize: 1,
        includeMetadata: true,
        priority: false,
        orderByCreatedOn: true,
        groupConcurrency: 1,
      } as const;
      const rollForward = async (expectedParentId: string | null) => {
        const [parent] = await boss.fetch<SyncPageExecutePayload>(SYNC_PAGE_EXECUTE_QUEUE, fetchOptions);
        expect(parent?.id).toBe(expectedParentId);
        if (!parent) {
          throw new Error("Expected a grandfathered parent wakeup");
        }

        const client = await testDb!.pool.connect();
        let committed = false;
        try {
          await client.query("begin");
          const db: PgBossDb = {
            executeSql: (text, values) => client.query(text, values),
          };
          const completed = await boss.complete(
            SYNC_PAGE_EXECUTE_QUEUE,
            parent.id,
            null,
            { db },
          ) as unknown as { affected: number };
          expect(completed.affected).toBe(1);
          const childId = await sendSyncPageWakeup(boss, {
            platformAccountId: 55,
            priority: 25,
            provider: "onlyfans",
            egressKey: "direct",
            db,
          });
          await client.query("commit");
          committed = true;
          return childId;
        } finally {
          if (!committed) {
            await client.query("rollback").catch(() => undefined);
          }
          client.release();
        }
      };

      const fixedChildId = await rollForward(firstLegacyId);
      expect(fixedChildId).toEqual(expect.any(String));
      await expect(rollForward(secondLegacyId)).resolves.toBeNull();

      if (!fixedChildId) {
        throw new Error("Expected one fixed child id");
      }
      const fixedRows = await boss.findJobs(SYNC_PAGE_EXECUTE_QUEUE, { id: fixedChildId });
      expect(fixedRows[0]).toMatchObject({
        state: "created",
        singletonKey: "55",
        expireInSeconds: 900,
        retryLimit: 0,
      });
      const firstRows = await boss.findJobs(SYNC_PAGE_EXECUTE_QUEUE, { id: firstLegacyId ?? "" });
      const secondRows = await boss.findJobs(SYNC_PAGE_EXECUTE_QUEUE, { id: secondLegacyId ?? "" });
      expect(firstRows[0]?.state).toBe("completed");
      expect(secondRows[0]?.state).toBe("completed");
    } finally {
      await boss.stop();
    }
  }, 30_000);

  it("rolls both parent completion and child insertion back together", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const boss = new PgBoss({ connectionString: testDb.connectionString });
    await boss.start();
    try {
      await ensureSyncQueues(boss);
      await sendSyncPageWakeup(boss, {
        platformAccountId: 55,
        priority: 25,
        provider: "onlyfans",
        egressKey: "direct",
      });
      const [parent] = await boss.fetch<{ platformAccountId: number }>(SYNC_PAGE_EXECUTE_QUEUE, {
        includeMetadata: true,
      });
      if (!parent) {
        throw new Error("Expected to fetch the parent wakeup");
      }

      const client = await testDb.pool.connect();
      let childId: string | null = null;
      try {
        await client.query("begin");
        const db: PgBossDb = {
          executeSql: (text, values) => client.query(text, values),
        };
        const completed = await boss.complete(SYNC_PAGE_EXECUTE_QUEUE, parent.id, null, { db }) as unknown as {
          affected: number;
        };
        expect(completed.affected).toBe(1);
        const sent = await sendSyncPageWakeup(boss, {
          platformAccountId: 55,
          priority: 25,
          provider: "onlyfans",
          egressKey: "direct",
          db,
        });
        if (!sent) {
          throw new Error("Expected a transactional child wakeup id");
        }
        childId = sent;
        await client.query("rollback");
      } finally {
        await client.query("rollback").catch(() => undefined);
        client.release();
      }

      if (!childId) {
        throw new Error("Expected the rolled-back child id to be captured");
      }
      const parentRows = await boss.findJobs(SYNC_PAGE_EXECUTE_QUEUE, { id: parent.id });
      const childRows = await boss.findJobs(SYNC_PAGE_EXECUTE_QUEUE, { id: childId });
      expect(parentRows[0]?.state).toBe("active");
      expect(childRows).toHaveLength(0);
    } finally {
      await boss.stop();
    }
  }, 30_000);

  it("queues sync revisions when the page already has a follower sync timestamp", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // Step 4 (S4-10): the legacy executor serves OnlyFans pages only (a
    // Fansly page is refused: tests/sync-fansly-off-legacy.integration.test.ts).
    const model = await createModel(testDb.db, { slug: "follower-stamp", name: "Follower Stamp" });
    const page = await createOnlyFansLightPage(testDb, {
      modelId: model.id,
      label: "follower-stamp-of",
      token: "follower-stamp",
      accountId: 7,
    });
    await updatePageMetadata(testDb.db, page.id, {
      platformAccountIdValue: "of-7",
      username: "of_7",
      displayName: "OnlyFans 7",
      followerCount: 1,
      subscriberCount: 1,
      earningsBalanceMills: 0n,
      metadata: { onlyMonsterAccountId: 7, accountCreatedAt: "2026-01-01T00:00:00.000Z" },
      syncType: "followers",
    });

    const app = createTestAppContext(testDb, {
      databaseUrl: testDb.connectionString,
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
      expect(request.requests.map((entry) => entry.stream)).toEqual(["light", "transactions", "fan_identities"]);
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
    // Step 4 (S4-10): the planner serves OnlyFans pages only.
    const page = await createOnlyFansLightPage(testDb, {
      modelId: model.id,
      label: "planner-regression-page",
      token: "planner-regression",
      accountId: 11,
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
      platform: "onlyfans",
      priority: resolvePageSyncPriority("light", "manual"),
      proxyUrl,
      egressKey,
    });
    expect(pages[0]?.requestedAt?.toISOString()).toBe(now.toISOString());
    expect(boss.send).toHaveBeenCalledWith(
      SYNC_PAGE_EXECUTE_QUEUE,
      { platformAccountId: page.id },
      expect.objectContaining({
        singletonKey: String(page.id),
        priority: resolvePageSyncPriority("light", "manual"),
        expireInSeconds: SYNC_PAGE_EXECUTE_EXPIRE_SECONDS,
        retryLimit: SYNC_PAGE_EXECUTE_RETRY_LIMIT,
        group: {
          id: buildSyncPageExecuteGroupId("onlyfans", egressKey),
        },
      }),
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
    for (const [index, testCase] of cases.entries()) {
      // Step 4 (S4-10): the planner serves OnlyFans pages only.
      const page = await createOnlyFansLightPage(testDb, {
        modelId: model.id,
        label: testCase.label,
        token: testCase.label,
        accountId: 100 + index,
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
            id: buildSyncPageExecuteGroupId("onlyfans", expected?.expectedEgressKey ?? ""),
          },
        }),
      );
    }
  });
});
