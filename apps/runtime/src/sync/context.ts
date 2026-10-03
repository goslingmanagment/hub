import {
  assertRuntimeSchemaReady,
  createDb,
  createPool,
  readPoolSessionTimeouts,
  type Database,
  type PoolTimeouts,
} from "@agency_hub_core/db";
import {
  createLogger,
  loadConfig,
  type AppConfig,
  type SkippedOverride,
} from "@agency_hub_core/shared";

import { loadBootConfig } from "../services/boot-config.ts";

/**
 * The `sync` process's pool (step 4, 4-3 layer 0): a hung database call
 * becomes an error the engine already handles — a lap that failed before an
 * admission backs off 1 s; a commit after a send is retried 3 times, then the
 * actor fails and the host restarts it 5 s later. 10–20× the slowest statement
 * seen on the sync tables (2.9 s). The lock session and the LISTEN client are
 * clients of their own with their own 5 s bounds (`engine/host-ports.ts`).
 */
export const SYNC_POOL_TIMEOUTS: PoolTimeouts = {
  connectionTimeoutMillis: 30_000,
  statementTimeoutMs: 60_000,
  lockTimeoutMs: 30_000,
  idleInTransactionSessionTimeoutMs: 60_000,
};

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
  /** The pool's timeouts, logged once they are in force. The `sync` process
   *  passes `SYNC_POOL_TIMEOUTS`; the one-shot CLI commands run without them
   *  (an operator watches each, and a report may need a longer statement). */
  poolTimeouts?: PoolTimeouts;
}

export async function createSyncContext(options: CreateSyncContextOptions = {}): Promise<SyncContext> {
  const rawConfig = options.env === undefined
    ? loadConfig()
    : loadConfig(options.env, { loadDotEnv: false });
  const logger = createLogger(rawConfig.logLevel);
  const timeouts = options.poolTimeouts;
  const pool = createPool(rawConfig.databaseUrl, timeouts === undefined ? {} : { timeouts });
  try {
    // The image's own latest migration must be applied: an older schema under
    // a newer engine is refused here, before anything reads or writes.
    await assertRuntimeSchemaReady(pool);
    if (timeouts !== undefined) {
      // What the server reports for a pooled session, not what was asked for.
      logger.info({ connectionTimeoutMillis: timeouts.connectionTimeoutMillis, ...(await readPoolSessionTimeouts(pool)) },
        "Sync pool timeouts in force");
    }
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
