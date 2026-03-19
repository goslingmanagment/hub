import type { AppContext } from "../../apps/runtime/src/bootstrap.ts";
import type { StartedTestDatabase } from "./db.ts";

export function createTestAppContext(
  testDb: StartedTestDatabase,
  overrides?: {
    adapter?: AppContext["adapter"];
    databaseUrl?: string;
    fanslyDefaultDelayMs?: number;
    followerPageDelayMs?: number;
    logger?: StartedTestDatabase["logger"];
    onlyFansDefaultDelayMs?: number;
    onlyFansAdapter?: AppContext["onlyFansAdapter"];
    sessionTtlDays?: number;
    syncPageExecutorConcurrency?: number;
    syncSharedRateLimitEnabled?: boolean;
  },
) {
  return {
    db: testDb.db,
    pool: testDb.pool,
    logger: overrides?.logger ?? testDb.logger,
    config: {
      databaseUrl: overrides?.databaseUrl ?? "",
      encryptionKey: Buffer.alloc(32, 7),
      encryptionKeyVersion: 1,
      logLevel: "silent",
      apiHost: "0.0.0.0",
      apiPort: 3000,
      sessionTtlDays: overrides?.sessionTtlDays ?? 30,
      fanslyBaseUrl: "https://example.invalid",
      onlyMonsterBaseUrl: "https://example.invalid",
      syncHttpTraceFile: null,
      fanslyDefaultDelayMs: overrides?.fanslyDefaultDelayMs ?? 2500,
      followerPageDelayMs: overrides?.followerPageDelayMs ?? 0,
      onlyFansDefaultDelayMs: overrides?.onlyFansDefaultDelayMs ?? 1000,
      transactionLookbackDays: 7,
      transactionRescanCapDays: 30,
      syncSharedRateLimitEnabled: overrides?.syncSharedRateLimitEnabled ?? false,
      syncPageExecutorConcurrency: overrides?.syncPageExecutorConcurrency ?? 1,
      syncObservabilityRetentionDays: 30,
    },
    adapter: overrides?.adapter ?? ({} as AppContext["adapter"]),
    onlyFansAdapter: overrides?.onlyFansAdapter ?? ({} as AppContext["onlyFansAdapter"]),
    async close() {},
  } satisfies AppContext;
}
