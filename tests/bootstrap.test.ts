import { afterEach, describe, expect, it, vi } from "vitest";

const bootstrapMocks = vi.hoisted(() => {
  const pool = {
    end: vi.fn(async () => {}),
  };
  const db = {
    kind: "db",
  };
  const adapter = {
    close: vi.fn(async () => {}),
  };
  const onlyFansAdapter = {
    close: vi.fn(async () => {}),
  };

  return {
    adapter,
    assertRuntimeSchemaReady: vi.fn(),
    createDb: vi.fn(() => db),
    createLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() })),
    createPool: vi.fn(() => pool),
    db,
    FanslyAdapter: vi.fn(() => adapter),
    loadConfig: vi.fn(() => ({
      databaseUrl: "postgres://postgres:postgres@127.0.0.1:5432/agency_hub_core_test",
      encryptionKey: Buffer.alloc(32, 7),
      encryptionKeyVersion: 1,
      logLevel: "silent",
      apiHost: "0.0.0.0",
      apiPort: 3000,
      sessionTtlDays: 30,
      fanslyBaseUrl: "https://example.invalid",
      onlyMonsterBaseUrl: "https://example.invalid",
      syncHttpTraceFile: null,
      fanslyGlobalDelayMs: 2500,
      followerPageDelayMs: 0,
      transactionLookbackDays: 7,
      transactionRescanCapDays: 30,
      syncSharedRateLimitEnabled: false,
      syncObservabilityRetentionDays: 30,
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
});

afterEach(() => {
  vi.resetModules();
});
