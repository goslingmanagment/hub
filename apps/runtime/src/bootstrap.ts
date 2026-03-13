import { assertRuntimeSchemaReady, createDb, createPool, type Database } from "@agency_hub_core/db";
import { FanslyAdapter } from "@agency_hub_core/fansly";
import { OnlyFansAdapter } from "@agency_hub_core/onlyfans";
import type {
  FanslyAccount,
  FanslyAccountMeResponse,
  FanslyEarningsTransaction,
  FanslyFollower,
  FanslyRequestContext,
  FanslySubscriber,
} from "@agency_hub_core/fansly";
import { createLogger, loadConfig } from "@agency_hub_core/shared";

import type { ProviderAdapter } from "./services/provider.ts";

export type AdapterLike = ProviderAdapter<
  FanslyRequestContext,
  FanslyAccountMeResponse,
  FanslyAccount,
  FanslyEarningsTransaction,
  FanslySubscriber,
  FanslyFollower
> & {
  close?(): Promise<void>;
};

export interface AppContext {
  config: ReturnType<typeof loadConfig>;
  logger: ReturnType<typeof createLogger>;
  pool: ReturnType<typeof createPool>;
  db: Database;
  adapter: AdapterLike;
  onlyFansAdapter: OnlyFansAdapter;
  close(): Promise<void>;
}

export async function createAppContext(): Promise<AppContext> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const pool = createPool(config.databaseUrl);
  try {
    await assertRuntimeSchemaReady(pool);

    const db = createDb(pool);
    const adapter = new FanslyAdapter({
      baseUrl: config.fanslyBaseUrl,
      globalDelayMs: config.fanslyGlobalDelayMs,
    });
    const onlyFansAdapter = new OnlyFansAdapter({
      baseUrl: config.onlyMonsterBaseUrl,
      defaultDelayMs: 1000,
    });

    return {
      config,
      logger,
      pool,
      db,
      adapter,
      onlyFansAdapter,
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
