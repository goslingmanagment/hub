import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "@agency_hub_core/shared";

const baseEnv = {
  DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/agency_hub_core_test",
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
} satisfies NodeJS.ProcessEnv;
const originalDotenvQuiet = process.env.DOTENV_CONFIG_QUIET;

beforeAll(() => {
  process.env.DOTENV_CONFIG_QUIET = "true";
});

afterAll(() => {
  if (originalDotenvQuiet === undefined) {
    delete process.env.DOTENV_CONFIG_QUIET;
    return;
  }

  process.env.DOTENV_CONFIG_QUIET = originalDotenvQuiet;
});

describe("config", () => {
  it("defaults Fansly and OnlyFans delays and executor concurrency", () => {
    const config = loadConfig(baseEnv);

    expect(config.fanslyDefaultDelayMs).toBe(2500);
    expect(config.fanslyDmConversationsDelayMs).toBe(5000);
    expect(config.fanslyDmMessagesDelayMs).toBe(7500);
    expect(config.onlyFansDefaultDelayMs).toBe(1000);
    expect(config.syncPageExecutorConcurrency).toBe(4);
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

  it("accepts an explicit Fansly default delay override", () => {
    const config = loadConfig({
      ...baseEnv,
      FANSLY_DEFAULT_DELAY_MS: "3000",
    });

    expect(config.fanslyDefaultDelayMs).toBe(3000);
  });

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

  it("rejects Telegram report hours outside the UTC 0-23 range", () => {
    expect(() => loadConfig({
      ...baseEnv,
      TELEGRAM_REPORT_HOUR: "24",
    })).toThrow();
  });
});
