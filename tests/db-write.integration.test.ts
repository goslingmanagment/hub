import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createOnlyFansPage,
  createFanslyPage,
  createModel,
  getFollowersForPage,
  recalculateFanPageSpend,
  storeFanslySession,
  storeProxyConfig,
  upsertCheckpoint,
  upsertFanPage,
  upsertFans,
  upsertPageFollow,
  upsertPageSubscription,
  upsertTransaction,
} from "@fansly-connect/db";
import type { FanslyAccountMeResponse } from "@fansly-connect/fansly";
import type { OnlyMonsterAccount } from "@fansly-connect/onlyfans";

import { onboardFanslyPage, onboardOnlyFansPage } from "../apps/runtime/src/services/page-onboarding.ts";
import { startTestDatabase } from "./helpers/db.ts";

describe("db write safety", () => {
  let testDb: Awaited<ReturnType<typeof startTestDatabase>> | null = null;
  const encryptionKey = Buffer.alloc(32, 7);

  function createOnboardingApp(
    verifySession: () => Promise<FanslyAccountMeResponse>,
  ) {
    if (!testDb) {
      throw new Error("Test database is not available");
    }

    return {
      db: testDb.db,
      config: {
        databaseUrl: "",
        encryptionKey,
        encryptionKeyVersion: 1,
        logLevel: "silent",
        apiHost: "0.0.0.0",
        apiPort: 3000,
        sessionTtlDays: 30,
        fanslyBaseUrl: "https://example.invalid",
        onlyMonsterBaseUrl: "https://example.invalid",
        followerPageDelayMs: 0,
        transactionLookbackDays: 7,
        transactionRescanCapDays: 30,
      },
      adapter: {
        async verifySession() {
          const parsed = await verifySession();
          return {
            parsed,
            raw: parsed,
          };
        },
      },
      onlyFansAdapter: {} as never,
    };
  }

  function createOnlyFansOnboardingApp(input: {
    accounts: OnlyMonsterAccount[];
    getAccount?: (accountId: number) => Promise<OnlyMonsterAccount>;
  }) {
    if (!testDb) {
      throw new Error("Test database is not available");
    }

    return {
      db: testDb.db,
      config: {
        databaseUrl: "",
        encryptionKey,
        encryptionKeyVersion: 1,
        logLevel: "silent",
        apiHost: "0.0.0.0",
        apiPort: 3000,
        sessionTtlDays: 30,
        fanslyBaseUrl: "https://example.invalid",
        onlyMonsterBaseUrl: "https://example.invalid",
        followerPageDelayMs: 0,
        transactionLookbackDays: 7,
        transactionRescanCapDays: 30,
      },
      onlyFansAdapter: {
        async listAccountsPage() {
          return {
            parsed: {
              accounts: input.accounts,
            },
            raw: {
              accounts: input.accounts,
            },
          };
        },
        async getAccount(_: unknown, accountId: number) {
          const account = input.getAccount
            ? await input.getAccount(accountId)
            : input.accounts.find((candidate) => candidate.id === accountId);
          if (!account) {
            throw new Error(`missing account ${accountId}`);
          }
          return {
            parsed: { account },
            raw: { account },
          };
        },
      },
    };
  }

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
               auth_sessions, user_page_assignments, users, daily_revenue,
               daily_followers, daily_subscribers, transactions, page_subscriptions,
               page_follows, fan_pages, fans, raw_payloads, sync_checkpoints,
               sync_runs, platform_account_proxies, platform_account_credentials,
               platform_accounts, models
      restart identity cascade
    `);
  });

  it("returns a friendly error for duplicate model slugs", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await createModel(testDb.db, {
      slug: "lora",
      name: "Lora",
    });

    await expect(
      createModel(testDb.db, {
        slug: "lora",
        name: "Lora 2",
      }),
    ).rejects.toThrow('Model "lora" already exists');

    const modelRows = await testDb.pool.query(`
      select count(*)::int as count
      from models
      where slug = 'lora'
    `);
    expect(modelRows.rows[0]?.count).toBe(1);
  });

  it("applies platform commission defaults when creating pages", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "lora",
      name: "Lora",
    });
    const fanslyPage = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "lora-fansly",
    });
    const onlyFansPage = await createOnlyFansPage(testDb.db, {
      modelId: model.id,
      label: "lora-onlyfans",
    });

    const rows = await testDb.pool.query(`
      select label, commission_rate::float8 as commission_rate
      from platform_accounts
      where id in (${fanslyPage.id}, ${onlyFansPage.id})
      order by label asc
    `);

    expect(rows.rows).toEqual([
      {
        label: "lora-fansly",
        commission_rate: 0,
      },
      {
        label: "lora-onlyfans",
        commission_rate: 0.2,
      },
    ]);
  });

  it("verifies Fansly auth before persisting a page and stores metadata immediately", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await createModel(testDb.db, {
      slug: "lora",
      name: "Lora",
    });

    const app = createOnboardingApp(async () => ({
      account: {
        id: "acct-123",
        username: "lora_verified",
        displayName: "Lora Verified",
        createdAt: 1_772_157_317_000,
        followCount: 42,
        subscriberCount: 7,
        earningsWallet: { id: "wallet-1", balance: 123_45 },
        walls: [{ id: "wall-1" }],
        subscriptionTiers: [{ id: "tier-1" }],
      },
    }));

    const session = {
      authorization: "token",
      fanslyClientId: "client-id",
      fanslyClientCheck: "client-check",
      fanslySessionId: "session-id",
    };

    const { page } = await onboardFanslyPage(app, {
      modelSlug: "lora",
      label: "lora-main",
      session,
      proxy: {
        url: "http://proxy.example",
        username: "proxy-user",
        password: "proxy-pass",
      },
    });

    const pageRows = await testDb.pool.query(`
      select label,
             platform_account_id,
             username,
             display_name,
             follower_count,
             subscriber_count,
             earnings_balance_mills,
             last_verified_at is not null as has_last_verified_at,
             last_light_sync_at is not null as has_last_light_sync_at
      from platform_accounts
      where id = ${page.id}
    `);
    const credentialRows = await testDb.pool.query(`
      select count(*)::int as count, max(key_version)::int as key_version
      from platform_account_credentials
      where platform_account_id = ${page.id}
    `);
    const proxyRows = await testDb.pool.query(`
      select count(*)::int as count,
             max(url) as url,
             bool_or(encrypted_auth is not null) as has_encrypted_auth
      from platform_account_proxies
      where platform_account_id = ${page.id}
    `);

    expect(pageRows.rows[0]).toMatchObject({
      label: "lora-main",
      platform_account_id: "acct-123",
      username: "lora_verified",
      display_name: "Lora Verified",
      follower_count: 42,
      subscriber_count: 7,
      earnings_balance_mills: 12345n,
      has_last_verified_at: true,
      has_last_light_sync_at: true,
    });
    expect(credentialRows.rows[0]?.count).toBe(1);
    expect(credentialRows.rows[0]?.key_version).toBe(1);
    expect(proxyRows.rows[0]?.count).toBe(1);
    expect(proxyRows.rows[0]?.url).toBe("http://proxy.example");
    expect(proxyRows.rows[0]?.has_encrypted_auth).toBe(true);
  });

  it("leaves no persisted rows behind when Fansly auth verification fails during onboarding", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await createModel(testDb.db, {
      slug: "lora",
      name: "Lora",
    });

    const app = createOnboardingApp(async () => {
      throw new Error("invalid auth");
    });

    await expect(
      onboardFanslyPage(app, {
        modelSlug: "lora",
        label: "lora-main",
        session: {
          authorization: "token",
        },
        proxy: {
          url: "http://proxy.example",
          username: "proxy-user",
          password: "proxy-pass",
        },
      }),
    ).rejects.toThrow("invalid auth");

    const counts = await testDb.pool.query(`
      select
        (select count(*)::int from platform_accounts) as platform_accounts_count,
        (select count(*)::int from platform_account_credentials) as credentials_count,
        (select count(*)::int from platform_account_proxies) as proxies_count
    `);

    expect(counts.rows[0]).toMatchObject({
      platform_accounts_count: 0,
      credentials_count: 0,
      proxies_count: 0,
    });
  });

  it("verifies OnlyMonster account access before persisting an OnlyFans page", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await createModel(testDb.db, {
      slug: "lora",
      name: "Lora",
    });

    const account: OnlyMonsterAccount = {
      id: 42,
      platform_account_id: "of-acct-42",
      platform: "onlyfans",
      name: "Lora OF",
      email: "lora@example.com",
      avatar: "https://example.com/lora.png",
      username: "lora_of",
      organisation_id: "org-1",
      subscribe_price: 12.5,
      subscription_expiration_date: "2026-04-01T00:00:00.000Z",
    };

    const app = createOnlyFansOnboardingApp({
      accounts: [account],
    });

    const { page } = await onboardOnlyFansPage(app, {
      modelSlug: "lora",
      label: "lora-of",
      auth: {
        token: "om-token",
      },
      username: "lora_of",
      proxy: {
        url: "http://proxy.example",
      },
    });

    const pageRows = await testDb.pool.query(`
      select platform,
             label,
             platform_account_id,
             username,
             display_name,
             follower_count,
             subscriber_count,
             earnings_balance_mills,
             metadata::text as metadata
      from platform_accounts
      where id = ${page.id}
    `);

    expect(pageRows.rows[0]).toMatchObject({
      platform: "onlyfans",
      label: "lora-of",
      platform_account_id: "of-acct-42",
      username: "lora_of",
      display_name: "Lora OF",
      follower_count: 0,
      subscriber_count: 0,
      earnings_balance_mills: 0n,
    });
    expect(JSON.parse(pageRows.rows[0]?.metadata ?? "{}")).toMatchObject({
      onlyMonsterAccountId: 42,
      subscribePriceMills: 12500,
    });
  });

  it("fails cleanly when the OnlyFans username is not accessible for the token", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await createModel(testDb.db, {
      slug: "lora",
      name: "Lora",
    });

    const app = createOnlyFansOnboardingApp({
      accounts: [],
    });

    await expect(
      onboardOnlyFansPage(app, {
        modelSlug: "lora",
        label: "lora-of",
        auth: {
          token: "om-token",
        },
        username: "missing",
      }),
    ).rejects.toThrow('OnlyMonster account "missing" was not found for this token');
  });

  it("fails cleanly when the OnlyFans username resolves to multiple accounts", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await createModel(testDb.db, {
      slug: "lora",
      name: "Lora",
    });

    const duplicate: OnlyMonsterAccount = {
      id: 42,
      platform_account_id: "of-acct-42",
      platform: "onlyfans",
      name: "Lora OF",
      email: null,
      avatar: "https://example.com/lora.png",
      username: "lora_of",
      organisation_id: "org-1",
      subscribe_price: null,
      subscription_expiration_date: null,
    };

    const app = createOnlyFansOnboardingApp({
      accounts: [
        duplicate,
        {
          ...duplicate,
          id: 43,
          platform_account_id: "of-acct-43",
        },
      ],
    });

    await expect(
      onboardOnlyFansPage(app, {
        modelSlug: "lora",
        label: "lora-of",
        auth: {
          token: "om-token",
        },
        username: "lora_of",
      }),
    ).rejects.toThrow(
      'OnlyMonster username "lora_of" matched multiple accounts; use a unique username',
    );
  });

  it("leaves no persisted rows behind when OnlyFans account verification fails during onboarding", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await createModel(testDb.db, {
      slug: "lora",
      name: "Lora",
    });

    const account: OnlyMonsterAccount = {
      id: 42,
      platform_account_id: "of-acct-42",
      platform: "onlyfans",
      name: "Lora OF",
      email: null,
      avatar: "https://example.com/lora.png",
      username: "lora_of",
      organisation_id: "org-1",
      subscribe_price: null,
      subscription_expiration_date: null,
    };

    const app = createOnlyFansOnboardingApp({
      accounts: [account],
      async getAccount() {
        throw new Error("invalid om auth");
      },
    });

    await expect(
      onboardOnlyFansPage(app, {
        modelSlug: "lora",
        label: "lora-of",
        auth: {
          token: "om-token",
        },
        username: "lora_of",
      }),
    ).rejects.toThrow("invalid om auth");

    const counts = await testDb.pool.query(`
      select
        (select count(*)::int from platform_accounts) as platform_accounts_count,
        (select count(*)::int from platform_account_credentials) as credentials_count
    `);

    expect(counts.rows[0]).toMatchObject({
      platform_accounts_count: 0,
      credentials_count: 0,
    });
  });

  it("lists active followers newest first with platform id fallback", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "lora",
      name: "Lora",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "lora-main",
    });
    const fans = await upsertFans(testDb.db, [
      {
        platform: "fansly",
        platformUserId: "fan-old",
        username: "oldest",
      },
      {
        platform: "fansly",
        platformUserId: "fan-mid",
      },
      {
        platform: "fansly",
        platformUserId: "fan-new",
        username: "newest",
      },
    ]);

    await upsertPageFollow(testDb.db, {
      platformAccountId: page.id,
      fanId: fans[0]!.id,
      platformFollowId: "follow-old",
      followedAt: new Date("2026-03-01T00:00:00.000Z"),
    });
    await upsertPageFollow(testDb.db, {
      platformAccountId: page.id,
      fanId: fans[1]!.id,
      platformFollowId: "follow-mid",
      followedAt: new Date("2026-03-03T00:00:00.000Z"),
    });
    await upsertPageFollow(testDb.db, {
      platformAccountId: page.id,
      fanId: fans[2]!.id,
      platformFollowId: "follow-new",
      followedAt: new Date("2026-03-05T00:00:00.000Z"),
    });
    await testDb.pool.query(`
      update page_follows
      set is_active = false
      where platform_account_id = ${page.id}
        and platform_follow_id = 'follow-old'
    `);

    const result = await getFollowersForPage(testDb.db, page.id);

    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((row) => row.username ?? row.platform_user_id)).toEqual([
      "newest",
      "fan-mid",
    ]);
    expect(
      result.rows.map((row) => new Date(row.followed_at as string | Date).toISOString()),
    ).toEqual([
      "2026-03-05T00:00:00.000Z",
      "2026-03-03T00:00:00.000Z",
    ]);
  });

  it("uses database-native upserts for unique-key sync writes", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "lora",
      name: "Lora",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "lora-main",
    });

    await storeFanslySession(testDb.db, page.id, "encrypted-a", 1);
    await storeFanslySession(testDb.db, page.id, "encrypted-b", 2);

    const credentialRows = await testDb.pool.query(`
      select count(*)::int as count, max(key_version)::int as key_version
      from platform_account_credentials
      where platform_account_id = ${page.id}
    `);
    expect(credentialRows.rows[0]?.count).toBe(1);
    expect(credentialRows.rows[0]?.key_version).toBe(2);

    await storeProxyConfig(testDb.db, page.id, {
      url: "http://proxy-a.example",
      encryptedAuth: "auth-a",
      keyVersion: 1,
    });
    await storeProxyConfig(testDb.db, page.id, {
      url: "http://proxy-b.example",
      encryptedAuth: null,
      keyVersion: null,
    });

    const proxyRows = await testDb.pool.query(`
      select count(*)::int as count, max(url) as url, max(encrypted_auth) as encrypted_auth
      from platform_account_proxies
      where platform_account_id = ${page.id}
    `);
    expect(proxyRows.rows[0]?.count).toBe(1);
    expect(proxyRows.rows[0]?.url).toBe("http://proxy-b.example");
    expect(proxyRows.rows[0]?.encrypted_auth).toBeNull();

    await upsertCheckpoint(testDb.db, {
      platformAccountId: page.id,
      stream: "transactions",
      cursorText: "cursor-a",
      state: { phase: "a" },
      lastSuccessfulRunId: null,
    });
    await upsertCheckpoint(testDb.db, {
      platformAccountId: page.id,
      stream: "transactions",
      cursorText: "cursor-b",
      state: { phase: "b" },
      lastSuccessfulRunId: null,
    });

    const checkpointRows = await testDb.pool.query(`
      select count(*)::int as count, max(cursor_text) as cursor_text
      from sync_checkpoints
      where platform_account_id = ${page.id}
        and stream = 'transactions'
    `);
    expect(checkpointRows.rows[0]?.count).toBe(1);
    expect(checkpointRows.rows[0]?.cursor_text).toBe("cursor-b");

    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-1",
      username: "alpha",
      displayName: "Alpha",
      createdAtExternal: new Date("2026-03-01T00:00:00.000Z"),
      metadata: { tier: "gold" },
    }]);
    await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-1",
      displayName: "Bravo",
    }]);

    const fanRows = await testDb.pool.query(`
      select count(*) over()::int as count,
             username,
             display_name,
             metadata::text as metadata
      from fans
      where platform = 'fansly'
        and platform_user_id = 'fan-1'
      limit 1
    `);
    expect(fanRows.rows[0]?.count).toBe(1);
    expect(fanRows.rows[0]?.username).toBe("alpha");
    expect(fanRows.rows[0]?.display_name).toBe("Bravo");
    expect(JSON.parse(fanRows.rows[0]?.metadata ?? "{}")).toMatchObject({
      tier: "gold",
    });

    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
      isFollower: true,
      followerSince: new Date("2026-03-02T00:00:00.000Z"),
      totalCreatorNetMills: 1200n,
    });
    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
      isSubscriber: true,
      subscriberSince: new Date("2026-03-03T00:00:00.000Z"),
    });

    const fanPageRows = await testDb.pool.query(`
      select count(*)::int as count,
             bool_or(is_follower) as is_follower,
             bool_or(is_subscriber) as is_subscriber,
             max(total_creator_net_mills)::bigint as total_creator_net_mills
      from fan_pages
      where fan_id = ${fan.id}
        and platform_account_id = ${page.id}
    `);
    expect(fanPageRows.rows[0]?.count).toBe(1);
    expect(fanPageRows.rows[0]?.is_follower).toBe(true);
    expect(fanPageRows.rows[0]?.is_subscriber).toBe(true);
    expect(BigInt(fanPageRows.rows[0]?.total_creator_net_mills ?? 0)).toBe(1200n);

    await upsertPageFollow(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      platformFollowId: "follow-1",
      followedAt: new Date("2026-03-04T00:00:00.000Z"),
    });
    await testDb.pool.query(`
      update page_follows
      set is_active = false
      where platform_account_id = ${page.id}
        and platform_follow_id = 'follow-1'
    `);
    await upsertPageFollow(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      platformFollowId: "follow-1",
      followedAt: new Date("2026-03-04T00:00:00.000Z"),
    });

    const followRows = await testDb.pool.query(`
      select count(*)::int as count, bool_or(is_active) as is_active
      from page_follows
      where platform_account_id = ${page.id}
        and platform_follow_id = 'follow-1'
    `);
    expect(followRows.rows[0]?.count).toBe(1);
    expect(followRows.rows[0]?.is_active).toBe(true);

    await upsertPageSubscription(testDb.db, {
      platformSubscriptionId: "sub-1",
      platformAccountId: page.id,
      fanId: fan.id,
      rawStatus: 1,
      canonicalStatus: "pending",
      priceMills: 5000n,
      renewPriceMills: 5000n,
      autoRenew: true,
      sourceCreatedAt: new Date("2026-03-01T00:00:00.000Z"),
    });
    await upsertPageSubscription(testDb.db, {
      platformSubscriptionId: "sub-1",
      platformAccountId: page.id,
      fanId: fan.id,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: 7000n,
      renewPriceMills: 7000n,
      autoRenew: false,
      sourceCreatedAt: new Date("2026-03-01T00:00:00.000Z"),
    });

    const subscriptionRows = await testDb.pool.query(`
      select count(*)::int as count,
             max(raw_status)::int as raw_status,
             max(canonical_status) as canonical_status,
             max(price_mills)::bigint as price_mills
      from page_subscriptions
      where platform_subscription_id = 'sub-1'
    `);
    expect(subscriptionRows.rows[0]?.count).toBe(1);
    expect(subscriptionRows.rows[0]?.raw_status).toBe(3);
    expect(subscriptionRows.rows[0]?.canonical_status).toBe("active");
    expect(BigInt(subscriptionRows.rows[0]?.price_mills ?? 0)).toBe(7000n);

    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      transactionId: "tx-1",
      rawType: 15001,
      canonicalType: "subscription",
      transactionState: "posted",
      rawStatus: 2,
      amountMills: 1000n,
      destinationAmountMills: 1000n,
      netAmountMills: 1000n,
      occurredAt: new Date("2026-03-05T00:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      fanId: null,
      transactionId: "tx-1",
      rawType: 16013,
      canonicalType: "payout_reversal",
      transactionState: "posted",
      rawStatus: 2,
      amountMills: 331000n,
      destinationAmountMills: 331000n,
      netAmountMills: 331000n,
      occurredAt: new Date("2026-03-05T01:00:00.000Z"),
    });

    const transactionRows = await testDb.pool.query(`
      select count(*)::int as count,
             max(raw_type)::int as raw_type,
             max(canonical_type) as canonical_type,
             max(net_amount_mills)::bigint as net_amount_mills
      from transactions
      where platform_account_id = ${page.id}
        and transaction_id = 'tx-1'
    `);
    expect(transactionRows.rows[0]?.count).toBe(1);
    expect(transactionRows.rows[0]?.raw_type).toBe(16013);
    expect(transactionRows.rows[0]?.canonical_type).toBe("payout_reversal");
    expect(BigInt(transactionRows.rows[0]?.net_amount_mills ?? 0)).toBe(331000n);
  });

  it("recalculates fan spend using fan-LTV transaction rules", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "ltv-model",
      name: "LTV Model",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "ltv-page",
    });
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "ltv-fan-1",
      username: "ltvfan",
    }]);

    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
      totalCreatorNetMills: 0n,
    });

    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      transactionId: "ltv-subscription",
      rawType: 15001,
      canonicalType: "subscription",
      transactionState: "posted",
      rawStatus: 2,
      amountMills: 5000n,
      destinationAmountMills: 5000n,
      netAmountMills: 5000n,
      occurredAt: new Date("2026-03-05T00:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      transactionId: "ltv-chargeback",
      rawType: 99901,
      canonicalType: "chargeback",
      transactionState: "posted",
      rawStatus: 2,
      amountMills: -800n,
      destinationAmountMills: -800n,
      netAmountMills: -800n,
      occurredAt: new Date("2026-03-06T00:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      transactionId: "ltv-refund",
      rawType: 99902,
      canonicalType: "refund",
      transactionState: "posted",
      rawStatus: 2,
      amountMills: -200n,
      destinationAmountMills: -200n,
      netAmountMills: -200n,
      occurredAt: new Date("2026-03-07T00:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      transactionId: "ltv-other",
      rawType: 18001,
      canonicalType: "other",
      transactionState: "posted",
      rawStatus: 2,
      amountMills: 300n,
      destinationAmountMills: 300n,
      netAmountMills: 300n,
      occurredAt: new Date("2026-03-08T00:00:00.000Z"),
    });

    await recalculateFanPageSpend(testDb.db, page.id);

    const spendBeforePayoutReversal = await testDb.pool.query(`
      select total_creator_net_mills
      from fan_pages
      where fan_id = ${fan.id}
        and platform_account_id = ${page.id}
    `);
    expect(BigInt(spendBeforePayoutReversal.rows[0]?.total_creator_net_mills ?? 0)).toBe(4300n);

    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      transactionId: "ltv-payout-reversal",
      rawType: 16013,
      canonicalType: "payout_reversal",
      transactionState: "posted",
      rawStatus: 2,
      amountMills: 2000n,
      destinationAmountMills: 2000n,
      netAmountMills: 2000n,
      occurredAt: new Date("2026-03-09T00:00:00.000Z"),
    });

    await recalculateFanPageSpend(testDb.db, page.id);

    const spendAfterPayoutReversal = await testDb.pool.query(`
      select total_creator_net_mills
      from fan_pages
      where fan_id = ${fan.id}
        and platform_account_id = ${page.id}
    `);
    expect(BigInt(spendAfterPayoutReversal.rows[0]?.total_creator_net_mills ?? 0)).toBe(4300n);
  });
});
