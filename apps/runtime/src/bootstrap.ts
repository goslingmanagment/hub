import { createDb, createPool } from "@fansly-connect/db";
import { FanslyAdapter } from "@fansly-connect/fansly";
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

  return {
    config,
    logger,
    pool,
    db,
    adapter,
    async close() {
      await pool.end();
    },
  };
}
