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
      databaseUrl: "postgres://postgres:postgres@127.0.0.1:5432/fansly_connect_test",
      encryptionKey: Buffer.alloc(32, 7),
      encryptionKeyVersion: 1,
      logLevel: "silent",
      apiHost: "0.0.0.0",
      apiPort: 3000,
      sessionTtlDays: 30,
      fanslyBaseUrl: "https://example.invalid",
      onlyMonsterBaseUrl: "https://example.invalid",
      syncHttpTraceFile: null,
      fanslyAccountLookupDelayMs: 2500,
      followerPageDelayMs: 0,
      transactionLookbackDays: 7,
      transactionRescanCapDays: 30,
      syncObservabilityRetentionDays: 30,
    })),
    onlyFansAdapter,
    OnlyFansAdapter: vi.fn(() => onlyFansAdapter),
    pool,
  };
});

vi.mock("@fansly-connect/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fansly-connect/db")>();
  return {
    ...actual,
    assertRuntimeSchemaReady: bootstrapMocks.assertRuntimeSchemaReady,
    createDb: bootstrapMocks.createDb,
    createPool: bootstrapMocks.createPool,
  };
});

vi.mock("@fansly-connect/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fansly-connect/shared")>();
  return {
    ...actual,
    createLogger: bootstrapMocks.createLogger,
    loadConfig: bootstrapMocks.loadConfig,
  };
});

vi.mock("@fansly-connect/fansly", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fansly-connect/fansly")>();
  return {
    ...actual,
    FanslyAdapter: bootstrapMocks.FanslyAdapter,
  };
});

vi.mock("@fansly-connect/onlyfans", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fansly-connect/onlyfans")>();
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
      "postgres://postgres:postgres@127.0.0.1:5432/fansly_connect_test",
    );
    expect(bootstrapMocks.assertRuntimeSchemaReady).toHaveBeenCalledWith(bootstrapMocks.pool);
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
