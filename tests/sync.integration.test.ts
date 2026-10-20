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
import {
  ensureSyncQueues,
  sendSyncPageWakeup,
  SYNC_PAGE_EXECUTE_EXPIRE_SECONDS,
  SYNC_PAGE_EXECUTE_QUEUE,
  SYNC_PAGE_EXECUTE_RETRY_LIMIT,
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
      ...(input.rateLimitScopeKey === undefined ? {} : { rateLimitScopeKey: input.rateLimitScopeKey }),
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
});
