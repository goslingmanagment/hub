import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { assertRuntimeSchemaReady } from "@agency_hub_core/db";

import { resolveMigrationFiles } from "../packages/db/src/migrations-dir.ts";
import { startTestDatabase } from "./helpers/db.ts";
import { acquireTestPrerequisite } from "./helpers/prerequisites.ts";

describe("runtime schema guard", () => {
  afterEach(() => {
    delete process.env.DOTENV_CONFIG_QUIET;
  });

  it("prefers cwd-relative migrations when present", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "agency-hub-schema-guard-"));
    const originalCwd = process.cwd();
    const migrationsDir = path.join(tempDir, "packages/db/migrations");
    const pool = {
      query: vi.fn(async (text: string, params?: unknown[]) => {
        if (text.includes("select to_regclass")) {
          return {
            rows: [{ name: "schema_migrations" }],
          };
        }

        if (text.includes("select id from schema_migrations")) {
          return {
            rows: [{ id: params?.[0] }],
          };
        }

        if (text.includes("table_name in ('pages', 'sync_state', 'sync_cursors')")) {
          return {
            rows: [{ name: "pages" }, { name: "sync_state" }, { name: "sync_cursors" }],
          };
        }

        if (text.includes("table_name in ('platform_accounts', 'platform_account_proxies', 'sync_stream_state', 'sync_checkpoints')")) {
          return {
            rows: [],
          };
        }

        return {
          rows: [{
            column_default: "'{}'::jsonb",
            data_type: "jsonb",
            is_nullable: "NO",
          }],
        };
      }),
    };

    try {
      await mkdir(migrationsDir, { recursive: true });
      await writeFile(path.join(migrationsDir, "9999_runtime.sql"), "select 1;\n");
      process.chdir(tempDir);

      await expect(assertRuntimeSchemaReady(pool as never)).resolves.toBeUndefined();
      expect(pool.query).toHaveBeenCalledWith(
        "select id from schema_migrations where id = $1 limit 1",
        ["9999_runtime.sql"],
      );
    } finally {
      process.chdir(originalCwd);
      await rm(tempDir, { recursive: true, force: true });
    }
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
      const { files } = await resolveMigrationFiles();
      const latestMigration = files.at(-1);

      if (!latestMigration) {
        throw new Error("Expected at least one migration file");
      }

      await testDb.pool.query("delete from schema_migrations where id = $1", [latestMigration]);

      await expect(assertRuntimeSchemaReady(testDb.pool)).rejects.toThrow(
        `missing latest migration ${latestMigration}`,
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
