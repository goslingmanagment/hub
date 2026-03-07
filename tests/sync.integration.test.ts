import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
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
  PageSyncLockedError,
  listFans,
  listFollowers,
  listModels,
  listPages,
  listStatus,
  revenueBreakdownForPage,
  runAllSync,
  runFollowerSync,
  runLightSync,
} from "../apps/runtime/src/services/sync.ts";
import { startTestDatabase, seedFanslyPage } from "./helpers/db.ts";

type StartedTestDatabase = NonNullable<Awaited<ReturnType<typeof startTestDatabase>>>;
const testEncryptionKey = Buffer.alloc(32, 7);

class FakeFanslyAdapter {
  readonly transactionAfterHistory: Array<Date | null> = [];

  constructor(
    private readonly fixture: {
      accountMe: FanslyAccountMeResponse;
      transactions: FanslyEarningsTransaction[];
      subscribers: FanslySubscriber[];
      followers: FanslyFollower[];
    },
    private readonly options?: {
      failTransactionPage?: number;
      holdAccountMe?: {
        onEntered: () => void;
        release: Promise<void>;
      };
    },
  ) {}

  setTransactions(transactions: FanslyEarningsTransaction[]) {
    this.fixture.transactions = transactions;
  }

  setFollowers(followers: FanslyFollower[]) {
    this.fixture.followers = followers;
  }

  clearTransactionAfterHistory() {
    this.transactionAfterHistory.length = 0;
  }

  async getAccountMe() {
    this.options?.holdAccountMe?.onEntered();
    await this.options?.holdAccountMe?.release;
    return {
      parsed: this.fixture.accountMe,
      raw: this.fixture.accountMe,
    };
  }

  async verifySession() {
    return {
      parsed: this.fixture.accountMe,
      raw: this.fixture.accountMe,
    };
  }

  async getAccountsByIdsPage(_: unknown, ids: string[]) {
    const parsed = ids.map((id) => ({
      id,
      username: `fan_${id.slice(-4)}`,
      displayName: `Fan ${id.slice(-4)}`,
      createdAt: 1770000000000,
    })) satisfies FanslyAccount[];
    return {
      parsed,
      raw: parsed,
    };
  }

  async getTransactionsPage(
    _: unknown,
    params: { after?: Date | null; offset?: number; limit?: number },
  ) {
    this.transactionAfterHistory.push(params.after ?? null);
    const limit = params.limit ?? 100;
    const offset = params.offset ?? 0;
    const pageIndex = Math.floor(offset / limit) + 1;

    if (this.options?.failTransactionPage === pageIndex) {
      throw new Error(`transactions page ${pageIndex} failed`);
    }

    const filtered = params.after
      ? this.fixture.transactions.filter((item) => item.createdAt >= params.after!.getTime())
      : this.fixture.transactions;
    const items = filtered.slice(offset, offset + limit);
    return {
      total: filtered.length,
      items,
      offset,
      done: items.length < limit,
      raw: {
        total: filtered.length,
        data: items,
      },
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
      raw: {
        stats: {
          totalActive: this.fixture.subscribers.length,
          totalExpired: 0,
          total: this.fixture.subscribers.length,
        },
        subscriptions: items,
      },
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
      raw: {
        followers: items,
        aggregationData: {
          accounts,
        },
      },
    };
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

function buildTransaction(
  base: FanslyEarningsTransaction,
  overrides: Partial<FanslyEarningsTransaction>,
): FanslyEarningsTransaction {
  return {
    ...base,
    ...overrides,
    transactionId: overrides.transactionId ?? base.transactionId,
    correlationId: overrides.correlationId ?? base.correlationId,
  };
}

function createTestApp(
  testDb: StartedTestDatabase,
  adapter: FakeFanslyAdapter,
  overrides?: {
    logger?: StartedTestDatabase["logger"];
    transactionLookbackDays?: number;
    transactionRescanCapDays?: number;
  },
) {
  return {
    db: testDb.db,
    pool: testDb.pool,
    logger: overrides?.logger ?? testDb.logger,
    config: {
      databaseUrl: "",
      encryptionKey: testEncryptionKey,
      encryptionKeyVersion: 1,
      logLevel: "silent",
      fanslyBaseUrl: "https://example.invalid",
      followerPageDelayMs: 0,
      transactionLookbackDays: overrides?.transactionLookbackDays ?? 7,
      transactionRescanCapDays: overrides?.transactionRescanCapDays ?? 30,
    },
    adapter,
    async close() {},
  };
}

describe("sync integration", () => {
  let testDb: Awaited<ReturnType<typeof startTestDatabase>> | null = null;
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

    const { page } = await seedFanslyPage(testDb.db, testEncryptionKey);
    const app = createTestApp(testDb, new FakeFanslyAdapter({
      accountMe: accountMeFixture,
      transactions: transactionsFixture,
      subscribers: subscribersFixture,
      followers: followersFixture,
    }));

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

    const { page } = await seedFanslyPage(testDb.db, testEncryptionKey);
    const app = createTestApp(testDb, new FakeFanslyAdapter({
      accountMe: accountMeFixture,
      transactions: transactionsFixture,
      subscribers: subscribersFixture,
      followers: followersFixture,
    }));

    await runAllSync(app, page.label);

    const rows = await listFollowers(app, page.label);

    expect(rows).toHaveLength(followersFixture.length);
    for (let index = 1; index < rows.length; index += 1) {
      const previous = new Date(rows[index - 1]!.followed_at as string | Date).getTime();
      const current = new Date(rows[index]!.followed_at as string | Date).getTime();
      expect(previous).toBeGreaterThanOrEqual(current);
    }
  });

  it("advances the follower checkpoint across second and third runs", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const accountMeFixture = JSON.parse(
      await readFile(path.resolve("reference/responses/account_me.json"), "utf8"),
    ).data.response as FanslyAccountMeResponse;
    const followersFixture = JSON.parse(
      await readFile(path.resolve("reference/responses/followers.json"), "utf8"),
    ).data.response.followers as FanslyFollower[];

    const fixture = {
      accountMe: {
        ...accountMeFixture,
        account: {
          ...accountMeFixture.account,
          followCount: followersFixture.length,
        },
      },
      transactions: [] as FanslyEarningsTransaction[],
      subscribers: [] as FanslySubscriber[],
      followers: [...followersFixture],
    };

    const adapter = new FakeFanslyAdapter(fixture);
    const { page } = await seedFanslyPage(testDb.db, testEncryptionKey);
    const app = createTestApp(testDb, adapter);

    const firstRun = await runFollowerSync(app, page.label);
    const firstCheckpoint = await getCheckpoint(testDb.db, page.id, "followers");

    const newFollower: FanslyFollower = {
      id: (BigInt(followersFixture[0]!.id) + 1000n).toString(),
      followerId: (BigInt(followersFixture[0]!.followerId) + 1000n).toString(),
    };
    adapter.setFollowers([newFollower, ...fixture.followers]);
    fixture.accountMe = {
      ...fixture.accountMe,
      account: {
        ...fixture.accountMe.account,
        followCount: fixture.followers.length,
      },
    };

    const secondRun = await runFollowerSync(app, page.label);
    const secondCheckpoint = await getCheckpoint(testDb.db, page.id, "followers");
    const thirdRun = await runFollowerSync(app, page.label);
    const thirdCheckpoint = await getCheckpoint(testDb.db, page.id, "followers");
    const followCount = await testDb.pool.query(
      `select count(*)::int as count from page_follows where platform_account_id = ${page.id}`,
    );

    expect(firstRun.delta).toBe(followersFixture.length);
    expect(firstCheckpoint?.cursorText).toBe(followersFixture[0]!.id);
    expect(secondRun.delta).toBe(1);
    expect(secondCheckpoint?.cursorText).toBe(newFollower.id);
    expect(thirdRun.delta).toBe(0);
    expect(thirdCheckpoint?.cursorText).toBe(newFollower.id);
    expect(followCount.rows[0]?.count).toBe(followersFixture.length + 1);
  });

  it("lists operator read models for models, pages, status, and top fans", async (context) => {
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

    const { model, page } = await seedFanslyPage(testDb.db, testEncryptionKey);
    const secondModel = await createModel(testDb.db, {
      slug: "nova",
      name: "Nova",
    });
    const secondPage = await createFanslyPage(testDb.db, {
      modelId: secondModel.id,
      label: "nova-main",
    });
    const secondLightSyncAt = new Date("2026-03-08T08:00:00.000Z");
    const secondFollowerSyncAt = new Date("2026-03-08T09:00:00.000Z");
    await testDb.pool.query(
      `
        update platform_accounts
        set username = $1,
            follower_count = $2,
            subscriber_count = $3,
            last_light_sync_at = $4,
            last_follower_sync_at = $5
        where id = $6
      `,
      ["nova_verified", 12, 3, secondLightSyncAt, secondFollowerSyncAt, secondPage.id],
    );

    const app = createTestApp(testDb, new FakeFanslyAdapter({
      accountMe: accountMeFixture,
      transactions: transactionsFixture,
      subscribers: subscribersFixture,
      followers: followersFixture,
    }));

    await runAllSync(app, page.label);

    const models = await listModels(app);
    const pages = await listPages(app);
    const status = await listStatus(app, { limit: 5 });
    const filteredStatus = await listStatus(app, { pageLabel: page.label, limit: 1 });
    const fans = await listFans(app, page.label, 5);

    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: model.slug, name: model.name, page_count: 1 }),
      expect.objectContaining({ slug: "nova", name: "Nova", page_count: 1 }),
    ]));
    expect(pages).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: page.label, model: model.slug }),
      expect.objectContaining({
        label: "nova-main",
        model: "nova",
        username: "nova_verified",
        follower_count: 12,
        subscriber_count: 3,
      }),
    ]));
    const listedSecondPage = pages.find((row) => row.label === "nova-main");
    expect(listedSecondPage).toBeDefined();
    expect(new Date(listedSecondPage!.last_light_sync_at as string | Date).toISOString()).toBe(
      secondLightSyncAt.toISOString(),
    );
    expect(new Date(listedSecondPage!.last_follower_sync_at as string | Date).toISOString()).toBe(
      secondFollowerSyncAt.toISOString(),
    );
    expect(status).toHaveLength(2);
    expect(status.map((row) => row.pageLabel)).toEqual([page.label, page.label]);
    expect(status.map((row) => row.stream)).toEqual(["followers", "light"]);
    expect(filteredStatus).toHaveLength(1);
    expect(filteredStatus[0]?.pageLabel).toBe(page.label);
    expect(fans.length).toBeGreaterThan(0);
    expect(typeof fans[0]?.total_creator_net_mills).toBe("bigint");
    for (let index = 1; index < fans.length; index += 1) {
      expect((fans[index - 1]!.total_creator_net_mills as bigint) ?? 0n).toBeGreaterThanOrEqual(
        (fans[index]!.total_creator_net_mills as bigint) ?? 0n,
      );
    }
  });

  it("rejects overlapping syncs for the same page", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const accountMeFixture = JSON.parse(
      await readFile(path.resolve("reference/responses/account_me.json"), "utf8"),
    ).data.response as FanslyAccountMeResponse;
    const entered = deferred();
    const release = deferred();
    const { page } = await seedFanslyPage(testDb.db, testEncryptionKey);
    const app = createTestApp(
      testDb,
      new FakeFanslyAdapter(
        {
          accountMe: accountMeFixture,
          transactions: [],
          subscribers: [],
          followers: [],
        },
        {
          holdAccountMe: {
            onEntered: entered.resolve,
            release: release.promise,
          },
        },
      ),
    );

    const firstRun = runLightSync(app, page.label);
    await entered.promise;

    await expect(runLightSync(app, page.label)).rejects.toBeInstanceOf(PageSyncLockedError);

    release.resolve();
    await firstRun;

    const runCount = await testDb.pool.query("select count(*)::int as count from sync_runs");
    expect(runCount.rows[0]?.count).toBe(1);
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

    const { page } = await seedFanslyPage(testDb.db, testEncryptionKey);
    const app = createTestApp(testDb, new FakeFanslyAdapter({
      accountMe: accountMeFixture,
      transactions: transactionsFixture,
      subscribers: subscribersFixture,
      followers: followersFixture,
    }));

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

    const { page } = await seedFanslyPage(testDb.db, testEncryptionKey);
    const app = createTestApp(testDb, new FakeFanslyAdapter({
      accountMe: accountMeFixture,
      transactions: transactionsFixture,
      subscribers: subscribersFixture,
      followers: followersFixture,
    }));

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

  it("revisits pending transactions older than the lookback when they are still within the cap", async (context) => {
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

    const baseTransaction = seedTransactions[0]!;
    const now = Date.now();
    const newestAt = now - 1 * 24 * 60 * 60 * 1000;
    const oldPendingAt = now - 20 * 24 * 60 * 60 * 1000;
    const initialTransactions = [
      buildTransaction(baseTransaction, {
        transactionId: "tx-recent-posted",
        correlationId: "corr-recent-posted",
        createdAt: newestAt,
        updatedAt: newestAt,
        status: 2,
        type: 15001,
      }),
      buildTransaction(baseTransaction, {
        transactionId: "tx-old-pending",
        correlationId: "corr-old-pending",
        createdAt: oldPendingAt,
        updatedAt: oldPendingAt,
        status: 1,
        type: 7101,
      }),
    ];

    const adapter = new FakeFanslyAdapter({
      accountMe: accountMeFixture,
      transactions: initialTransactions,
      subscribers: [],
      followers: [],
    });
    const { page } = await seedFanslyPage(testDb.db, testEncryptionKey);
    const app = createTestApp(testDb, adapter, {
      transactionLookbackDays: 7,
      transactionRescanCapDays: 30,
    });

    await runLightSync(app, page.label);

    adapter.setTransactions([
      buildTransaction(initialTransactions[0]!, {
        status: 2,
        updatedAt: now,
      }),
      buildTransaction(initialTransactions[1]!, {
        status: 2,
        updatedAt: now,
      }),
    ]);
    adapter.clearTransactionAfterHistory();

    await runLightSync(app, page.label);

    const revisitedAfter = adapter.transactionAfterHistory[0];
    const pendingRow = await testDb.pool.query(`
      select transaction_state
      from transactions
      where platform_account_id = ${page.id}
        and transaction_id = 'tx-old-pending'
    `);

    expect(revisitedAfter?.toISOString()).toBe(new Date(oldPendingAt).toISOString());
    expect(pendingRow.rows[0]?.transaction_state).toBe("posted");
  });

  it("clamps pending-aware rescans at the configured cap and warns once", async (context) => {
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

    const baseTransaction = seedTransactions[0]!;
    const now = Date.now();
    const newestAt = now - 1 * 24 * 60 * 60 * 1000;
    const veryOldPendingAt = now - 40 * 24 * 60 * 60 * 1000;
    const initialTransactions = [
      buildTransaction(baseTransaction, {
        transactionId: "tx-cap-recent",
        correlationId: "corr-cap-recent",
        createdAt: newestAt,
        updatedAt: newestAt,
        status: 2,
      }),
      buildTransaction(baseTransaction, {
        transactionId: "tx-cap-old-pending",
        correlationId: "corr-cap-old-pending",
        createdAt: veryOldPendingAt,
        updatedAt: veryOldPendingAt,
        status: 1,
      }),
    ];

    const adapter = new FakeFanslyAdapter({
      accountMe: accountMeFixture,
      transactions: initialTransactions,
      subscribers: [],
      followers: [],
    });
    const warnSpy = vi.spyOn(testDb.logger, "warn").mockImplementation(() => undefined);
    const { page } = await seedFanslyPage(testDb.db, testEncryptionKey);
    const app = createTestApp(testDb, adapter, {
      transactionLookbackDays: 7,
      transactionRescanCapDays: 30,
    });

    try {
      await runLightSync(app, page.label);

      adapter.setTransactions([
        buildTransaction(initialTransactions[0]!, {
          status: 2,
          updatedAt: now,
        }),
        buildTransaction(initialTransactions[1]!, {
          status: 2,
          updatedAt: now,
        }),
      ]);
      adapter.clearTransactionAfterHistory();

      const beforeSecondRun = Date.now();
      await runLightSync(app, page.label);
      const afterSecondRun = Date.now();

      const requestedAfter = adapter.transactionAfterHistory[0];
      const pendingRow = await testDb.pool.query(`
        select transaction_state
        from transactions
        where platform_account_id = ${page.id}
          and transaction_id = 'tx-cap-old-pending'
      `);

      expect(requestedAfter).not.toBeNull();
      expect(requestedAfter!.getTime()).toBeGreaterThanOrEqual(
        beforeSecondRun - 30 * 24 * 60 * 60 * 1000,
      );
      expect(requestedAfter!.getTime()).toBeLessThanOrEqual(
        afterSecondRun - 30 * 24 * 60 * 60 * 1000,
      );
      expect(pendingRow.rows[0]?.transaction_state).toBe("pending");
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
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

    const { page } = await seedFanslyPage(testDb.db, testEncryptionKey);
    const app = createTestApp(
      testDb,
      new FakeFanslyAdapter(
        {
          accountMe: accountMeFixture,
          transactions: duplicateTransactions(seedTransactions, 150),
          subscribers: subscribersFixture,
          followers: [],
        },
        { failTransactionPage: 2 },
      ),
    );

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
