import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runMigrations } from "../packages/db/src/migrate-runner.ts";
import { startIntegrationTestDatabase } from "./helpers/db.ts";

describe("runMigrations integration", () => {
  it("rolls back failed pool-backed migrations without recording schema state", async () => {
    const testDb = await startIntegrationTestDatabase();
    if (!testDb) {
      return;
    }

    const migrationsDir = await mkdtemp(path.join(tmpdir(), "agency-hub-migrations-rollback-"));
    const migrationName = "0001_pool_rollback_probe.sql";

    try {
      await writeFile(
        path.join(migrationsDir, migrationName),
        [
          "create table migration_pool_rollback_probe (id integer primary key);",
          "select * from definitely_missing_migration_pool_rollback_probe;",
          "",
        ].join("\n"),
      );

      await expect(runMigrations({
        databaseUrl: testDb.connectionString,
        migrationsDir,
      })).rejects.toThrow();

      const createdTable = await testDb.pool.query<{ relation: string | null }>(`
        select to_regclass('public.migration_pool_rollback_probe') as relation
      `);
      expect(createdTable.rows[0]?.relation).toBeNull();

      const migrationRows = await testDb.pool.query<{ count: number }>(
        "select count(*)::int as count from schema_migrations where id = $1",
        [migrationName],
      );
      expect(migrationRows.rows[0]?.count).toBe(0);
    } finally {
      await rm(migrationsDir, { recursive: true, force: true });
      await testDb.stop();
    }
  }, 30_000);
});
