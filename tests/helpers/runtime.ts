import type { AppContext } from "../../apps/runtime/src/bootstrap.ts";
import type { StartedTestDatabase } from "./db.ts";

export function createTestAppContext(
  testDb: StartedTestDatabase,
  overrides?: {
    adapter?: AppContext["adapter"];
    databaseUrl?: string;
    encryptionKey?: Buffer;
    encryptionKeyVersion?: number;
    encryptionKeysByVersion?: ReadonlyMap<number, Buffer>;
    fanslyDefaultDelayMs?: number;
    fanslyDmConversationsDelayMs?: number;
    fanslyDmMessagesDelayMs?: number;
    followerPageDelayMs?: number;
    logger?: StartedTestDatabase["logger"];
    onlyFansDefaultDelayMs?: number;
    onlyFansAdapter?: AppContext["onlyFansAdapter"];
    ofapi?: AppContext["ofapi"];
    ofapiEventRetentionDays?: number;
    sessionTtlDays?: number;
    syncPageExecutorConcurrency?: number;
    syncSharedRateLimitEnabled?: boolean;
    healthSyncMonitoringToken?: string | null;
    trustProxy?: boolean;
  },
) {
  const encryptionKey = overrides?.encryptionKey ?? Buffer.alloc(32, 7);
  const encryptionKeyVersion = overrides?.encryptionKeyVersion ?? 1;
  const encryptionKeysByVersion = new Map(overrides?.encryptionKeysByVersion ?? []);
  if (!encryptionKeysByVersion.has(encryptionKeyVersion)) {
    encryptionKeysByVersion.set(encryptionKeyVersion, encryptionKey);
  }

  return {
    db: testDb.db,
    pool: testDb.pool,
    logger: overrides?.logger ?? testDb.logger,
    config: {
      databaseUrl: overrides?.databaseUrl ?? "",
      encryptionKey,
      encryptionKeyVersion,
      encryptionKeysByVersion,
      logLevel: "silent",
      apiHost: "0.0.0.0",
      apiPort: 3000,
      isProduction: false,
      trustProxy: overrides?.trustProxy ?? false,
      sessionTtlDays: overrides?.sessionTtlDays ?? 30,
      fanslyBaseUrl: "https://example.invalid",
      onlyMonsterBaseUrl: "https://example.invalid",
      syncHttpTraceFile: null,
      fanslyDefaultDelayMs: overrides?.fanslyDefaultDelayMs ?? 2500,
      fanslyDmConversationsDelayMs: overrides?.fanslyDmConversationsDelayMs ?? 5000,
      fanslyDmMessagesDelayMs: overrides?.fanslyDmMessagesDelayMs ?? 5000,
      followerPageDelayMs: overrides?.followerPageDelayMs ?? 0,
      onlyFansDefaultDelayMs: overrides?.onlyFansDefaultDelayMs ?? 1000,
      transactionLookbackDays: 7,
      transactionRescanCapDays: 30,
      syncSharedRateLimitEnabled: overrides?.syncSharedRateLimitEnabled ?? false,
      syncPageExecutorConcurrency: overrides?.syncPageExecutorConcurrency ?? 1,
      syncObservabilityRetentionDays: 30,
      healthSyncLightMaxAgeMinutes: 180,
      healthSyncFollowerMaxAgeMinutes: 1080,
      healthSyncMonitoringToken: overrides?.healthSyncMonitoringToken ?? null,
      telegramBotToken: null,
      telegramChatId: null,
      telegramEnabled: false,
      telegramReportHourUtc: 9,
      ofapiEventRetentionDays: overrides?.ofapiEventRetentionDays ?? 7,
    },
    adapter: overrides?.adapter ?? ({} as AppContext["adapter"]),
    onlyFansAdapter: overrides?.onlyFansAdapter ?? ({} as AppContext["onlyFansAdapter"]),
    ofapi: overrides?.ofapi,
    async close() {},
  } satisfies AppContext;
}
