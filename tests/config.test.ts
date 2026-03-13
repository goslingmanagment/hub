import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "@fansly-connect/shared";

const baseEnv = {
  DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/fansly_connect_test",
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
  it("defaults Fansly account lookup delay to 2500ms", () => {
    const config = loadConfig(baseEnv);

    expect(config.fanslyAccountLookupDelayMs).toBe(2500);
  });

  it("accepts an explicit Fansly account lookup delay override", () => {
    const config = loadConfig({
      ...baseEnv,
      FANSLY_ACCOUNT_LOOKUP_DELAY_MS: "3000",
    });

    expect(config.fanslyAccountLookupDelayMs).toBe(3000);
  });
});
