import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FANSLY_PAUSE_MAX_MS,
  FANSLY_PAUSE_MIN_MS,
  listRetiredFanslyEnv,
  loadConfig,
  RETIRED_FANSLY_ENV_KEYS,
} from "@agency_hub_core/shared";

const baseEnv = {
  DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/agency_hub_core_test",
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
} satisfies NodeJS.ProcessEnv;
const originalDotenvQuiet = process.env.DOTENV_CONFIG_QUIET;
const originalCwd = process.cwd();
let testCwd: string;

beforeAll(async () => {
  process.env.DOTENV_CONFIG_QUIET = "true";
  testCwd = await mkdtemp(path.join(tmpdir(), "agency-hub-config-tests-"));
  process.chdir(testCwd);
});

afterAll(async () => {
  process.chdir(originalCwd);

  if (originalDotenvQuiet === undefined) {
    delete process.env.DOTENV_CONFIG_QUIET;
  } else {
    process.env.DOTENV_CONFIG_QUIET = originalDotenvQuiet;
  }

  await rm(testCwd, { recursive: true, force: true });
});

describe("config", () => {
  it("keeps the prompt-echo kill-switch off in env so enabling needs the audited PATCH", () => {
    expect(loadConfig(baseEnv).chatMuseAiPromptDebugEchoEnabled).toBe(false);
    expect(loadConfig({ ...baseEnv, CHATMUSE_AI_PROMPT_DEBUG_ECHO_ENABLED: "false" })
      .chatMuseAiPromptDebugEchoEnabled).toBe(false);
    // A deploy must be inert: env cannot turn it on.
    expect(() => loadConfig({ ...baseEnv, CHATMUSE_AI_PROMPT_DEBUG_ECHO_ENABLED: "true" }))
      .toThrow(/audited live-config API/);
    expect(() => loadConfig({ ...baseEnv, CHATMUSE_AI_PROMPT_DEBUG_ECHO_ENABLED: "maybe" }))
      .toThrow();
  });

  it("defaults Fansly and OnlyFans delays and executor concurrency", () => {
    const config = loadConfig(baseEnv);

    expect(config.fanslyDefaultDelayMs).toBe(2500);
    expect(config.onlyFansDefaultDelayMs).toBe(1000);
    expect(config.onlyFansDmPollingEnabled).toBe(false);
    expect(config.syncPageExecutorConcurrency).toBe(4);
    expect(config.trustProxy).toBe(false);
    expect(config.chatMuseAiGatewayDailyRequestLimit).toBe(500);
    expect(config.chatMuseAiGatewayDailyMicroUsdLimit).toBe(10_000_000);
    expect(config.chatMuseAiGatewayRequestMicroUsdLimit).toBe(5_000_000);
    expect(config.ofapiEventWorkerReplicas).toBe(1);
  });

  it("accepts an explicit OFAPI event worker replica declaration", () => {
    const config = loadConfig({
      ...baseEnv,
      OFAPI_EVENT_WORKER_REPLICAS: "2",
    });

    expect(config.ofapiEventWorkerReplicas).toBe(2);
  });

  it("accepts an explicit OnlyFans DM polling override", () => {
    const config = loadConfig({
      ...baseEnv,
      ONLYFANS_DM_POLLING_ENABLED: "true",
    });

    expect(config.onlyFansDmPollingEnabled).toBe(true);
  });

  it("accepts an explicit trust proxy override", () => {
    const config = loadConfig({
      ...baseEnv,
      TRUST_PROXY: "true",
    });

    expect(config.trustProxy).toBe(true);
  });

  it("narrows trust proxy to a hop count or address list (audit P-9)", () => {
    expect(loadConfig({ ...baseEnv, TRUST_PROXY: "1" }).trustProxy).toBe(1);
    expect(loadConfig({ ...baseEnv, TRUST_PROXY: "2" }).trustProxy).toBe(2);
    expect(loadConfig({ ...baseEnv, TRUST_PROXY: "false" }).trustProxy).toBe(false);
    expect(loadConfig({ ...baseEnv, TRUST_PROXY: "" }).trustProxy).toBe(false);
    expect(loadConfig({ ...baseEnv, TRUST_PROXY: "127.0.0.1, 10.0.0.0/8" }).trustProxy)
      .toBe("127.0.0.1, 10.0.0.0/8");
  });

  it("boots an environment that still sets the retired Fansly env vars, whatever their values, and carries none of them", () => {
    // Step 4 (S4-26): the keys are gone from the schema, so a value the env still
    // sets is dropped unparsed — production sets seven of them — and a value the
    // old schema would have refused no longer stops the boot.
    const canonical = { ...baseEnv, FANSLY_DEFAULT_DELAY_MS: "2500" };
    const stale = Object.fromEntries(RETIRED_FANSLY_ENV_KEYS.map((key) => [key, "not-a-value"]));

    expect(loadConfig({ ...canonical, ...stale })).toEqual(loadConfig(canonical));
    expect(loadConfig({
      ...canonical,
      FOLLOWER_PAGE_DELAY_MS: "5000",
      FANSLY_DM_CONVERSATIONS_DELAY_MS: "5000",
      FANSLY_DM_MESSAGES_DELAY_MS: "7500",
      HEALTH_SYNC_FOLLOWER_MAX_AGE_MINUTES: "1080",
      SYNC_SHARED_RATE_LIMIT_ENABLED: "true",
      TRANSACTION_LOOKBACK_DAYS: "7",
      TRANSACTION_RESCAN_CAP_DAYS: "30",
    })).toEqual(loadConfig(canonical));
  });

  it("names the retired Fansly env vars an environment still sets, in the list's order", () => {
    expect(new Set(RETIRED_FANSLY_ENV_KEYS).size).toBe(RETIRED_FANSLY_ENV_KEYS.length);
    expect(listRetiredFanslyEnv({})).toEqual([]);
    expect(listRetiredFanslyEnv({
      TRANSACTION_LOOKBACK_DAYS: "7",
      FANSLY_DM_MESSAGES_DELAY_MS: "7500",
      FOLLOWER_PAGE_DELAY_MS: "5000",
      FANSLY_DM_CONVERSATIONS_DELAY_MS: "  ",
      AGENT_HYDRATION_AUTO_APPROVE_MODE: "enforce",
      FANSLY_DEFAULT_DELAY_MS: "2500",
      FANSLY_REPLIES_REWALK_CYCLE_DAYS: "30",
    })).toEqual([
      "FOLLOWER_PAGE_DELAY_MS",
      "FANSLY_DM_MESSAGES_DELAY_MS",
      "TRANSACTION_LOOKBACK_DAYS",
      "AGENT_HYDRATION_AUTO_APPROVE_MODE",
    ]);
  });

  it("accepts an explicit Fansly default delay override", () => {
    const config = loadConfig({
      ...baseEnv,
      FANSLY_DEFAULT_DELAY_MS: "3000",
    });

    expect(config.fanslyDefaultDelayMs).toBe(3000);
  });

  // The ONLYFANS_PUBLIC_PROFILE_* flags and their boot OR-invariant were
  // deleted in W8.2 (A30, decision #133): the resolver had zero callers, so
  // the flags could only crash boot, never enable anything. An unknown env
  // var is simply ignored by the schema — nothing left to pin here.

  it("fails the boot when only a retired pause alias sets the Fansly pause, and names the fix", () => {
    // The aliases fed the pause while FANSLY_DEFAULT_DELAY_MS was unset. Dropping
    // one silently would move the owner's pause to the default.
    expect(() => loadConfig({ ...baseEnv, FANSLY_GLOBAL_DELAY_MS: "3000" })).toThrow(
      "FANSLY_GLOBAL_DELAY_MS is retired and no longer sets the Fansly pause; "
        + "set FANSLY_DEFAULT_DELAY_MS=3000 instead and remove FANSLY_GLOBAL_DELAY_MS",
    );
    expect(() => loadConfig({ ...baseEnv, FANSLY_ACCOUNT_LOOKUP_DELAY_MS: " 3500 " })).toThrow(
      "FANSLY_ACCOUNT_LOOKUP_DELAY_MS is retired and no longer sets the Fansly pause; "
        + "set FANSLY_DEFAULT_DELAY_MS=3500 instead and remove FANSLY_ACCOUNT_LOOKUP_DELAY_MS",
    );
    // A blank canonical name is an unset one.
    expect(() => loadConfig({ ...baseEnv, FANSLY_DEFAULT_DELAY_MS: " ", FANSLY_GLOBAL_DELAY_MS: "3000" }))
      .toThrow("FANSLY_GLOBAL_DELAY_MS is retired");
  });

  it("ignores a retired pause alias beside FANSLY_DEFAULT_DELAY_MS, whatever it says", () => {
    const config = loadConfig({
      ...baseEnv,
      FANSLY_GLOBAL_DELAY_MS: "1500",
      FANSLY_ACCOUNT_LOOKUP_DELAY_MS: "90000",
      FANSLY_DEFAULT_DELAY_MS: "2800",
    });

    expect(config.fanslyDefaultDelayMs).toBe(2800);
  });

  it("accepts the Fansly pause bounds themselves", () => {
    expect(loadConfig({ ...baseEnv, FANSLY_DEFAULT_DELAY_MS: String(FANSLY_PAUSE_MIN_MS) }).fanslyDefaultDelayMs)
      .toBe(2000);
    expect(loadConfig({ ...baseEnv, FANSLY_DEFAULT_DELAY_MS: String(FANSLY_PAUSE_MAX_MS) }).fanslyDefaultDelayMs)
      .toBe(60_000);
  });

  it("fails the boot on a Fansly pause below 2000 ms instead of raising it", () => {
    // The old example env said 1900; it must stop the process, not be clamped silently.
    for (const value of ["1", "1900", String(FANSLY_PAUSE_MIN_MS - 1)]) {
      expect(() => loadConfig({ ...baseEnv, FANSLY_DEFAULT_DELAY_MS: value }), value)
        .toThrow(`FANSLY_DEFAULT_DELAY_MS must be between 2000 and 60000 ms (got ${value})`);
    }
  });

  it("fails the boot on a Fansly pause above 60000 ms", () => {
    expect(() => loadConfig({ ...baseEnv, FANSLY_DEFAULT_DELAY_MS: String(FANSLY_PAUSE_MAX_MS + 1) }))
      .toThrow("FANSLY_DEFAULT_DELAY_MS must be between 2000 and 60000 ms (got 60001)");
  });

  it("enables Telegram delivery when bot token and chat id are configured", () => {
    const config = loadConfig({
      ...baseEnv,
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "6065935464",
    });

    expect(config.telegramBotToken).toBe("bot-token");
    expect(config.telegramChatId).toBe("6065935464");
    expect(config.telegramEnabled).toBe(true);
    expect(config.telegramReportHourUtc).toBe(9);
    expect(config.telegramProxyPageLabel).toBeNull();
  });

  it("treats blank Telegram values as unconfigured", () => {
    const config = loadConfig({
      ...baseEnv,
      TELEGRAM_BOT_TOKEN: "   ",
      TELEGRAM_CHAT_ID: "",
    });

    expect(config.telegramBotToken).toBeNull();
    expect(config.telegramChatId).toBeNull();
    expect(config.telegramEnabled).toBe(false);
    expect(config.telegramReportHourUtc).toBe(9);
    expect(config.telegramProxyPageLabel).toBeNull();
  });

  it("treats blank optional sync env values as unset", () => {
    const config = loadConfig({
      ...baseEnv,
      SYNC_HTTP_TRACE_FILE: "   ",
      FANSLY_DEFAULT_DELAY_MS: "",
      FANSLY_GLOBAL_DELAY_MS: " ",
      FANSLY_ACCOUNT_LOOKUP_DELAY_MS: "",
      HEALTH_SYNC_MONITORING_TOKEN: " ",
      TELEGRAM_PROXY_PAGE_LABEL: " ",
    });

    expect(config.syncHttpTraceFile).toBeNull();
    expect(config.fanslyDefaultDelayMs).toBe(2500);
    expect(config.healthSyncMonitoringToken).toBeNull();
    expect(config.telegramProxyPageLabel).toBeNull();
  });

  it("accepts an explicit sync health monitoring token", () => {
    const config = loadConfig({
      ...baseEnv,
      HEALTH_SYNC_MONITORING_TOKEN: "health-monitor-secret",
    });

    expect(config.healthSyncMonitoringToken).toBe("health-monitor-secret");
  });

  it("accepts an explicit Telegram report hour", () => {
    const config = loadConfig({
      ...baseEnv,
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-1001234567890",
      TELEGRAM_REPORT_HOUR: "6",
    });

    expect(config.telegramEnabled).toBe(true);
    expect(config.telegramChatId).toBe("-1001234567890");
    expect(config.telegramReportHourUtc).toBe(6);
  });

  it("accepts an explicit Telegram proxy page label", () => {
    const config = loadConfig({
      ...baseEnv,
      TELEGRAM_PROXY_PAGE_LABEL: "lilly-1",
    });

    expect(config.telegramProxyPageLabel).toBe("lilly-1");
  });

  it("accepts a complete credential-separated service egress proxy tuple", () => {
    const config = loadConfig({
      ...baseEnv,
      SERVICE_EGRESS_PROXY_URL: "socks5://proxy.example.internal:1080",
      SERVICE_EGRESS_PROXY_USERNAME: "fake-service-user",
      SERVICE_EGRESS_PROXY_PASSWORD: "fake-service-password",
    });

    expect(config.serviceEgressProxyUrl).toBe("socks5://proxy.example.internal:1080");
    expect(config.serviceEgressProxyUsername).toBe("fake-service-user");
    expect(config.serviceEgressProxyPassword).toBe("fake-service-password");
  });

  it("normalizes an entirely blank service egress tuple to unconfigured", () => {
    const config = loadConfig({
      ...baseEnv,
      SERVICE_EGRESS_PROXY_URL: " ",
      SERVICE_EGRESS_PROXY_USERNAME: "",
      SERVICE_EGRESS_PROXY_PASSWORD: "   ",
    });

    expect(config.serviceEgressProxyUrl).toBeNull();
    expect(config.serviceEgressProxyUsername).toBeNull();
    expect(config.serviceEgressProxyPassword).toBeNull();
  });

  it("rejects partial service egress tuples without exposing credentials", () => {
    const fakePassword = "fake-partial-password";
    expect(() => loadConfig({
      ...baseEnv,
      SERVICE_EGRESS_PROXY_URL: "socks5://proxy.example.internal:1080",
      SERVICE_EGRESS_PROXY_PASSWORD: fakePassword,
    })).toThrow(/must be configured together/);

    try {
      loadConfig({
        ...baseEnv,
        SERVICE_EGRESS_PROXY_URL: "socks5://proxy.example.internal:1080",
        SERVICE_EGRESS_PROXY_PASSWORD: fakePassword,
      });
    } catch (error) {
      expect(String(error)).not.toContain(fakePassword);
    }
  });

  it.each([
    ["non-SOCKS5", "http://proxy.example.internal:1080"],
    ["inline auth", "socks5://fake-user:fake-password@proxy.example.internal:1080"],
    ["missing port", "socks5://proxy.example.internal"],
    ["path", "socks5://proxy.example.internal:1080/path"],
    ["query", "socks5://proxy.example.internal:1080?mode=fake"],
    ["fragment", "socks5://proxy.example.internal:1080#fake"],
    ["disallowed loopback literal", "socks5://127.0.0.1:1080"],
  ])("rejects a service egress URL with %s", (_case, url) => {
    expect(() => loadConfig({
      ...baseEnv,
      SERVICE_EGRESS_PROXY_URL: url,
      SERVICE_EGRESS_PROXY_USERNAME: "fake-service-user",
      SERVICE_EGRESS_PROXY_PASSWORD: "fake-service-password",
    })).toThrow(/SERVICE_EGRESS_PROXY_URL/);
  });

  it("rejects Telegram report hours outside the UTC 0-23 range", () => {
    expect(() => loadConfig({
      ...baseEnv,
      TELEGRAM_REPORT_HOUR: "24",
    })).toThrow();
  });

  it("parses optional historical encryption keys alongside the current write key", () => {
    const currentKey = Buffer.alloc(32, 7);
    const historicalKey = Buffer.alloc(32, 9);
    const config = loadConfig({
      ...baseEnv,
      APP_ENCRYPTION_KEY: currentKey.toString("base64"),
      APP_ENCRYPTION_KEY_VERSION: "2",
      APP_ENCRYPTION_KEY_RING: `1:${historicalKey.toString("base64")}`,
    });

    expect(config.encryptionKeysByVersion.get(1)?.equals(historicalKey)).toBe(true);
    expect(config.encryptionKeysByVersion.get(2)?.equals(currentKey)).toBe(true);
  });

  it("can skip dotenv loading for machine-readable runtime commands", async () => {
    const dotenvPath = path.join(testCwd, ".env");
    await writeFile(
      dotenvPath,
      "FANSLY_BASE_URL=https://example.invalid/should-not-load\n",
      "utf8",
    );

    try {
      const env: NodeJS.ProcessEnv = { ...baseEnv };
      const config = loadConfig(env, { loadDotEnv: false });

      expect(env.FANSLY_BASE_URL).toBeUndefined();
      expect(config.fanslyBaseUrl).toBe("https://apiv3.fansly.com/api/v1");
    } finally {
      await rm(dotenvPath, { force: true });
    }
  });

  it("loads dotenv values into the supplied env object without mutating process.env", async () => {
    const originalFanslyBaseUrl = process.env.FANSLY_BASE_URL;
    const dotenvPath = path.join(testCwd, ".env");

    await writeFile(
      dotenvPath,
      "FANSLY_BASE_URL=https://example.invalid/from-dotenv\n",
      "utf8",
    );

    delete process.env.FANSLY_BASE_URL;

    try {
      const env: NodeJS.ProcessEnv = {
        ...baseEnv,
      };
      const config = loadConfig(env);

      expect(env.FANSLY_BASE_URL).toBe("https://example.invalid/from-dotenv");
      expect(config.fanslyBaseUrl).toBe("https://example.invalid/from-dotenv");
      expect(process.env.FANSLY_BASE_URL).toBeUndefined();
    } finally {
      if (originalFanslyBaseUrl === undefined) {
        delete process.env.FANSLY_BASE_URL;
      } else {
        process.env.FANSLY_BASE_URL = originalFanslyBaseUrl;
      }
      await rm(dotenvPath, { force: true });
    }
  });
});
