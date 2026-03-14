import type { AppContext } from "../../apps/runtime/src/bootstrap.ts";
import type { StartedTestDatabase } from "./db.ts";

export function createTestAppContext(
  testDb: StartedTestDatabase,
  overrides?: {
    adapter?: AppContext["adapter"];
    databaseUrl?: string;
    logger?: StartedTestDatabase["logger"];
    onlyFansAdapter?: AppContext["onlyFansAdapter"];
    sessionTtlDays?: number;
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
      fanslyGlobalDelayMs: 2500,
      followerPageDelayMs: 0,
      transactionLookbackDays: 7,
      transactionRescanCapDays: 30,
      syncObservabilityRetentionDays: 30,
    },
    adapter: overrides?.adapter ?? ({} as AppContext["adapter"]),
    onlyFansAdapter: overrides?.onlyFansAdapter ?? ({} as AppContext["onlyFansAdapter"]),
    async close() {},
  } satisfies AppContext;
}
