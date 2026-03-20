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
  getFollowersForPage,
  recalculateFanPageSpend,
  rebuildRevenueRollups,
  storeFanslySession,
  storeProxyConfig,
  updatePageMetadata,
  upsertCheckpoint,
  upsertFanPage,
  upsertFans,
  upsertPageFollow,
  upsertPageSubscription,
  upsertTransaction,
} from "@agency_hub_core/db";
import type { FanslyAccountMeResponse } from "@agency_hub_core/fansly";
import type { OnlyMonsterAccount } from "@agency_hub_core/onlyfans";

import { onboardFanslyPage, onboardOnlyFansPage } from "../apps/runtime/src/services/page-onboarding.ts";
import { updatePageCredentials } from "../apps/runtime/src/services/connections.ts";
import { resolvePageContext, saveProxy } from "../apps/runtime/src/services/page-context.ts";
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
        logLevel: "silent",
        apiHost: "0.0.0.0",
        apiPort: 3000,
        sessionTtlDays: 30,
        fanslyBaseUrl: "https://example.invalid",
        onlyMonsterBaseUrl: "https://example.invalid",
        syncHttpTraceFile: null,
        fanslyDefaultDelayMs: 2500,
        fanslyDmConversationsDelayMs: 5000,
        fanslyDmMessagesDelayMs: 7500,
        followerPageDelayMs: 0,
        onlyFansDefaultDelayMs: 1000,
        transactionLookbackDays: 7,
        transactionRescanCapDays: 30,
        syncSharedRateLimitEnabled: false,
        syncPageExecutorConcurrency: 1,
        syncObservabilityRetentionDays: 30,
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
        logLevel: "silent",
        apiHost: "0.0.0.0",
        apiPort: 3000,
        sessionTtlDays: 30,
        fanslyBaseUrl: "https://example.invalid",
        onlyMonsterBaseUrl: "https://example.invalid",
        syncHttpTraceFile: null,
        fanslyDefaultDelayMs: 2500,
        fanslyDmConversationsDelayMs: 5000,
        fanslyDmMessagesDelayMs: 7500,
        followerPageDelayMs: 0,
        onlyFansDefaultDelayMs: 1000,
        transactionLookbackDays: 7,
        transactionRescanCapDays: 30,
        syncSharedRateLimitEnabled: false,
        syncPageExecutorConcurrency: 1,
        syncObservabilityRetentionDays: 30,
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
        (select count(*)::int from platform_accounts) as platform_accounts_count,
        (select count(*)::int from platform_account_credentials) as credentials_count
    `);

    expect(counts.rows[0]).toMatchObject({
      platform_accounts_count: 1,
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
      select platform_account_id, username, display_name
      from platform_accounts
      where id = ${page.id}
    `);

    expect(rows.rows[0]).toMatchObject({
      platform_account_id: "acct-123",
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
      from platform_account_proxies
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
      url: "socks5://proxy-user:proxy-pass@127.0.0.1:1080",
    });

    const proxyRows = await testDb.pool.query(`
      select url, encrypted_auth is not null as has_encrypted_auth
      from platform_account_proxies
      where platform_account_id = ${page.id}
    `);

    expect(verifyCallCount).toBe(1);
    expect(verifiedProxy).toEqual({
      url: "socks5://127.0.0.1:1080",
      username: "proxy-user",
      password: "proxy-pass",
    });
    expect(proxyRows.rows[0]).toEqual({
      url: "socks5://127.0.0.1:1080",
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
    await storeProxyConfig(testDb.db, page.id, {
      url: "socks5://legacy-user:legacy-pass@127.0.0.1:1080",
      encryptedAuth: null,
      keyVersion: null,
    });

    const contextResult = await resolvePageContext(createTestAppContext(testDb), page.label);

    expect(contextResult.proxy).toEqual({
      url: "socks5://127.0.0.1:1080",
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
      from platform_account_proxies
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
      from platform_account_credentials
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
      from platform_account_credentials
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
      from fan_pages
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
      from spender_lifetime_page
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
      from spender_lifetime_page
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
      from daily_revenue
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
      from daily_revenue
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
      from spender_lifetime_page
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
      from fan_pages
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
      from spender_lifetime_page
      where fan_id = ${fan.id}
        and platform_account_id = ${page.id}
    `);
    const afterDeleteDailyFacts = await testDb.pool.query(`
      select count(*)::int as count
      from spender_daily_facts
      where fan_id = ${fan.id}
        and platform_account_id = ${page.id}
    `);
    const afterDeleteFanPage = await testDb.pool.query(`
      select total_creator_net_mills
      from fan_pages
      where fan_id = ${fan.id}
        and platform_account_id = ${page.id}
    `);

    expect(afterDeleteLifetime.rows[0]?.count).toBe(0);
    expect(afterDeleteDailyFacts.rows[0]?.count).toBe(0);
    expect(BigInt(afterDeleteFanPage.rows[0]?.total_creator_net_mills ?? 0)).toBe(0n);
  });
});
