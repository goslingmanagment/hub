import { afterEach, describe, expect, it } from "vitest";

import { assertRuntimeSchemaReady } from "@agency_hub_core/db";

import { startTestDatabase } from "./helpers/db.ts";
import { acquireTestPrerequisite } from "./helpers/prerequisites.ts";

describe("runtime schema guard", () => {
  afterEach(() => {
    delete process.env.DOTENV_CONFIG_QUIET;
  });

  it("passes when the latest migration is applied and sync_runs.stats has the expected shape", async () => {
    const testDb = await acquireTestPrerequisite(
      () => startTestDatabase(),
      {
        prerequisite: "Docker-backed Postgres for schema guard tests",
        reason: "These tests validate runtime schema expectations against the migrated database schema.",
      },
    );
    if (!testDb) {
      return;
    }

    try {
      await expect(assertRuntimeSchemaReady(testDb.pool)).resolves.toBeUndefined();
    } finally {
      await testDb.stop();
    }
  }, 30_000);

  it("fails when the latest migration is missing from schema_migrations", async () => {
    const testDb = await acquireTestPrerequisite(
      () => startTestDatabase({
        through: "0012_fansly_utc_business_dates.sql",
      }),
      {
        prerequisite: "Docker-backed Postgres for schema guard tests",
        reason: "These tests validate runtime schema expectations against the migrated database schema.",
      },
    );
    if (!testDb) {
      return;
    }

    try {
      await expect(assertRuntimeSchemaReady(testDb.pool)).rejects.toThrow(
        "missing latest migration 0022_telegram_credentials_in_db.sql",
      );
    } finally {
      await testDb.stop();
    }
  }, 30_000);

  it("fails when sync_runs.stats does not match the required runtime shape", async () => {
    const testDb = await acquireTestPrerequisite(
      () => startTestDatabase(),
      {
        prerequisite: "Docker-backed Postgres for schema guard tests",
        reason: "These tests validate runtime schema expectations against the migrated database schema.",
      },
    );
    if (!testDb) {
      return;
    }

    try {
      await testDb.pool.query("alter table sync_runs alter column stats drop default");

      await expect(assertRuntimeSchemaReady(testDb.pool)).rejects.toThrow(
        "sync_runs.stats must be jsonb NOT NULL DEFAULT '{}'::jsonb",
      );
    } finally {
      await testDb.stop();
    }
  }, 30_000);
});
