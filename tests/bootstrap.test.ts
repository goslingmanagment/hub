import { afterEach, describe, expect, it, vi } from "vitest";

const bootstrapMocks = vi.hoisted(() => {
  const pool = {
    end: vi.fn(async () => {}),
  };
  const db = {
    kind: "db",
  };
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
  const adapter = {
    close: vi.fn(async () => {}),
  };
  const onlyFansAdapter = {
    close: vi.fn(async () => {}),
  };
  const encryptionKey = Buffer.alloc(32, 7);

  return {
    adapter,
    assertRuntimeSchemaReady: vi.fn(),
    createDb: vi.fn(() => db),
    createLogger: vi.fn(() => logger),
    createPool: vi.fn(() => pool),
    db,
    FanslyAdapter: vi.fn(() => adapter),
    logger,
    loadConfig: vi.fn(() => ({
      databaseUrl: "postgres://postgres:postgres@127.0.0.1:5432/agency_hub_core_test",
      encryptionKey,
      encryptionKeyVersion: 1,
      encryptionKeysByVersion: new Map([[1, encryptionKey]]),
      logLevel: "silent",
      apiHost: "0.0.0.0",
      apiPort: 3000,
      sessionTtlDays: 30,
      fanslyBaseUrl: "https://example.invalid",
      onlyMonsterBaseUrl: "https://example.invalid",
      syncHttpTraceFile: null,
      fanslyDefaultDelayMs: 2500,
      fanslyDmConversationsDelayMs: 5000,
      fanslyDmMessagesDelayMs: 7500,
      followerPageDelayMs: 0,
      onlyFansDefaultDelayMs: 1000,
      transactionLookbackDays: 7,
      transactionRescanCapDays: 30,
      syncSharedRateLimitEnabled: false,
      syncPageExecutorConcurrency: 1,
      syncObservabilityRetentionDays: 30,
      healthSyncLightMaxAgeMinutes: 180,
      healthSyncFollowerMaxAgeMinutes: 1080,
      telegramBotToken: null,
      telegramChatId: null,
      telegramEnabled: false,
      telegramReportHourUtc: 9,
    })),
    onlyFansAdapter,
    OnlyFansAdapter: vi.fn(() => onlyFansAdapter),
    pool,
  };
});

vi.mock("@agency_hub_core/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agency_hub_core/db")>();
  return {
    ...actual,
    assertRuntimeSchemaReady: bootstrapMocks.assertRuntimeSchemaReady,
    createDb: bootstrapMocks.createDb,
    createPool: bootstrapMocks.createPool,
  };
});

vi.mock("@agency_hub_core/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agency_hub_core/shared")>();
  return {
    ...actual,
    createLogger: bootstrapMocks.createLogger,
    loadConfig: bootstrapMocks.loadConfig,
  };
});

vi.mock("@agency_hub_core/fansly", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agency_hub_core/fansly")>();
  return {
    ...actual,
    FanslyAdapter: bootstrapMocks.FanslyAdapter,
  };
});

vi.mock("@agency_hub_core/onlyfans", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agency_hub_core/onlyfans")>();
  return {
    ...actual,
    OnlyFansAdapter: bootstrapMocks.OnlyFansAdapter,
  };
});

describe("bootstrap", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.FANSLY_DEFAULT_DELAY_MS;
    delete process.env.FANSLY_GLOBAL_DELAY_MS;
    delete process.env.FANSLY_ACCOUNT_LOOKUP_DELAY_MS;
  });

  it("verifies runtime schema readiness before returning the app context", async () => {
    bootstrapMocks.assertRuntimeSchemaReady.mockResolvedValue(undefined);
    const { createAppContext } = await import("../apps/runtime/src/bootstrap.ts");

    const app = await createAppContext();

    expect(bootstrapMocks.createPool).toHaveBeenCalledWith(
      "postgres://postgres:postgres@127.0.0.1:5432/agency_hub_core_test",
    );
    expect(bootstrapMocks.assertRuntimeSchemaReady).toHaveBeenCalledWith(bootstrapMocks.pool);
    expect(bootstrapMocks.FanslyAdapter).toHaveBeenCalledWith({
      baseUrl: "https://example.invalid",
      globalDelayMs: 2500,
    });
    expect(bootstrapMocks.OnlyFansAdapter).toHaveBeenCalledWith({
      baseUrl: "https://example.invalid",
      defaultDelayMs: 1000,
    });
    expect(app.db).toBe(bootstrapMocks.db);
    expect(app.adapter).toBe(bootstrapMocks.adapter);
    const onlyFansCloseSpy = vi.spyOn(app.onlyFansAdapter, "close");

    await app.close();

    expect(bootstrapMocks.adapter.close).toHaveBeenCalledTimes(1);
    expect(onlyFansCloseSpy).toHaveBeenCalledTimes(1);
    expect(bootstrapMocks.pool.end).toHaveBeenCalledTimes(1);
  });

  it("closes the pool and aborts startup when the schema guard fails", async () => {
    const guardError = new Error("schema drift");
    bootstrapMocks.assertRuntimeSchemaReady.mockRejectedValueOnce(guardError);
    const { createAppContext } = await import("../apps/runtime/src/bootstrap.ts");

    await expect(createAppContext()).rejects.toThrow("schema drift");

    expect(bootstrapMocks.pool.end).toHaveBeenCalledTimes(1);
    expect(bootstrapMocks.FanslyAdapter).not.toHaveBeenCalled();
  });

  it("warns when a deprecated Fansly delay alias is the active source", async () => {
    process.env.FANSLY_GLOBAL_DELAY_MS = "3000";
    bootstrapMocks.assertRuntimeSchemaReady.mockResolvedValue(undefined);
    bootstrapMocks.loadConfig.mockReturnValueOnce({
      ...bootstrapMocks.loadConfig(),
      fanslyDefaultDelayMs: 3000,
    });
    const { createAppContext } = await import("../apps/runtime/src/bootstrap.ts");

    const app = await createAppContext();
    await app.close();

    expect(bootstrapMocks.logger.warn).toHaveBeenCalledWith(
      { envVar: "FANSLY_GLOBAL_DELAY_MS" },
      "Deprecated Fansly delay env var in use; prefer FANSLY_DEFAULT_DELAY_MS",
    );
  });

  it("rejects executor concurrency above 1 when shared limiting is disabled", async () => {
    bootstrapMocks.loadConfig.mockReturnValueOnce({
      ...bootstrapMocks.loadConfig(),
      syncSharedRateLimitEnabled: false,
      syncPageExecutorConcurrency: 4,
    });
    const { createAppContext } = await import("../apps/runtime/src/bootstrap.ts");

    await expect(createAppContext()).rejects.toThrow(
      "SYNC_PAGE_EXECUTOR_CONCURRENCY > 1 requires SYNC_SHARED_RATE_LIMIT_ENABLED=true",
    );

    expect(bootstrapMocks.createPool).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.resetModules();
});
