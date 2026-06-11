import { assertRuntimeSchemaReady, createDb, createPool, type Database } from "@agency_hub_core/db";
import { FanslyAdapter } from "@agency_hub_core/fansly";
import { OnlyFansAdapter } from "@agency_hub_core/onlyfans";
import type {
  FanslyAccount,
  FanslyAccountMeResponse,
  FanslyEarningsAccountsPageResponse,
  FanslyEarningsTransaction,
  FanslyFollower,
  FanslyGroupDetail,
  FanslyMessagesPageResponse,
  FanslyMessagingGroupsPageResponse,
  FanslyRequestContext,
  FanslySubscriber,
} from "@agency_hub_core/fansly";
import {
  createLogger,
  loadConfig,
  resolveFanslyDefaultDelayEnvSource,
} from "@agency_hub_core/shared";

import { createOfapiCreditSpendSink } from "./services/ofapi-credits.ts";
import type { OfapiClient } from "./services/ofapi.ts";
import { createOfapiClient } from "./services/ofapi.ts";
import type { ProviderAdapter } from "./services/provider.ts";

export type AdapterLike = ProviderAdapter<
  FanslyRequestContext,
  FanslyAccountMeResponse,
  FanslyAccount,
  FanslyEarningsTransaction,
  FanslySubscriber,
  FanslyFollower
> & {
  getMessagingGroupsPage(
    context: FanslyRequestContext,
    params: {
      offset?: number;
      limit?: number;
      sortOrder?: number;
      flags?: number;
      search?: string;
      subscriptionTierId?: string | null;
      listIds?: string | null;
    },
  ): Promise<FanslyMessagingGroupsPageResponse>;
  getGroupDetail(context: FanslyRequestContext, groupId: string): Promise<{
    parsed: FanslyGroupDetail;
    raw: FanslyGroupDetail;
  }>;
  getMessagesPage(
    context: FanslyRequestContext,
    params: {
      groupId: string;
      limit?: number;
      before?: string | null;
    },
  ): Promise<FanslyMessagesPageResponse>;
  getEarningsAccountsPage(
    context: FanslyRequestContext,
    params: {
      after?: Date | null;
      before?: Date | null;
    },
  ): Promise<FanslyEarningsAccountsPageResponse>;
  close?(): Promise<void>;
};

export interface AppContext {
  config: ReturnType<typeof loadConfig>;
  logger: ReturnType<typeof createLogger>;
  pool: ReturnType<typeof createPool>;
  db: Database;
  adapter: AdapterLike;
  onlyFansAdapter: OnlyFansAdapter;
  // onlyfansapi.com management client; absent when OFAPI_API_KEY is not set
  // (admin webhook registration then 503s). Optional so existing AppContext
  // literals (tests, codegen) need not provide it.
  ofapi?: OfapiClient;
  close(): Promise<void>;
}

export async function createAppContext(): Promise<AppContext> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const deprecatedFanslyDelayAlias = resolveFanslyDefaultDelayEnvSource(process.env);
  if (
    deprecatedFanslyDelayAlias &&
    deprecatedFanslyDelayAlias !== "FANSLY_DEFAULT_DELAY_MS"
  ) {
    logger.warn(
      { envVar: deprecatedFanslyDelayAlias },
      "Deprecated Fansly delay env var in use; prefer FANSLY_DEFAULT_DELAY_MS",
    );
  }

  if (config.syncPageExecutorConcurrency > 1 && !config.syncSharedRateLimitEnabled) {
    throw new Error(
      "SYNC_PAGE_EXECUTOR_CONCURRENCY > 1 requires SYNC_SHARED_RATE_LIMIT_ENABLED=true",
    );
  }

  const pool = createPool(config.databaseUrl);
  try {
    await assertRuntimeSchemaReady(pool);

    const db = createDb(pool);
    const adapter = new FanslyAdapter({
      baseUrl: config.fanslyBaseUrl,
      globalDelayMs: config.fanslyDefaultDelayMs,
    });
    const onlyFansAdapter = new OnlyFansAdapter({
      baseUrl: config.onlyMonsterBaseUrl,
      defaultDelayMs: config.onlyFansDefaultDelayMs,
    });

    const ofapi = config.ofapiApiKey
      ? createOfapiClient({
        baseUrl: config.ofapiBaseUrl,
        apiKey: config.ofapiApiKey,
        restDelayMs: config.ofapiRestDelayMs,
        onCreditSpend: createOfapiCreditSpendSink({ db, logger, config }),
      })
      : undefined;

    return {
      config,
      logger,
      pool,
      db,
      adapter,
      onlyFansAdapter,
      ofapi,
      async close() {
        await adapter.close?.();
        await onlyFansAdapter.close();
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}
