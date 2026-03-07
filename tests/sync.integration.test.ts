import { readFile } from "node:fs/promises";
import path from "node:path";

import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  dailyFollowers,
  dailyRevenue,
  dailySubscribers,
  getCheckpoint,
  pageFollows,
  pageSubscriptions,
  platformAccounts,
  rebuildFollowerRollups,
  rebuildRevenueRollups,
  rebuildSubscriberRollups,
  syncRuns,
  transactions,
} from "@fansly-connect/db";
import type {
  FanslyAccount,
  FanslyAccountMeResponse,
  FanslySubscriber,
  FanslyEarningsTransaction,
  FanslyFollower,
} from "@fansly-connect/fansly";

import {
  listFollowers,
  revenueBreakdownForPage,
  runAllSync,
  runLightSync,
} from "../apps/runtime/src/services/sync.ts";
import { startTestDatabase, seedFanslyPage } from "./helpers/db.ts";

class FakeFanslyAdapter {
  constructor(
    private readonly fixture: {
      accountMe: FanslyAccountMeResponse;
      transactions: FanslyEarningsTransaction[];
      subscribers: FanslySubscriber[];
      followers: FanslyFollower[];
    },
    private readonly options?: {
      failTransactionPage?: number;
    },
  ) {}

  async getAccountMe() {
    return this.fixture.accountMe;
  }

  async verifySession() {
    return this.fixture.accountMe;
  }

  async getAccountsByIds(_: unknown, ids: string[]) {
    return ids.map((id) => ({
      id,
      username: `fan_${id.slice(-4)}`,
      displayName: `Fan ${id.slice(-4)}`,
      createdAt: 1770000000000,
    })) satisfies FanslyAccount[];
  }

  async getTransactionsPage(
    _: unknown,
    params: { offset?: number; limit?: number },
  ) {
    const limit = params.limit ?? 100;
    const offset = params.offset ?? 0;
    const pageIndex = Math.floor(offset / limit) + 1;

    if (this.options?.failTransactionPage === pageIndex) {
      throw new Error(`transactions page ${pageIndex} failed`);
    }

    const items = this.fixture.transactions.slice(offset, offset + limit);
    return {
      total: this.fixture.transactions.length,
      items,
      offset,
      done: items.length < limit,
    };
  }

  async getSubscribersPage(
    _: unknown,
    params: { offset?: number; limit?: number },
  ) {
    const limit = params.limit ?? 100;
    const offset = params.offset ?? 0;
    const items = this.fixture.subscribers.slice(offset, offset + limit);
    return {
      total: this.fixture.subscribers.length,
      items,
      offset,
      done: items.length < limit,
    };
  }

  async getFollowersPage(
    _: unknown,
    __: string,
    params: { offset?: number; limit?: number },
  ) {
    const limit = params.limit ?? 100;
    const offset = params.offset ?? 0;
    const items = this.fixture.followers.slice(offset, offset + limit);
    const accounts = items.map((item) => ({
      id: item.followerId,
      username: `fan_${item.followerId.slice(-4)}`,
      displayName: `Fan ${item.followerId.slice(-4)}`,
      createdAt: 1770000000000,
    }));
    return {
      total: this.fixture.followers.length,
      items,
      offset,
      done: items.length < limit,
      accounts,
    };
  }
}

function duplicateTransactions(seed: FanslyEarningsTransaction[], count: number) {
  return Array.from({ length: count }).map((_, index) => {
    const base = seed[index % seed.length]!;
    return {
      ...base,
      transactionId: `${base.transactionId}-${index}`,
      correlationId: `${base.correlationId}-${index}`,
      createdAt: base.createdAt + index,
    };
  });
}

function withPayoutReversal(seed: FanslyEarningsTransaction[]) {
  const base = seed[0]!;
  return [
    ...seed,
    {
      ...base,
      transactionId: `${base.transactionId}-16013`,
      correlationId: null,
      correlationAccountId: null,
      type: 16013,
      amount: 331000,
      destinationAmount: 331000,
      destinationTax: 0,
      newBalance: (base.newBalance ?? 0) + 331000,
      newBalance64: (base.newBalance64 ?? 0) + 331000,
      createdAt: base.createdAt + 1,
      status: 2,
      senderId: null,
      receiverId: base.receiverId,
    },
  ] satisfies FanslyEarningsTransaction[];
}

describe("sync integration", () => {
  let testDb: Awaited<ReturnType<typeof startTestDatabase>> | null = null;
  const encryptionKey = Buffer.alloc(32, 7);
  const expectedRevenueTotal = 238392n;

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
    if (testDb) {
      await testDb.stop();
    }
  });

  beforeEach(async () => {
    if (!testDb) {
      return;
    }
    await testDb.pool.query(`
      truncate daily_revenue, daily_followers, daily_subscribers, transactions,
               page_subscriptions, page_follows, fan_pages, fans, raw_payloads,
               sync_checkpoints, sync_runs, platform_account_proxies,
               platform_account_credentials, platform_accounts, models
      restart identity cascade
    `);
  });

  it("syncs idempotently and rebuilds rollups", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const accountMeFixture = JSON.parse(
      await readFile(path.resolve("reference/responses/account_me.json"), "utf8"),
    ).data.response as FanslyAccountMeResponse;
    const transactionsFixture = JSON.parse(
      await readFile(path.resolve("reference/responses/earnings_transactions.json"), "utf8"),
    ).data.response.data as FanslyEarningsTransaction[];
    const subscribersFixture = JSON.parse(
      await readFile(path.resolve("reference/responses/subscribers.json"), "utf8"),
    ).data.response.subscriptions as FanslySubscriber[];
    const followersFixture = JSON.parse(
      await readFile(path.resolve("reference/responses/followers.json"), "utf8"),
    ).data.response.followers as FanslyFollower[];

    const { page } = await seedFanslyPage(testDb.db, encryptionKey);
    const app = {
      db: testDb.db,
      pool: testDb.pool,
      logger: testDb.logger,
      config: {
        databaseUrl: "",
        encryptionKey,
        encryptionKeyVersion: 1,
        logLevel: "silent",
        fanslyBaseUrl: "https://example.invalid",
        followerPageDelayMs: 0,
        transactionLookbackDays: 7,
      },
      adapter: new FakeFanslyAdapter({
        accountMe: accountMeFixture,
        transactions: transactionsFixture,
        subscribers: subscribersFixture,
        followers: followersFixture,
      }),
      async close() {},
    };

    await runAllSync(app, page.label);
    await runAllSync(app, page.label);

    const transactionCount = await testDb.pool.query("select count(*)::int from transactions");
    const followCount = await testDb.pool.query("select count(*)::int from page_follows");
    const subscriptionCount = await testDb.pool.query("select count(*)::int from page_subscriptions");
    const revenueRows = await testDb.pool.query(
      "select coalesce(sum(net_amount_mills), 0)::bigint as total from daily_revenue",
    );
    const followerRollupRows = await testDb.pool.query(
      "select coalesce(sum(new_followers), 0)::int as total from daily_followers",
    );
    const subscriberRollupRows = await testDb.pool.query(
      "select max(active_subscribers)::int as total from daily_subscribers",
    );

    expect(transactionCount.rows[0]?.count).toBe(transactionsFixture.length);
    expect(followCount.rows[0]?.count).toBe(followersFixture.length);
    expect(subscriptionCount.rows[0]?.count).toBe(subscribersFixture.length);
    expect(BigInt(revenueRows.rows[0]?.total ?? 0)).toBe(expectedRevenueTotal);
    expect(followerRollupRows.rows[0]?.total).toBe(followersFixture.length);
    expect(subscriberRollupRows.rows[0]?.total).toBe(subscribersFixture.length);

    const stateRows = await testDb.pool.query(
      "select distinct transaction_state from daily_revenue order by transaction_state",
    );
    expect(stateRows.rows.map((row: { transaction_state: string }) => row.transaction_state)).toEqual(["pending", "posted"]);
  });

  it("lists synced followers most recent first", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const accountMeFixture = JSON.parse(
      await readFile(path.resolve("reference/responses/account_me.json"), "utf8"),
    ).data.response as FanslyAccountMeResponse;
    const transactionsFixture = JSON.parse(
      await readFile(path.resolve("reference/responses/earnings_transactions.json"), "utf8"),
    ).data.response.data as FanslyEarningsTransaction[];
    const subscribersFixture = JSON.parse(
      await readFile(path.resolve("reference/responses/subscribers.json"), "utf8"),
    ).data.response.subscriptions as FanslySubscriber[];
    const followersFixture = JSON.parse(
      await readFile(path.resolve("reference/responses/followers.json"), "utf8"),
    ).data.response.followers as FanslyFollower[];

    const { page } = await seedFanslyPage(testDb.db, encryptionKey);
    const app = {
      db: testDb.db,
      pool: testDb.pool,
      logger: testDb.logger,
      config: {
        databaseUrl: "",
        encryptionKey,
        encryptionKeyVersion: 1,
        logLevel: "silent",
        fanslyBaseUrl: "https://example.invalid",
        followerPageDelayMs: 0,
        transactionLookbackDays: 7,
      },
      adapter: new FakeFanslyAdapter({
        accountMe: accountMeFixture,
        transactions: transactionsFixture,
        subscribers: subscribersFixture,
        followers: followersFixture,
      }),
      async close() {},
    };

    await runAllSync(app, page.label);

    const rows = await listFollowers(app, page.label);

    expect(rows).toHaveLength(followersFixture.length);
    for (let index = 1; index < rows.length; index += 1) {
      const previous = new Date(rows[index - 1]!.followed_at as string | Date).getTime();
      const current = new Date(rows[index]!.followed_at as string | Date).getTime();
      expect(previous).toBeGreaterThanOrEqual(current);
    }
  });

  it("stores payout reversals for audit but excludes them from revenue", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const accountMeFixture = JSON.parse(
      await readFile(path.resolve("reference/responses/account_me.json"), "utf8"),
    ).data.response as FanslyAccountMeResponse;
    const transactionsFixture = withPayoutReversal(
      JSON.parse(
        await readFile(path.resolve("reference/responses/earnings_transactions.json"), "utf8"),
      ).data.response.data as FanslyEarningsTransaction[],
    );
    const subscribersFixture = JSON.parse(
      await readFile(path.resolve("reference/responses/subscribers.json"), "utf8"),
    ).data.response.subscriptions as FanslySubscriber[];
    const followersFixture = JSON.parse(
      await readFile(path.resolve("reference/responses/followers.json"), "utf8"),
    ).data.response.followers as FanslyFollower[];

    const { page } = await seedFanslyPage(testDb.db, encryptionKey);
    const app = {
      db: testDb.db,
      pool: testDb.pool,
      logger: testDb.logger,
      config: {
        databaseUrl: "",
        encryptionKey,
        encryptionKeyVersion: 1,
        logLevel: "silent",
        fanslyBaseUrl: "https://example.invalid",
        followerPageDelayMs: 0,
        transactionLookbackDays: 7,
      },
      adapter: new FakeFanslyAdapter({
        accountMe: accountMeFixture,
        transactions: transactionsFixture,
        subscribers: subscribersFixture,
        followers: followersFixture,
      }),
      async close() {},
    };

    await runAllSync(app, page.label);

    const payoutRows = await testDb.pool.query(`
      select raw_type, canonical_type, net_amount_mills
      from transactions
      where raw_type = 16013
    `);
    const payoutRollupRows = await testDb.pool.query(`
      select count(*)::int as count
      from daily_revenue
      where canonical_type = 'payout_reversal'
    `);
    const totalRevenueRows = await testDb.pool.query(`
      select coalesce(sum(net_amount_mills), 0)::bigint as total
      from daily_revenue
    `);
    const breakdown = await revenueBreakdownForPage(app, page.label, "all");

    expect(payoutRows.rowCount).toBe(1);
    expect(payoutRows.rows[0]).toMatchObject({
      raw_type: 16013,
      canonical_type: "payout_reversal",
    });
    expect(BigInt(payoutRows.rows[0]?.net_amount_mills ?? 0)).toBe(331000n);
    expect(payoutRollupRows.rows[0]?.count).toBe(0);
    expect(BigInt(totalRevenueRows.rows[0]?.total ?? 0)).toBe(expectedRevenueTotal);
    expect(breakdown.rows.some((row) => row.canonicalType === "payout_reversal")).toBe(false);
  });

  it("rebuilds rollups safely on concurrent reruns", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const accountMeFixture = JSON.parse(
      await readFile(path.resolve("reference/responses/account_me.json"), "utf8"),
    ).data.response as FanslyAccountMeResponse;
    const transactionsFixture = JSON.parse(
      await readFile(path.resolve("reference/responses/earnings_transactions.json"), "utf8"),
    ).data.response.data as FanslyEarningsTransaction[];
    const subscribersFixture = JSON.parse(
      await readFile(path.resolve("reference/responses/subscribers.json"), "utf8"),
    ).data.response.subscriptions as FanslySubscriber[];
    const followersFixture = JSON.parse(
      await readFile(path.resolve("reference/responses/followers.json"), "utf8"),
    ).data.response.followers as FanslyFollower[];

    const { page } = await seedFanslyPage(testDb.db, encryptionKey);
    const app = {
      db: testDb.db,
      pool: testDb.pool,
      logger: testDb.logger,
      config: {
        databaseUrl: "",
        encryptionKey,
        encryptionKeyVersion: 1,
        logLevel: "silent",
        fanslyBaseUrl: "https://example.invalid",
        followerPageDelayMs: 0,
        transactionLookbackDays: 7,
      },
      adapter: new FakeFanslyAdapter({
        accountMe: accountMeFixture,
        transactions: transactionsFixture,
        subscribers: subscribersFixture,
        followers: followersFixture,
      }),
      async close() {},
    };

    await runAllSync(app, page.label);

    await Promise.all([
      rebuildRevenueRollups(testDb.db, page.id),
      rebuildRevenueRollups(testDb.db, page.id),
    ]);
    await Promise.all([
      rebuildFollowerRollups(testDb.db, page.id, accountMeFixture.account.followCount),
      rebuildFollowerRollups(testDb.db, page.id, accountMeFixture.account.followCount),
    ]);
    await Promise.all([
      rebuildSubscriberRollups(testDb.db, page.id),
      rebuildSubscriberRollups(testDb.db, page.id),
    ]);

    const revenueRows = await testDb.pool.query(`
      select count(*)::int as row_count,
             count(distinct (business_date, canonical_type, transaction_state))::int as distinct_count,
             coalesce(sum(net_amount_mills), 0)::bigint as total
      from daily_revenue
      where platform_account_id = ${page.id}
    `);
    const followerRows = await testDb.pool.query(`
      select count(*)::int as row_count,
             count(distinct business_date)::int as distinct_count,
             coalesce(sum(new_followers), 0)::int as total
      from daily_followers
      where platform_account_id = ${page.id}
    `);
    const subscriberRows = await testDb.pool.query(`
      select count(*)::int as row_count,
             count(distinct business_date)::int as distinct_count,
             coalesce(max(active_subscribers), 0)::int as total
      from daily_subscribers
      where platform_account_id = ${page.id}
    `);

    expect(revenueRows.rows[0]?.row_count).toBe(revenueRows.rows[0]?.distinct_count);
    expect(BigInt(revenueRows.rows[0]?.total ?? 0)).toBe(expectedRevenueTotal);
    expect(followerRows.rows[0]?.row_count).toBe(followerRows.rows[0]?.distinct_count);
    expect(followerRows.rows[0]?.total).toBe(followersFixture.length);
    expect(subscriberRows.rows[0]?.row_count).toBe(subscriberRows.rows[0]?.distinct_count);
    expect(subscriberRows.rows[0]?.total).toBe(subscribersFixture.length);
  });

  it("does not advance the transaction checkpoint on partial failure", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const accountMeFixture = JSON.parse(
      await readFile(path.resolve("reference/responses/account_me.json"), "utf8"),
    ).data.response as FanslyAccountMeResponse;
    const seedTransactions = JSON.parse(
      await readFile(path.resolve("reference/responses/earnings_transactions.json"), "utf8"),
    ).data.response.data as FanslyEarningsTransaction[];
    const subscribersFixture = JSON.parse(
      await readFile(path.resolve("reference/responses/subscribers.json"), "utf8"),
    ).data.response.subscriptions as FanslySubscriber[];

    const { page } = await seedFanslyPage(testDb.db, encryptionKey);
    const app = {
      db: testDb.db,
      pool: testDb.pool,
      logger: testDb.logger,
      config: {
        databaseUrl: "",
        encryptionKey,
        encryptionKeyVersion: 1,
        logLevel: "silent",
        fanslyBaseUrl: "https://example.invalid",
        followerPageDelayMs: 0,
        transactionLookbackDays: 7,
      },
      adapter: new FakeFanslyAdapter(
        {
          accountMe: accountMeFixture,
          transactions: duplicateTransactions(seedTransactions, 150),
          subscribers: subscribersFixture,
          followers: [],
        },
        { failTransactionPage: 2 },
      ),
      async close() {},
    };

    const result = await runLightSync(app, page.label);
    const checkpoint = await getCheckpoint(testDb.db, page.id, "transactions");
    const rollupCount = await testDb.pool.query("select count(*)::int from daily_revenue");
    const runRow = await testDb.pool.query(
      "select status from sync_runs order by id desc limit 1",
    );

    expect(result.status).toBe("partial");
    expect(result.errors.some((entry) => entry.includes("transactions"))).toBe(true);
    expect(checkpoint).toBeNull();
    expect(rollupCount.rows[0]?.count).toBe(0);
    expect(runRow.rows[0]?.status).toBe("partial");
  });
});
