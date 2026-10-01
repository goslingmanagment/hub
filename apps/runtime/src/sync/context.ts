import { assertRuntimeSchemaReady, createDb, createPool, type Database } from "@agency_hub_core/db";
import {
  createLogger,
  loadConfig,
  type AppConfig,
  type SkippedOverride,
} from "@agency_hub_core/shared";

import { loadBootConfig } from "../services/boot-config.ts";

/** Everything the `sync` process runs on. Deliberately adapter-free: no
 *  FanslyAdapter, no OFAPI client (whose credential preflight may call OFAPI
 *  at boot), no AI providers, no legacy send guards — the engine reaches
 *  Fansly only through its own wire layer, from inside a page actor. */
export interface SyncContext {
  /** The env config with the staged ('boot') DB overrides applied, exactly as
   *  every other role boots, so the heartbeat reports the same `running`
   *  values as api/worker/scheduler. */
  config: AppConfig;
  /** The env config before the boot overrides (the live overlay's baseline). */
  rawConfig: AppConfig;
  bootSkipped: SkippedOverride[];
  logger: ReturnType<typeof createLogger>;
  pool: ReturnType<typeof createPool>;
  db: Database;
  close(): Promise<void>;
}

export interface CreateSyncContextOptions {
  /** An explicit environment (tests). Without one the process env is used and
   *  the ambient `.env` file is merged, as `loadConfig()` does for every role. */
  env?: NodeJS.ProcessEnv;
}

export async function createSyncContext(options: CreateSyncContextOptions = {}): Promise<SyncContext> {
  const rawConfig = options.env === undefined
    ? loadConfig()
    : loadConfig(options.env, { loadDotEnv: false });
  const logger = createLogger(rawConfig.logLevel);
  const pool = createPool(rawConfig.databaseUrl);
  try {
    // The image's own latest migration must be applied: an older schema under
    // a newer engine is refused here, before anything reads or writes.
    await assertRuntimeSchemaReady(pool);
    const db = createDb(pool);
    const { config, bootSkipped } = await loadBootConfig(db, rawConfig, logger);
    return {
      config,
      rawConfig,
      bootSkipped,
      logger,
      pool,
      db,
      async close() {
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}
