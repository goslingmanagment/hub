import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  storeFanslySession,
  storeProxyConfig,
  upsertCheckpoint,
  upsertFanPage,
  upsertFans,
  upsertPageFollow,
  upsertPageSubscription,
  upsertTransaction,
} from "@fansly-connect/db";

import { startTestDatabase } from "./helpers/db.ts";

describe("db write safety", () => {
  let testDb: Awaited<ReturnType<typeof startTestDatabase>> | null = null;

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
      totalSpentMills: 1200n,
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
             max(total_spent_mills)::bigint as total_spent_mills
      from fan_pages
      where fan_id = ${fan.id}
        and platform_account_id = ${page.id}
    `);
    expect(fanPageRows.rows[0]?.count).toBe(1);
    expect(fanPageRows.rows[0]?.is_follower).toBe(true);
    expect(fanPageRows.rows[0]?.is_subscriber).toBe(true);
    expect(BigInt(fanPageRows.rows[0]?.total_spent_mills ?? 0)).toBe(1200n);

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
});
