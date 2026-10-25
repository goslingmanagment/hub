import assert from "node:assert/strict";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { encryptJson } from "@agency_hub_core/shared";
import {
  createOnlyFansPage,
  createFanslyPage,
  createModel,
  deleteProxyConfig,
  deleteTransactionsMissingFromWindow,
  recalculateFanPageSpend,
  rebuildRevenueRollups,
  storeProxyConfig,
  updatePageMetadata,
  upsertFanPage,
  upsertFans,
  upsertFanslyTransactionWithEarningsDirty,
  upsertPageTopSpenders,
  upsertTransaction,
} from "@agency_hub_core/db";
import type { OfapiAccountRecord } from "../apps/runtime/src/services/ofapi.ts";

import { onboardOnlyFansPage } from "../apps/runtime/src/services/page-onboarding.ts";
import { resolvePageContext, saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { getPageRevenueReport } from "../apps/runtime/src/services/reporting.ts";
import { mapFanslyTransactionItem } from "../apps/runtime/src/sync/fansly/lib/money-rules.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

describe("db write safety", () => {
  let testDb: StartedTestDatabase | null = null;
  const encryptionKey = Buffer.alloc(32, 7);

  function createOnlyFansOnboardingApp(input: {
    accounts: OfapiAccountRecord[];
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
        encryptionKeysByVersion: new Map([[1, encryptionKey]]),
        logLevel: "silent",
        apiHost: "0.0.0.0",
        apiPort: 3000,
        trustProxy: false,
        sessionTtlDays: 30,
        fanslyBaseUrl: "https://example.invalid",
        syncHttpTraceFile: null,
        fanslyDefaultDelayMs: 2500,
        onlyFansDefaultDelayMs: 1000,
        lakeDir: "lake",
        syncPageExecutorConcurrency: 1,
        syncObservabilityRetentionDays: 30,
        healthSyncLightMaxAgeMinutes: 180,
        healthSyncMonitoringToken: null,
        telegramBotToken: null,
        telegramChatId: null,
        telegramEnabled: false,
        telegramReportHourUtc: 9,
        serviceEgressProxyUrl: null,
        serviceEgressProxyUsername: null,
        serviceEgressProxyPassword: null,
        isProduction: false,
      },
      ofapi: {
        async listAccounts() {
          return input.accounts;
        },
      } as never,
    };
  }

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
      from pages
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

  it("refuses to rebind an existing page to a different upstream account", async (context) => {
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

    await updatePageMetadata(testDb.db, page.id, {
      platformAccountIdValue: "acct-123",
      username: "lora_verified",
      displayName: "Lora Verified",
      followerCount: 42,
      subscriberCount: 7,
      earningsBalanceMills: 12345n,
      metadata: {},
      syncType: "light",
    });

    await expect(
      updatePageMetadata(testDb.db, page.id, {
        platformAccountIdValue: "acct-456",
        username: "lora_rebound",
        displayName: "Lora Rebound",
        followerCount: 99,
        subscriberCount: 9,
        earningsBalanceMills: 999n,
        metadata: {},
        syncType: "light",
      }),
    ).rejects.toThrow(
      'Page "lora-main" is already bound to upstream account "acct-123" and cannot be rebound to "acct-456"',
    );

    const rows = await testDb.pool.query(`
      select external_page_id, username, display_name
      from pages
      where id = ${page.id}
    `);

    expect(rows.rows[0]).toMatchObject({
      external_page_id: "acct-123",
      username: "lora_verified",
      display_name: "Lora Verified",
    });
  });

  it("strips inline proxy credentials from stored URLs and encrypts auth separately", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "proxy-model",
      name: "Proxy Model",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "proxy-page",
    });

    await saveProxy(createTestAppContext(testDb), page.id, {
      url: "socks5://proxy-user:proxy-pass@proxy.example:1080",
    });

    const proxyRows = await testDb.pool.query(`
      select url, encrypted_auth is not null as has_encrypted_auth
      from egress_endpoints
      where platform_account_id = ${page.id}
    `);

    expect(proxyRows.rows[0]).toEqual({
      url: "socks5://proxy.example:1080",
      has_encrypted_auth: true,
    });
  });

  it("reads stored proxy auth using historical encryption keys", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const historicalKey = Buffer.alloc(32, 3);
    const currentKey = Buffer.alloc(32, 8);
    const model = await createModel(testDb.db, {
      slug: "rotated-key-model",
      name: "Rotated Key Model",
    });
    const page = await createOnlyFansPage(testDb.db, {
      modelId: model.id,
      label: "rotated-key-page",
    });

    await storeProxyConfig(testDb.db, page.id, {
      url: "socks5://127.0.0.1:1080",
      encryptedAuth: JSON.stringify(encryptJson(
        {
          username: "legacy-user",
          password: "legacy-pass",
        },
        historicalKey,
        1,
      )),
      keyVersion: 1,
    });

    const contextResult = await resolvePageContext(createTestAppContext(testDb, {
      encryptionKey: currentKey,
      encryptionKeyVersion: 2,
      encryptionKeysByVersion: new Map([
        [1, historicalKey],
        [2, currentKey],
      ]),
    }), page.label);

    expect(contextResult.proxy).toEqual({
      url: "socks5://127.0.0.1:1080",
      username: "legacy-user",
      password: "legacy-pass",
    });
    expect(contextResult.egressKey).toBe("socks5://127.0.0.1:1080");
  });

  it("deletes proxy rows when a page proxy is removed", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "delete-proxy-model",
      name: "Delete Proxy Model",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "delete-proxy-page",
    });

    await storeProxyConfig(testDb.db, page.id, {
      url: "http://proxy.example:8080",
      encryptedAuth: "auth",
      keyVersion: 1,
    });
    await deleteProxyConfig(testDb.db, page.id);

    const proxyRows = await testDb.pool.query(`
      select count(*)::int as count
      from egress_endpoints
      where platform_account_id = ${page.id}
    `);

    expect(proxyRows.rows[0]?.count).toBe(0);
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

    const account: OfapiAccountRecord = {
      id: "acct_42",
      username: "@lora_of",
      displayName: "Lora OF",
      onlyfansName: "lora_of",
      onlyfansUserId: "4242",
      avatarUrl: "https://public.onlyfans.com/files/lora/avatar.jpg",
    };

    const app = createOnlyFansOnboardingApp({
      accounts: [account],
    });

    const { page } = await onboardOnlyFansPage(app, {
      modelSlug: "lora",
      label: "lora-of",
      username: "Lora_OF",
    });

    const pageRows = await testDb.pool.query(`
      select platform,
             label,
             ofapi_account_id,
             username,
             display_name,
             follower_count,
             subscriber_count,
             earnings_balance_mills,
             metadata::text as metadata
      from pages
      where id = ${page.id}
    `);

    expect(pageRows.rows[0]).toMatchObject({
      platform: "onlyfans",
      label: "lora-of",
      ofapi_account_id: "acct_42",
      username: "@lora_of",
      display_name: "Lora OF",
      follower_count: null,
      subscriber_count: null,
      earnings_balance_mills: 0n,
    });
    expect(JSON.parse(pageRows.rows[0]?.metadata ?? "{}")).toMatchObject({
      avatarUrl: "https://public.onlyfans.com/files/lora/avatar.jpg",
      onlyfansUserId: "4242",
    });

    // Stage 18: no pasted credentials — onboarding must leave the vault empty.
    const credentialRows = await testDb.pool.query(`
      select count(*)::int as count from page_credentials
      where platform_account_id = ${page.id}
    `);
    expect(credentialRows.rows[0]?.count).toBe(0);
  });

  it("fails cleanly when the OnlyFans username is not connected at the OFAPI vendor", async (context) => {
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
        username: "missing",
      }),
    ).rejects.toThrow('No connected OFAPI account matches "missing"');
  });

  it("refuses to onboard when multiple OFAPI accounts match the username", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await createModel(testDb.db, {
      slug: "lora",
      name: "Lora",
    });

    const duplicate: OfapiAccountRecord = {
      id: "acct_42",
      username: "lora_of",
      displayName: "Lora OF",
      onlyfansName: "lora_of",
      onlyfansUserId: null,
      avatarUrl: null,
    };

    const app = createOnlyFansOnboardingApp({
      accounts: [
        duplicate,
        {
          ...duplicate,
          id: "acct_43",
        },
      ],
    });

    await expect(
      onboardOnlyFansPage(app, {
        modelSlug: "lora",
        label: "lora-of",
        username: "lora_of",
      }),
    ).rejects.toThrow('Multiple OFAPI accounts match "lora_of"');

    const counts = await testDb.pool.query(`
      select count(*)::int as pages_count from pages
    `);
    expect(counts.rows[0]?.pages_count).toBe(0);
  });

  it("leaves no persisted rows behind when OnlyFans onboarding fails mid-transaction", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await createModel(testDb.db, {
      slug: "lora",
      name: "Lora",
    });

    const account: OfapiAccountRecord = {
      id: "acct_42",
      username: "lora_of",
      displayName: "Lora OF",
      onlyfansName: "lora_of",
      onlyfansUserId: "4242",
      avatarUrl: null,
    };

    const app = createOnlyFansOnboardingApp({
      accounts: [account],
    });

    await onboardOnlyFansPage(app, {
      modelSlug: "lora",
      label: "lora-of",
      username: "lora_of",
    });

    // Same OFAPI account under a second label: the pages_ofapi_account_uniq
    // constraint fires AFTER the second page row is inserted, so the whole
    // transaction must roll back without leaving an orphan page.
    await expect(
      onboardOnlyFansPage(app, {
        modelSlug: "lora",
        label: "lora-of-second",
        username: "lora_of",
      }),
    ).rejects.toThrow();

    const counts = await testDb.pool.query(`
      select
        (select count(*)::int from pages) as pages_count,
        (select count(*)::int from page_credentials) as credentials_count
    `);

    expect(counts.rows[0]).toMatchObject({
      pages_count: 1,
      credentials_count: 0,
    });
  });

  it("rebuilds spender lifetime from ledger truth using shared analytics rules", async (context) => {
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
    assert(fan !== undefined, "Expected fan from the test fixture");

    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
    });

    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      fanId: fan.id,
      transactionId: "ltv-subscription",
      rawType: 15001,
      canonicalType: "subscription",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 5000n,
      sourceDestinationAmountMills: 5000n,
      creatorNetAmountMills: 5000n,
      occurredAt: new Date("2026-03-05T00:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      fanId: fan.id,
      transactionId: "ltv-chargeback",
      rawType: 99901,
      canonicalType: "chargeback",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: -800n,
      sourceDestinationAmountMills: -800n,
      creatorNetAmountMills: -800n,
      occurredAt: new Date("2026-03-06T00:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      fanId: fan.id,
      transactionId: "ltv-refund",
      rawType: 99902,
      canonicalType: "refund",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: -200n,
      sourceDestinationAmountMills: -200n,
      creatorNetAmountMills: -200n,
      occurredAt: new Date("2026-03-07T00:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      fanId: fan.id,
      transactionId: "ltv-other",
      rawType: 18001,
      canonicalType: "other",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 300n,
      sourceDestinationAmountMills: 300n,
      creatorNetAmountMills: 300n,
      occurredAt: new Date("2026-03-08T00:00:00.000Z"),
    });

    await recalculateFanPageSpend(testDb.db, page.id);

    const spendBeforePayoutReversal = await testDb.pool.query(`
      select creator_net_amount_mills
      from fan_spend_lifetime
      where fan_id = ${fan.id}
        and platform_account_id = ${page.id}
    `);
    expect(BigInt(spendBeforePayoutReversal.rows[0]?.creator_net_amount_mills ?? 0)).toBe(4300n);

    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      fanId: fan.id,
      transactionId: "ltv-payout-reversal",
      rawType: 16013,
      canonicalType: "payout_reversal",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 2000n,
      sourceDestinationAmountMills: 2000n,
      creatorNetAmountMills: 2000n,
      occurredAt: new Date("2026-03-09T00:00:00.000Z"),
    });

    await recalculateFanPageSpend(testDb.db, page.id);

    const spendAfterPayoutReversal = await testDb.pool.query(`
      select creator_net_amount_mills
      from fan_spend_lifetime
      where fan_id = ${fan.id}
        and platform_account_id = ${page.id}
    `);
    expect(BigInt(spendAfterPayoutReversal.rows[0]?.creator_net_amount_mills ?? 0)).toBe(4300n);
  });

  it("preserves a known fan binding when a transaction rescan cannot resolve the fan", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "rescan-model",
      name: "Rescan Model",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "rescan-page",
    });
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-1",
      username: "fan1",
    }]);
    assert(fan !== undefined, "Expected fan from the test fixture");

    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      fanId: fan.id,
      transactionId: "rescan-tip",
      correlationAccountId: "fan-1",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 1000n,
      sourceDestinationAmountMills: 1000n,
      creatorNetAmountMills: 1000n,
      occurredAt: new Date("2026-03-05T00:00:00.000Z"),
    });

    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      fanId: null,
      transactionId: "rescan-tip",
      correlationAccountId: null,
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 3,
      grossAmountMills: 1200n,
      sourceDestinationAmountMills: 1200n,
      creatorNetAmountMills: 1200n,
      occurredAt: new Date("2026-03-05T01:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-03-05T01:05:00.000Z"),
    });

    const rows = await testDb.pool.query(`
      select fan_id,
             correlation_account_id,
             raw_status,
             creator_net_amount_mills,
             source_updated_at
      from transactions
      where platform_account_id = ${page.id}
        and transaction_id = 'rescan-tip'
    `);

    expect(rows.rows[0]).toMatchObject({
      fan_id: BigInt(fan.id),
      correlation_account_id: null,
      raw_status: "3",
      creator_net_amount_mills: 1200n,
    });
    expect(rows.rows[0]?.source_updated_at).toBeInstanceOf(Date);
  });

  it("deletes only missing transactions in a keep-set cleanup window", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "keep-set-cleanup-model",
      name: "Keep Set Cleanup Model",
    });
    const page = await createOnlyFansPage(testDb.db, {
      modelId: model.id,
      label: "keep-set-cleanup-page",
    });

    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      transactionId: "keep-me",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 1000n,
      sourceDestinationAmountMills: 1000n,
      creatorNetAmountMills: 1000n,
      occurredAt: new Date("2026-03-06T00:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      transactionId: "drop-me",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 1000n,
      sourceDestinationAmountMills: 1000n,
      creatorNetAmountMills: 1000n,
      occurredAt: new Date("2026-03-06T01:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      transactionId: "outside-window",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 1000n,
      sourceDestinationAmountMills: 1000n,
      creatorNetAmountMills: 1000n,
      occurredAt: new Date("2026-03-08T00:00:00.000Z"),
    });

    await deleteTransactionsMissingFromWindow(testDb.db, {
      platformAccountId: page.id,
      from: new Date("2026-03-05T00:00:00.000Z"),
      to: new Date("2026-03-07T00:00:00.000Z"),
      cleanupMode: "keep_set",
      keepTransactionIds: ["keep-me"],
    });

    const rows = await testDb.pool.query(`
      select transaction_id,
             is_active as "isActive",
             inactive_reason as "inactiveReason"
      from transactions
      where platform_account_id = ${page.id}
      order by transaction_id asc
    `);

    expect(rows.rows).toEqual([
      {
        transaction_id: "drop-me",
        isActive: false,
        inactiveReason: "missing_from_sync_window",
      },
      {
        transaction_id: "keep-me",
        isActive: true,
        inactiveReason: null,
      },
      {
        transaction_id: "outside-window",
        isActive: true,
        inactiveReason: null,
      },
    ]);
  });

  it("deletes the full cleanup window for authoritative empty scans", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "authoritative-empty-cleanup-model",
      name: "Authoritative Empty Cleanup Model",
    });
    const page = await createOnlyFansPage(testDb.db, {
      modelId: model.id,
      label: "authoritative-empty-cleanup-page",
    });

    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      transactionId: "drop-1",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 1000n,
      sourceDestinationAmountMills: 1000n,
      creatorNetAmountMills: 1000n,
      occurredAt: new Date("2026-03-06T00:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      transactionId: "drop-2",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 1000n,
      sourceDestinationAmountMills: 1000n,
      creatorNetAmountMills: 1000n,
      occurredAt: new Date("2026-03-06T01:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      transactionId: "outside-window",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 1000n,
      sourceDestinationAmountMills: 1000n,
      creatorNetAmountMills: 1000n,
      occurredAt: new Date("2026-03-08T00:00:00.000Z"),
    });

    await deleteTransactionsMissingFromWindow(testDb.db, {
      platformAccountId: page.id,
      from: new Date("2026-03-05T00:00:00.000Z"),
      to: new Date("2026-03-07T00:00:00.000Z"),
      cleanupMode: "authoritative_empty",
      keepTransactionIds: [],
    });

    const rows = await testDb.pool.query(`
      select transaction_id,
             is_active as "isActive",
             inactive_reason as "inactiveReason"
      from transactions
      where platform_account_id = ${page.id}
      order by transaction_id asc
    `);

    expect(rows.rows).toEqual([
      {
        transaction_id: "drop-1",
        isActive: false,
        inactiveReason: "missing_from_sync_window",
      },
      {
        transaction_id: "drop-2",
        isActive: false,
        inactiveReason: "missing_from_sync_window",
      },
      {
        transaction_id: "outside-window",
        isActive: true,
        inactiveReason: null,
      },
    ]);
  });

  it("rebuilds revenue rollups from the first affected business day without deleting older history", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "partial-rollup-model",
      name: "Partial Rollup Model",
    });
    const page = await createOnlyFansPage(testDb.db, {
      modelId: model.id,
      label: "partial-rollup-of",
    });

    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      transactionId: "historic-of-tip",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 1000n,
      sourceDestinationAmountMills: 1000n,
      creatorNetAmountMills: 1000n,
      occurredAt: new Date("2026-03-05T12:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      transactionId: "same-day-early-of-tip",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 2000n,
      sourceDestinationAmountMills: 2000n,
      creatorNetAmountMills: 2000n,
      occurredAt: new Date("2026-03-06T01:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      transactionId: "same-day-late-of-tip",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 3000n,
      sourceDestinationAmountMills: 3000n,
      creatorNetAmountMills: 3000n,
      occurredAt: new Date("2026-03-06T20:00:00.000Z"),
    });

    await rebuildRevenueRollups(testDb.db, page.id);
    await rebuildRevenueRollups(testDb.db, page.id, new Date("2026-03-06T18:00:00.000Z"));

    const rows = await testDb.pool.query(`
      select business_date,
             gross_amount_mills,
             creator_net_amount_mills
      from revenue_daily
      where platform_account_id = ${page.id}
      order by business_date asc
    `);

    expect(rows.rows.map((row) => ({
      ...row,
      business_date: typeof row.business_date === "string"
        ? row.business_date
        : [
          row.business_date.getFullYear(),
          String(row.business_date.getMonth() + 1).padStart(2, "0"),
          String(row.business_date.getDate()).padStart(2, "0"),
        ].join("-"),
    }))).toEqual([
      {
        business_date: "2026-03-05",
        gross_amount_mills: 1000n,
        creator_net_amount_mills: 1000n,
      },
      {
        business_date: "2026-03-06",
        gross_amount_mills: 5000n,
        creator_net_amount_mills: 5000n,
      },
    ]);
  });

  it("rebuilds Fansly revenue rollups from the first affected UTC business day", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "partial-rollup-fansly-model",
      name: "Partial Rollup Fansly Model",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "partial-rollup-fansly",
    });

    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      transactionId: "historic-fansly-tip",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 1000n,
      sourceDestinationAmountMills: 1000n,
      creatorNetAmountMills: 1000n,
      occurredAt: new Date("2025-11-30T21:30:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      transactionId: "same-day-early-fansly-tip",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 2000n,
      sourceDestinationAmountMills: 2000n,
      creatorNetAmountMills: 2000n,
      occurredAt: new Date("2025-12-01T00:10:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      transactionId: "same-day-late-fansly-tip",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 3000n,
      sourceDestinationAmountMills: 3000n,
      creatorNetAmountMills: 3000n,
      occurredAt: new Date("2025-12-01T20:00:00.000Z"),
    });

    await rebuildRevenueRollups(testDb.db, page.id);
    await rebuildRevenueRollups(testDb.db, page.id, new Date("2025-12-01T18:00:00.000Z"));

    const rows = await testDb.pool.query(`
      select business_date,
             gross_amount_mills,
             creator_net_amount_mills
      from revenue_daily
      where platform_account_id = ${page.id}
      order by business_date asc
    `);

    expect(rows.rows.map((row) => ({
      ...row,
      business_date: typeof row.business_date === "string"
        ? row.business_date
        : [
          row.business_date.getFullYear(),
          String(row.business_date.getMonth() + 1).padStart(2, "0"),
          String(row.business_date.getDate()).padStart(2, "0"),
        ].join("-"),
    }))).toEqual([
      {
        business_date: "2025-11-30",
        gross_amount_mills: 1000n,
        creator_net_amount_mills: 1000n,
      },
      {
        business_date: "2025-12-01",
        gross_amount_mills: 5000n,
        creator_net_amount_mills: 5000n,
      },
    ]);
  });

  it("maps Fansly raw type 20001 into the tip revenue bucket end to end", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "fansly-tip-sync-model",
      name: "Fansly Tip Sync Model",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "fansly-tip-sync",
    });
    const app = createTestAppContext(testDb);

    // The Sync Engine's transactions apply (resources/transactions.ts): the
    // served item through the shared mapper into the ledger, then the
    // dirty range's revenue rollups.
    const { row } = mapFanslyTransactionItem({
      transactionId: "mapped-tip-20001",
      walletId: "wallet-tip-sync",
      accountId: "account-tip-sync",
      correlationId: null,
      correlationAccountId: null,
      type: 20001,
      status: 2,
      destination: null,
      amount: 12000,
      destinationAmount: 12000,
      destinationTax: null,
      newBalance: null,
      newBalance64: null,
      senderId: null,
      receiverId: null,
      createdAt: new Date("2026-03-10T12:00:00.000Z").getTime(),
      updatedAt: null,
    }, 0);
    await upsertFanslyTransactionWithEarningsDirty(testDb.db, {
      platformAccountId: page.id,
      source: "fansly:rest",
      fanId: null,
      ...row,
    });
    await rebuildRevenueRollups(testDb.db, page.id, row.occurredAt);

    const transactionRows = await testDb.pool.query(`
      select raw_type, canonical_type
      from transactions
      where platform_account_id = ${page.id}
        and transaction_id = 'mapped-tip-20001'
    `);
    expect(transactionRows.rows[0]).toEqual({
      raw_type: "20001",
      canonical_type: "tip",
    });

    const report = await getPageRevenueReport(app, page.label, {
      period: "30d",
      now: new Date("2026-03-15T00:00:00.000Z"),
    });
    expect(report.revenueMills).toBe(12000);
    expect(report.breakdown).toEqual(expect.arrayContaining([
      {
        canonicalType: "tip",
        bucket: "revenue",
        netAmountMills: 12000,
      },
    ]));
    expect(report.breakdown.some((row) => row.canonicalType === "other")).toBe(false);
  });

  it("fully clears stale spender projections when qualifying ledger rows disappear", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "stale-spender-model",
      name: "Stale Spender Model",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "stale-spender-page",
    });
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "stale-fan-1",
      username: "stalefan",
    }]);
    assert(fan !== undefined, "Expected fan from the test fixture");

    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      fanId: fan.id,
      transactionId: "stale-tip",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 2000n,
      sourceDestinationAmountMills: 2000n,
      creatorNetAmountMills: 2000n,
      occurredAt: new Date("2026-03-05T00:00:00.000Z"),
    });

    await recalculateFanPageSpend(testDb.db, page.id);

    const beforeDelete = await testDb.pool.query(`
      select gross_amount_mills, creator_net_amount_mills
      from fan_spend_lifetime
      where fan_id = ${fan.id}
        and platform_account_id = ${page.id}
    `);
    expect(beforeDelete.rows).toEqual([
      {
        gross_amount_mills: 2000n,
        creator_net_amount_mills: 2000n,
      },
    ]);
    const beforeDeleteFanPage = await testDb.pool.query(`
      select total_creator_net_mills
      from page_fans
      where fan_id = ${fan.id}
        and platform_account_id = ${page.id}
    `);
    expect(BigInt(beforeDeleteFanPage.rows[0]?.total_creator_net_mills ?? 0)).toBe(2000n);

    await testDb.pool.query(`
      delete from transactions
      where platform_account_id = ${page.id}
        and transaction_id = 'stale-tip'
    `);

    await recalculateFanPageSpend(testDb.db, page.id);

    const afterDeleteLifetime = await testDb.pool.query(`
      select count(*)::int as count
      from fan_spend_lifetime
      where fan_id = ${fan.id}
        and platform_account_id = ${page.id}
    `);
    const afterDeleteDailyFacts = await testDb.pool.query(`
      select count(*)::int as count
      from fan_spend_daily
      where fan_id = ${fan.id}
        and platform_account_id = ${page.id}
    `);
    const afterDeleteFanPage = await testDb.pool.query(`
      select total_creator_net_mills
      from page_fans
      where fan_id = ${fan.id}
        and platform_account_id = ${page.id}
    `);

    expect(afterDeleteLifetime.rows[0]?.count).toBe(0);
    expect(afterDeleteDailyFacts.rows[0]?.count).toBe(0);
    expect(BigInt(afterDeleteFanPage.rows[0]?.total_creator_net_mills ?? 0)).toBe(0n);
  });

  it("upserts top spenders by source identity key when correlation identity is missing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "top-spender-fallback-model",
      name: "Top Spender Fallback Model",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "top-spender-fallback-page",
    });

    await upsertPageTopSpenders(testDb.db, [{
      platformAccountId: page.id,
      sourceIdentityKey: "account:acct-1",
      correlationAccountId: null,
      accountId: "acct-1",
      fanId: null,
      grossAmountMills: 1000n,
      creatorNetAmountMills: 750n,
      sourceWindowStartedAt: new Date("2026-03-01T00:00:00.000Z"),
      sourceWindowEndedAt: new Date("2026-03-08T00:00:00.000Z"),
    }]);
    await upsertPageTopSpenders(testDb.db, [{
      platformAccountId: page.id,
      sourceIdentityKey: "account:acct-1",
      correlationAccountId: null,
      accountId: "acct-1",
      fanId: null,
      grossAmountMills: 1250n,
      creatorNetAmountMills: 900n,
      sourceWindowStartedAt: new Date("2026-03-08T00:00:00.000Z"),
      sourceWindowEndedAt: new Date("2026-03-15T00:00:00.000Z"),
    }]);

    const rows = await testDb.pool.query(`
      select source_identity_key,
             correlation_account_id,
             account_id,
             gross_amount_mills,
             creator_net_amount_mills,
             source_window_started_at,
             source_window_ended_at
      from page_fan_identities
      where platform_account_id = ${page.id}
    `);

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      source_identity_key: "account:acct-1",
      correlation_account_id: null,
      account_id: "acct-1",
      gross_amount_mills: 1250n,
      creator_net_amount_mills: 900n,
    });
    expect(new Date(rows.rows[0].source_window_started_at).toISOString()).toBe("2026-03-08T00:00:00.000Z");
    expect(new Date(rows.rows[0].source_window_ended_at).toISOString()).toBe("2026-03-15T00:00:00.000Z");
  });
});
