import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  rebuildFollowerRollups,
  rebuildRevenueRollups,
  rebuildSubscriberRollups,
  updatePageMetadata,
  upsertFanPage,
  upsertFans,
  upsertPageFollow,
  upsertPageSubscription,
  upsertTransaction,
} from "@fansly-connect/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import {
  SESSION_COOKIE_NAME,
  assignPageToUser,
  createUserAccount,
  issueChatterApiKey,
  setUserPassword,
  unassignPageFromUser,
} from "../apps/runtime/src/services/auth.ts";
import { getPageRevenueReport } from "../apps/runtime/src/services/reporting.ts";
import { startTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

async function seedPhase2Fixture(testDb: NonNullable<Awaited<ReturnType<typeof startTestDatabase>>>) {
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
    totalCreatorNetMills: 7000n,
    isFollower: true,
    followerSince: new Date("2026-03-02T12:00:00.000Z"),
    isSubscriber: true,
    subscriberSince: new Date("2026-03-01T12:00:00.000Z"),
    subscriptionExpiresAt: new Date("2026-03-20T12:00:00.000Z"),
    autoRenew: true,
    lastTransactionAt: new Date("2026-03-06T12:00:00.000Z"),
  });
  await upsertFanPage(testDb.db, {
    fanId: fan.id,
    platformAccountId: lilyPage.id,
    totalCreatorNetMills: 3000n,
    isFollower: false,
    isSubscriber: false,
    lastTransactionAt: new Date("2026-03-06T13:00:00.000Z"),
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
    amountMills: 5000n,
    destinationAmountMills: 5000n,
    netAmountMills: 5000n,
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
    amountMills: 2000n,
    destinationAmountMills: 2000n,
    netAmountMills: 2000n,
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
    amountMills: 900n,
    destinationAmountMills: 900n,
    netAmountMills: 900n,
    occurredAt: new Date("2026-03-07T12:00:00.000Z"),
  });

  await rebuildRevenueRollups(testDb.db, lanaPage.id);
  await rebuildFollowerRollups(testDb.db, lanaPage.id, 1);
  await rebuildSubscriberRollups(testDb.db, lanaPage.id);

  return {
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

describe("api integration", () => {
  let testDb: Awaited<ReturnType<typeof startTestDatabase>> | null = null;
  let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
  let fixture: Awaited<ReturnType<typeof seedPhase2Fixture>> | null = null;

  beforeAll(async () => {
    try {
      testDb = await startTestDatabase();
    } catch (error) {
      console.warn(
        `Skipping integration tests: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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

    await testDb.pool.query(`
      truncate fan_flags, fan_summaries, fan_notes, audit_events, api_keys,
               auth_sessions, user_page_assignments, users, daily_revenue,
               daily_followers, daily_subscribers, transactions, page_subscriptions,
               page_follows, fan_pages, fans, raw_payloads, sync_checkpoints,
               sync_runs, platform_account_proxies, platform_account_credentials,
               platform_accounts, models
      restart identity cascade
    `);

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

  it("matches page revenue service output and excludes payout reversals", async (context) => {
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
      totalNetMills: expected.totalNetMills,
      breakdown: expected.breakdown,
    });
    expect(response.json().breakdown.some((row: { canonicalType: string }) => row.canonicalType === "payout_reversal")).toBe(false);
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
      platformTotalSpendMills: 10000,
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
