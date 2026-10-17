import { afterEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";
import { RETIRED_FANSLY_ENV_KEYS } from "@agency_hub_core/shared";
import type * as SharedModule from "@agency_hub_core/shared";

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
  const encryptionKey = Buffer.alloc(32, 7);

  return {
    assertRuntimeSchemaReady: vi.fn(),
    // No boot overrides in the DB → applyBootOverrides is a no-op (config === env).
    getConfigOverrides: vi.fn(async () => new Map()),
    createDb: vi.fn(() => db),
    createLogger: vi.fn(() => logger),
    createPool: vi.fn(() => pool),
    db,
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
      onlyFansDefaultDelayMs: 1000,
      egressPacerMode: "off" as const,
      lakeDir: "lake",
      syncPageExecutorConcurrency: 1,
      syncObservabilityRetentionDays: 30,
      healthSyncLightMaxAgeMinutes: 180,
      healthSyncMonitoringToken: null,
      telegramBotToken: null,
      telegramChatId: null,
      telegramEnabled: false,
      telegramReportHourUtc: 9,
      telegramProxyPageLabel: null as string | null,
      serviceEgressProxyUrl: null as string | null,
      serviceEgressProxyUsername: null as string | null,
      serviceEgressProxyPassword: null as string | null,
      elevenLabsApiKey: undefined as string | undefined,
      // Staged boot flags default off (mirrors loadConfig) so the fallback-normalization test
      // can override them to an invalid env-only graph.
      ofapiDmProjectionEnabled: false,
      ofapiDmSyncEnabled: false,
    })),
    pool,
  };
});

vi.mock("@agency_hub_core/db", async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    assertRuntimeSchemaReady: bootstrapMocks.assertRuntimeSchemaReady,
    getConfigOverrides: bootstrapMocks.getConfigOverrides,
    createDb: bootstrapMocks.createDb,
    createPool: bootstrapMocks.createPool,
  };
});

vi.mock("@agency_hub_core/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof SharedModule>();
  return {
    ...actual,
    createLogger: bootstrapMocks.createLogger,
    loadConfig: bootstrapMocks.loadConfig,
  };
});

describe("bootstrap", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    delete process.env.FANSLY_DEFAULT_DELAY_MS;
    for (const key of RETIRED_FANSLY_ENV_KEYS) delete process.env[key];
  });

  it("verifies runtime schema readiness before returning the app context", async () => {
    bootstrapMocks.assertRuntimeSchemaReady.mockResolvedValue(undefined);
    const { createAppContext } = await import("../apps/runtime/src/bootstrap.ts");

    const app = await createAppContext();

    // A one-shot command keeps node-postgres' 10 s idle close: it must exit.
    expect(bootstrapMocks.createPool).toHaveBeenCalledWith(
      "postgres://postgres:postgres@127.0.0.1:5432/agency_hub_core_test",
      {},
    );
    expect(app.poolLifetime).toBeUndefined();
    expect(bootstrapMocks.assertRuntimeSchemaReady).toHaveBeenCalledWith(bootstrapMocks.pool);
    expect(app.fanslySendGuards).toBeDefined();
    expect(app.db).toBe(bootstrapMocks.db);
    // No Fansly HTTP client is built at boot: the Sync Engine is the only
    // sender of a Fansly page (step 4, S4-20).
    expect(app).not.toHaveProperty("adapter");
    // No boot overrides in the DB → nothing skipped, config is the env config.
    expect(bootstrapMocks.getConfigOverrides).toHaveBeenCalledWith(bootstrapMocks.db);
    expect(app.bootSkipped).toEqual([]);

    await app.close();

    expect(bootstrapMocks.pool.end).toHaveBeenCalledTimes(1);
  });

  it("closes the pool and aborts startup when the schema guard fails", async () => {
    const guardError = new Error("schema drift");
    bootstrapMocks.assertRuntimeSchemaReady.mockRejectedValueOnce(guardError);
    const { createAppContext } = await import("../apps/runtime/src/bootstrap.ts");

    await expect(createAppContext()).rejects.toThrow("schema drift");

    expect(bootstrapMocks.pool.end).toHaveBeenCalledTimes(1);
    // Nothing is built on a database the guard refused.
    expect(bootstrapMocks.createDb).not.toHaveBeenCalled();
  });

  it("gives a long-lived role's pool the runtime lifetime and hands it on for its pg-boss", async () => {
    bootstrapMocks.assertRuntimeSchemaReady.mockResolvedValue(undefined);
    const { createAppContext } = await import("../apps/runtime/src/bootstrap.ts");
    const { RUNTIME_POOL_LIFETIME } = await import("@agency_hub_core/db");

    const app = await createAppContext({ processRole: "scheduler" });
    await app.close();

    expect(bootstrapMocks.createPool).toHaveBeenCalledWith(
      "postgres://postgres:postgres@127.0.0.1:5432/agency_hub_core_test",
      { lifetime: RUNTIME_POOL_LIFETIME },
    );
    expect(app.poolLifetime).toBe(RUNTIME_POOL_LIFETIME);
  });

  it("warns a long-lived process that retired Fansly env vars are set and ignored, naming only the ones set", async () => {
    // What production's env still carries when the keys go (step 4, S4-26).
    process.env.FANSLY_DM_MESSAGES_DELAY_MS = "7500";
    process.env.FOLLOWER_PAGE_DELAY_MS = "5000";
    process.env.TRANSACTION_LOOKBACK_DAYS = "7";
    process.env.SYNC_SHARED_RATE_LIMIT_ENABLED = "true";
    process.env.FANSLY_DM_CONVERSATIONS_DELAY_MS = " ";
    bootstrapMocks.assertRuntimeSchemaReady.mockResolvedValue(undefined);
    const { createAppContext } = await import("../apps/runtime/src/bootstrap.ts");

    const app = await createAppContext({ processRole: "worker" });
    await app.close();

    expect(bootstrapMocks.logger.warn).toHaveBeenCalledTimes(1);
    expect(bootstrapMocks.logger.warn).toHaveBeenCalledWith(
      { envVars: ["FOLLOWER_PAGE_DELAY_MS", "FANSLY_DM_MESSAGES_DELAY_MS", "SYNC_SHARED_RATE_LIMIT_ENABLED", "TRANSACTION_LOOKBACK_DAYS"] },
      expect.stringMatching(/^Retired Fansly env vars are set and ignored: .* remove them from the env$/),
    );
  });

  it("says nothing about retired Fansly env vars when the env sets none, or to a CLI run", async () => {
    bootstrapMocks.assertRuntimeSchemaReady.mockResolvedValue(undefined);
    const { createAppContext } = await import("../apps/runtime/src/bootstrap.ts");
    const retiredWarning = [expect.objectContaining({ envVars: expect.anything() }), expect.anything()];

    const quiet = await createAppContext({ processRole: "api" });
    await quiet.close();
    expect(bootstrapMocks.logger.warn).not.toHaveBeenCalledWith(...retiredWarning);

    // A CLI command's stdout is its output (some of it is parsed).
    process.env.FANSLY_DM_MESSAGES_DELAY_MS = "7500";
    const cli = await createAppContext();
    await cli.close();
    expect(bootstrapMocks.logger.warn).not.toHaveBeenCalledWith(...retiredWarning);
  });

  it("constructs the voice provider only when both the key and proxy tuple are ready", async () => {
    bootstrapMocks.assertRuntimeSchemaReady.mockResolvedValue(undefined);
    const base = bootstrapMocks.loadConfig();
    bootstrapMocks.loadConfig.mockReturnValueOnce({
      ...base,
      elevenLabsApiKey: "fake-elevenlabs-key",
    });
    const { createAppContext } = await import("../apps/runtime/src/bootstrap.ts");

    const missingProxy = await createAppContext();
    expect(missingProxy.voiceTtsProvider).toBeUndefined();
    await missingProxy.close();

    bootstrapMocks.loadConfig.mockReturnValueOnce({
      ...base,
      elevenLabsApiKey: "fake-elevenlabs-key",
      serviceEgressProxyUrl: "socks5://proxy.example.internal:1080",
      serviceEgressProxyUsername: "fake-service-user",
      serviceEgressProxyPassword: "fake-service-password",
    });
    const ready = await createAppContext();
    expect(ready.voiceTtsProvider).toBeDefined();
    await ready.close();
  });

  it("warns once when Telegram is using the transition legacy-page route", async () => {
    bootstrapMocks.assertRuntimeSchemaReady.mockResolvedValue(undefined);
    bootstrapMocks.loadConfig.mockReturnValueOnce({
      ...bootstrapMocks.loadConfig(),
      telegramProxyPageLabel: "fake-legacy-page",
    });
    const { createAppContext } = await import("../apps/runtime/src/bootstrap.ts");

    const app = await createAppContext();
    await app.close();

    expect(bootstrapMocks.logger.warn).toHaveBeenCalledWith({
      component: "service_egress",
      event: "legacy_route_active",
      vendor: "telegram",
      egressKey: "legacy-page",
    }, "Telegram is using the deprecated transition legacy-page egress route");
    expect(bootstrapMocks.logger.warn).toHaveBeenCalledTimes(1);
  });

  it("boots with executor concurrency above 1: no boot invariant ties it to another key (step 4, S4-19)", async () => {
    // The invariant that tied the page executor's concurrency to the shared
    // rate limiter went with the limiter's last reader, and the limiter's key
    // with the legacy Fansly config keys (S4-26).
    bootstrapMocks.assertRuntimeSchemaReady.mockResolvedValue(undefined);
    bootstrapMocks.loadConfig.mockReturnValueOnce({
      ...bootstrapMocks.loadConfig(),
      egressPacerMode: "off" as const,
      lakeDir: "lake",
      syncPageExecutorConcurrency: 4,
    });
    const { createAppContext } = await import("../apps/runtime/src/bootstrap.ts");

    const app = await createAppContext();

    expect(app.config.syncPageExecutorConcurrency).toBe(4);
    expect(bootstrapMocks.createPool).toHaveBeenCalledTimes(1);
  });

  it("retries a transient override read failure, then boots with the graph normalized (A31)", async () => {
    bootstrapMocks.assertRuntimeSchemaReady.mockResolvedValue(undefined);
    // The override read throws ONCE (a transient DB blip) → the retry succeeds.
    bootstrapMocks.getConfigOverrides.mockRejectedValueOnce(new Error("db blip"));
    // Env itself is an invalid staged graph: dmSync ON while its prerequisite dmProjection is OFF.
    bootstrapMocks.loadConfig.mockReturnValueOnce({
      ...bootstrapMocks.loadConfig(),
      ofapiDmProjectionEnabled: false,
      ofapiDmSyncEnabled: true,
    });
    const { createAppContext } = await import("../apps/runtime/src/bootstrap.ts");
    // The retry backoff is the only timer on this path; fake it instead of
    // sleeping the real second.
    vi.useFakeTimers({ toFake: ["setTimeout"] });

    const booting = createAppContext();
    await vi.advanceTimersByTimeAsync(999);
    expect(bootstrapMocks.getConfigOverrides).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const app = await booting;
    expect(bootstrapMocks.getConfigOverrides).toHaveBeenCalledTimes(2);

    // The retried read supplies the overrides; normalization still forces
    // dmSync OFF (prerequisite off) and surfaces the skip.
    expect(app.config.ofapiDmSyncEnabled).toBe(false);
    expect(app.bootSkipped?.map((s) => s.key)).toContain("ofapiDmSyncEnabled");
    expect(bootstrapMocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), attempt: 1 }),
      "boot override read failed; retrying",
    );

    await app.close();
  });

  it("refuses to boot fail-open when the override read keeps failing (A31)", async () => {
    bootstrapMocks.assertRuntimeSchemaReady.mockResolvedValue(undefined);
    // Every attempt fails → boot must THROW, never continue with all staged
    // flags silently off (a crash-looping container is visible; a "healthy"
    // api running pre-cutover code paths is not).
    bootstrapMocks.getConfigOverrides.mockRejectedValue(new Error("db down"));
    const { createAppContext } = await import("../apps/runtime/src/bootstrap.ts");
    vi.useFakeTimers({ toFake: ["setTimeout"] });

    // The rejection handler goes on BEFORE the clock moves: the boot rejects
    // while the timers advance, and an unhandled rejection would fail the run.
    const refused = expect(createAppContext()).rejects.toThrow("db down");
    // The 1s-then-2s ladder: the third read waits for the full 3s.
    await vi.advanceTimersByTimeAsync(2_999);
    expect(bootstrapMocks.getConfigOverrides).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await refused;
    expect(bootstrapMocks.getConfigOverrides).toHaveBeenCalledTimes(3);
    expect(bootstrapMocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), attempts: 3 }),
      "boot override read failed after retries; refusing fail-open boot",
    );
  });
});

afterEach(() => {
  vi.resetModules();
});
