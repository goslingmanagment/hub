import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  encryptJson,
  type StoredPlatformCredentialBundle,
} from "@agency_hub_core/shared";
import {
  createOnlyFansPage,
  createFanslyPage,
  createModel,
  deleteProxyConfig,
  deleteTransactionsMissingFromWindow,
  getFollowersForPage,
  listFollowersForPage,
  recalculateFanPageSpend,
  refreshFanPageFollowerState,
  rebuildRevenueRollups,
  startSyncRun,
  storeFanslySession,
  storeProxyConfig,
  updatePageMetadata,
  upsertCheckpoint,
  upsertFanPage,
  upsertFanPageExternalPresences,
  upsertFans,
  upsertPageDmConversation,
  upsertPageTopSpenders,
  upsertPageFollow,
  upsertPageSubscription,
  upsertTransaction,
} from "@agency_hub_core/db";
import type { FanslyAccountMeResponse } from "@agency_hub_core/fansly";
import type { OnlyMonsterAccount } from "@agency_hub_core/onlyfans";

import { onboardFanslyPage, onboardOnlyFansPage } from "../apps/runtime/src/services/page-onboarding.ts";
import { updatePageCredentials } from "../apps/runtime/src/services/connections.ts";
import { resolvePageContext, saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { getPageRevenueReport } from "../apps/runtime/src/services/reporting.ts";
import { syncTransactions } from "../apps/runtime/src/services/sync/transactions.ts";
import { setPageProxy } from "../apps/runtime/src/services/page-proxies.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

describe("db write safety", () => {
  let testDb: StartedTestDatabase | null = null;
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
        encryptionKeysByVersion: new Map([[1, encryptionKey]]),
        logLevel: "silent",
        apiHost: "0.0.0.0",
        apiPort: 3000,
        trustProxy: false,
        sessionTtlDays: 30,
        fanslyBaseUrl: "https://example.invalid",
        onlyMonsterBaseUrl: "https://example.invalid",
        syncHttpTraceFile: null,
        fanslyDefaultDelayMs: 2500,
        fanslyDmConversationsDelayMs: 5000,
        fanslyDmMessagesDelayMs: 5000,
        followerPageDelayMs: 0,
        onlyFansDefaultDelayMs: 1000,
        transactionLookbackDays: 7,
        transactionRescanCapDays: 30,
        syncSharedRateLimitEnabled: false,
        syncPageExecutorConcurrency: 1,
        syncObservabilityRetentionDays: 30,
        healthSyncLightMaxAgeMinutes: 180,
        healthSyncFollowerMaxAgeMinutes: 1080,
        healthSyncMonitoringToken: null,
        telegramBotToken: null,
        telegramChatId: null,
        telegramEnabled: false,
        telegramReportHourUtc: 9,
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
        encryptionKeysByVersion: new Map([[1, encryptionKey]]),
        logLevel: "silent",
        apiHost: "0.0.0.0",
        apiPort: 3000,
        trustProxy: false,
        sessionTtlDays: 30,
        fanslyBaseUrl: "https://example.invalid",
        onlyMonsterBaseUrl: "https://example.invalid",
        syncHttpTraceFile: null,
        fanslyDefaultDelayMs: 2500,
        fanslyDmConversationsDelayMs: 5000,
        fanslyDmMessagesDelayMs: 5000,
        followerPageDelayMs: 0,
        onlyFansDefaultDelayMs: 1000,
        transactionLookbackDays: 7,
        transactionRescanCapDays: 30,
        syncSharedRateLimitEnabled: false,
        syncPageExecutorConcurrency: 1,
        syncObservabilityRetentionDays: 30,
        healthSyncLightMaxAgeMinutes: 180,
        healthSyncFollowerMaxAgeMinutes: 1080,
        healthSyncMonitoringToken: null,
        telegramBotToken: null,
        telegramChatId: null,
        telegramEnabled: false,
        telegramReportHourUtc: 9,
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
             external_page_id,
             username,
             display_name,
             follower_count,
             subscriber_count,
             earnings_balance_mills,
             last_verified_at is not null as has_last_verified_at,
             last_light_sync_at is not null as has_last_light_sync_at
      from pages
      where id = ${page.id}
    `);
    const credentialRows = await testDb.pool.query(`
      select count(*)::int as count, max(key_version)::int as key_version
      from page_credentials
      where platform_account_id = ${page.id}
    `);
    const proxyRows = await testDb.pool.query(`
      select count(*)::int as count,
             max(url) as url,
             bool_or(encrypted_auth is not null) as has_encrypted_auth
      from egress_endpoints
      where platform_account_id = ${page.id}
    `);

    expect(pageRows.rows[0]).toMatchObject({
      label: "lora-main",
      external_page_id: "acct-123",
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
        (select count(*)::int from pages) as pages_count,
        (select count(*)::int from page_credentials) as credentials_count,
        (select count(*)::int from egress_endpoints) as proxies_count
    `);

    expect(counts.rows[0]).toMatchObject({
      pages_count: 0,
      credentials_count: 0,
      proxies_count: 0,
    });
  });

  it("rejects onboarding a second Fansly page for the same upstream account", async (context) => {
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

    await onboardFanslyPage(app, {
      modelSlug: "lora",
      label: "lora-main",
      session: {
        authorization: "token-1",
      },
    });

    await expect(
      onboardFanslyPage(app, {
        modelSlug: "lora",
        label: "lora-duplicate",
        session: {
          authorization: "token-2",
        },
      }),
    ).rejects.toThrow('Upstream account "fansly:acct-123" is already bound to page "lora-main"');

    const counts = await testDb.pool.query(`
      select
        (select count(*)::int from pages) as pages_count,
        (select count(*)::int from page_credentials) as credentials_count
    `);

    expect(counts.rows[0]).toMatchObject({
      pages_count: 1,
      credentials_count: 1,
    });
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
      url: "socks5://proxy-user:proxy-pass@127.0.0.1:1080",
    });

    const proxyRows = await testDb.pool.query(`
      select url, encrypted_auth is not null as has_encrypted_auth
      from egress_endpoints
      where platform_account_id = ${page.id}
    `);

    expect(proxyRows.rows[0]).toEqual({
      url: "socks5://127.0.0.1:1080",
      has_encrypted_auth: true,
    });
  });

  it("verifies credentials before saving a proxy on an existing page", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "verify-proxy-model",
      name: "Verify Proxy Model",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "verify-proxy-page",
    });

    const encryptedSession = JSON.stringify(
      encryptJson<StoredPlatformCredentialBundle>(
        {
          platform: "fansly",
          session: {
            authorization: "token",
          },
        },
        encryptionKey,
        1,
      ),
    );
    await storeFanslySession(testDb.db, page.id, encryptedSession, 1);

    let verifyCallCount = 0;
    let verifiedProxy: Record<string, unknown> | null = null;
    const app = createTestAppContext(testDb, {
      adapter: {
        async verifySession(contextInput: { proxy?: Record<string, unknown> | null }) {
          verifyCallCount += 1;
          verifiedProxy = contextInput.proxy ?? null;
          return {
            parsed: {
              account: {
                id: "acct-1",
                username: "lana",
                displayName: "Lana",
                followCount: 0,
                subscriberCount: 0,
              },
            },
            raw: null,
          };
        },
      } as never,
    });

    await setPageProxy(app, page.label, {
      url: "socks5://proxy-user:proxy-pass@proxy.example:1080",
    });

    const proxyRows = await testDb.pool.query(`
      select url, encrypted_auth is not null as has_encrypted_auth
      from egress_endpoints
      where platform_account_id = ${page.id}
    `);

    expect(verifyCallCount).toBe(1);
    expect(verifiedProxy).toEqual({
      url: "socks5://proxy.example:1080",
      username: "proxy-user",
      password: "proxy-pass",
    });
    expect(proxyRows.rows[0]).toEqual({
      url: "socks5://proxy.example:1080",
      has_encrypted_auth: true,
    });
  });

  it("resolves legacy inline-auth proxy URLs when loading page context", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "legacy-proxy-model",
      name: "Legacy Proxy Model",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "legacy-proxy-page",
    });

    const encryptedSession = JSON.stringify(
      encryptJson<StoredPlatformCredentialBundle>(
        {
          platform: "fansly",
          session: {
            authorization: "token",
          },
        },
        encryptionKey,
        1,
      ),
    );
    await storeFanslySession(testDb.db, page.id, encryptedSession, 1);
    await testDb.pool.query(
      `
        insert into egress_endpoints (
          platform_account_id,
          kind,
          url,
          encrypted_auth,
          key_version,
          rate_limit_scope_key
        ) values ($1, 'proxy', $2, null, null, null)
      `,
      [page.id, "socks5://legacy-user:legacy-pass@127.0.0.1:1080"],
    );

    const contextResult = await resolvePageContext(createTestAppContext(testDb), page.label);

    expect(contextResult.proxy).toEqual({
      url: "socks5://127.0.0.1:1080",
      egressKey: "socks5://127.0.0.1:1080",
      username: "legacy-user",
      password: "legacy-pass",
    });
  });

  it("backfills canonical egress keys for legacy inline-auth proxy URLs", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "proxy-migration-model",
      name: "Proxy Migration Model",
    });
    const inlineAuthPage = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "proxy-migration-inline-auth",
    });
    const queryPage = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "proxy-migration-query",
    });
    const fragmentPage = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "proxy-migration-fragment",
    });
    const leadingZeroPortPage = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "proxy-migration-leading-zero-port",
    });
    const ipv6Page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "proxy-migration-ipv6",
    });
    const uppercaseHostPage = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "proxy-migration-uppercase-host",
    });
    const mappedIpv6Page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "proxy-migration-mapped-ipv6",
    });
    const invalidIpv6Page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "proxy-migration-invalid-ipv6",
    });
    const invalidPortPage = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "proxy-migration-invalid-port",
    });
    const extraAuthorityPage = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "proxy-migration-extra-authority",
    });

    await testDb.pool.query(`
      insert into egress_endpoints (
        platform_account_id,
        kind,
        url,
        encrypted_auth,
        key_version,
        rate_limit_scope_key
      ) values
        ($1, 'proxy', $2, null, null, null),
        ($3, 'proxy', $4, null, null, null),
        ($5, 'proxy', $6, null, null, null),
        ($7, 'proxy', $8, null, null, null),
        ($9, 'proxy', $10, null, null, null),
        ($11, 'proxy', $12, null, null, null),
        ($13, 'proxy', $14, null, null, null),
        ($15, 'proxy', $16, null, null, null),
        ($17, 'proxy', $18, null, null, null),
        ($19, 'proxy', $20, null, null, null)
    `, [
      inlineAuthPage.id,
      "socks5://legacy-user:legacy-pass@127.0.0.1",
      queryPage.id,
      "socks5://legacy-user:legacy-pass@127.0.0.1?pool=a",
      fragmentPage.id,
      "socks5://legacy-user:legacy-pass@127.0.0.1#primary",
      leadingZeroPortPage.id,
      "socks5://legacy-user:legacy-pass@proxy.example:01080",
      ipv6Page.id,
      "socks5://legacy-user:legacy-pass@[2001:0db8:0:0:0:0:0:1]",
      uppercaseHostPage.id,
      "socks5://legacy-user:legacy-pass@Proxy.EXAMPLE",
      mappedIpv6Page.id,
      "socks5://legacy-user:legacy-pass@[::ffff:192.0.2.1]:1080",
      invalidIpv6Page.id,
      "socks5://legacy-user:legacy-pass@[bad:host]:1080",
      invalidPortPage.id,
      "socks5://legacy-user:legacy-pass@proxy.example:999999999999999999",
      extraAuthorityPage.id,
      "socks5://legacy-user:legacy-pass@proxy.example:1080:garbage",
    ]);

    const migration = await readFile(
      "packages/db/migrations/0013_backfill_egress_rate_limit_scope_key.sql",
      "utf8",
    );
    await testDb.pool.query(migration);

    const proxyRows = await testDb.pool.query(`
      select url, rate_limit_scope_key
      from egress_endpoints
      where platform_account_id = any($1::int[])
      order by id
    `, [[
      inlineAuthPage.id,
      queryPage.id,
      fragmentPage.id,
      leadingZeroPortPage.id,
      ipv6Page.id,
      uppercaseHostPage.id,
      mappedIpv6Page.id,
      invalidIpv6Page.id,
      invalidPortPage.id,
      extraAuthorityPage.id,
    ]]);

    expect(proxyRows.rows).toEqual([
      {
        url: "socks5://legacy-user:legacy-pass@127.0.0.1",
        rate_limit_scope_key: "socks5://127.0.0.1:1080",
      },
      {
        url: "socks5://legacy-user:legacy-pass@127.0.0.1?pool=a",
        rate_limit_scope_key: "socks5://127.0.0.1:1080",
      },
      {
        url: "socks5://legacy-user:legacy-pass@127.0.0.1#primary",
        rate_limit_scope_key: "socks5://127.0.0.1:1080",
      },
      {
        url: "socks5://legacy-user:legacy-pass@proxy.example:01080",
        rate_limit_scope_key: "socks5://proxy.example:1080",
      },
      {
        url: "socks5://legacy-user:legacy-pass@[2001:0db8:0:0:0:0:0:1]",
        rate_limit_scope_key: "socks5://[2001:db8::1]:1080",
      },
      {
        url: "socks5://legacy-user:legacy-pass@Proxy.EXAMPLE",
        rate_limit_scope_key: "socks5://proxy.example:1080",
      },
      {
        url: "socks5://legacy-user:legacy-pass@[::ffff:192.0.2.1]:1080",
        rate_limit_scope_key: "socks5://[::ffff:c000:201]:1080",
      },
      {
        url: "socks5://legacy-user:legacy-pass@[bad:host]:1080",
        rate_limit_scope_key: null,
      },
      {
        url: "socks5://legacy-user:legacy-pass@proxy.example:999999999999999999",
        rate_limit_scope_key: null,
      },
      {
        url: "socks5://legacy-user:legacy-pass@proxy.example:1080:garbage",
        rate_limit_scope_key: null,
      },
    ]);
  });

  it("repairs non-null canonical egress keys from previously applied migrations", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "proxy-repair-model",
      name: "Proxy Repair Model",
    });
    const uppercaseHostPage = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "proxy-repair-uppercase-host",
    });
    const leadingZeroPortPage = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "proxy-repair-leading-zero-port",
    });
    const ipv6Page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "proxy-repair-ipv6",
    });
    const customScopePage = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "proxy-repair-custom-scope",
    });

    await testDb.pool.query(`
      insert into egress_endpoints (
        platform_account_id,
        kind,
        url,
        encrypted_auth,
        key_version,
        rate_limit_scope_key
      ) values
        ($1, 'proxy', $2, null, null, $3),
        ($4, 'proxy', $5, null, null, $6),
        ($7, 'proxy', $8, null, null, $9),
        ($10, 'proxy', $11, null, null, $12)
    `, [
      uppercaseHostPage.id,
      "socks5://legacy-user:legacy-pass@Proxy.EXAMPLE",
      "socks5://Proxy.EXAMPLE:1080",
      leadingZeroPortPage.id,
      "socks5://legacy-user:legacy-pass@proxy.example:01080",
      "socks5://proxy.example:01080",
      ipv6Page.id,
      "socks5://legacy-user:legacy-pass@[2001:0db8:0:0:0:0:0:1]",
      "socks5://[2001:0db8:0:0:0:0:0:1]:1080",
      customScopePage.id,
      "socks5://legacy-user:legacy-pass@proxy.example",
      "shared-proxy-pool",
    ]);

    const migration = await readFile(
      "packages/db/migrations/0015_repair_egress_rate_limit_scope_key.sql",
      "utf8",
    );
    await testDb.pool.query(migration);

    const proxyRows = await testDb.pool.query(`
      select url, rate_limit_scope_key
      from egress_endpoints
      where platform_account_id = any($1::int[])
      order by id
    `, [[uppercaseHostPage.id, leadingZeroPortPage.id, ipv6Page.id, customScopePage.id]]);

    expect(proxyRows.rows).toEqual([
      {
        url: "socks5://legacy-user:legacy-pass@Proxy.EXAMPLE",
        rate_limit_scope_key: "socks5://proxy.example:1080",
      },
      {
        url: "socks5://legacy-user:legacy-pass@proxy.example:01080",
        rate_limit_scope_key: "socks5://proxy.example:1080",
      },
      {
        url: "socks5://legacy-user:legacy-pass@[2001:0db8:0:0:0:0:0:1]",
        rate_limit_scope_key: "socks5://[2001:db8::1]:1080",
      },
      {
        url: "socks5://legacy-user:legacy-pass@proxy.example",
        rate_limit_scope_key: "shared-proxy-pool",
      },
    ]);
  });

  it("reads stored credentials and proxy auth using historical encryption keys", async (context) => {
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
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "rotated-key-page",
    });

    await storeFanslySession(
      testDb.db,
      page.id,
      JSON.stringify(encryptJson<StoredPlatformCredentialBundle>(
        {
          platform: "fansly",
          session: {
            authorization: "legacy-token",
          },
        },
        historicalKey,
        1,
      )),
      1,
    );
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

    expect(contextResult.session).toBeDefined();
    if (!contextResult.session) {
      throw new Error("Expected page context session to be present");
    }

    expect(contextResult.session.authorization).toBe("legacy-token");
    expect(contextResult.proxy).toEqual({
      url: "socks5://127.0.0.1:1080",
      egressKey: "socks5://127.0.0.1:1080",
      username: "legacy-user",
      password: "legacy-pass",
    });
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

  it("reuses the stored proxy when credential updates omit proxy fields", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "stored-proxy-update-model",
      name: "Stored Proxy Update Model",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "stored-proxy-update-page",
    });

    await saveProxy(createTestAppContext(testDb), page.id, {
      url: "socks5://proxy-user:proxy-pass@127.0.0.1:1080",
    });

    let verifyCallCount = 0;
    let verifiedProxy: Record<string, unknown> | null = null;
    const app = createTestAppContext(testDb, {
      adapter: {
        async verifySession(contextInput: { proxy?: Record<string, unknown> | null }) {
          verifyCallCount += 1;
          verifiedProxy = contextInput.proxy ?? null;
          return {
            parsed: {
              account: {
                id: "acct-1",
                username: "lana",
                displayName: "Lana",
                followCount: 0,
                subscriberCount: 0,
              },
            },
            raw: null,
          };
        },
      } as never,
    });

    await updatePageCredentials(app, page.label, {
      platform: "fansly",
      session: {
        authorization: "replacement-token",
      },
    });

    const proxyRows = await testDb.pool.query(`
      select url, encrypted_auth is not null as has_encrypted_auth
      from egress_endpoints
      where platform_account_id = ${page.id}
    `);

    expect(verifyCallCount).toBe(1);
    expect(verifiedProxy).toEqual({
      url: "socks5://127.0.0.1:1080",
      egressKey: "socks5://127.0.0.1:1080",
      username: "proxy-user",
      password: "proxy-pass",
    });
    expect(proxyRows.rows).toEqual([
      {
        url: "socks5://127.0.0.1:1080",
        has_encrypted_auth: true,
      },
    ]);
  });

  it("updates proxy settings without requiring credentials to be re-entered", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "proxy-only-credentials-model",
      name: "Proxy Only Credentials Model",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "proxy-only-credentials-page",
    });

    let verifiedAuthorization: string | null = null;
    const app = createTestAppContext(testDb, {
      adapter: {
        async verifySession(contextInput: { session: { authorization: string } }) {
          verifiedAuthorization = contextInput.session.authorization;
          return {
            parsed: {
              account: {
                id: "acct-1",
                username: "lana",
                displayName: "Lana",
                followCount: 0,
                subscriberCount: 0,
              },
            },
            raw: null,
          };
        },
      } as never,
    });

    await updatePageCredentials(app, page.label, {
      platform: "fansly",
      session: {
        authorization: "stored-token",
      },
    });
    verifiedAuthorization = null;

    await updatePageCredentials(app, page.label, {
      platform: "fansly",
      proxy: {
        url: "http://8.8.8.8:8080",
      },
    });

    const proxyRows = await testDb.pool.query(`
      select url
      from egress_endpoints
      where platform_account_id = ${page.id}
    `);

    expect(verifiedAuthorization).toBe("stored-token");
    expect(proxyRows.rows).toEqual([{ url: "http://8.8.8.8:8080" }]);
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
             external_page_id,
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
      external_page_id: "of-acct-42",
      username: "lora_of",
      display_name: "Lora OF",
      follower_count: null,
      subscriber_count: null,
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

  it("uses the first OnlyFans username match when multiple accounts share the username", async (context) => {
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

    const { page } = await onboardOnlyFansPage(app, {
      modelSlug: "lora",
      label: "lora-of",
      auth: {
        token: "om-token",
      },
      username: "lora_of",
    });

    const pageRows = await testDb.pool.query(`
      select external_page_id,
             username,
             metadata::text as metadata
      from pages
      where id = ${page.id}
    `);

    expect(pageRows.rows[0]).toMatchObject({
      external_page_id: "of-acct-42",
      username: "lora_of",
    });
    expect(JSON.parse(pageRows.rows[0]?.metadata ?? "{}")).toMatchObject({
      onlyMonsterAccountId: 42,
    });
  });

  it("rejects Fansly credential updates that point at a different upstream account", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "fansly-credentials-model",
      name: "Fansly Credentials Model",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "fansly-credentials-page",
    });
    await updatePageMetadata(testDb.db, page.id, {
      platformAccountIdValue: "acct-123",
      username: "fansly-bound",
      displayName: "Fansly Bound",
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: {},
      syncType: "light",
    });

    const app = createTestAppContext(testDb, {
      adapter: {
        async verifySession() {
          return {
            parsed: {
              account: {
                id: "acct-999",
                username: "fansly-other",
                displayName: "Fansly Other",
                followCount: 0,
                subscriberCount: 0,
              },
            },
            raw: null,
          };
        },
      } as never,
    });

    await expect(
      updatePageCredentials(app, page.label, {
        platform: "fansly",
        session: {
          authorization: "replacement-token",
        },
      }),
    ).rejects.toThrow(
      'Submitted credentials belong to upstream account "acct-999", but page "fansly-credentials-page" is bound to "acct-123"',
    );

    const credentialRows = await testDb.pool.query(`
      select count(*)::int as count
      from page_credentials
      where platform_account_id = ${page.id}
    `);
    expect(credentialRows.rows[0]?.count).toBe(0);
  });

  it("rejects OnlyFans credential updates that point at a different upstream account", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "onlyfans-credentials-model",
      name: "OnlyFans Credentials Model",
    });
    const page = await createOnlyFansPage(testDb.db, {
      modelId: model.id,
      label: "onlyfans-credentials-page",
    });
    await updatePageMetadata(testDb.db, page.id, {
      platformAccountIdValue: "of-acct-42",
      username: "lora_of",
      displayName: "Lora OF",
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: {},
      syncType: "light",
    });

    const mismatchAccount: OnlyMonsterAccount = {
      id: 99,
      platform_account_id: "of-acct-99",
      platform: "onlyfans",
      name: "Other OF",
      email: null,
      avatar: "https://example.com/other.png",
      username: "other_of",
      organisation_id: "org-2",
      subscribe_price: null,
      subscription_expiration_date: null,
    };

    const app = createTestAppContext(testDb, {
      onlyFansAdapter: {
        async listAccountsPage() {
          return {
            parsed: {
              accounts: [mismatchAccount],
            },
            raw: {
              accounts: [mismatchAccount],
            },
          };
        },
      } as never,
    });

    await expect(
      updatePageCredentials(app, page.label, {
        platform: "onlyfans",
        auth: {
          token: "replacement-token",
        },
        username: "other_of",
      }),
    ).rejects.toThrow(
      'Submitted credentials belong to upstream account "of-acct-99", but page "onlyfans-credentials-page" is bound to "of-acct-42"',
    );

    const credentialRows = await testDb.pool.query(`
      select count(*)::int as count
      from page_credentials
      where platform_account_id = ${page.id}
    `);
    expect(credentialRows.rows[0]?.count).toBe(0);
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
        (select count(*)::int from pages) as pages_count,
        (select count(*)::int from page_credentials) as credentials_count
    `);

    expect(counts.rows[0]).toMatchObject({
      pages_count: 0,
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

  it("enriches active followers with subscriber, spend, DM, and presence state", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "mira",
      name: "Mira",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "mira-main",
    });
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-rich",
      username: "richfan",
      displayName: "Rich Fan",
    }]);
    const now = new Date();
    const presenceAt = new Date(now.getTime() - 12 * 60 * 1000);
    const followedAt = new Date(now.getTime() - 60 * 60 * 1000);
    const expiresAt = new Date(now.getTime() + 3 * 86_400_000);
    const messageAt = new Date(now.getTime() - 20 * 60 * 1000);

    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
      isFollower: true,
      followerSince: followedAt,
      isSubscriber: true,
      subscriberSince: new Date(now.getTime() - 2 * 86_400_000),
      subscriptionExpiresAt: expiresAt,
      autoRenew: false,
    });
    await upsertFanPageExternalPresences(testDb.db, [{
      fanId: fan.id,
      platformAccountId: page.id,
      externalPresenceAt: presenceAt,
      externalPresenceObservedAt: now,
    }]);
    await upsertPageFollow(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      platformFollowId: "follow-rich",
      followedAt,
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      transactionId: "tx-rich-tip",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 12_340n,
      sourceDestinationAmountMills: 12_340n,
      creatorNetAmountMills: 12_340n,
      occurredAt: new Date(now.getTime() - 30 * 60 * 1000),
    });
    await recalculateFanPageSpend(testDb.db, page.id);
    await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      platformConversationId: "conv-rich",
      partnerPlatformUserId: "fan-rich",
      partnerUsername: "richfan",
      partnerDisplayName: "Rich Fan",
      conversationFlags: 0,
      unreadCount: 2,
      subscriptionTierId: null,
      lastMessageId: "msg-rich",
      lastUnreadMessageId: "msg-rich",
      lastMessageAt: messageAt,
      lastMessageSenderId: "fan-rich",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "hey are you online?",
      lastFanMessageAt: messageAt,
      lastModelMessageAt: null,
      storedMessageCount: 1,
      messageCoverageStatus: "partial_window",
      messageBackfillComplete: false,
      lastMessageSyncAt: messageAt,
      isVisible: true,
      lastSeenGeneration: 1,
    });

    const result = await listFollowersForPage(testDb.db, {
      pageId: page.id,
      limit: 10,
      offset: 0,
      activeWithinMinutes: 120,
      dmStatus: "has_dm",
      subscriber: true,
    });

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      platformUserId: "fan-rich",
      isSubscriber: true,
      autoRenew: false,
      totalCreatorNetAmountMills: 12_340n,
      platformConversationId: "conv-rich",
      unreadCount: 2,
      lastMessagePreview: "hey are you online?",
      presenceStatus: "active_now",
    });
    expect(new Date(result.items[0]!.subscriptionExpiresAt!).toISOString()).toBe(expiresAt.toISOString());
    expect(new Date(result.items[0]!.externalPresenceAt!).toISOString()).toBe(presenceAt.toISOString());
  });

  it("refreshes follower projection state safely when called directly", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "direct-refresh",
      name: "Direct Refresh",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "direct-refresh-main",
    });
    const otherPage = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "direct-refresh-other",
    });
    const [activeFan, inactiveFan, scopedFan] = await upsertFans(testDb.db, [
      {
        platform: "fansly",
        platformUserId: "fan-direct-active",
        username: "direct_active",
      },
      {
        platform: "fansly",
        platformUserId: "fan-direct-inactive",
        username: "direct_inactive",
      },
      {
        platform: "fansly",
        platformUserId: "fan-direct-scoped",
        username: "direct_scoped",
      },
    ]);

    await upsertFanPage(testDb.db, {
      platformAccountId: page.id,
      fanId: activeFan!.id,
      isFollower: false,
      followerSince: null,
    });
    await upsertFanPage(testDb.db, {
      platformAccountId: page.id,
      fanId: inactiveFan!.id,
      isFollower: true,
      followerSince: new Date("2026-03-01T00:00:00.000Z"),
    });
    await upsertFanPage(testDb.db, {
      platformAccountId: otherPage.id,
      fanId: scopedFan!.id,
      isFollower: true,
      followerSince: new Date("2026-03-02T00:00:00.000Z"),
    });

    await upsertPageFollow(testDb.db, {
      platformAccountId: page.id,
      fanId: activeFan!.id,
      platformFollowId: "follow-direct-active-later",
      followedAt: new Date("2026-03-05T00:00:00.000Z"),
    });
    await upsertPageFollow(testDb.db, {
      platformAccountId: page.id,
      fanId: activeFan!.id,
      platformFollowId: "follow-direct-active-earlier",
      followedAt: new Date("2026-03-04T00:00:00.000Z"),
    });
    await upsertPageFollow(testDb.db, {
      platformAccountId: page.id,
      fanId: inactiveFan!.id,
      platformFollowId: "follow-direct-inactive",
      followedAt: new Date("2026-03-03T00:00:00.000Z"),
    });
    await testDb.pool.query(`
      update page_follows
      set is_active = false
      where platform_account_id = ${page.id}
        and platform_follow_id = 'follow-direct-inactive'
    `);

    await refreshFanPageFollowerState(testDb.db, page.id);

    const rows = await testDb.pool.query<{
      platform_user_id: string;
      is_follower: boolean;
      follower_since: Date | null;
    }>(`
      select f.platform_user_id,
             fp.is_follower,
             fp.follower_since
      from page_fans fp
      join fans f on f.id = fp.fan_id
      where fp.platform_account_id in (${page.id}, ${otherPage.id})
      order by f.platform_user_id asc
    `);

    expect(rows.rows.map((row) => ({
      platformUserId: row.platform_user_id,
      isFollower: row.is_follower,
      followerSince: row.follower_since?.toISOString() ?? null,
    }))).toEqual([
      {
        platformUserId: "fan-direct-active",
        isFollower: true,
        followerSince: "2026-03-04T00:00:00.000Z",
      },
      {
        platformUserId: "fan-direct-inactive",
        isFollower: false,
        followerSince: null,
      },
      {
        platformUserId: "fan-direct-scoped",
        isFollower: true,
        followerSince: "2026-03-02T00:00:00.000Z",
      },
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
      from page_credentials
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
      from egress_endpoints
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
      from page_sync_cursors
      where page_id = ${page.id}
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
             bool_or(is_subscriber) as is_subscriber
      from page_fans
      where fan_id = ${fan.id}
        and platform_account_id = ${page.id}
    `);
    expect(fanPageRows.rows[0]?.count).toBe(1);
    expect(fanPageRows.rows[0]?.is_follower).toBe(true);
    expect(fanPageRows.rows[0]?.is_subscriber).toBe(true);

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
             max(price_mills)::bigint as price_mills,
             max(auto_renew_off_detected_at) as auto_renew_off_detected_at
      from page_subscriptions
      where platform_subscription_id = 'sub-1'
    `);
    expect(subscriptionRows.rows[0]?.count).toBe(1);
    expect(subscriptionRows.rows[0]?.raw_status).toBe(3);
    expect(subscriptionRows.rows[0]?.canonical_status).toBe("active");
    expect(BigInt(subscriptionRows.rows[0]?.price_mills ?? 0)).toBe(7000n);
    expect(subscriptionRows.rows[0]?.auto_renew_off_detected_at).toBeTruthy();

    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      transactionId: "tx-1",
      rawType: 15001,
      canonicalType: "subscription",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 1000n,
      sourceDestinationAmountMills: 1000n,
      creatorNetAmountMills: 1000n,
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
      grossAmountMills: 331000n,
      sourceDestinationAmountMills: 331000n,
      creatorNetAmountMills: 331000n,
      occurredAt: new Date("2026-03-05T01:00:00.000Z"),
    });

    const transactionRows = await testDb.pool.query(`
      select count(*)::int as count,
             max(raw_type)::int as raw_type,
             max(canonical_type) as canonical_type,
             max(creator_net_amount_mills)::bigint as net_amount_mills
      from transactions
      where platform_account_id = ${page.id}
        and transaction_id = 'tx-1'
    `);
    expect(transactionRows.rows[0]?.count).toBe(1);
    expect(transactionRows.rows[0]?.raw_type).toBe(16013);
    expect(transactionRows.rows[0]?.canonical_type).toBe("payout_reversal");
    expect(BigInt(transactionRows.rows[0]?.net_amount_mills ?? 0)).toBe(331000n);
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

    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
    });

    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
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

    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
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

  it("batches fan upserts and username alias writes into set-based statements", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const querySpy = vi.spyOn(testDb.pool, "query");

    try {
      const fans = await upsertFans(testDb.db, [
        {
          platform: "fansly",
          platformUserId: "batch-fan-1",
          username: "alpha",
          displayName: "Alpha",
        },
        {
          platform: "fansly",
          platformUserId: "batch-fan-2",
          username: "beta",
          displayName: "Beta",
        },
        {
          platform: "fansly",
          platformUserId: "batch-fan-1",
          displayName: "Alpha Updated",
        },
      ]);

      const statements = querySpy.mock.calls
        .map((call) => {
          const statement = call[0];
          if (typeof statement === "string") {
            return statement;
          }
          if (statement && typeof statement === "object" && "text" in statement) {
            const text = (statement as { text?: unknown }).text;
            return typeof text === "string" ? text : "";
          }
          return "";
        })
        .filter((statement) => statement.length > 0);
      expect(statements.filter((statement) => statement.includes('insert into "fans"'))).toHaveLength(1);
      expect(statements.filter((statement) => statement.includes('insert into "fan_username_aliases"')))
        .toHaveLength(1);
      expect(fans.map((fan) => fan.platformUserId)).toEqual([
        "batch-fan-1",
        "batch-fan-2",
      ]);
    } finally {
      querySpy.mockRestore();
    }

    const aliasRows = await testDb.pool.query(`
      select count(*)::int as count
      from fan_username_aliases
      where username in ('alpha', 'beta')
    `);
    expect(aliasRows.rows[0]?.count).toBe(2);
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
    const run = await startSyncRun(testDb.db, {
      platformAccountId: page.id,
      stream: "transactions",
      trigger: "worker",
    });
    const app = createTestAppContext(testDb, {
      adapter: {
        async getTransactionsPage() {
          return {
            items: [{
              transactionId: "mapped-tip-20001",
              walletId: null,
              accountId: null,
              correlationId: null,
              correlationAccountId: null,
              type: 20001,
              status: 2,
              destination: null,
              amount: 12000,
              destinationAmount: 12000,
              destinationTax: null,
              newBalance64: null,
              senderId: null,
              receiverId: null,
              createdAt: new Date("2026-03-10T12:00:00.000Z").getTime(),
              updatedAt: null,
            }],
            total: 1,
            done: true,
            raw: {
              items: [{
                transactionId: "mapped-tip-20001",
                type: 20001,
              }],
            },
          };
        },
        async getAccountsByIdsPage() {
          return {
            parsed: [],
            raw: [],
          };
        },
      } as never,
    });
    const telemetry = {
      recordCheckpointLoaded: vi.fn(async () => {}),
      recordCheckpointAdvanced: vi.fn(async () => {}),
      addAnomaly: vi.fn(async () => {}),
      addNote: vi.fn(async () => {}),
      mergeHydrationSummary: vi.fn(),
      setBoundarySummary: vi.fn(),
      setScanSummary: vi.fn(),
    };

    await syncTransactions(app, {
      pageLabel: page.label,
      platformAccountId: page.id,
      commissionRate: 0,
      requestContext: {
        session: { authorization: "token" },
        proxy: null,
        requestObserver: null,
      } as never,
      syncRunId: run.id,
      telemetry: telemetry as never,
    });

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

    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
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
