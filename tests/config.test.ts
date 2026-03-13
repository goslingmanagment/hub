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
  it("defaults Fansly global delay to 2500ms", () => {
    const config = loadConfig(baseEnv);

    expect(config.fanslyGlobalDelayMs).toBe(2500);
  });

  it("accepts an explicit Fansly global delay override", () => {
    const config = loadConfig({
      ...baseEnv,
      FANSLY_GLOBAL_DELAY_MS: "3000",
    });

    expect(config.fanslyGlobalDelayMs).toBe(3000);
  });

  it("falls back to the deprecated account lookup delay alias when the global var is unset", () => {
    const config = loadConfig({
      ...baseEnv,
      FANSLY_ACCOUNT_LOOKUP_DELAY_MS: "3000",
    });

    expect(config.fanslyGlobalDelayMs).toBe(3000);
  });

  it("prefers FANSLY_GLOBAL_DELAY_MS over the deprecated alias when both are set", () => {
    const config = loadConfig({
      ...baseEnv,
      FANSLY_GLOBAL_DELAY_MS: "3000",
      FANSLY_ACCOUNT_LOOKUP_DELAY_MS: "3500",
    });

    expect(config.fanslyGlobalDelayMs).toBe(3000);
  });
});
