import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createOnlyFansPage,
  createFanslyPage,
  createModel,
  finishSyncRun,
  recalculateFanPageSpend,
  rebuildFollowerRollups,
  rebuildRevenueRollups,
  rebuildSubscriberRollups,
  startSyncRun,
  updatePageMetadata,
  upsertFanPage,
  upsertFans,
  upsertPageFollow,
  upsertPageSubscription,
  upsertTransaction,
} from "@agency_hub_core/db";
import { PgBoss } from "pg-boss";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { startSyncPageExecutor } from "../apps/runtime/src/services/sync/executor.ts";
import {
  SESSION_COOKIE_NAME,
  assignPageToUser,
  createUserAccount,
  issueChatterApiKey,
  setUserPassword,
  unassignPageFromUser,
} from "../apps/runtime/src/services/auth.ts";
import { getModelRevenueReport, getPageRevenueReport } from "../apps/runtime/src/services/reporting.ts";
import { ensureSyncQueues } from "../apps/runtime/src/services/sync-queue.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

async function seedPhase2Fixture(testDb: StartedTestDatabase) {
  const lanaModel = await createModel(testDb.db, {
    slug: "lana-model",
    name: "Lana Model",
  });
  const lilyModel = await createModel(testDb.db, {
    slug: "lily-model",
    name: "Lily Model",
  });
  const lanaPage = await createFanslyPage(testDb.db, {
    modelId: lanaModel.id,
    label: "lana",
  });
  const lilyPage = await createFanslyPage(testDb.db, {
    modelId: lilyModel.id,
    label: "lily1",
  });

  await updatePageMetadata(testDb.db, lanaPage.id, {
    platformAccountIdValue: "acct-lana",
    username: "lana_page",
    displayName: "Lana",
    followerCount: 1,
    subscriberCount: 1,
    earningsBalanceMills: 7000n,
    metadata: {},
    syncType: "light",
  });
  await updatePageMetadata(testDb.db, lilyPage.id, {
    platformAccountIdValue: "acct-lily",
    username: "lily_page",
    displayName: "Lily",
    followerCount: 0,
    subscriberCount: 0,
    earningsBalanceMills: 3000n,
    metadata: {},
    syncType: "light",
  });

  const [fan] = await upsertFans(testDb.db, [{
    platform: "fansly",
    platformUserId: "fan-001",
    username: "buyer",
    displayName: "Buyer One",
  }]);

  await upsertFanPage(testDb.db, {
    fanId: fan.id,
    platformAccountId: lanaPage.id,
    isFollower: true,
    followerSince: new Date("2026-03-02T12:00:00.000Z"),
    isSubscriber: true,
    subscriberSince: new Date("2026-03-01T12:00:00.000Z"),
    subscriptionExpiresAt: new Date("2026-03-20T12:00:00.000Z"),
    autoRenew: true,
  });
  await upsertFanPage(testDb.db, {
    fanId: fan.id,
    platformAccountId: lilyPage.id,
    isFollower: false,
    isSubscriber: false,
  });

  await upsertPageFollow(testDb.db, {
    platformAccountId: lanaPage.id,
    fanId: fan.id,
    platformFollowId: "follow-lana-1",
    followedAt: new Date("2026-03-02T12:00:00.000Z"),
  });
  await upsertPageSubscription(testDb.db, {
    platformSubscriptionId: "sub-lana-1",
    platformAccountId: lanaPage.id,
    fanId: fan.id,
    rawStatus: 3,
    canonicalStatus: "active",
    priceMills: 5000n,
    renewPriceMills: 5000n,
    autoRenew: true,
    sourceCreatedAt: new Date("2026-03-01T12:00:00.000Z"),
    endsAt: new Date("2026-03-20T12:00:00.000Z"),
  });

  await upsertTransaction(testDb.db, {
    platformAccountId: lanaPage.id,
    fanId: fan.id,
    transactionId: "tx-subscription",
    rawType: 15001,
    canonicalType: "subscription",
    transactionState: "posted",
    rawStatus: 2,
    grossAmountMills: 5000n,
    sourceDestinationAmountMills: 5000n,
    creatorNetAmountMills: 5000n,
    occurredAt: new Date("2026-03-05T12:00:00.000Z"),
  });
  await upsertTransaction(testDb.db, {
    platformAccountId: lanaPage.id,
    fanId: fan.id,
    transactionId: "tx-tip",
    rawType: 20001,
    canonicalType: "tip",
    transactionState: "pending",
    rawStatus: 1,
    grossAmountMills: 2000n,
    sourceDestinationAmountMills: 2000n,
    creatorNetAmountMills: 2000n,
    occurredAt: new Date("2026-03-06T12:00:00.000Z"),
  });
  await upsertTransaction(testDb.db, {
    platformAccountId: lanaPage.id,
    fanId: fan.id,
    transactionId: "tx-reversal",
    rawType: 16013,
    canonicalType: "payout_reversal",
    transactionState: "posted",
    rawStatus: 2,
    grossAmountMills: 900n,
    sourceDestinationAmountMills: 900n,
    creatorNetAmountMills: 900n,
    occurredAt: new Date("2026-03-07T12:00:00.000Z"),
  });
  await upsertTransaction(testDb.db, {
    platformAccountId: lilyPage.id,
    fanId: fan.id,
    transactionId: "tx-lily-tip",
    rawType: 20001,
    canonicalType: "tip",
    transactionState: "posted",
    rawStatus: 2,
    grossAmountMills: 3000n,
    sourceDestinationAmountMills: 3000n,
    creatorNetAmountMills: 3000n,
    occurredAt: new Date("2026-03-06T13:00:00.000Z"),
  });

  await rebuildRevenueRollups(testDb.db, lanaPage.id);
  await rebuildRevenueRollups(testDb.db, lilyPage.id);
  await rebuildFollowerRollups(testDb.db, lanaPage.id, 1);
  await rebuildSubscriberRollups(testDb.db, lanaPage.id);
  await recalculateFanPageSpend(testDb.db, lanaPage.id);
  await recalculateFanPageSpend(testDb.db, lilyPage.id);

  return {
    lanaModel,
    lanaPage,
    lilyPage,
  };
}

function sessionCookieFrom(response: { headers: Record<string, string | string[] | number | undefined> }) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || typeof value !== "string") {
    throw new Error("Expected set-cookie header");
  }
  return value.split(";")[0]!;
}

function createAutoSyncFanslyAdapter(input: {
  accountId: string;
  username: string;
  displayName: string | null;
}): AppContext["adapter"] {
  const accountMe = {
    account: {
      id: input.accountId,
      username: input.username,
      displayName: input.displayName,
      createdAt: 1_772_157_317_000,
      followCount: 0,
      subscriberCount: 0,
      earningsWallet: null,
      walls: [],
      subscriptionTiers: [],
    },
  };

  return {
    async verifySession() {
      return {
        parsed: accountMe,
        raw: accountMe,
      };
    },
    async getAccountMe() {
      return {
        parsed: accountMe,
        raw: accountMe,
      };
    },
    async getAccountsByIdsPage() {
      return {
        parsed: [],
        raw: [],
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
        total: 0,
        items: [],
        offset: 0,
        done: true,
        raw: {
          stats: {
            totalActive: 0,
            totalExpired: 0,
            total: 0,
          },
          subscriptions: [],
        },
      };
    },
    async getFollowersPage() {
      return {
        total: 0,
        items: [],
        offset: 0,
        done: true,
        accounts: [],
        raw: {
          followers: [],
          aggregationData: {
            accounts: [],
          },
        },
      };
    },
    async close() {},
  } as AppContext["adapter"];
}

async function waitForCondition(check: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }

    await sleep(100);
  }

  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

describe("api integration", () => {
  let testDb: StartedTestDatabase | null = null;
  let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
  let fixture: Awaited<ReturnType<typeof seedPhase2Fixture>> | null = null;
  let workerBoss: PgBoss | null = null;

  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  });

  afterAll(async () => {
    if (server) {
      await server.close();
    }
    if (testDb) {
      await testDb.stop();
    }
  });

  beforeEach(async () => {
    if (!testDb) {
      return;
    }

    await resetIntegrationDatabase(testDb.pool);

    const appContext = createTestAppContext(testDb);
    fixture = await seedPhase2Fixture(testDb);
    await createUserAccount(appContext, {
      username: "dima",
      role: "owner",
      password: "owner-secret",
    }, { source: "cli" });
    await createUserAccount(appContext, {
      username: "lead",
      role: "team_lead",
      password: "lead-secret",
    }, { source: "cli" });
    await assignPageToUser(appContext, {
      username: "lead",
      pageLabel: "lana",
    }, { source: "cli" });
    await createUserAccount(appContext, {
      username: "anton",
      role: "chatter",
    }, { source: "cli" });

    if (server) {
      await server.close();
    }
    server = await buildApiServer(appContext);
    await server.ready();
  });

  afterEach(async () => {
    if (workerBoss) {
      await workerBoss.stop();
      workerBoss = null;
    }
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("logs in with a cookie session and supports logout", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    expect(login.statusCode).toBe(200);
    expect(login.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME)?.value).toBeTruthy();
    expect(login.json()).toMatchObject({
      authMethod: "session",
      user: {
        username: "dima",
        role: "owner",
      },
    });

    const cookie = sessionCookieFrom(login);
    const me = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: {
        cookie,
      },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      authMethod: "session",
      user: {
        username: "dima",
      },
    });

    const badLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "wrong",
      },
    });
    expect(badLogin.statusCode).toBe(401);

    const logout = await server.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: {
        cookie,
      },
    });
    expect(logout.statusCode).toBe(200);

    const afterLogout = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: {
        cookie,
      },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("rate limits repeated login attempts", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: {
          username: "dima",
          password: "wrong",
        },
      });
      expect(response.statusCode).toBe(401);
    }

    const limited = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "wrong",
      },
    });

    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({
      error: "rate_limit_exceeded",
      message: "Too many login attempts",
      statusCode: 429,
    });
  });

  it("rejects expired sessions", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    await testDb.pool.query(`
      update auth_sessions
      set expires_at = now() - interval '1 day'
    `);

    const me = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: {
        cookie,
      },
    });
    expect(me.statusCode).toBe(401);
  });

  it("revokes live sessions when a password is reset", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    await setUserPassword(createTestAppContext(testDb), {
      username: "dima",
      password: "owner-secret-2",
    }, { source: "cli" });

    const me = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: {
        cookie,
      },
    });
    expect(me.statusCode).toBe(401);

    const oldPassword = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    expect(oldPassword.statusCode).toBe(401);

    const newPassword = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret-2",
      },
    });
    expect(newPassword.statusCode).toBe(200);
  });

  it("scopes chatter API keys to assigned pages", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const appContext = createTestAppContext(testDb);
    const { key } = await issueChatterApiKey(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });

    const allowed = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/fans",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().items).toHaveLength(1);

    const forbidden = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lily1/fans",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(forbidden.statusCode).toBe(403);

    const overview = await server.inject({
      method: "GET",
      url: "/api/v1/overview/revenue?period=custom&from=2026-03-01&to=2026-03-31",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(overview.statusCode).toBe(403);
  });

  it("uses one chatter API key across current page assignments", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const appContext = createTestAppContext(testDb);
    await assignPageToUser(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });
    await assignPageToUser(appContext, {
      username: "anton",
      pageLabel: "lily1",
    }, { source: "cli" });

    const { key } = await issueChatterApiKey(appContext, {
      username: "anton",
    }, { source: "cli" });

    const authMe = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(authMe.statusCode).toBe(200);
    expect(authMe.json().user.assignedPages.map((page: { label: string }) => page.label)).toEqual([
      "lana",
      "lily1",
    ]);

    const lana = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/fans",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(lana.statusCode).toBe(200);

    const lily = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lily1/fans",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(lily.statusCode).toBe(200);

    await unassignPageFromUser(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });

    const lanaAfterUnassign = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/fans",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(lanaAfterUnassign.statusCode).toBe(403);

    const lilyAfterUnassign = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lily1/fans",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(lilyAfterUnassign.statusCode).toBe(200);
  });

  it("issues a user key without changing assignments when no page is provided", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const appContext = createTestAppContext(testDb);
    const { key } = await issueChatterApiKey(appContext, {
      username: "anton",
    }, { source: "cli" });

    const me = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.assignedPages).toEqual([]);

    const forbidden = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/fans",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("matches page revenue service output with explicit revenue buckets", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    await upsertTransaction(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      fanId: null,
      transactionId: "tx-chargeback",
      rawType: 99901,
      canonicalType: "chargeback",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: -1000n,
      sourceDestinationAmountMills: -1000n,
      creatorNetAmountMills: -1000n,
      occurredAt: new Date("2026-03-08T12:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      fanId: null,
      transactionId: "tx-other",
      rawType: 18001,
      canonicalType: "other",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 300n,
      sourceDestinationAmountMills: 300n,
      creatorNetAmountMills: 300n,
      occurredAt: new Date("2026-03-09T12:00:00.000Z"),
    });
    await rebuildRevenueRollups(testDb.db, fixture.lanaPage.id);

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/revenue?period=custom&from=2026-03-01&to=2026-03-31",
      headers: {
        cookie,
      },
    });
    expect(response.statusCode).toBe(200);

    const expected = await getPageRevenueReport(createTestAppContext(testDb), "lana", {
      period: "custom",
      custom: {
        from: "2026-03-01",
        to: "2026-03-31",
      },
    });

    expect(response.json()).toMatchObject({
      revenueMills: expected.revenueMills,
      adjustmentMills: expected.adjustmentMills,
      unclassifiedMills: expected.unclassifiedMills,
      netEarningsMills: expected.netEarningsMills,
      totalNetMills: expected.totalNetMills,
      breakdown: expected.breakdown,
    });
    expect(response.json().revenueMills).toBe(7000);
    expect(response.json().adjustmentMills).toBe(-1000);
    expect(response.json().unclassifiedMills).toBe(300);
    expect(response.json().netEarningsMills).toBe(6300);
    expect(response.json().totalNetMills).toBe(response.json().netEarningsMills);
    expect(response.json().breakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({
        canonicalType: "chargeback",
        bucket: "adjustment",
        netAmountMills: -1000,
      }),
      expect.objectContaining({
        canonicalType: "other",
        bucket: "unclassified",
        netAmountMills: 300,
      }),
    ]));
    expect(response.json().breakdown.some((row: { canonicalType: string }) => row.canonicalType === "payout_reversal")).toBe(false);
  });

  it("combines Fansly and OnlyFans revenue in model reports", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const onlyFansPage = await createOnlyFansPage(testDb.db, {
      modelId: fixture.lanaModel.id,
      label: "lana-of",
    });
    await updatePageMetadata(testDb.db, onlyFansPage.id, {
      platformAccountIdValue: "of-acct-42",
      username: "lana_of",
      displayName: "Lana OF",
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: {
        onlyMonsterAccountId: 42,
      },
      syncType: "light",
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      transactionId: "of-tip-1",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "loading",
      grossAmountMills: 12000n,
      sourceDestinationAmountMills: 12000n,
      creatorNetAmountMills: 12000n,
      occurredAt: new Date("2026-03-05T15:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      transactionId: "of-cb-1",
      rawType: "Tip from",
      canonicalType: "chargeback",
      transactionState: "posted",
      rawStatus: "undo",
      grossAmountMills: -2000n,
      sourceDestinationAmountMills: -2000n,
      creatorNetAmountMills: -2000n,
      occurredAt: new Date("2026-03-06T15:00:00.000Z"),
    });
    await rebuildRevenueRollups(testDb.db, onlyFansPage.id);

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/models/lana-model/revenue?period=custom&from=2026-03-01&to=2026-03-31",
      headers: {
        cookie,
      },
    });
    expect(response.statusCode).toBe(200);

    const expected = await getModelRevenueReport(createTestAppContext(testDb), "lana-model", {
      period: "custom",
      custom: {
        from: "2026-03-01",
        to: "2026-03-31",
      },
    });

    expect(response.json()).toMatchObject({
      revenueMills: expected.revenueMills,
      adjustmentMills: expected.adjustmentMills,
      unclassifiedMills: expected.unclassifiedMills,
      netEarningsMills: expected.netEarningsMills,
      totalNetMills: expected.totalNetMills,
      breakdown: expected.breakdown,
      pages: expect.arrayContaining([
        expect.objectContaining({
          pageLabel: "lana",
          netEarningsMills: 7000,
          totalNetMills: 7000,
        }),
        expect.objectContaining({
          pageLabel: "lana-of",
          netEarningsMills: 10000,
          totalNetMills: 10000,
        }),
      ]),
    });
  });

  it("merges and sorts overview revenue daily rows across platforms", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const onlyFansPage = await createOnlyFansPage(testDb.db, {
      modelId: fixture.lanaModel.id,
      label: "lana-daily-of",
    });
    await updatePageMetadata(testDb.db, onlyFansPage.id, {
      platformAccountIdValue: "of-daily-42",
      username: "lana_daily_of",
      displayName: "Lana Daily OF",
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: {
        onlyMonsterAccountId: 44,
      },
      syncType: "light",
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      transactionId: "of-daily-tip-1",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 4000n,
      sourceDestinationAmountMills: 4000n,
      creatorNetAmountMills: 4000n,
      occurredAt: new Date("2026-03-06T15:00:00.000Z"),
    });
    await rebuildRevenueRollups(testDb.db, onlyFansPage.id);

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const summarySeries = await server.inject({
      method: "GET",
      url: "/api/v1/overview/revenue/daily?period=30d",
      headers: { cookie },
    });
    expect(summarySeries.statusCode).toBe(200);
    expect(summarySeries.json().series).toEqual([
      {
        businessDate: "2026-03-05",
        netAmountMills: 5000,
        transactionCount: 1,
      },
      {
        businessDate: "2026-03-06",
        netAmountMills: 9000,
        transactionCount: 3,
      },
    ]);

    const groupedSeries = await server.inject({
      method: "GET",
      url: "/api/v1/overview/revenue/daily?period=30d&groupByType=true",
      headers: { cookie },
    });
    expect(groupedSeries.statusCode).toBe(200);
    expect(groupedSeries.json().series).toEqual([
      {
        businessDate: "2026-03-05",
        canonicalType: "subscription",
        netAmountMills: 5000,
        transactionCount: 1,
      },
      {
        businessDate: "2026-03-06",
        canonicalType: "tip",
        netAmountMills: 9000,
        transactionCount: 3,
      },
    ]);
  });

  it("returns merged mixed-platform bounds in model reports", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const onlyFansPage = await createOnlyFansPage(testDb.db, {
      modelId: fixture.lanaModel.id,
      label: "lana-of-bounds",
    });
    await updatePageMetadata(testDb.db, onlyFansPage.id, {
      platformAccountIdValue: "of-bounds-42",
      username: "lana_of_bounds",
      displayName: "Lana OF Bounds",
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: {
        onlyMonsterAccountId: 43,
      },
      syncType: "light",
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      transactionId: "of-bounds-tip-1",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "loading",
      grossAmountMills: 1000n,
      sourceDestinationAmountMills: 1000n,
      creatorNetAmountMills: 1000n,
      occurredAt: new Date("2026-03-05T15:00:00.000Z"),
    });
    await rebuildRevenueRollups(testDb.db, onlyFansPage.id);

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/models/lana-model/revenue?period=custom&from=2026-03-01&to=2026-03-31",
      headers: {
        cookie,
      },
    });
    expect(response.statusCode).toBe(200);

    const expected = await getModelRevenueReport(createTestAppContext(testDb), "lana-model", {
      period: "custom",
      custom: {
        from: "2026-03-01",
        to: "2026-03-31",
      },
    });

    expect(response.json()).toMatchObject({
      from: expected.from,
      to: expected.to,
      comparison: expected.comparison
        ? {
          from: expected.comparison.from,
          to: expected.comparison.to,
        }
        : null,
    });
  });

  it("uses UTC day boundaries for OnlyFans 30d revenue and rollups", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "utc-boundary-model",
      name: "UTC Boundary Model",
    });
    const onlyFansPage = await createOnlyFansPage(testDb.db, {
      modelId: model.id,
      label: "utc-boundary-of",
    });

    await updatePageMetadata(testDb.db, onlyFansPage.id, {
      platformAccountIdValue: "of-boundary-1",
      username: "utc_boundary",
      displayName: "UTC Boundary",
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: {
        onlyMonsterAccountId: 404,
      },
      syncType: "light",
    });

    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      transactionId: "before-window",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 500n,
      sourceDestinationAmountMills: 500n,
      creatorNetAmountMills: 500n,
      occurredAt: new Date("2026-02-06T23:59:59.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      transactionId: "utc-0010",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 1000n,
      sourceDestinationAmountMills: 1000n,
      creatorNetAmountMills: 1000n,
      occurredAt: new Date("2026-02-07T00:10:15.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      transactionId: "utc-2059",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 2000n,
      sourceDestinationAmountMills: 2000n,
      creatorNetAmountMills: 2000n,
      occurredAt: new Date("2026-02-07T20:59:59.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      transactionId: "utc-2100",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 3000n,
      sourceDestinationAmountMills: 3000n,
      creatorNetAmountMills: 3000n,
      occurredAt: new Date("2026-02-07T21:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      transactionId: "after-window",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 4000n,
      sourceDestinationAmountMills: 4000n,
      creatorNetAmountMills: 4000n,
      occurredAt: new Date("2026-03-10T00:00:00.000Z"),
    });

    await rebuildRevenueRollups(testDb.db, onlyFansPage.id);

    const report = await getPageRevenueReport(createTestAppContext(testDb), onlyFansPage.label, {
      period: "30d",
      now: new Date("2026-03-09T12:00:00.000Z"),
    });
    const rollupRows = await testDb.pool.query(`
      select business_date::text as business_date,
             creator_net_amount_mills as net_amount_mills
      from daily_revenue
      where platform_account_id = ${onlyFansPage.id}
      order by business_date asc
    `);

    expect(report.from).toBe("2026-02-07T00:00:00.000Z");
    expect(report.to).toBe("2026-03-10T00:00:00.000Z");
    expect(report.revenueMills).toBe(6000);
    expect(report.adjustmentMills).toBe(0);
    expect(report.unclassifiedMills).toBe(0);
    expect(report.netEarningsMills).toBe(6000);
    expect(report.totalNetMills).toBe(6000);
    expect(report.totalNetMills).toBe(report.netEarningsMills);
    expect(report.breakdown).toEqual([
      {
        canonicalType: "tip",
        bucket: "revenue",
        netAmountMills: 6000,
      },
    ]);
    expect(rollupRows.rows).toEqual([
      {
        business_date: "2026-02-06",
        net_amount_mills: 500n,
      },
      {
        business_date: "2026-02-07",
        net_amount_mills: 6000n,
      },
      {
        business_date: "2026-03-10",
        net_amount_mills: 4000n,
      },
    ]);
  });

  it("uses UTC day boundaries for Fansly December 2025 revenue and spender reporting", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-001",
      username: "buyer",
      displayName: "Buyer One",
    }]);

    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: fixture.lilyPage.id,
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: fixture.lilyPage.id,
      fanId: fan.id,
      transactionId: "lily-december-main",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 350376n,
      sourceDestinationAmountMills: 350376n,
      creatorNetAmountMills: 350376n,
      occurredAt: new Date("2025-12-15T12:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: fixture.lilyPage.id,
      fanId: fan.id,
      transactionId: "lily-boundary-november",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 8000n,
      sourceDestinationAmountMills: 8000n,
      creatorNetAmountMills: 8000n,
      occurredAt: new Date("2025-11-30T21:30:00.000Z"),
    });

    await rebuildRevenueRollups(testDb.db, fixture.lilyPage.id);
    await recalculateFanPageSpend(testDb.db, fixture.lilyPage.id);

    const report = await getPageRevenueReport(createTestAppContext(testDb), fixture.lilyPage.label, {
      period: "custom",
      custom: {
        from: "2025-12-01",
        to: "2025-12-31",
      },
    });
    const modelReport = await getModelRevenueReport(createTestAppContext(testDb), "lily-model", {
      period: "custom",
      custom: {
        from: "2025-12-01",
        to: "2025-12-31",
      },
    });
    const rollupRows = await testDb.pool.query(`
      select business_date::text as business_date,
             creator_net_amount_mills as net_amount_mills
      from daily_revenue
      where platform_account_id = ${fixture.lilyPage.id}
        and business_date between '2025-11-30'::date and '2025-12-31'::date
      order by business_date asc
    `);

    expect(report.from).toBe("2025-12-01T00:00:00.000Z");
    expect(report.to).toBe("2026-01-01T00:00:00.000Z");
    expect(report.revenueMills).toBe(350376);
    expect(report.netEarningsMills).toBe(350376);
    expect(report.totalNetMills).toBe(350376);
    expect(modelReport.netEarningsMills).toBe(350376);
    expect(modelReport.totalNetMills).toBe(350376);
    expect(rollupRows.rows).toEqual([
      {
        business_date: "2025-11-30",
        net_amount_mills: 8000n,
      },
      {
        business_date: "2025-12-15",
        net_amount_mills: 350376n,
      },
    ]);

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);
    const spenderList = await server.inject({
      method: "GET",
      url: "/api/v2/spenders?scope=page&pageLabel=lily1&period=custom&from=2025-12-01&to=2025-12-31&limit=10&offset=0",
      headers: {
        cookie: ownerCookie,
      },
    });
    const spenderSeries = await server.inject({
      method: "GET",
      url: "/api/v2/spenders/fansly/fan-001/series?scope=page&pageLabel=lily1&period=custom&from=2025-11-30&to=2025-12-01&granularity=day",
      headers: {
        cookie: ownerCookie,
      },
    });

    expect(spenderList.statusCode).toBe(200);
    expect(spenderList.json()).toMatchObject({
      period: {
        timeZone: "UTC",
        fromBusinessDate: "2025-12-01",
        toBusinessDateInclusive: "2025-12-31",
      },
      diagnostics: {
        totalCreatorNetAmountMills: 350376,
        attributedCreatorNetAmountMills: 350376,
        unattributedCreatorNetAmountMills: 0,
      },
      items: [
        {
          fan: {
            platform: "fansly",
            platformUserId: "fan-001",
          },
          metrics: {
            window: {
              creatorNetAmountMills: 350376,
              grossAmountMills: 350376,
            },
          },
        },
      ],
    });

    expect(spenderSeries.statusCode).toBe(200);
    expect(spenderSeries.json()).toMatchObject({
      period: {
        timeZone: "UTC",
        fromBusinessDate: "2025-11-30",
        toBusinessDateInclusive: "2025-12-01",
      },
      items: [
        {
          fromBusinessDate: "2025-11-30",
          toBusinessDateInclusive: "2025-11-30",
          metrics: {
            creatorNetAmountMills: 8000,
            grossAmountMills: 8000,
          },
        },
        {
          fromBusinessDate: "2025-12-01",
          toBusinessDateInclusive: "2025-12-01",
          metrics: {
            creatorNetAmountMills: 0,
            grossAmountMills: 0,
          },
        },
      ],
    });
  });

  it("uses occurred_at instead of transactions.created_at in revenue and page transaction reporting", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const createdAtPage = await createFanslyPage(testDb.db, {
      modelId: fixture.lanaModel.id,
      label: "created-at-check",
    });
    await updatePageMetadata(testDb.db, createdAtPage.id, {
      platformAccountIdValue: "acct-created-at-check",
      username: "created_at_check",
      displayName: "Created At Check",
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: {},
      syncType: "light",
    });

    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-created-at",
      username: "created-at-fan",
      displayName: "Created At Fan",
    }]);
    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: createdAtPage.id,
      isFollower: false,
      isSubscriber: false,
    });

    await upsertTransaction(testDb.db, {
      platformAccountId: createdAtPage.id,
      fanId: fan.id,
      transactionId: "tx-newer-occurred",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 2000n,
      sourceDestinationAmountMills: 2000n,
      creatorNetAmountMills: 2000n,
      occurredAt: new Date("2026-03-05T12:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: createdAtPage.id,
      fanId: fan.id,
      transactionId: "tx-older-occurred",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 1000n,
      sourceDestinationAmountMills: 1000n,
      creatorNetAmountMills: 1000n,
      occurredAt: new Date("2026-01-15T12:00:00.000Z"),
    });

    await testDb.pool.query(
      `
        update transactions
        set created_at = $1
        where platform_account_id = $2
      `,
      [new Date("2026-04-01T00:00:00.000Z"), createdAtPage.id],
    );

    await rebuildRevenueRollups(testDb.db, createdAtPage.id);
    await recalculateFanPageSpend(testDb.db, createdAtPage.id);

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const revenue = await server.inject({
      method: "GET",
      url: "/api/v1/pages/created-at-check/revenue?period=custom&from=2026-03-01&to=2026-03-31",
      headers: {
        cookie,
      },
    });
    expect(revenue.statusCode).toBe(200);
    expect(revenue.json().totalNetMills).toBe(2000);
    expect(revenue.json().breakdown).toEqual([
      {
        bucket: "revenue",
        canonicalType: "tip",
        netAmountMills: 2000,
      },
    ]);

    const transactions = await server.inject({
      method: "GET",
      url: "/api/v1/pages/created-at-check/transactions?limit=10&offset=0",
      headers: {
        cookie,
      },
    });
    expect(transactions.statusCode).toBe(200);
    expect(transactions.json().items.map((row: { transactionId: string }) => row.transactionId)).toEqual([
      "tx-newer-occurred",
      "tx-older-occurred",
    ]);

    const fans = await server.inject({
      method: "GET",
      url: "/api/v1/pages/created-at-check/fans?limit=10&offset=0",
      headers: {
        cookie,
      },
    });
    expect(fans.statusCode).toBe(200);
    expect(fans.json().items[0]).toMatchObject({
      platformUserId: "fan-created-at",
      totalCreatorNetMills: 3000,
      lastTransactionAt: "2026-03-05T12:00:00.000Z",
    });
  });

  it("lists payout reversals in the transaction ledger", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const allTransactions = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/transactions?limit=10&offset=0",
      headers: {
        cookie,
      },
    });
    expect(allTransactions.statusCode).toBe(200);
    expect(allTransactions.json().items.some((row: { canonicalType: string }) => row.canonicalType === "payout_reversal")).toBe(true);

    const reversalsOnly = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/transactions?limit=10&offset=0&type=payout_reversal",
      headers: {
        cookie,
      },
    });
    expect(reversalsOnly.statusCode).toBe(200);
    expect(reversalsOnly.json().items).toHaveLength(1);
    expect(reversalsOnly.json().items[0]?.transactionId).toBe("tx-reversal");
  });

  it("rejects invalid custom period requests with 400 responses", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const missingDates = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/revenue?period=custom",
      headers: {
        cookie,
      },
    });
    expect(missingDates.statusCode).toBe(400);

    const malformedDate = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/revenue?period=custom&from=2026-02-30&to=2026-03-01",
      headers: {
        cookie,
      },
    });
    expect(malformedDate.statusCode).toBe(400);

    const reversedRange = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/revenue?period=custom&from=2026-03-10&to=2026-03-01",
      headers: {
        cookie,
      },
    });
    expect(reversedRange.statusCode).toBe(400);
  });

  it("limits cross-page fan visibility for team leads and exposes full scope for owners", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const leadLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "lead",
        password: "lead-secret",
      },
    });
    const leadCookie = sessionCookieFrom(leadLogin);

    const leadFan = await server.inject({
      method: "GET",
      url: "/api/v1/fans/fansly/fan-001",
      headers: {
        cookie: leadCookie,
      },
    });
    expect(leadFan.statusCode).toBe(200);
    expect(leadFan.json()).toMatchObject({
      platformTotalSpendMills: 7000,
    });
    expect(leadFan.json().pages).toHaveLength(1);
    expect(leadFan.json().pages[0]?.pageLabel).toBe("lana");

    const deniedPage = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lily1/fans/fan-001",
      headers: {
        cookie: leadCookie,
      },
    });
    expect(deniedPage.statusCode).toBe(403);

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);
    const ownerFan = await server.inject({
      method: "GET",
      url: "/api/v1/fans/fansly/fan-001",
      headers: {
        cookie: ownerCookie,
      },
    });
    expect(ownerFan.statusCode).toBe(200);
    expect(ownerFan.json().pages).toHaveLength(2);
  });

  it("lists v2 spenders with scoped diagnostics and no hidden-page leakage", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await upsertTransaction(testDb.db, {
      platformAccountId: fixture!.lanaPage.id,
      fanId: null,
      transactionId: "tx-unattributed-v2",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 500n,
      sourceDestinationAmountMills: 500n,
      creatorNetAmountMills: 500n,
      occurredAt: new Date("2026-03-06T18:00:00.000Z"),
    });
    await rebuildRevenueRollups(testDb.db, fixture!.lanaPage.id);
    await testDb.pool.query(`
      insert into daily_revenue (
        platform_account_id,
        business_date,
        canonical_type,
        transaction_state,
        transaction_count,
        gross_amount_mills,
        creator_net_amount_mills,
        updated_at
      )
      values (
        ${fixture!.lanaPage.id},
        '2026-03-06',
        'payout_reversal'::transaction_type,
        'posted'::transaction_state,
        1,
        2000,
        2000,
        now()
      )
    `);

    const leadLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "lead",
        password: "lead-secret",
      },
    });
    const leadCookie = sessionCookieFrom(leadLogin);

    const response = await server.inject({
      method: "GET",
      url: "/api/v2/spenders?scope=agency&platform=fansly&period=30d&limit=10&offset=0",
      headers: {
        cookie: leadCookie,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scope: {
        kind: "agency",
        platform: "fansly",
        pageCount: 1,
      },
      diagnostics: {
        totalGrossAmountMills: 7500,
        totalCreatorNetAmountMills: 7500,
        attributedGrossAmountMills: 7000,
        attributedCreatorNetAmountMills: 7000,
        unattributedGrossAmountMills: 500,
        unattributedCreatorNetAmountMills: 500,
      },
      items: [
        {
          fan: {
            platform: "fansly",
            platformUserId: "fan-001",
            username: "buyer",
            displayName: "Buyer One",
          },
          metrics: {
            window: {
              grossAmountMills: 7000,
              creatorNetAmountMills: 7000,
              postedGrossAmountMills: 5000,
              pendingGrossAmountMills: 2000,
              unknownGrossAmountMills: 0,
              postedCreatorNetAmountMills: 5000,
              pendingCreatorNetAmountMills: 2000,
              unknownCreatorNetAmountMills: 0,
              transactionCount: 2,
            },
            lifetime: {
              scopeGrossAmountMills: 7000,
              scopeCreatorNetAmountMills: 7000,
              platformGrossAmountMills: 7000,
              platformCreatorNetAmountMills: 7000,
            },
          },
        },
      ],
      total: 1,
    });
    expect(response.json().period.timeZone).toBe("UTC");
    expect(response.json().period.asOf).toBeTruthy();
    expect(response.json().items[0].fan.fanId).toBeUndefined();
  });

  it("lists v2 spenders with page-scope lifetime totals and visible-platform lifetime totals", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    const response = await server.inject({
      method: "GET",
      url: "/api/v2/spenders?scope=page&pageLabel=lana&platform=fansly&period=30d&limit=10&offset=0",
      headers: {
        cookie: ownerCookie,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toMatchObject({
      fan: {
        platformUserId: "fan-001",
      },
      metrics: {
        lifetime: {
          scopeGrossAmountMills: 7000,
          scopeCreatorNetAmountMills: 7000,
          platformGrossAmountMills: 10000,
          platformCreatorNetAmountMills: 10000,
        },
      },
    });
  });

  it("serves v2 spender detail with visible-platform totals and scoped page breakdowns", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const expectedTypeBreakdown = [
      {
        canonicalType: "subscription",
        grossAmountMills: 5000,
        creatorNetAmountMills: 5000,
        transactionCount: 1,
      },
      {
        canonicalType: "tip",
        grossAmountMills: 2000,
        creatorNetAmountMills: 2000,
        transactionCount: 1,
      },
    ];

    const leadLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "lead",
        password: "lead-secret",
      },
    });
    const leadCookie = sessionCookieFrom(leadLogin);
    const leadResponse = await server.inject({
      method: "GET",
      url: "/api/v2/spenders/fansly/fan-001?scope=page&pageLabel=lana&period=30d",
      headers: {
        cookie: leadCookie,
      },
    });

    expect(leadResponse.statusCode).toBe(200);
    expect(leadResponse.json()).toMatchObject({
      scope: {
        kind: "page",
        platform: "fansly",
      },
      metrics: {
        lifetime: {
          scopeGrossAmountMills: 7000,
          scopeCreatorNetAmountMills: 7000,
          platformGrossAmountMills: 7000,
          platformCreatorNetAmountMills: 7000,
        },
      },
      typeBreakdown: expectedTypeBreakdown,
    });
    expect(leadResponse.json().pages).toHaveLength(1);
    expect(leadResponse.json().pages[0]).toMatchObject({
      pageLabel: "lana",
      inScope: true,
      creatorNetAmountMills: 7000,
    });
    expect(leadResponse.json().typeBreakdown.some((row: { canonicalType: string }) => row.canonicalType === "payout_reversal")).toBe(false);

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);
    const ownerResponse = await server.inject({
      method: "GET",
      url: "/api/v2/spenders/fansly/fan-001?scope=page&pageLabel=lana&period=30d",
      headers: {
        cookie: ownerCookie,
      },
    });

    expect(ownerResponse.statusCode).toBe(200);
    expect(ownerResponse.json().metrics.lifetime).toMatchObject({
      scopeGrossAmountMills: 7000,
      scopeCreatorNetAmountMills: 7000,
      platformGrossAmountMills: 10000,
      platformCreatorNetAmountMills: 10000,
    });
    expect(ownerResponse.json().typeBreakdown).toEqual(expectedTypeBreakdown);
    expect(ownerResponse.json().pages).toHaveLength(2);
    expect(ownerResponse.json().pages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pageLabel: "lana",
        inScope: true,
        creatorNetAmountMills: 7000,
      }),
      expect.objectContaining({
        pageLabel: "lily1",
        inScope: false,
        creatorNetAmountMills: 3000,
      }),
    ]));
    expect(ownerResponse.json().typeBreakdown.some((row: { canonicalType: string }) => row.canonicalType === "payout_reversal")).toBe(false);
    expect(ownerResponse.json().fan.fanId).toBeUndefined();
  });

  it("returns zero-filled v2 spender day series buckets", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);
    const response = await server.inject({
      method: "GET",
      url: "/api/v2/spenders/fansly/fan-001/series?scope=page&pageLabel=lana&period=custom&from=2026-03-04&to=2026-03-07&granularity=day",
      headers: {
        cookie: ownerCookie,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      granularity: "day",
      period: {
        timeZone: "UTC",
        fromBusinessDate: "2026-03-04",
        toBusinessDateInclusive: "2026-03-07",
      },
    });
    expect(response.json().items).toEqual([
      {
        fromBusinessDate: "2026-03-04",
        toBusinessDateInclusive: "2026-03-04",
        metrics: {
          grossAmountMills: 0,
          creatorNetAmountMills: 0,
          postedGrossAmountMills: 0,
          pendingGrossAmountMills: 0,
          unknownGrossAmountMills: 0,
          postedCreatorNetAmountMills: 0,
          pendingCreatorNetAmountMills: 0,
          unknownCreatorNetAmountMills: 0,
          transactionCount: 0,
          lastTransactionAt: null,
        },
      },
      {
        fromBusinessDate: "2026-03-05",
        toBusinessDateInclusive: "2026-03-05",
        metrics: {
          grossAmountMills: 5000,
          creatorNetAmountMills: 5000,
          postedGrossAmountMills: 5000,
          pendingGrossAmountMills: 0,
          unknownGrossAmountMills: 0,
          postedCreatorNetAmountMills: 5000,
          pendingCreatorNetAmountMills: 0,
          unknownCreatorNetAmountMills: 0,
          transactionCount: 1,
          lastTransactionAt: "2026-03-05T12:00:00.000Z",
        },
      },
      {
        fromBusinessDate: "2026-03-06",
        toBusinessDateInclusive: "2026-03-06",
        metrics: {
          grossAmountMills: 2000,
          creatorNetAmountMills: 2000,
          postedGrossAmountMills: 0,
          pendingGrossAmountMills: 2000,
          unknownGrossAmountMills: 0,
          postedCreatorNetAmountMills: 0,
          pendingCreatorNetAmountMills: 2000,
          unknownCreatorNetAmountMills: 0,
          transactionCount: 1,
          lastTransactionAt: "2026-03-06T12:00:00.000Z",
        },
      },
      {
        fromBusinessDate: "2026-03-07",
        toBusinessDateInclusive: "2026-03-07",
        metrics: {
          grossAmountMills: 0,
          creatorNetAmountMills: 0,
          postedGrossAmountMills: 0,
          pendingGrossAmountMills: 0,
          unknownGrossAmountMills: 0,
          postedCreatorNetAmountMills: 0,
          pendingCreatorNetAmountMills: 0,
          unknownCreatorNetAmountMills: 0,
          transactionCount: 0,
          lastTransactionAt: null,
        },
      },
    ]);
  });

  it("supports alias-aware v2 fan search and page-scoped bearer batch lookups", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-001",
      username: "spender-renamed",
      displayName: "Renamed Fan",
    }]);

    const appContext = createTestAppContext(testDb);
    const { key } = await issueChatterApiKey(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });

    const search = await server.inject({
      method: "GET",
      url: "/api/v2/fans/search?scope=page&pageLabel=lana&query=buyer&limit=10&offset=0",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });

    expect(search.statusCode).toBe(200);
    expect(search.json()).toMatchObject({
      scope: {
        kind: "page",
        platform: "fansly",
      },
      items: [
        {
          fan: {
            platform: "fansly",
            platformUserId: "fan-001",
            username: "spender-renamed",
            displayName: "Renamed Fan",
          },
          matchKind: "alias",
          matchedValue: "buyer",
        },
      ],
    });
    expect(search.json().items[0].fan.fanId).toBeUndefined();
    expect(search.json().items[0].metrics).toBeUndefined();

    const legacySearch = await server.inject({
      method: "GET",
      url: "/api/v2/fans/search?scope=page&pageLabel=lana&q=buyer&limit=10&offset=0",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(legacySearch.statusCode).toBe(200);
    expect(legacySearch.json().items).toEqual(search.json().items);

    const batch = await server.inject({
      method: "POST",
      url: "/api/v2/spenders:batch",
      headers: {
        authorization: `Bearer ${key}`,
      },
      payload: {
        scope: "page",
        pageLabel: "lana",
        period: "30d",
        fans: [
          { platform: "fansly", platformUserId: "fan-001" },
          { platform: "fansly", platformUserId: "fan-missing" },
        ],
      },
    });

    expect(batch.statusCode).toBe(200);
    expect(batch.json().items).toEqual([
      expect.objectContaining({
        requestedFan: {
          platform: "fansly",
          platformUserId: "fan-001",
        },
        found: true,
        metrics: expect.objectContaining({
          window: expect.objectContaining({
            creatorNetAmountMills: 7000,
          }),
          lifetime: {
            scopeGrossAmountMills: 7000,
            scopeCreatorNetAmountMills: 7000,
            platformGrossAmountMills: 7000,
            platformCreatorNetAmountMills: 7000,
          },
        }),
      }),
      {
        requestedFan: {
          platform: "fansly",
          platformUserId: "fan-missing",
        },
        found: false,
        fan: null,
        metrics: null,
      },
    ]);

    const forbidden = await server.inject({
      method: "POST",
      url: "/api/v2/spenders:batch",
      headers: {
        authorization: `Bearer ${key}`,
      },
      payload: {
        scope: "agency",
        platform: "fansly",
        period: "30d",
        fans: [
          { platform: "fansly", platformUserId: "fan-001" },
        ],
      },
    });

    expect(forbidden.statusCode).toBe(403);
  });

  it("returns a typed 404 when onboarding references a missing model slug", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/admin/pages",
      headers: { cookie },
      payload: {
        platform: "fansly",
        modelSlug: "missing-model",
        label: "ghost-page",
        session: {
          authorization: "token",
        },
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: "not_found",
      message: 'Model "missing-model" does not exist',
      statusCode: 404,
    });
  });

  it("auto-queues and processes an initial full sync after page creation", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const activeTestDb = testDb;
    await server.close();
    const appContext = createTestAppContext(activeTestDb, {
      databaseUrl: activeTestDb.connectionString,
      adapter: createAutoSyncFanslyAdapter({
        accountId: "acct-auto-sync",
        username: "auto_sync_user",
        displayName: "Auto Sync User",
      }),
    });
    server = await buildApiServer(appContext);
    await server.ready();

    workerBoss = new PgBoss({ connectionString: activeTestDb.connectionString });
    await workerBoss.start();
    await ensureSyncQueues(workerBoss);
    const abortController = new AbortController();
    const executorPromise = startSyncPageExecutor(appContext, workerBoss, {
      signal: abortController.signal,
    });

    try {
      const login = await server.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: {
          username: "dima",
          password: "owner-secret",
        },
      });
      const cookie = sessionCookieFrom(login);

      const response = await server.inject({
        method: "POST",
        url: "/api/v1/admin/pages",
        headers: { cookie },
        payload: {
          platform: "fansly",
          modelSlug: "lana-model",
          label: "auto-sync-page",
          session: {
            authorization: "token",
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        page: {
          label: "auto-sync-page",
          platform: "fansly",
          username: "auto_sync_user",
        },
        verified: true,
      });

      await waitForCondition(async () => {
        const rows = await activeTestDb.pool.query<{
          stream: string;
          status: string;
        }>(`
          select sr.stream, sr.status
          from sync_runs sr
          join platform_accounts pa on pa.id = sr.platform_account_id
          where pa.label = 'auto-sync-page'
          order by sr.stream asc
        `);

        return rows.rows.length >= 4
          && rows.rows.every((row) => row.status === "success");
      });

      const syncRunRows = await activeTestDb.pool.query<{
        stream: string;
        status: string;
        trigger: string;
      }>(`
        select sr.stream, sr.status, sr.trigger
        from sync_runs sr
        join platform_accounts pa on pa.id = sr.platform_account_id
        where pa.label = 'auto-sync-page'
        order by sr.stream asc
      `);

      expect(syncRunRows.rows.map((row) => row.stream)).toEqual([
        "light",
        "followers",
        "transactions",
        "subscribers",
        "followers_reconcile",
      ]);
      expect(syncRunRows.rows.every((row) => row.status === "success")).toBe(true);
      expect(syncRunRows.rows.every((row) => row.trigger === "onboarding")).toBe(true);
    } finally {
      abortController.abort();
      await executorPromise;
    }
  });

  it("returns 503 when page creation succeeds but the initial sync cannot be queued", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const activeTestDb = testDb;
    await server.close();
    const appContext = createTestAppContext(activeTestDb, {
      databaseUrl: activeTestDb.connectionString,
      adapter: createAutoSyncFanslyAdapter({
        accountId: "acct-enqueue-fail",
        username: "enqueue_fail_user",
        displayName: "Enqueue Fail User",
      }),
    });
    server = await buildApiServer(appContext);
    await server.ready();

    await activeTestDb.pool.query("drop schema pgboss cascade");

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/admin/pages",
      headers: { cookie },
      payload: {
        platform: "fansly",
        modelSlug: "lana-model",
        label: "enqueue-fail-page",
        session: {
          authorization: "token",
        },
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "service_unavailable",
      message: 'Page "enqueue-fail-page" was created, but the automatic sync could not be queued',
      statusCode: 503,
    });

    const pageRows = await activeTestDb.pool.query<{ count: string }>(`
      select count(*)::text as count
      from platform_accounts
      where label = 'enqueue-fail-page'
    `);
    expect(pageRows.rows[0]?.count).toBe("1");
  });

  it("uses the latest light sync run for connection health", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const latestLightRun = await startSyncRun(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      stream: "light",
      trigger: "worker",
    });
    await finishSyncRun(testDb.db, latestLightRun.id, {
      status: "success",
      stats: {},
    });

    const followerRun = await startSyncRun(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      stream: "followers",
      trigger: "worker",
    });
    await finishSyncRun(testDb.db, followerRun.id, {
      status: "failed",
      stats: {},
      errorSummary: "Follower sync failed",
    });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/connections",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "lana",
        connectionStatus: "active",
        lastSyncError: null,
      }),
    ]));
  });

  it("applies subscriber and follower query filters before pagination", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const now = new Date();
    const freshFollowedAt = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const distractorFollowedAt = new Date(now.getTime() - 1 * 60 * 60 * 1000);
    const freshStartedAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const distractorStartedAt = new Date(now.getTime() - 6 * 60 * 60 * 1000);
    const freshEndsAt = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    const distractorEndsAt = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);
    const [distractorFan, freshFan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-101",
      username: "alpha",
      displayName: "Alpha Fan",
    }, {
      platform: "fansly",
      platformUserId: "fan-102",
      username: "freshfan",
      displayName: "Fresh Fan",
    }]);

    await upsertFanPage(testDb.db, {
      fanId: distractorFan.id,
      platformAccountId: fixture.lanaPage.id,
      isFollower: true,
      followerSince: distractorFollowedAt,
      isSubscriber: true,
      subscriberSince: distractorStartedAt,
      subscriptionExpiresAt: distractorEndsAt,
      autoRenew: true,
    });
    await upsertPageFollow(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      fanId: distractorFan.id,
      platformFollowId: "follow-lana-alpha",
      followedAt: distractorFollowedAt,
    });
    await upsertPageSubscription(testDb.db, {
      platformSubscriptionId: "sub-lana-alpha",
      platformAccountId: fixture.lanaPage.id,
      fanId: distractorFan.id,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: 5000n,
      renewPriceMills: 5000n,
      autoRenew: true,
      sourceCreatedAt: distractorStartedAt,
      endsAt: distractorEndsAt,
    });

    await upsertFanPage(testDb.db, {
      fanId: freshFan.id,
      platformAccountId: fixture.lanaPage.id,
      isFollower: true,
      followerSince: freshFollowedAt,
      isSubscriber: true,
      subscriberSince: freshStartedAt,
      subscriptionExpiresAt: freshEndsAt,
      autoRenew: false,
    });
    await upsertPageFollow(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      fanId: freshFan.id,
      platformFollowId: "follow-lana-fresh",
      followedAt: freshFollowedAt,
    });
    await upsertPageSubscription(testDb.db, {
      platformSubscriptionId: "sub-lana-fresh",
      platformAccountId: fixture.lanaPage.id,
      fanId: freshFan.id,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: 5000n,
      renewPriceMills: 5000n,
      autoRenew: false,
      sourceCreatedAt: freshStartedAt,
      endsAt: freshEndsAt,
    });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const subscriberSearch = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/subscribers?query=fresh&limit=1",
      headers: { cookie },
    });
    expect(subscriberSearch.statusCode).toBe(200);
    expect(subscriberSearch.json().items).toEqual([
      expect.objectContaining({
        platformUserId: "fan-102",
      }),
    ]);

    const followerSearch = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/followers?query=fresh&limit=1",
      headers: { cookie },
    });
    expect(followerSearch.statusCode).toBe(200);
    expect(followerSearch.json().items).toEqual([
      expect.objectContaining({
        platformUserId: "fan-102",
      }),
    ]);
  });

  it("applies subscriber and follower date-window filters", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const now = new Date();
    const recentFollowAt = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const oldFollowAt = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const recentSubscriberAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const oldSubscriberAt = new Date(now.getTime() - 72 * 60 * 60 * 1000);
    const expiringAt = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    const nonExpiringAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const [existingFan, oldFan, freshFan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-001",
    }, {
      platform: "fansly",
      platformUserId: "fan-201",
      username: "stalefan",
      displayName: "Stale Fan",
    }, {
      platform: "fansly",
      platformUserId: "fan-202",
      username: "freshfan",
      displayName: "Fresh Fan",
    }]);

    await upsertFanPage(testDb.db, {
      fanId: existingFan.id,
      platformAccountId: fixture.lanaPage.id,
      subscriptionExpiresAt: nonExpiringAt,
      autoRenew: true,
    });
    await upsertPageSubscription(testDb.db, {
      platformSubscriptionId: "sub-lana-1",
      platformAccountId: fixture.lanaPage.id,
      fanId: existingFan.id,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: 5000n,
      renewPriceMills: 5000n,
      autoRenew: true,
      sourceCreatedAt: oldSubscriberAt,
      endsAt: nonExpiringAt,
    });

    await upsertFanPage(testDb.db, {
      fanId: oldFan.id,
      platformAccountId: fixture.lanaPage.id,
      isFollower: true,
      followerSince: oldFollowAt,
      isSubscriber: true,
      subscriberSince: oldSubscriberAt,
      subscriptionExpiresAt: nonExpiringAt,
      autoRenew: true,
    });
    await upsertPageFollow(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      fanId: oldFan.id,
      platformFollowId: "follow-lana-stale",
      followedAt: oldFollowAt,
    });
    await upsertPageSubscription(testDb.db, {
      platformSubscriptionId: "sub-lana-stale",
      platformAccountId: fixture.lanaPage.id,
      fanId: oldFan.id,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: 5000n,
      renewPriceMills: 5000n,
      autoRenew: true,
      sourceCreatedAt: oldSubscriberAt,
      endsAt: nonExpiringAt,
    });

    await upsertFanPage(testDb.db, {
      fanId: freshFan.id,
      platformAccountId: fixture.lanaPage.id,
      isFollower: true,
      followerSince: recentFollowAt,
      isSubscriber: true,
      subscriberSince: recentSubscriberAt,
      subscriptionExpiresAt: expiringAt,
      autoRenew: false,
    });
    await upsertPageFollow(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      fanId: freshFan.id,
      platformFollowId: "follow-lana-recent",
      followedAt: recentFollowAt,
    });
    await upsertPageSubscription(testDb.db, {
      platformSubscriptionId: "sub-lana-recent",
      platformAccountId: fixture.lanaPage.id,
      fanId: freshFan.id,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: 5000n,
      renewPriceMills: 5000n,
      autoRenew: false,
      sourceCreatedAt: recentSubscriberAt,
      endsAt: expiringAt,
    });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const subscriberRecent = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/subscribers?startedWithinHours=24&limit=50",
      headers: { cookie },
    });
    expect(subscriberRecent.statusCode).toBe(200);
    expect(subscriberRecent.json().items).toEqual([
      expect.objectContaining({
        platformUserId: "fan-202",
      }),
    ]);

    const subscriberExpiring = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/subscribers?expiringWithinDays=7&limit=50",
      headers: { cookie },
    });
    expect(subscriberExpiring.statusCode).toBe(200);
    expect(subscriberExpiring.json().items).toEqual([
      expect.objectContaining({
        platformUserId: "fan-202",
      }),
    ]);

    const subscriberNoRenew = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/subscribers?autoRenew=false&limit=50",
      headers: { cookie },
    });
    expect(subscriberNoRenew.statusCode).toBe(200);
    expect(subscriberNoRenew.json().items).toEqual([
      expect.objectContaining({
        platformUserId: "fan-202",
      }),
    ]);

    const followerRecent = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/followers?followedWithinHours=24&limit=50",
      headers: { cookie },
    });
    expect(followerRecent.statusCode).toBe(200);
    expect(followerRecent.json().items).toEqual([
      expect.objectContaining({
        platformUserId: "fan-202",
      }),
    ]);
  });

  it("returns sync runs as a bare array for admin clients", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const run = await startSyncRun(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      stream: "light",
      trigger: "worker",
    });
    await finishSyncRun(testDb.db, run.id, {
      status: "success",
      stats: { synced: 1 },
    });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/sync/runs?limit=1",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        runId: run.id,
        pageLabel: "lana",
        stream: "light",
      }),
    ]);
  });

  it("rejects owner-only admin endpoints for team leads", async (context) => {
    if (!server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "lead",
        password: "lead-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/connections",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it("updates stored page credentials via PATCH for owners", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const activeTestDb = testDb;
    await server.close();
    const appContext = createTestAppContext(activeTestDb, {
      adapter: createAutoSyncFanslyAdapter({
        accountId: "acct-lana",
        username: "lana_page",
        displayName: "Lana",
      }),
    });
    server = await buildApiServer(appContext);
    await server.ready();

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/pages/lana/credentials",
      headers: { cookie },
      payload: {
        platform: "fansly",
        session: {
          authorization: "updated-token",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      updated: true,
      verified: true,
    });
  });

  it("normalizes inline proxy credentials when updating page credentials via PATCH", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const activeTestDb = testDb;
    await server.close();
    const appContext = createTestAppContext(activeTestDb, {
      adapter: createAutoSyncFanslyAdapter({
        accountId: "acct-lana",
        username: "lana_page",
        displayName: "Lana",
      }),
    });
    server = await buildApiServer(appContext);
    await server.ready();

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/pages/lana/credentials",
      headers: { cookie },
      payload: {
        platform: "fansly",
        session: {
          authorization: "updated-token",
        },
        proxy: {
          url: "socks5://proxy-user:proxy-pass@127.0.0.1:1080",
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const proxyRows = await activeTestDb.pool.query(`
      select url, encrypted_auth is not null as has_encrypted_auth
      from platform_account_proxies
      where platform_account_id = (
        select id from platform_accounts where label = 'lana'
      )
    `);

    expect(proxyRows.rows[0]).toEqual({
      url: "socks5://127.0.0.1:1080",
      has_encrypted_auth: true,
    });
  });

  it("serves follower and subscriber daily series plus swagger security schemes", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const followersDaily = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/followers/daily?period=custom&from=2026-03-01&to=2026-03-10",
      headers: { cookie },
    });
    expect(followersDaily.statusCode).toBe(200);
    expect(followersDaily.json().items).toEqual([
      expect.objectContaining({
        businessDate: "2026-03-02",
        newFollowers: 1,
      }),
    ]);

    const subscribersDaily = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/subscribers/daily?period=custom&from=2026-03-01&to=2026-03-10",
      headers: { cookie },
    });
    expect(subscribersDaily.statusCode).toBe(200);
    expect(subscribersDaily.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          businessDate: "2026-03-01",
          newSubscribers: 1,
        }),
      ]),
    );

    const spec = server.swagger() as {
      components?: {
        securitySchemes?: Record<string, unknown>;
      };
    };
    expect(spec.components?.securitySchemes).toMatchObject({
      cookieAuth: expect.any(Object),
      bearerAuth: expect.any(Object),
    });
  });

  it("uses UTC day boundaries for Fansly follower and subscriber daily rollups", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "utc-fansly-daily-model",
      name: "UTC Fansly Daily",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "utc-fansly-daily",
    });
    await updatePageMetadata(testDb.db, page.id, {
      platformAccountIdValue: "acct-utc-fansly-daily",
      username: "utc_fansly_daily",
      displayName: "UTC Fansly Daily",
      followerCount: 1,
      subscriberCount: 1,
      earningsBalanceMills: 0n,
      metadata: {},
      syncType: "light",
    });

    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "utc-fansly-daily-fan",
      username: "utcfan",
      displayName: "UTC Fan",
    }]);

    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
      isFollower: true,
      followerSince: new Date("2026-03-01T21:30:00.000Z"),
      isSubscriber: true,
      subscriberSince: new Date("2026-03-01T21:30:00.000Z"),
      subscriptionExpiresAt: new Date("2026-03-05T21:30:00.000Z"),
      autoRenew: true,
    });
    await upsertPageFollow(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      platformFollowId: "utc-fansly-follow-1",
      followedAt: new Date("2026-03-01T21:30:00.000Z"),
    });
    await upsertPageSubscription(testDb.db, {
      platformSubscriptionId: "utc-fansly-sub-1",
      platformAccountId: page.id,
      fanId: fan.id,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: 5000n,
      renewPriceMills: 5000n,
      autoRenew: true,
      sourceCreatedAt: new Date("2026-03-01T21:30:00.000Z"),
      endsAt: new Date("2026-03-05T21:30:00.000Z"),
    });

    await rebuildFollowerRollups(testDb.db, page.id, 1);
    await rebuildSubscriberRollups(testDb.db, page.id);

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const followersDaily = await server.inject({
      method: "GET",
      url: "/api/v1/pages/utc-fansly-daily/followers/daily?period=custom&from=2026-03-01&to=2026-03-02",
      headers: { cookie },
    });
    const subscribersDaily = await server.inject({
      method: "GET",
      url: "/api/v1/pages/utc-fansly-daily/subscribers/daily?period=custom&from=2026-03-01&to=2026-03-06",
      headers: { cookie },
    });

    expect(followersDaily.statusCode).toBe(200);
    expect(followersDaily.json().items).toEqual([
      expect.objectContaining({
        businessDate: "2026-03-01",
        newFollowers: 1,
      }),
    ]);

    expect(subscribersDaily.statusCode).toBe(200);
    expect(subscribersDaily.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        businessDate: "2026-03-01",
        newSubscribers: 1,
        activeSubscribers: 1,
      }),
      expect.objectContaining({
        businessDate: "2026-03-06",
        newSubscribers: 0,
        activeSubscribers: 0,
      }),
    ]));
    expect(
      subscribersDaily.json().items.some(
        (row: { businessDate: string; newSubscribers: number }) =>
          row.businessDate === "2026-03-02" && row.newSubscribers === 1,
      ),
    ).toBe(false);
  });

  it("paginates follower and subscriber list endpoints", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }
    const lanaPageId = fixture.lanaPage.id;

    const [fanTwo, fanThree] = await upsertFans(testDb.db, [
      {
        platform: "fansly",
        platformUserId: "fan-002",
        username: "buyer2",
        displayName: "Buyer Two",
      },
      {
        platform: "fansly",
        platformUserId: "fan-003",
        username: "buyer3",
        displayName: "Buyer Three",
      },
    ]);

    for (const [index, fan] of [fanTwo, fanThree].entries()) {
      await upsertFanPage(testDb.db, {
        fanId: fan.id,
        platformAccountId: lanaPageId,
        isFollower: true,
        followerSince: new Date(`2026-03-0${index + 3}T12:00:00.000Z`),
        isSubscriber: true,
        subscriberSince: new Date(`2026-03-0${index + 3}T12:00:00.000Z`),
        subscriptionExpiresAt: new Date(`2026-03-2${index + 1}T12:00:00.000Z`),
        autoRenew: index % 2 === 0,
      });
      await upsertPageFollow(testDb.db, {
        platformAccountId: lanaPageId,
        fanId: fan.id,
        platformFollowId: `follow-lana-${index + 2}`,
        followedAt: new Date(`2026-03-0${index + 3}T12:00:00.000Z`),
      });
      await upsertPageSubscription(testDb.db, {
        platformSubscriptionId: `sub-lana-${index + 2}`,
        platformAccountId: lanaPageId,
        fanId: fan.id,
        rawStatus: 3,
        canonicalStatus: "active",
        priceMills: 5000n,
        renewPriceMills: 5000n,
        autoRenew: index % 2 === 0,
        sourceCreatedAt: new Date(`2026-03-0${index + 3}T12:00:00.000Z`),
        endsAt: new Date(`2026-03-2${index + 1}T12:00:00.000Z`),
      });
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const followers = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/followers?limit=1&offset=1",
      headers: { cookie },
    });
    expect(followers.statusCode).toBe(200);
    expect(followers.json()).toMatchObject({
      limit: 1,
      offset: 1,
      total: 3,
    });
    expect(followers.json().items).toHaveLength(1);
    expect(followers.json().items[0]?.platformUserId).toBe("fan-002");

    const subscribers = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/subscribers?limit=1&offset=1",
      headers: { cookie },
    });
    expect(subscribers.statusCode).toBe(200);
    expect(subscribers.json()).toMatchObject({
      limit: 1,
      offset: 1,
      total: 3,
    });
    expect(subscribers.json().items).toHaveLength(1);
    expect(subscribers.json().items[0]?.platformSubscriptionId).toBe("sub-lana-2");
  });
});
