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
  const encryptionKey = Buffer.alloc(32, 7);

  return {
    adapter,
    assertRuntimeSchemaReady: vi.fn(),
    // No boot overrides in the DB → applyBootOverrides is a no-op (config === env).
    getConfigOverrides: vi.fn(async () => new Map()),
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
      isProduction: false,
      trustProxy: false,
      sessionTtlDays: 30,
      fanslyBaseUrl: "https://example.invalid",
      syncHttpTraceFile: null,
      fanslyDefaultDelayMs: 2500,
      fanslyDmConversationsDelayMs: 5000,
      fanslyDmMessagesDelayMs: 5000,
      followerPageDelayMs: 0,
      onlyFansDefaultDelayMs: 1000,
      transactionLookbackDays: 7,
      transactionRescanCapDays: 30,
      syncSharedRateLimitEnabled: false,
      syncPageExecutorConcurrency: 1,
      syncObservabilityRetentionDays: 30,
      healthSyncLightMaxAgeMinutes: 180,
      healthSyncFollowerMaxAgeMinutes: 1080,
      healthSyncMonitoringToken: null,
      telegramBotToken: null,
      telegramChatId: null,
      telegramEnabled: false,
      telegramReportHourUtc: 9,
      // Staged boot flags default off (mirrors loadConfig) so the fallback-normalization test
      // can override them to an invalid env-only graph.
      ofapiDmProjectionEnabled: false,
      ofapiDmSyncEnabled: false,
    })),
    pool,
  };
});

vi.mock("@agency_hub_core/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agency_hub_core/db")>();
  return {
    ...actual,
    assertRuntimeSchemaReady: bootstrapMocks.assertRuntimeSchemaReady,
    getConfigOverrides: bootstrapMocks.getConfigOverrides,
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
    expect(app.db).toBe(bootstrapMocks.db);
    expect(app.adapter).toBe(bootstrapMocks.adapter);
    // No boot overrides in the DB → nothing skipped, config is the env config.
    expect(bootstrapMocks.getConfigOverrides).toHaveBeenCalledWith(bootstrapMocks.db);
    expect(app.bootSkipped).toEqual([]);

    await app.close();

    expect(bootstrapMocks.adapter.close).toHaveBeenCalledTimes(1);
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

  it("normalizes an invalid env-only staged graph when the override read fails at boot", async () => {
    bootstrapMocks.assertRuntimeSchemaReady.mockResolvedValue(undefined);
    // The override read throws (a transient DB blip) → the fallback path runs.
    bootstrapMocks.getConfigOverrides.mockRejectedValueOnce(new Error("db blip"));
    // Env itself is an invalid staged graph: dmSync ON while its prerequisite dmProjection is OFF.
    bootstrapMocks.loadConfig.mockReturnValueOnce({
      ...bootstrapMocks.loadConfig(),
      ofapiDmProjectionEnabled: false,
      ofapiDmSyncEnabled: true,
    });
    const { createAppContext } = await import("../apps/runtime/src/bootstrap.ts");

    const app = await createAppContext();

    // The fallback still normalizes: dmSync is forced OFF because its prerequisite is off, and
    // the skip is surfaced — boot never starts the invalid graph even though the read failed.
    expect(app.config.ofapiDmSyncEnabled).toBe(false);
    expect(app.bootSkipped?.map((s) => s.key)).toContain("ofapiDmSyncEnabled");
    expect(bootstrapMocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "boot override read failed; normalizing env config without overrides",
    );

    await app.close();
  });
});

afterEach(() => {
  vi.resetModules();
});
