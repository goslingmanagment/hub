import { afterEach, describe, expect, it, vi } from "vitest";

const originalDatabaseUrl = process.env.DATABASE_URL;

async function importDrizzleConfig() {
  vi.resetModules();
  return import("../packages/db/drizzle.config.ts");
}

afterEach(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

describe("drizzle config", () => {
  it("fails fast when DATABASE_URL is missing", async () => {
    delete process.env.DATABASE_URL;

    await expect(importDrizzleConfig()).rejects.toThrow(
      "DATABASE_URL is required for drizzle-kit",
    );
  });

  it("uses DATABASE_URL when it is configured", async () => {
    process.env.DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5432/agency_hub_core_test";

    const imported = await importDrizzleConfig();
    const config = imported.default as { dbCredentials: { url: string } };

    expect(config.dbCredentials.url).toBe(process.env.DATABASE_URL);
  });
});
