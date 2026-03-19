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
    expect(config.onlyFansDefaultDelayMs).toBe(1000);
    expect(config.syncPageExecutorConcurrency).toBe(4);
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
});
