import type { AppContext } from "../../apps/runtime/src/bootstrap.ts";
import type { startTestDatabase } from "./db.ts";

type StartedTestDatabase = NonNullable<Awaited<ReturnType<typeof startTestDatabase>>>;

export function createTestAppContext(
  testDb: StartedTestDatabase,
  overrides?: {
    logger?: StartedTestDatabase["logger"];
    sessionTtlDays?: number;
  },
) {
  return {
    db: testDb.db,
    pool: testDb.pool,
    logger: overrides?.logger ?? testDb.logger,
    config: {
      databaseUrl: "",
      encryptionKey: Buffer.alloc(32, 7),
      encryptionKeyVersion: 1,
      logLevel: "silent",
      apiHost: "0.0.0.0",
      apiPort: 3000,
      sessionTtlDays: overrides?.sessionTtlDays ?? 30,
      fanslyBaseUrl: "https://example.invalid",
      onlyMonsterBaseUrl: "https://example.invalid",
      followerPageDelayMs: 0,
      transactionLookbackDays: 7,
      transactionRescanCapDays: 30,
      syncObservabilityRetentionDays: 30,
    },
    adapter: {} as AppContext["adapter"],
    onlyFansAdapter: {} as AppContext["onlyFansAdapter"],
    async close() {},
  } satisfies AppContext;
}
