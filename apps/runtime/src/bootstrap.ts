import { createDb, createPool } from "@fansly-connect/db";
import { FanslyAdapter } from "@fansly-connect/fansly";
import { OnlyFansAdapter } from "@fansly-connect/onlyfans";
import type {
  FanslyAccount,
  FanslyAccountMeResponse,
  FanslyEarningsTransaction,
  FanslyFollower,
  FanslyRequestContext,
  FanslySubscriber,
} from "@fansly-connect/fansly";
import { createLogger, loadConfig } from "@fansly-connect/shared";

import type { ProviderAdapter } from "./services/provider.ts";

export type AdapterLike = ProviderAdapter<
  FanslyRequestContext,
  FanslyAccountMeResponse,
  FanslyAccount,
  FanslyEarningsTransaction,
  FanslySubscriber,
  FanslyFollower
>;

export interface AppContext {
  config: ReturnType<typeof loadConfig>;
  logger: ReturnType<typeof createLogger>;
  pool: ReturnType<typeof createPool>;
  db: ReturnType<typeof createDb>;
  adapter: AdapterLike;
  onlyFansAdapter: OnlyFansAdapter;
  close(): Promise<void>;
}

export async function createAppContext(): Promise<AppContext> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const pool = createPool(config.databaseUrl);
  const db = createDb(pool);
  const adapter = new FanslyAdapter({
    baseUrl: config.fanslyBaseUrl,
    defaultDelayMs: 1000,
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
      await pool.end();
    },
  };
}
