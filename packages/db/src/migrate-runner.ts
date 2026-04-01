import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "@agency_hub_core/shared";
import type { PoolClient, QueryResult } from "pg";

import { createPool } from "./client.ts";
import { resolveMigrationFiles } from "./migrations-dir.ts";

const MIGRATION_LOCK_KEY_1 = 31415;
const MIGRATION_LOCK_KEY_2 = 27182;

function assertUniqueMigrationPrefixes(files: string[]) {
  const seenPrefixes = new Map<string, string>();

  for (const file of files) {
    const prefix = file.split("_", 1)[0] ?? "";
    if (!prefix) {
      continue;
    }

    const existing = seenPrefixes.get(prefix);
    if (existing) {
      throw new Error(
        `Duplicate migration prefix "${prefix}" found in "${existing}" and "${file}"`,
      );
    }

    seenPrefixes.set(prefix, file);
  }
}

type MigrationDb = {
  query: (text: string, params?: unknown[]) => Promise<QueryResult>;
};

async function withMigrationClient<T>(
  databaseUrl: string,
  run: (db: MigrationDb) => Promise<T>,
) {
  const pool = createPool(databaseUrl);
  const client = await pool.connect();

  try {
    return await run(client);
  } finally {
    (client as PoolClient).release();
    await pool.end();
  }
}

async function withMigrationLock<T>(
  db: MigrationDb,
  run: () => Promise<T>,
) {
  await db.query("select pg_advisory_lock($1, $2)", [
    MIGRATION_LOCK_KEY_1,
    MIGRATION_LOCK_KEY_2,
  ]);

  try {
    return await run();
  } finally {
    await db.query("select pg_advisory_unlock($1, $2)", [
      MIGRATION_LOCK_KEY_1,
      MIGRATION_LOCK_KEY_2,
    ]).catch(() => undefined);
  }
}

export async function runMigrations(input?: {
  databaseUrl?: string;
  db?: MigrationDb;
  migrationsDir?: string;
}) {
  const migrate = async (db: MigrationDb) => {
    await withMigrationLock(db, async () => {
      await db.query(`
        create table if not exists schema_migrations (
          id text primary key,
          applied_at timestamptz not null default now()
        )
      `);

      const { files, migrationsDir } = await resolveMigrationFiles({
        migrationsDir: input?.migrationsDir,
      });
      assertUniqueMigrationPrefixes(files);

      for (const file of files) {
        const alreadyApplied = await db.query(
          "select 1 from schema_migrations where id = $1",
          [file],
        );

        if (alreadyApplied.rowCount) {
          continue;
        }

        const sql = await readFile(path.join(migrationsDir, file), "utf8");
        await db.query("begin");
        try {
          await db.query(sql);
          await db.query("insert into schema_migrations (id) values ($1)", [file]);
          await db.query("commit");
        } catch (error) {
          await db.query("rollback");
          throw error;
        }
      }
    });
  };

  if (input?.db) {
    await migrate(input.db);
    return;
  }

  const config = loadConfig();
  await withMigrationClient(input?.databaseUrl ?? config.databaseUrl, migrate);
}
