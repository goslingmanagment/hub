import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "@agency_hub_core/shared";

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
    expect(config.fanslyDmConversationsDelayMs).toBe(5000);
    expect(config.fanslyDmMessagesDelayMs).toBe(5000);
    expect(config.fanslyDmDeepBackfillLiveRequestsPerDeep).toBe(4);
    expect(config.fanslyDmDeepBackfillContinuationDelayMs).toBe(0);
    expect(config.fanslyDmDeepBackfillContinuationJitterMs).toBe(0);
    expect(config.onlyFansDefaultDelayMs).toBe(1000);
    expect(config.onlyFansDmPollingEnabled).toBe(false);
    expect(config.syncSharedRateLimitEnabled).toBe(true);
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

  it("accepts explicit Fansly DM delay overrides", () => {
    const config = loadConfig({
      ...baseEnv,
      FANSLY_DM_CONVERSATIONS_DELAY_MS: "6200",
      FANSLY_DM_MESSAGES_DELAY_MS: "8300",
    });

    expect(config.fanslyDmConversationsDelayMs).toBe(6200);
    expect(config.fanslyDmMessagesDelayMs).toBe(8300);
  });

  it("enforces a safe Fansly DM delay floor", () => {
    const config = loadConfig({
      ...baseEnv,
      FANSLY_DM_CONVERSATIONS_DELAY_MS: "2000",
      FANSLY_DM_MESSAGES_DELAY_MS: "3000",
    });

    expect(config.fanslyDmConversationsDelayMs).toBe(5000);
    expect(config.fanslyDmMessagesDelayMs).toBe(5000);
  });

  it("accepts Fansly DM deep backfill pacing overrides", () => {
    const config = loadConfig({
      ...baseEnv,
      FANSLY_DM_DEEP_BACKFILL_LIVE_REQUESTS_PER_DEEP: "6",
      FANSLY_DM_DEEP_BACKFILL_CONTINUATION_DELAY_MS: "22000",
      FANSLY_DM_DEEP_BACKFILL_CONTINUATION_JITTER_MS: "8000",
    });

    expect(config.fanslyDmDeepBackfillLiveRequestsPerDeep).toBe(6);
    expect(config.fanslyDmDeepBackfillContinuationDelayMs).toBe(22_000);
    expect(config.fanslyDmDeepBackfillContinuationJitterMs).toBe(8_000);
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

  it("falls back to the deprecated account lookup delay alias when the global var is unset", () => {
    const config = loadConfig({
      ...baseEnv,
      FANSLY_ACCOUNT_LOOKUP_DELAY_MS: "3000",
    });

    expect(config.fanslyDefaultDelayMs).toBe(3000);
  });

  it("prefers FANSLY_DEFAULT_DELAY_MS over deprecated aliases", () => {
    const config = loadConfig({
      ...baseEnv,
      FANSLY_GLOBAL_DELAY_MS: "3000",
      FANSLY_ACCOUNT_LOOKUP_DELAY_MS: "3500",
      FANSLY_DEFAULT_DELAY_MS: "2800",
    });

    expect(config.fanslyDefaultDelayMs).toBe(2800);
  });

  it("prefers FANSLY_GLOBAL_DELAY_MS over the legacy account lookup alias when canonical is unset", () => {
    const config = loadConfig({
      ...baseEnv,
      FANSLY_GLOBAL_DELAY_MS: "3000",
      FANSLY_ACCOUNT_LOOKUP_DELAY_MS: "3500",
    });

    expect(config.fanslyDefaultDelayMs).toBe(3000);
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
