import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createOnlyFansPage,
  createFanslyPage,
  createModel,
  dailyFollowers,
  dailyRevenue,
  dailySubscribers,
  getCheckpoint,
  pageFollows,
  pageSubscriptions,
  platformAccounts,
  rawPayloads,
  rebuildFollowerRollups,
  rebuildRevenueRollups,
  rebuildSubscriberRollups,
  storePlatformCredentials,
  syncRuns,
  transactions,
  updatePageMetadata,
  upsertTransaction,
} from "@fansly-connect/db";
import type {
  FanslyAccount,
  FanslyAccountMeResponse,
  FanslySubscriber,
  FanslyEarningsTransaction,
  FanslyFollower,
} from "@fansly-connect/fansly";
import type {
  OnlyMonsterAccount,
  OnlyMonsterChargeback,
  OnlyMonsterTransaction,
} from "@fansly-connect/onlyfans";
import { encryptJson } from "@fansly-connect/shared";

import {
  listFans,
  listFollowers,
  listModels,
  listPages,
  listStatus,
  revenueBreakdownForPage,
  runAllSync,
  runFollowerSync,
  runLightSync,
  scheduleExistingPages,
} from "../apps/runtime/src/services/sync.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { applyTestMigrations, startTestDatabase, seedFanslyPage } from "./helpers/db.ts";

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
      ignoreTransactionAfter?: boolean;
      holdAccountMe?: {
        onEntered: () => void;
        release: Promise<void>;
      };
      buildFollowersRawPage?: (input: {
        followers: FanslyFollower[];
        accounts: FanslyAccount[];
      }) => Record<string, unknown>;
    },
  ) {}

  setTransactions(transactions: FanslyEarningsTransaction[]) {
    this.fixture.transactions = transactions;
  }

  setFollowers(followers: FanslyFollower[]) {
    this.fixture.followers = followers;
  }

  setSubscribers(subscribers: FanslySubscriber[]) {
    this.fixture.subscribers = subscribers;
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

    const filtered = params.after && !this.options?.ignoreTransactionAfter
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
    const raw = this.options?.buildFollowersRawPage
      ? this.options.buildFollowersRawPage({ followers: items, accounts })
      : {
        followers: items,
        aggregationData: {
          accounts,
        },
      };
    return {
      total: this.fixture.followers.length,
      items,
      offset,
      done: items.length < limit,
      accounts,
      raw,
    };
  }
}

class FakeOnlyFansAdapter {
  readonly transactionRequestHistory: Array<{
    start: Date;
    end: Date;
    cursor: string | null;
  }> = [];

  readonly chargebackRequestHistory: Array<{
    start: Date;
    end: Date;
    cursor: string | null;
  }> = [];

  constructor(
    private readonly fixture: {
      account: OnlyMonsterAccount;
      transactions: OnlyMonsterTransaction[];
      chargebacks: OnlyMonsterChargeback[];
    },
    private readonly options?: {
      filterByWindow?: boolean;
    },
  ) {}

  setTransactions(transactions: OnlyMonsterTransaction[]) {
    this.fixture.transactions = transactions;
  }

  setChargebacks(chargebacks: OnlyMonsterChargeback[]) {
    this.fixture.chargebacks = chargebacks;
  }

  clearRequestHistory() {
    this.transactionRequestHistory.length = 0;
    this.chargebackRequestHistory.length = 0;
  }

  async getAccount() {
    return {
      parsed: {
        account: this.fixture.account,
      },
      raw: {
        account: this.fixture.account,
      },
    };
  }

  async getTransactionsPage(
    _: unknown,
    __: string,
    params: { start: Date; end: Date; cursor?: string | null; limit?: number },
  ) {
    this.transactionRequestHistory.push({
      start: params.start,
      end: params.end,
      cursor: params.cursor ?? null,
    });
    const limit = params.limit ?? 100;
    const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0;
    const filtered = this.options?.filterByWindow
      ? this.fixture.transactions.filter((item) => {
        const occurredAt = Date.parse(item.timestamp);
        return occurredAt >= params.start.getTime() && occurredAt < params.end.getTime();
      })
      : this.fixture.transactions;
    const items = filtered.slice(offset, offset + limit);
    const nextOffset = offset + items.length;

    return {
      parsed: {
        items,
        cursor: nextOffset < filtered.length ? String(nextOffset) : undefined,
      },
      raw: {
        items,
        cursor: nextOffset < filtered.length ? String(nextOffset) : undefined,
      },
    };
  }

  async getChargebacksPage(
    _: unknown,
    __: string,
    params: { start: Date; end: Date; cursor?: string | null; limit?: number },
  ) {
    this.chargebackRequestHistory.push({
      start: params.start,
      end: params.end,
      cursor: params.cursor ?? null,
    });
    const limit = params.limit ?? 100;
    const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0;
    const filtered = this.options?.filterByWindow
      ? this.fixture.chargebacks.filter((item) => {
        const occurredAt = Date.parse(item.chargeback_timestamp);
        return occurredAt >= params.start.getTime() && occurredAt < params.end.getTime();
      })
      : this.fixture.chargebacks;
    const items = filtered.slice(offset, offset + limit);
    const nextOffset = offset + items.length;

    return {
      parsed: {
        items,
        cursor: nextOffset < filtered.length ? String(nextOffset) : undefined,
      },
      raw: {
        items,
        cursor: nextOffset < filtered.length ? String(nextOffset) : undefined,
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

function mockStdoutWrite(lines: string[]) {
  return vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, cb?: unknown) => {
    lines.push(String(chunk));
    if (typeof cb === "function") {
      cb();
    }
    return true;
  }) as typeof process.stdout.write);
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
    db?: AppContext["db"];
    logger?: StartedTestDatabase["logger"];
    transactionLookbackDays?: number;
    transactionRescanCapDays?: number;
    onlyFansAdapter?: AppContext["onlyFansAdapter"];
  },
) {
  return {
    db: overrides?.db ?? testDb.db,
    pool: testDb.pool,
    logger: overrides?.logger ?? testDb.logger,
    config: {
      databaseUrl: "",
      encryptionKey: testEncryptionKey,
      encryptionKeyVersion: 1,
      logLevel: "silent",
      apiHost: "0.0.0.0",
      apiPort: 3000,
      sessionTtlDays: 30,
      fanslyBaseUrl: "https://example.invalid",
      onlyMonsterBaseUrl: "https://example.invalid",
      syncHttpTraceFile: null,
      followerPageDelayMs: 0,
      transactionLookbackDays: overrides?.transactionLookbackDays ?? 7,
      transactionRescanCapDays: overrides?.transactionRescanCapDays ?? 30,
      syncObservabilityRetentionDays: 30,
    },
    adapter,
    onlyFansAdapter: overrides?.onlyFansAdapter ?? ({} as never),
    async close() {},
  };
}

function createRawPayloadInsertFailureDb(
  db: AppContext["db"],
  input: {
    error: Error;
    endpoint: string;
    payloadKind?: string;
    failTimes?: number;
  },
) {
  let failuresRemaining = input.failTimes ?? 1;

  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "insert") {
        return Reflect.get(target, prop, receiver);
      }

      return (table: unknown) => {
        const realBuilder = target.insert(table as never);
        if (table !== rawPayloads) {
          return realBuilder;
        }

        return {
          ...realBuilder,
          values(values: Record<string, unknown>) {
            if (
              failuresRemaining > 0 &&
              values.endpoint === input.endpoint &&
              values.payloadKind === (input.payloadKind ?? "mapping_critical")
            ) {
              failuresRemaining -= 1;
              return Promise.reject(input.error);
            }

            return realBuilder.values(values as never);
          },
        };
      };
    },
  });
}

async function seedOnlyFansPage(testDb: StartedTestDatabase, label: string) {
  const model = await createModel(testDb.db, {
    slug: `${label}-model`,
    name: `${label} Model`,
  });
  const page = await createOnlyFansPage(testDb.db, {
    modelId: model.id,
    label,
  });

  await storePlatformCredentials(testDb.db, {
    platformAccountId: page.id,
    encryptedSession: JSON.stringify(encryptJson({
      platform: "onlyfans",
      auth: {
        token: "om-token",
      },
    }, testEncryptionKey, 1)),
    keyVersion: 1,
  });
  await updatePageMetadata(testDb.db, page.id, {
    platformAccountIdValue: `of-${label}`,
    username: label,
    displayName: label,
    followerCount: 0,
    subscriberCount: 0,
    earningsBalanceMills: 0n,
    metadata: {
      onlyMonsterAccountId: 42,
    },
    syncType: "light",
  });

  return { model, page };
}

function createUnusedFanslyAdapter() {
  return new FakeFanslyAdapter({
    accountMe: {
      account: {
        id: "unused",
        username: "unused",
        displayName: null,
        createdAt: 0,
        followCount: 0,
        subscriberCount: 0,
        earningsWallet: null,
      },
    },
    transactions: [],
    subscribers: [],
    followers: [],
  });
}

describe("sync integration", () => {
  let testDb: Awaited<ReturnType<typeof startTestDatabase>> | null = null;
  const expectedRevenueNetTotal = 238392n;
  const expectedRevenueGrossTotal = 297990n;

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
      truncate fan_flags, fan_summaries, fan_notes, audit_events, api_keys,
               auth_sessions, user_page_assignments, users, fan_username_aliases,
               spender_projection_watermarks, spender_lifetime_page, spender_daily_facts,
               daily_revenue,
               daily_followers, daily_subscribers, transactions, page_subscriptions,
               page_follows, fan_pages, fans, raw_payloads, sync_checkpoints,
               sync_runs, platform_account_proxies, platform_account_credentials,
               platform_accounts, models
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
    const revenueRows = await testDb.pool.query(`
      select coalesce(sum(gross_amount_mills), 0)::bigint as gross_total,
             coalesce(sum(creator_net_amount_mills), 0)::bigint as net_total
      from daily_revenue
    `);
    const followerRollupRows = await testDb.pool.query(
      "select coalesce(sum(new_followers), 0)::int as total from daily_followers",
    );
    const subscriberRollupRows = await testDb.pool.query(
      "select max(active_subscribers)::int as total from daily_subscribers",
    );

    expect(transactionCount.rows[0]?.count).toBe(transactionsFixture.length);
    expect(followCount.rows[0]?.count).toBe(followersFixture.length);
    expect(subscriptionCount.rows[0]?.count).toBe(subscribersFixture.length);
    expect(BigInt(revenueRows.rows[0]?.gross_total ?? 0)).toBe(expectedRevenueGrossTotal);
    expect(BigInt(revenueRows.rows[0]?.net_total ?? 0)).toBe(expectedRevenueNetTotal);
    expect(followerRollupRows.rows[0]?.total).toBe(followersFixture.length);
    expect(subscriberRollupRows.rows[0]?.total).toBe(subscribersFixture.length);

    const stateRows = await testDb.pool.query(
      "select distinct transaction_state from daily_revenue order by transaction_state",
    );
    expect(stateRows.rows.map((row: { transaction_state: string }) => row.transaction_state)).toEqual(["pending", "posted"]);
  });

  it("derives Fansly gross from destination tax while preserving the source net fields", async (context) => {
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

    const { page } = await seedFanslyPage(testDb.db, testEncryptionKey);
    const app = createTestApp(testDb, new FakeFanslyAdapter({
      accountMe: accountMeFixture,
      transactions: transactionsFixture,
      subscribers: [],
      followers: [],
    }));

    await runLightSync(app, page.label);

    const txRows = await testDb.pool.query(`
      select transaction_id,
             gross_amount_mills,
             source_destination_amount_mills,
             creator_net_amount_mills,
             raw_destination_tax
      from transactions
      where platform_account_id = ${page.id}
        and transaction_id in ('883584486774681600', '881649113408479232')
      order by transaction_id asc
    `);

    expect(txRows.rows).toEqual([
      {
        transaction_id: "881649113408479232",
        gross_amount_mills: 13990n,
        source_destination_amount_mills: 11192n,
        creator_net_amount_mills: 11192n,
        raw_destination_tax: 2000,
      },
      {
        transaction_id: "883584486774681600",
        gross_amount_mills: 20000n,
        source_destination_amount_mills: 16000n,
        creator_net_amount_mills: 16000n,
        raw_destination_tax: 2000,
      },
    ]);
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

  it("stores trimmed follower raw payloads with mapper fields only", async (context) => {
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
    const sampleFollowers = followersFixture.slice(0, 2);
    const { page } = await seedFanslyPage(testDb.db, testEncryptionKey);
    const app = createTestApp(
      testDb,
      new FakeFanslyAdapter(
        {
          accountMe: {
            ...accountMeFixture,
            account: {
              ...accountMeFixture.account,
              followCount: sampleFollowers.length,
            },
          },
          transactions: [],
          subscribers: [],
          followers: sampleFollowers,
        },
        {
          buildFollowersRawPage: ({ followers, accounts }) => ({
            followers,
            aggregationData: {
              accounts: accounts.map((account) => ({
                ...account,
                profile: {
                  bio: "extra",
                  media: [{
                    id: "profile-media-1",
                    url: "https://example.invalid/profile-media-1",
                  }],
                },
              })),
              accountMediaBundles: [{
                id: "bundle-1",
                items: [{
                  id: "bundle-item-1",
                  url: "https://example.invalid/bundle-item-1",
                }],
              }],
            },
            accountMedia: [{
              id: "account-media-1",
              url: "https://example.invalid/account-media-1",
            }],
            extraBlock: {
              nested: true,
            },
          }),
        },
      ),
    );

    const result = await runFollowerSync(app, page.label);
    const payloadRows = await testDb.pool.query(
      `select response_payload
       from raw_payloads
       where platform_account_id = ${page.id}
         and endpoint = 'followers'
         and payload_kind = 'mapping_critical'
       order by id desc
       limit 1`,
    );

    expect(result.status).toBe("success");
    expect(payloadRows.rows).toHaveLength(1);
    expect(payloadRows.rows[0]?.response_payload).toEqual({
      followers: sampleFollowers,
      aggregationData: {
        accounts: sampleFollowers.map((follower) => ({
          id: follower.followerId,
          username: `fan_${follower.followerId.slice(-4)}`,
          displayName: `Fan ${follower.followerId.slice(-4)}`,
          createdAt: 1770000000000,
        })),
      },
    });
  });

  it("bounds failed follower persistence diagnostics and strips query text", async (context) => {
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
    const sampleFollowers = followersFixture.slice(0, 2);
    const hugeParams = "payload-fragment-".repeat(300);
    const drizzleError = new Error(
      `Failed query: insert into raw_payloads values (...) returning * params: [${hugeParams}]`,
    );
    drizzleError.name = "DrizzleQueryError";
    (drizzleError as Error & { cause: { code: string } }).cause = { code: "54000" };

    const { page } = await seedFanslyPage(testDb.db, testEncryptionKey);
    const app = createTestApp(
      testDb,
      new FakeFanslyAdapter({
        accountMe: {
          ...accountMeFixture,
          account: {
            ...accountMeFixture.account,
            followCount: sampleFollowers.length,
          },
        },
        transactions: [],
        subscribers: [],
        followers: sampleFollowers,
      }),
      {
        db: createRawPayloadInsertFailureDb(testDb.db, {
          error: drizzleError,
          endpoint: "followers",
        }) as AppContext["db"],
      },
    );

    await expect(runFollowerSync(app, page.label)).rejects.toThrow(
      "Failed to persist raw payload while inserting followers raw payload",
    );

    const runRows = await testDb.pool.query(
      `select id, status, error_summary, stats
       from sync_runs
       where platform_account_id = ${page.id}
       order by id desc
       limit 1`,
    );
    const failedPayloadRows = await testDb.pool.query(
      `select error_message, response_payload
       from raw_payloads
       where platform_account_id = ${page.id}
         and endpoint = 'followers'
         and payload_kind = 'failed'
       order by id desc
       limit 1`,
    );
    const eventRows = await testDb.pool.query(
      `select details
       from sync_run_events
       where sync_run_id = ${runRows.rows[0]!.id}
         and event_type = 'run_finished'
       order by id desc
       limit 1`,
    );

    expect(runRows.rows).toHaveLength(1);
    expect(runRows.rows[0]?.status).toBe("failed");
    expect(runRows.rows[0]?.error_summary).toBe(
      "DrizzleQueryError while inserting followers raw payload (54000)",
    );
    expect(runRows.rows[0]?.error_summary.length).toBeLessThanOrEqual(1024);
    expect(runRows.rows[0]?.error_summary).not.toContain("Failed query:");
    expect(runRows.rows[0]?.error_summary).not.toContain("params:");
    expect(runRows.rows[0]?.stats.errorSummary).toBeUndefined();
    expect(runRows.rows[0]?.stats.error).toMatchObject({
      type: "DrizzleQueryError",
      summary: "DrizzleQueryError while inserting followers raw payload (54000)",
      endpoint: "followers",
      code: "54000",
      truncated: true,
    });
    expect(runRows.rows[0]?.stats.error.originalMessageLength).toBeGreaterThan(1024);

    expect(failedPayloadRows.rows).toHaveLength(1);
    expect(failedPayloadRows.rows[0]?.error_message).toBe(
      "DrizzleQueryError while inserting followers raw payload (54000)",
    );
    expect(failedPayloadRows.rows[0]?.error_message.length).toBeLessThanOrEqual(1024);
    expect(failedPayloadRows.rows[0]?.response_payload).toMatchObject({
      error: {
        type: "DrizzleQueryError",
        summary: "DrizzleQueryError while inserting followers raw payload (54000)",
        endpoint: "followers",
        code: "54000",
        truncated: true,
      },
    });

    expect(eventRows.rows).toHaveLength(1);
    expect(eventRows.rows[0]?.details.error).toMatchObject({
      type: "DrizzleQueryError",
      summary: "DrizzleQueryError while inserting followers raw payload (54000)",
      endpoint: "followers",
      code: "54000",
      truncated: true,
    });
    expect(JSON.stringify(eventRows.rows[0]?.details)).not.toContain("Failed query:");
    expect(JSON.stringify(eventRows.rows[0]?.details)).not.toContain("params:");
    expect(JSON.stringify(eventRows.rows[0]?.details)).not.toContain(hugeParams);
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

  it("reconciles follower removals when the authoritative count drops", async (context) => {
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

    await runFollowerSync(app, page.label);

    fixture.followers = followersFixture.slice(0, 1);
    fixture.accountMe = {
      ...fixture.accountMe,
      account: {
        ...fixture.accountMe.account,
        followCount: fixture.followers.length,
      },
    };

    const secondRun = await runFollowerSync(app, page.label);
    const activeFollowers = await listFollowers(app, page.label);
    const followRows = await testDb.pool.query(`
      select (count(*) filter (where is_active))::int as active_count,
             (count(*) filter (where not is_active))::int as inactive_count
      from page_follows
      where platform_account_id = ${page.id}
    `);

    expect(secondRun.delta).toBe(0);
    expect(activeFollowers).toHaveLength(1);
    expect(activeFollowers[0]?.platform_user_id).toBe(fixture.followers[0]!.followerId);
    expect(followRows.rows[0]?.active_count).toBe(1);
    expect(followRows.rows[0]?.inactive_count).toBe(followersFixture.length - 1);
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

  it("records operator-facing request telemetry for a healthy light run", async (context) => {
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

    const { page } = await seedFanslyPage(testDb.db, testEncryptionKey);
    const app = createTestApp(testDb, new FakeFanslyAdapter({
      accountMe: accountMeFixture,
      transactions: transactionsFixture,
      subscribers: subscribersFixture,
      followers: [],
    }));

    const stdoutLines: string[] = [];
    const stdoutSpy = mockStdoutWrite(stdoutLines);
    const result = await runLightSync(app, page.label);
    stdoutSpy.mockRestore();
    const attemptRows = await testDb.pool.query(`
      select operation, state, request_shape
      from sync_request_attempts
      where sync_run_id = ${result.runId}
      order by id asc
    `);
    const eventRows = await testDb.pool.query(`
      select event_type
      from sync_run_events
      where sync_run_id = ${result.runId}
      order by id asc
    `);
    const runRow = await testDb.pool.query(`
      select stats->>'health' as health
      from sync_runs
      where id = ${result.runId}
    `);
    const traceRecords = stdoutLines
      .flatMap((line) => line.split("\n"))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const accountLookupTrace = traceRecords.find((record) =>
      record.component === "sync_http" && record.operation === "account_lookup"
    ) as Record<string, unknown> | undefined;
    const summaryTrace = traceRecords.find((record) =>
      record.component === "sync_http_summary"
    ) as Record<string, unknown> | undefined;

    expect(result.status).toBe("success");
    expect(result.stats.health).toBe("healthy");
    expect(runRow.rows[0]?.health).toBe("healthy");
    expect(attemptRows.rows.map((row: { operation: string }) => row.operation)).toEqual(
      expect.arrayContaining(["account_me", "earnings_transactions", "subscribers", "account_lookup"]),
    );
    expect(
      attemptRows.rows.find((row: { operation: string }) => row.operation === "account_lookup")?.request_shape,
    ).toMatchObject({
      idsCount: expect.any(Number),
    });
    expect(
      attemptRows.rows.find((row: { operation: string }) => row.operation === "account_lookup")?.request_shape?.ids,
    ).toBeUndefined();
    expect(eventRows.rows.map((row: { event_type: string }) => row.event_type)).toEqual(
      expect.arrayContaining([
        "run_started",
        "phase_started",
        "checkpoint_loaded",
        "checkpoint_advanced",
        "run_finished",
      ]),
    );
    expect(accountLookupTrace).toMatchObject({
      component: "sync_http",
      endpointTemplate: "/account",
      idsCount: expect.any(Number),
    });
    expect(accountLookupTrace?.ids).toBeUndefined();
    expect(summaryTrace).toMatchObject({
      component: "sync_http_summary",
      provider: "fansly",
      runId: result.runId,
      pageLabel: page.label,
      stream: "light",
      totalAttempts: expect.any(Number),
      totalRequestDurationMs: expect.any(Number),
      totalSyncDurationMs: expect.any(Number),
    });
    const serializedTrace = JSON.stringify(traceRecords);
    expect(serializedTrace).not.toContain("authorization");
    expect(serializedTrace).not.toContain("fansly-session-id");
  });

  it("flags after_ineffective when Fansly ignores the lower-bound filter", async (context) => {
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
    const recentAt = now - 2 * 24 * 60 * 60 * 1000;
    const oldAt = now - 25 * 24 * 60 * 60 * 1000;
    const adapter = new FakeFanslyAdapter(
      {
        accountMe: accountMeFixture,
        transactions: [
          buildTransaction(baseTransaction, {
            transactionId: "recent-checkpoint",
            correlationId: "recent-checkpoint",
            createdAt: recentAt,
            updatedAt: recentAt,
          }),
        ],
        subscribers: [],
        followers: [],
      },
      {
        ignoreTransactionAfter: true,
      },
    );
    const { page } = await seedFanslyPage(testDb.db, testEncryptionKey);
    const app = createTestApp(testDb, adapter, {
      transactionLookbackDays: 7,
      transactionRescanCapDays: 30,
    });

    await runLightSync(app, page.label);

    adapter.setTransactions(Array.from({ length: 150 }, (_, index) => buildTransaction(baseTransaction, {
      transactionId: `old-ignored-${index}`,
      correlationId: `old-ignored-${index}`,
      createdAt: oldAt + index,
      updatedAt: oldAt + index,
    })));

    const result = await runLightSync(app, page.label);
    const anomalyCodes = (result.stats.anomalies as Array<{ code: string }>).map((entry) => entry.code);

    expect(result.status).toBe("success");
    expect(result.stats.health).toBe("suspicious");
    expect(anomalyCodes).toEqual(expect.arrayContaining(["after_ineffective", "checkpoint_stalled"]));
  });

  it("keeps current subscribers when a sync returns an unexpected empty page", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const accountMeFixture = JSON.parse(
      await readFile(path.resolve("reference/responses/account_me.json"), "utf8"),
    ).data.response as FanslyAccountMeResponse;
    const subscribersFixture = JSON.parse(
      await readFile(path.resolve("reference/responses/subscribers.json"), "utf8"),
    ).data.response.subscriptions as FanslySubscriber[];

    const fixture = {
      accountMe: accountMeFixture,
      transactions: [] as FanslyEarningsTransaction[],
      subscribers: [...subscribersFixture],
      followers: [] as FanslyFollower[],
    };

    const adapter = new FakeFanslyAdapter(fixture);
    const { page } = await seedFanslyPage(testDb.db, testEncryptionKey);
    const app = createTestApp(testDb, adapter);

    const firstRun = await runLightSync(app, page.label);
    adapter.setSubscribers([]);
    const secondRun = await runLightSync(app, page.label);
    const currentSubscriptions = await testDb.pool.query(`
      select count(*)::int as count
      from page_subscriptions
      where platform_account_id = ${page.id}
        and is_current = true
    `);

    expect(firstRun.status).toBe("success");
    expect(secondRun.status).toBe("partial");
    expect(secondRun.errors).toContain(
      "subscribers: Subscriber sync returned zero rows; refusing to clear existing current subscriptions",
    );
    expect(currentSubscriptions.rows[0]?.count).toBe(subscribersFixture.length);
  });

  it("records skipped runs when a sync overlaps the page lock", async (context) => {
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

    const skippedRun = await runLightSync(app, page.label);

    release.resolve();
    await firstRun;

    const runRows = await testDb.pool.query(`
      select status, error_summary, stats->>'health' as health
      from sync_runs
      order by id asc
    `);
    expect(skippedRun.status).toBe("skipped");
    expect(runRows.rows).toHaveLength(2);
    expect(runRows.rows[1]).toMatchObject({
      status: "skipped",
      error_summary: "Skipped sync because the page lock is already held",
      health: "degraded",
    });
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
      select raw_type, canonical_type, creator_net_amount_mills as net_amount_mills
      from transactions
      where raw_type = '16013'
    `);
    const payoutRollupRows = await testDb.pool.query(`
      select count(*)::int as count
      from daily_revenue
      where canonical_type = 'payout_reversal'
    `);
    const totalRevenueRows = await testDb.pool.query(`
      select coalesce(sum(gross_amount_mills), 0)::bigint as gross_total,
             coalesce(sum(creator_net_amount_mills), 0)::bigint as net_total
      from daily_revenue
    `);
    const breakdown = await revenueBreakdownForPage(app, page.label, "all");

    expect(payoutRows.rowCount).toBe(1);
    expect(payoutRows.rows[0]).toMatchObject({
      raw_type: "16013",
      canonical_type: "payout_reversal",
    });
    expect(BigInt(payoutRows.rows[0]?.net_amount_mills ?? 0)).toBe(331000n);
    expect(payoutRollupRows.rows[0]?.count).toBe(0);
    expect(BigInt(totalRevenueRows.rows[0]?.gross_total ?? 0)).toBe(expectedRevenueGrossTotal);
    expect(BigInt(totalRevenueRows.rows[0]?.net_total ?? 0)).toBe(expectedRevenueNetTotal);
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
             coalesce(sum(gross_amount_mills), 0)::bigint as gross_total,
             coalesce(sum(creator_net_amount_mills), 0)::bigint as net_total
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
    expect(BigInt(revenueRows.rows[0]?.gross_total ?? 0)).toBe(expectedRevenueGrossTotal);
    expect(BigInt(revenueRows.rows[0]?.net_total ?? 0)).toBe(expectedRevenueNetTotal);
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

  it("requires a manual OnlyFans rescan start to recover late historical transactions outside the lookback", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));

    try {
      const { page } = await seedOnlyFansPage(testDb, "late-of");
      const onlyFansAdapter = new FakeOnlyFansAdapter({
        account: {
          id: 42,
          platform_account_id: "of-late-of",
          platform: "onlyfans",
          name: "late-of",
          email: null,
          avatar: "https://example.com/late-of.png",
          username: "late-of",
          organisation_id: "org-1",
          subscribe_price: 12.5,
          subscription_expiration_date: null,
        },
        transactions: [
          {
            id: "recent-tx",
            amount: 12.5,
            fan: { id: "fan-of-1" },
            type: "Tip from",
            status: "done",
            timestamp: "2026-03-08T19:04:49.000Z",
          },
        ],
        chargebacks: [],
      }, {
        filterByWindow: true,
      });

      const app = createTestApp(testDb, createUnusedFanslyAdapter(), {
        onlyFansAdapter: onlyFansAdapter as unknown as AppContext["onlyFansAdapter"],
      });

      await runLightSync(app, page.label);

      onlyFansAdapter.setTransactions([
        {
          id: "late-tx",
          amount: 35,
          fan: { id: "fan-of-2" },
          type: "Payment for message",
          status: "done",
          timestamp: "2026-02-07T00:10:15.000Z",
        },
        {
          id: "recent-tx",
          amount: 12.5,
          fan: { id: "fan-of-1" },
          type: "Tip from",
          status: "done",
          timestamp: "2026-03-08T19:04:49.000Z",
        },
      ]);
      onlyFansAdapter.clearRequestHistory();

      await runLightSync(app, page.label);

      const afterOrdinaryRerun = await testDb.pool.query(`
        select transaction_id
        from transactions
        where platform_account_id = ${page.id}
        order by transaction_id asc
      `);

      expect(onlyFansAdapter.transactionRequestHistory[0]?.start.toISOString()).toBe("2026-03-01T19:04:49.000Z");
      expect(afterOrdinaryRerun.rows).toEqual([
        {
          transaction_id: "recent-tx",
        },
      ]);

      onlyFansAdapter.clearRequestHistory();

      await runLightSync(app, page.label, {
        onlyFansTransactionStart: new Date("2026-02-07T00:00:00.000Z"),
      });

      const afterManualBackfill = await testDb.pool.query(`
        select transaction_id
        from transactions
        where platform_account_id = ${page.id}
        order by transaction_id asc
      `);

      expect(onlyFansAdapter.transactionRequestHistory[0]?.start.toISOString()).toBe("2026-02-07T00:00:00.000Z");
      expect(afterManualBackfill.rows).toEqual([
        {
          transaction_id: "late-tx",
        },
        {
          transaction_id: "recent-tx",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("floors the initial OnlyFans rescan cap to the start of the UTC day", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T11:19:02.676Z"));

    try {
      const { page } = await seedOnlyFansPage(testDb, "initial-window-of");
      const onlyFansAdapter = new FakeOnlyFansAdapter({
        account: {
          id: 42,
          platform_account_id: "of-initial-window-of",
          platform: "onlyfans",
          name: "initial-window-of",
          email: null,
          avatar: "https://example.com/initial-window-of.png",
          username: "initial-window-of",
          organisation_id: "org-1",
          subscribe_price: 12.5,
          subscription_expiration_date: null,
        },
        transactions: [
          {
            id: "too-old-tx",
            amount: 10,
            fan: { id: "fan-of-0" },
            type: "Tip from",
            status: "done",
            timestamp: "2026-02-06T23:59:59.000Z",
          },
          {
            id: "cap-day-early-tx",
            amount: 15,
            fan: { id: "fan-of-1" },
            type: "Payment for message",
            status: "done",
            timestamp: "2026-02-07T00:10:15.000Z",
          },
          {
            id: "cap-day-late-tx",
            amount: 20,
            fan: { id: "fan-of-2" },
            type: "Tip from",
            status: "done",
            timestamp: "2026-02-07T13:15:05.000Z",
          },
          {
            id: "recent-tx",
            amount: 25,
            fan: { id: "fan-of-3" },
            type: "Subscription",
            status: "done",
            timestamp: "2026-03-08T19:04:49.000Z",
          },
        ],
        chargebacks: [],
      }, {
        filterByWindow: true,
      });

      const app = createTestApp(testDb, createUnusedFanslyAdapter(), {
        onlyFansAdapter: onlyFansAdapter as unknown as AppContext["onlyFansAdapter"],
      });

      await runLightSync(app, page.label);

      const rows = await testDb.pool.query(`
        select transaction_id
        from transactions
        where platform_account_id = ${page.id}
        order by transaction_id asc
      `);

      expect(onlyFansAdapter.transactionRequestHistory[0]?.start.toISOString()).toBe("2026-02-07T00:00:00.000Z");
      expect(onlyFansAdapter.chargebackRequestHistory[0]?.start.toISOString()).toBe("2026-02-07T00:00:00.000Z");
      expect(rows.rows).toEqual([
        {
          transaction_id: "cap-day-early-tx",
        },
        {
          transaction_id: "cap-day-late-tx",
        },
        {
          transaction_id: "recent-tx",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves existing OnlyFans window transactions when the transaction fetch is empty", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));

    try {
      const { page } = await seedOnlyFansPage(testDb, "chargeback-of");
      const onlyFansAdapter = new FakeOnlyFansAdapter({
        account: {
          id: 42,
          platform_account_id: "of-chargeback-of",
          platform: "onlyfans",
          name: "chargeback-of",
          email: null,
          avatar: "https://example.com/chargeback-of.png",
          username: "chargeback-of",
          organisation_id: "org-1",
          subscribe_price: 12.5,
          subscription_expiration_date: null,
        },
        transactions: [
          {
            id: "vip-subscription",
            amount: 4.99,
            fan: { id: "fan-of-1" },
            type: "Subscription",
            status: "done",
            timestamp: "2026-03-07T09:01:45.000Z",
          },
        ],
        chargebacks: [],
      }, {
        filterByWindow: true,
      });

      const app = createTestApp(testDb, createUnusedFanslyAdapter(), {
        onlyFansAdapter: onlyFansAdapter as unknown as AppContext["onlyFansAdapter"],
      });

      await runLightSync(app, page.label);

      onlyFansAdapter.setTransactions([]);
      onlyFansAdapter.setChargebacks([
        {
          id: "vip-chargeback",
          amount: 4.99,
          fan: { id: "fan-of-1" },
          type: "Subscription",
          status: "undo",
          chargeback_timestamp: "2026-03-08T04:06:31.000Z",
          transaction_timestamp: "2026-03-07T09:01:45.000Z",
        },
      ]);
      onlyFansAdapter.clearRequestHistory();

      await runLightSync(app, page.label);

      const txRows = await testDb.pool.query(`
        select transaction_id,
               canonical_type,
               gross_amount_mills as amount_mills,
               creator_net_amount_mills as net_amount_mills
        from transactions
        where platform_account_id = ${page.id}
        order by transaction_id asc
      `);
      const checkpoint = await getCheckpoint(testDb.db, page.id, "transactions");

      expect(onlyFansAdapter.transactionRequestHistory[0]?.start.toISOString()).toBe("2026-02-28T09:01:45.000Z");
      expect(txRows.rows).toEqual([
        {
          transaction_id: "vip-chargeback",
          canonical_type: "chargeback",
          amount_mills: -4990n,
          net_amount_mills: -3990n,
        },
        {
          transaction_id: "vip-subscription",
          canonical_type: "subscription",
          amount_mills: 4990n,
          net_amount_mills: 3990n,
        },
      ]);
      expect(checkpoint?.cursorTimestamp?.toISOString()).toBe("2026-03-08T04:06:31.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("syncs OnlyFans revenue and chargebacks without follower work", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));

    try {
      const { page } = await seedOnlyFansPage(testDb, "lora-of");
      const onlyFansAdapter = new FakeOnlyFansAdapter({
        account: {
          id: 42,
          platform_account_id: "of-lora-of",
          platform: "onlyfans",
          name: "Lora OF",
          email: null,
          avatar: "https://example.com/lora.png",
          username: "lora_of",
          organisation_id: "org-1",
          subscribe_price: 12.5,
          subscription_expiration_date: null,
        },
        transactions: [
          {
            id: "of-tx-1",
            amount: 12.5,
            fan: { id: "fan-of-1" },
            type: "Tip from",
            status: "loading",
            timestamp: "2026-03-05T12:00:00.000Z",
          },
          {
            id: "of-tx-2",
            amount: 5,
            fan: { id: "fan-of-2" },
            type: "Subscription",
            status: "done",
            timestamp: "2026-03-06T12:00:00.000Z",
          },
        ],
        chargebacks: [
          {
            id: "of-cb-1",
            amount: 2.5,
            fan: { id: "fan-of-1" },
            type: "Tip from",
            status: "undo",
            chargeback_timestamp: "2026-03-07T12:00:00.000Z",
            transaction_timestamp: "2026-03-05T12:00:00.000Z",
          },
        ],
      }, {
        filterByWindow: true,
      });

      const app = createTestApp(testDb, createUnusedFanslyAdapter(), {
        onlyFansAdapter: onlyFansAdapter as unknown as AppContext["onlyFansAdapter"],
      });

      const first = await runAllSync(app, page.label);
      const second = await runLightSync(app, page.label);
      const checkpoint = await getCheckpoint(testDb.db, page.id, "transactions");
      const txRows = await testDb.pool.query(`
        select transaction_id,
               raw_type,
               canonical_type,
               gross_amount_mills as amount_mills,
               source_destination_amount_mills as destination_amount_mills,
               creator_net_amount_mills as net_amount_mills
        from transactions
        where platform_account_id = ${page.id}
        order by transaction_id asc
      `);
      const fanRows = await testDb.pool.query(`
        select platform, platform_user_id, username
        from fans
        where platform = 'onlyfans'
        order by platform_user_id asc
      `);
      const revenue = await revenueBreakdownForPage(app, page.label, "all");

      expect(first.followers).toBeNull();
      expect(second.status).toBe("success");
      expect(txRows.rows).toEqual([
        {
          transaction_id: "of-cb-1",
          raw_type: "Tip from",
          canonical_type: "chargeback",
          amount_mills: -2500n,
          destination_amount_mills: -2500n,
          net_amount_mills: -2000n,
        },
        {
          transaction_id: "of-tx-1",
          raw_type: "Tip from",
          canonical_type: "tip",
          amount_mills: 12500n,
          destination_amount_mills: 12500n,
          net_amount_mills: 10000n,
        },
        {
          transaction_id: "of-tx-2",
          raw_type: "Subscription",
          canonical_type: "subscription",
          amount_mills: 5000n,
          destination_amount_mills: 5000n,
          net_amount_mills: 4000n,
        },
      ]);
      expect(fanRows.rows).toEqual([
        {
          platform: "onlyfans",
          platform_user_id: "fan-of-1",
          username: null,
        },
        {
          platform: "onlyfans",
          platform_user_id: "fan-of-2",
          username: null,
        },
      ]);
      expect(revenue.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            canonicalType: "tip",
            bucket: "revenue",
            netAmountMills: 10000n,
          }),
          expect.objectContaining({
            canonicalType: "subscription",
            bucket: "revenue",
            netAmountMills: 4000n,
          }),
          expect.objectContaining({
            canonicalType: "chargeback",
            bucket: "adjustment",
            netAmountMills: -2000n,
          }),
        ]),
      );
      expect(checkpoint?.cursorTimestamp?.toISOString()).toBe("2026-03-07T12:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedules light sync for all platforms and discovers new pages without duplicate registrations", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const { page: fanslyPage } = await seedFanslyPage(testDb.db, testEncryptionKey);
    await seedOnlyFansPage(testDb, "worker-existing-of");

    const schedules: string[] = [];
    const workers: string[] = [];
    const boss = {
      async schedule(name: string) {
        schedules.push(name);
      },
      async work(name: string) {
        workers.push(name);
      },
    };

    const app = createTestApp(testDb, createUnusedFanslyAdapter(), {
      onlyFansAdapter: {} as AppContext["onlyFansAdapter"],
    });

    const scheduler = await scheduleExistingPages(app, boss);

    expect(schedules).toContain(`fansly.sync.light.${fanslyPage.label}`);
    expect(schedules).toContain(`fansly.sync.followers.${fanslyPage.label}`);
    expect(schedules).toContain("onlyfans.sync.light.worker-existing-of");
    expect(schedules).not.toContain("onlyfans.sync.followers.worker-existing-of");
    expect(workers).toContain(`fansly.sync.light.${fanslyPage.label}`);
    expect(workers).toContain(`fansly.sync.followers.${fanslyPage.label}`);
    expect(workers).toContain("onlyfans.sync.light.worker-existing-of");

    await seedOnlyFansPage(testDb, "worker-new-of");
    await scheduler.discoverPages();

    expect(schedules.filter((name) => name === `fansly.sync.light.${fanslyPage.label}`)).toHaveLength(1);
    expect(schedules.filter((name) => name === "onlyfans.sync.light.worker-new-of")).toHaveLength(1);
    expect(workers.filter((name) => name === "onlyfans.sync.light.worker-new-of")).toHaveLength(1);
  });

  it("backfills existing Fansly gross revenue when the gross migration runs", async (context) => {
    let legacyDb: StartedTestDatabase | null = null;

    try {
      legacyDb = await startTestDatabase({
        through: "0010_spenders_domain_foundation.sql",
      });
    } catch (error) {
      context.skip();
      return;
    }

    try {
      const model = await createModel(legacyDb.db, {
        slug: "legacy-fansly-gross",
        name: "Legacy Fansly Gross",
      });
      const page = await createFanslyPage(legacyDb.db, {
        modelId: model.id,
        label: "legacy-fansly-gross",
      });
      const insertedFan = await legacyDb.pool.query(`
        insert into fans (platform, platform_user_id, username)
        values ('fansly', 'legacy-fan', 'legacyfan')
        returning id
      `);
      const fanId = Number(insertedFan.rows[0]?.id ?? 0);

      await legacyDb.pool.query(`
        insert into transactions (
          platform_account_id,
          fan_id,
          transaction_id,
          raw_type,
          canonical_type,
          transaction_state,
          raw_status,
          gross_amount_mills,
          source_destination_amount_mills,
          creator_net_amount_mills,
          raw_destination_tax,
          occurred_at
        )
        values
          (${page.id}, ${fanId}, 'legacy-subscription', '15001', 'subscription', 'posted', '2', 16000, 16000, 16000, 2000, '2026-03-05T12:00:00.000Z'::timestamptz),
          (${page.id}, null, 'legacy-payout-reversal', '16013', 'payout_reversal', 'posted', '2', 331000, 331000, 331000, 0, '2026-03-06T12:00:00.000Z'::timestamptz)
      `);
      await legacyDb.pool.query(`
        insert into daily_revenue (
          platform_account_id,
          business_date,
          canonical_type,
          transaction_state,
          transaction_count,
          gross_amount_mills,
          creator_net_amount_mills
        )
        values
          (${page.id}, '2026-03-05'::date, 'subscription', 'posted', 1, 16000, 16000)
      `);
      await legacyDb.pool.query(`
        insert into spender_daily_facts (
          platform_account_id,
          fan_id,
          business_date,
          canonical_type,
          transaction_state,
          transaction_count,
          gross_amount_mills,
          creator_net_amount_mills,
          last_transaction_at
        )
        values
          (${page.id}, ${fanId}, '2026-03-05'::date, 'subscription', 'posted', 1, 16000, 16000, '2026-03-05T12:00:00.000Z'::timestamptz)
      `);
      await legacyDb.pool.query(`
        insert into spender_lifetime_page (
          platform_account_id,
          fan_id,
          gross_amount_mills,
          creator_net_amount_mills,
          last_transaction_at
        )
        values
          (${page.id}, ${fanId}, 16000, 16000, '2026-03-05T12:00:00.000Z'::timestamptz)
      `);

      await applyTestMigrations(legacyDb.pool, {
        from: "0011_fansly_gross_backfill.sql",
      });

      const transactionRows = await legacyDb.pool.query(`
        select transaction_id,
               gross_amount_mills,
               source_destination_amount_mills,
               creator_net_amount_mills
        from transactions
        where platform_account_id = ${page.id}
        order by transaction_id asc
      `);
      const revenueRows = await legacyDb.pool.query(`
        select canonical_type,
               gross_amount_mills,
               creator_net_amount_mills
        from daily_revenue
        where platform_account_id = ${page.id}
        order by canonical_type asc
      `);
      const spenderDailyRows = await legacyDb.pool.query(`
        select gross_amount_mills,
               creator_net_amount_mills
        from spender_daily_facts
        where platform_account_id = ${page.id}
          and fan_id = ${fanId}
      `);
      const spenderLifetimeRows = await legacyDb.pool.query(`
        select gross_amount_mills,
               creator_net_amount_mills
        from spender_lifetime_page
        where platform_account_id = ${page.id}
          and fan_id = ${fanId}
      `);

      expect(transactionRows.rows).toEqual([
        {
          transaction_id: "legacy-payout-reversal",
          gross_amount_mills: 331000n,
          source_destination_amount_mills: 331000n,
          creator_net_amount_mills: 331000n,
        },
        {
          transaction_id: "legacy-subscription",
          gross_amount_mills: 20000n,
          source_destination_amount_mills: 16000n,
          creator_net_amount_mills: 16000n,
        },
      ]);
      expect(revenueRows.rows).toEqual([
        {
          canonical_type: "subscription",
          gross_amount_mills: 20000n,
          creator_net_amount_mills: 16000n,
        },
      ]);
      expect(spenderDailyRows.rows).toEqual([
        {
          gross_amount_mills: 20000n,
          creator_net_amount_mills: 16000n,
        },
      ]);
      expect(spenderLifetimeRows.rows).toEqual([
        {
          gross_amount_mills: 20000n,
          creator_net_amount_mills: 16000n,
        },
      ]);
    } finally {
      if (legacyDb) {
        await legacyDb.stop();
      }
    }
  });

  it("re-buckets existing Fansly business dates to UTC when the UTC migration runs", async (context) => {
    let legacyDb: StartedTestDatabase | null = null;

    try {
      legacyDb = await startTestDatabase({
        through: "0011_fansly_gross_backfill.sql",
      });
    } catch (error) {
      context.skip();
      return;
    }

    try {
      const model = await createModel(legacyDb.db, {
        slug: "legacy-fansly-utc",
        name: "Legacy Fansly UTC",
      });
      const page = await createFanslyPage(legacyDb.db, {
        modelId: model.id,
        label: "legacy-fansly-utc",
      });
      const insertedFan = await legacyDb.pool.query(`
        insert into fans (platform, platform_user_id, username)
        values ('fansly', 'legacy-utc-fan', 'legacyutcfan')
        returning id
      `);
      const fanId = Number(insertedFan.rows[0]?.id ?? 0);

      await legacyDb.pool.query(`
        insert into fan_pages (
          fan_id,
          platform_account_id,
          total_creator_net_mills
        )
        values (${fanId}, ${page.id}, 123)
      `);
      await legacyDb.pool.query(`
        insert into transactions (
          platform_account_id,
          fan_id,
          transaction_id,
          raw_type,
          canonical_type,
          transaction_state,
          raw_status,
          gross_amount_mills,
          source_destination_amount_mills,
          creator_net_amount_mills,
          occurred_at
        )
        values
          (${page.id}, ${fanId}, 'legacy-nov-boundary', '20001', 'tip', 'posted', '2', 8000, 8000, 8000, '2025-11-30T21:30:00.000Z'::timestamptz),
          (${page.id}, ${fanId}, 'legacy-dec-main', '20001', 'tip', 'posted', '2', 350376, 350376, 350376, '2025-12-15T12:00:00.000Z'::timestamptz)
      `);
      await legacyDb.pool.query(`
        insert into page_follows (
          platform_account_id,
          fan_id,
          platform_follow_id,
          followed_at
        )
        values (${page.id}, ${fanId}, 'legacy-fansly-follow', '2026-03-01T21:30:00.000Z'::timestamptz)
      `);
      await legacyDb.pool.query(`
        insert into page_subscriptions (
          platform_subscription_id,
          platform_account_id,
          fan_id,
          raw_status,
          canonical_status,
          price_mills,
          renew_price_mills,
          auto_renew,
          source_created_at,
          ends_at
        )
        values (
          'legacy-fansly-sub',
          ${page.id},
          ${fanId},
          3,
          'active',
          5000,
          5000,
          true,
          '2026-03-01T21:30:00.000Z'::timestamptz,
          '2026-03-05T21:30:00.000Z'::timestamptz
        )
      `);
      await legacyDb.pool.query(`
        insert into daily_revenue (
          platform_account_id,
          business_date,
          canonical_type,
          transaction_state,
          transaction_count,
          gross_amount_mills,
          creator_net_amount_mills
        )
        values
          (${page.id}, '2025-12-01'::date, 'tip', 'posted', 1, 8000, 8000),
          (${page.id}, '2025-12-15'::date, 'tip', 'posted', 1, 350376, 350376)
      `);
      await legacyDb.pool.query(`
        insert into spender_daily_facts (
          platform_account_id,
          fan_id,
          business_date,
          canonical_type,
          transaction_state,
          transaction_count,
          gross_amount_mills,
          creator_net_amount_mills,
          last_transaction_at
        )
        values
          (${page.id}, ${fanId}, '2025-12-01'::date, 'tip', 'posted', 1, 8000, 8000, '2025-11-30T21:30:00.000Z'::timestamptz),
          (${page.id}, ${fanId}, '2025-12-15'::date, 'tip', 'posted', 1, 350376, 350376, '2025-12-15T12:00:00.000Z'::timestamptz)
      `);
      await legacyDb.pool.query(`
        insert into spender_lifetime_page (
          platform_account_id,
          fan_id,
          gross_amount_mills,
          creator_net_amount_mills,
          last_transaction_at
        )
        values (${page.id}, ${fanId}, 123, 123, '2025-12-15T12:00:00.000Z'::timestamptz)
      `);
      await legacyDb.pool.query(`
        insert into daily_followers (
          platform_account_id,
          business_date,
          new_followers
        )
        values (${page.id}, '2026-03-02'::date, 1)
      `);
      await legacyDb.pool.query(`
        insert into daily_subscribers (
          platform_account_id,
          business_date,
          new_subscribers,
          active_subscribers
        )
        values (${page.id}, '2026-03-02'::date, 1, 1)
      `);

      await applyTestMigrations(legacyDb.pool, {
        from: "0012_fansly_utc_business_dates.sql",
      });

      const revenueRows = await legacyDb.pool.query(`
        select business_date::text as business_date,
               creator_net_amount_mills
        from daily_revenue
        where platform_account_id = ${page.id}
        order by business_date asc
      `);
      const spenderDailyRows = await legacyDb.pool.query(`
        select business_date::text as business_date,
               creator_net_amount_mills
        from spender_daily_facts
        where platform_account_id = ${page.id}
          and fan_id = ${fanId}
        order by business_date asc
      `);
      const followerRows = await legacyDb.pool.query(`
        select business_date::text as business_date,
               new_followers
        from daily_followers
        where platform_account_id = ${page.id}
        order by business_date asc
      `);
      const subscriberRows = await legacyDb.pool.query(`
        select business_date::text as business_date,
               new_subscribers,
               active_subscribers
        from daily_subscribers
        where platform_account_id = ${page.id}
          and business_date between '2026-03-01'::date and '2026-03-06'::date
        order by business_date asc
      `);
      const spenderLifetimeRows = await legacyDb.pool.query(`
        select gross_amount_mills,
               creator_net_amount_mills
        from spender_lifetime_page
        where platform_account_id = ${page.id}
          and fan_id = ${fanId}
      `);
      const fanPageRows = await legacyDb.pool.query(`
        select total_creator_net_mills
        from fan_pages
        where platform_account_id = ${page.id}
          and fan_id = ${fanId}
      `);

      expect(revenueRows.rows).toEqual([
        {
          business_date: "2025-11-30",
          creator_net_amount_mills: 8000n,
        },
        {
          business_date: "2025-12-15",
          creator_net_amount_mills: 350376n,
        },
      ]);
      expect(spenderDailyRows.rows).toEqual([
        {
          business_date: "2025-11-30",
          creator_net_amount_mills: 8000n,
        },
        {
          business_date: "2025-12-15",
          creator_net_amount_mills: 350376n,
        },
      ]);
      expect(followerRows.rows).toEqual([
        {
          business_date: "2026-03-01",
          new_followers: 1,
        },
      ]);
      expect(subscriberRows.rows).toEqual([
        {
          business_date: "2026-03-01",
          new_subscribers: 1,
          active_subscribers: 1,
        },
        {
          business_date: "2026-03-02",
          new_subscribers: 0,
          active_subscribers: 1,
        },
        {
          business_date: "2026-03-03",
          new_subscribers: 0,
          active_subscribers: 1,
        },
        {
          business_date: "2026-03-04",
          new_subscribers: 0,
          active_subscribers: 1,
        },
        {
          business_date: "2026-03-05",
          new_subscribers: 0,
          active_subscribers: 1,
        },
        {
          business_date: "2026-03-06",
          new_subscribers: 0,
          active_subscribers: 0,
        },
      ]);
      expect(spenderLifetimeRows.rows).toEqual([
        {
          gross_amount_mills: 358376n,
          creator_net_amount_mills: 358376n,
        },
      ]);
      expect(fanPageRows.rows).toEqual([
        {
          total_creator_net_mills: 358376n,
        },
      ]);
    } finally {
      if (legacyDb) {
        await legacyDb.stop();
      }
    }
  });

  it("backfills existing OnlyFans net revenue when the commission migration runs", async (context) => {
    let legacyDb: StartedTestDatabase | null = null;

    try {
      legacyDb = await startTestDatabase({
        through: "0006_onlymonster_raw_transaction_fields.sql",
      });
    } catch (error) {
      context.skip();
      return;
    }

    try {
      const model = await createModel(legacyDb.db, {
        slug: "legacy-lora",
        name: "Legacy Lora",
      });
      const insertedPage = await legacyDb.pool.query(`
        insert into platform_accounts (model_id, platform, label)
        values (${model.id}, 'onlyfans', 'legacy-of')
        returning id
      `);
      const pageId = Number(insertedPage.rows[0]?.id ?? 0);

      expect(pageId).toBeGreaterThan(0);

      await legacyDb.pool.query(`
        insert into transactions (
          platform_account_id,
          fan_id,
          transaction_id,
          raw_type,
          canonical_type,
          transaction_state,
          raw_status,
          amount_mills,
          destination_amount_mills,
          net_amount_mills,
          occurred_at
        )
        values
          (${pageId}, null, 'legacy-tip', 'Tip from', 'tip', 'posted', 'done', 12500, 12500, 12500, '2026-03-05T12:00:00.000Z'::timestamptz),
          (${pageId}, null, 'legacy-chargeback', 'Tip from', 'chargeback', 'posted', 'undo', -2500, -2500, -2500, '2026-03-06T12:00:00.000Z'::timestamptz)
      `);
      await legacyDb.pool.query(`
        insert into daily_revenue (
          platform_account_id,
          business_date,
          canonical_type,
          transaction_state,
          transaction_count,
          net_amount_mills
        )
        values
          (${pageId}, '2026-03-05'::date, 'tip', 'posted', 1, 12500),
          (${pageId}, '2026-03-06'::date, 'chargeback', 'posted', 1, -2500)
      `);

      const beforeRows = await legacyDb.pool.query(`
        select transaction_id, net_amount_mills
        from transactions
        where platform_account_id = ${pageId}
        order by transaction_id asc
      `);
      const beforeRevenueRows = await legacyDb.pool.query(`
        select canonical_type, net_amount_mills
        from daily_revenue
        where platform_account_id = ${pageId}
        order by canonical_type asc
      `);

      expect(beforeRows.rows).toEqual([
        {
          transaction_id: "legacy-chargeback",
          net_amount_mills: -2500n,
        },
        {
          transaction_id: "legacy-tip",
          net_amount_mills: 12500n,
        },
      ]);
      expect(beforeRevenueRows.rows).toEqual([
        {
          canonical_type: "tip",
          net_amount_mills: 12500n,
        },
        {
          canonical_type: "chargeback",
          net_amount_mills: -2500n,
        },
      ]);

      await applyTestMigrations(legacyDb.pool, {
        from: "0007_onlyfans_commission_rate.sql",
      });

      const pageRows = await legacyDb.pool.query(`
        select commission_rate::float8 as commission_rate
        from platform_accounts
        where id = ${pageId}
      `);
      const afterRows = await legacyDb.pool.query(`
        select transaction_id, creator_net_amount_mills as net_amount_mills
        from transactions
        where platform_account_id = ${pageId}
        order by transaction_id asc
      `);
      const afterRevenueRows = await legacyDb.pool.query(`
        select canonical_type, creator_net_amount_mills as net_amount_mills
        from daily_revenue
        where platform_account_id = ${pageId}
        order by canonical_type asc
      `);

      expect(pageRows.rows[0]?.commission_rate).toBe(0.2);
      expect(afterRows.rows).toEqual([
        {
          transaction_id: "legacy-chargeback",
          net_amount_mills: -2000n,
        },
        {
          transaction_id: "legacy-tip",
          net_amount_mills: 10000n,
        },
      ]);
      expect(afterRevenueRows.rows).toEqual([
        {
          canonical_type: "tip",
          net_amount_mills: 10000n,
        },
        {
          canonical_type: "chargeback",
          net_amount_mills: -2000n,
        },
      ]);
    } finally {
      if (legacyDb) {
        await legacyDb.stop();
      }
    }
  });

  it("backfills existing OnlyFans net revenue when the cent-rounding migration runs", async (context) => {
    let legacyDb: StartedTestDatabase | null = null;

    try {
      legacyDb = await startTestDatabase({
        through: "0008_onlyfans_utc_business_dates.sql",
      });
    } catch (error) {
      context.skip();
      return;
    }

    try {
      const model = await createModel(legacyDb.db, {
        slug: "legacy-of-cent-rounding",
        name: "Legacy OF Cent Rounding",
      });
      const insertedPage = await legacyDb.pool.query(`
        insert into platform_accounts (model_id, platform, label, commission_rate)
        values (${model.id}, 'onlyfans', 'legacy-of-cent-rounding', 0.2)
        returning id
      `);
      const page = { id: Number(insertedPage.rows[0]?.id ?? 0) };

      await legacyDb.pool.query(`
        insert into transactions (
          platform_account_id,
          fan_id,
          transaction_id,
          raw_type,
          canonical_type,
          transaction_state,
          raw_status,
          amount_mills,
          destination_amount_mills,
          net_amount_mills,
          occurred_at
        )
        values
          (${page.id}, null, 'legacy-subscription', 'Subscription', 'subscription', 'posted', 'done', 4990, 4990, 3992, '2026-03-05T12:00:00.000Z'::timestamptz),
          (${page.id}, null, 'legacy-chargeback', 'Subscription', 'chargeback', 'posted', 'undo', -4990, -4990, -3992, '2026-03-06T12:00:00.000Z'::timestamptz)
      `);
      await legacyDb.pool.query(`
        insert into daily_revenue (
          platform_account_id,
          business_date,
          canonical_type,
          transaction_state,
          transaction_count,
          net_amount_mills
        )
        values
          (${page.id}, '2026-03-05'::date, 'subscription', 'posted', 1, 3992),
          (${page.id}, '2026-03-06'::date, 'chargeback', 'posted', 1, -3992)
      `);

      const beforeRows = await legacyDb.pool.query(`
        select transaction_id, net_amount_mills
        from transactions
        where platform_account_id = ${page.id}
        order by transaction_id asc
      `);
      const beforeRevenueRows = await legacyDb.pool.query(`
        select canonical_type, net_amount_mills
        from daily_revenue
        where platform_account_id = ${page.id}
        order by canonical_type asc
      `);

      expect(beforeRows.rows).toEqual([
        {
          transaction_id: "legacy-chargeback",
          net_amount_mills: -3992n,
        },
        {
          transaction_id: "legacy-subscription",
          net_amount_mills: 3992n,
        },
      ]);
      expect(beforeRevenueRows.rows).toEqual([
        {
          canonical_type: "subscription",
          net_amount_mills: 3992n,
        },
        {
          canonical_type: "chargeback",
          net_amount_mills: -3992n,
        },
      ]);

      await applyTestMigrations(legacyDb.pool, {
        from: "0009_onlyfans_net_amount_cent_rounding.sql",
      });

      const afterRows = await legacyDb.pool.query(`
        select transaction_id, creator_net_amount_mills as net_amount_mills
        from transactions
        where platform_account_id = ${page.id}
        order by transaction_id asc
      `);
      const afterRevenueRows = await legacyDb.pool.query(`
        select canonical_type, creator_net_amount_mills as net_amount_mills
        from daily_revenue
        where platform_account_id = ${page.id}
        order by canonical_type asc
      `);

      expect(afterRows.rows).toEqual([
        {
          transaction_id: "legacy-chargeback",
          net_amount_mills: -3990n,
        },
        {
          transaction_id: "legacy-subscription",
          net_amount_mills: 3990n,
        },
      ]);
      expect(afterRevenueRows.rows).toEqual([
        {
          canonical_type: "subscription",
          net_amount_mills: 3990n,
        },
        {
          canonical_type: "chargeback",
          net_amount_mills: -3990n,
        },
      ]);
    } finally {
      if (legacyDb) {
        await legacyDb.stop();
      }
    }
  });
});
