import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "@agency_hub_core/shared";
import type { PoolClient, QueryResult } from "pg";

import { createPool } from "./client.ts";
import { resolveMigrationFiles } from "./migrations-dir.ts";

const MIGRATION_LOCK_KEY_1 = 31415;
const MIGRATION_LOCK_KEY_2 = 27182;
const NO_TRANSACTION_MARKER = "-- agency-hub:no-transaction";
const NO_TRANSACTION_STATEMENT_MARKER = "-- agency-hub:statement";
const EXECUTE_RETURNED_STATEMENTS_MARKER = "-- agency-hub:execute-returned-statements";

function splitNoTransactionMigration(sql: string): string[] {
  const statements = sql.split(NO_TRANSACTION_STATEMENT_MARKER)
    .slice(1)
    .map((statement) => statement.trim())
    .filter(Boolean);
  if (statements.length === 0) {
    throw new Error(
      `${NO_TRANSACTION_MARKER} migration must delimit each query with ${NO_TRANSACTION_STATEMENT_MARKER}`,
    );
  }
  return statements;
}

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

function assertContiguousAppliedPrefix(files: string[], applied: Set<string>) {
  let firstUnapplied: string | undefined;

  for (const file of files) {
    if (!applied.has(file)) {
      if (firstUnapplied === undefined) {
        firstUnapplied = file;
      }
      continue;
    }

    if (firstUnapplied !== undefined) {
      throw new Error(
        `Out-of-order migration detected: "${firstUnapplied}" is not applied but the later "${file}" already is. `
          + "Applied migrations must form a contiguous prefix of the sorted migration files; "
          + "a lower-numbered migration was likely added after higher-numbered ones were applied.",
      );
    }
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
  /** Apply only the contiguous prefix ending at this exact filename. */
  through?: string;
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
      const throughIndex = input?.through === undefined ? files.length - 1 : files.indexOf(input.through);
      if (throughIndex < 0) {
        throw new Error(`Migration through-bound "${input?.through}" was not found in ${migrationsDir}`);
      }
      const selectedFiles = files.slice(0, throughIndex + 1);

      const appliedFiles = new Set<string>();
      for (const file of files) {
        const alreadyApplied = await db.query(
          "select 1 from schema_migrations where id = $1",
          [file],
        );

        if (alreadyApplied.rowCount) {
          appliedFiles.add(file);
        }
      }
      assertContiguousAppliedPrefix(files, appliedFiles);

      for (const file of selectedFiles) {
        if (appliedFiles.has(file)) {
          continue;
        }

        const sql = await readFile(path.join(migrationsDir, file), "utf8");
        if (sql.startsWith(NO_TRANSACTION_MARKER)) {
          // Used only for idempotent operations PostgreSQL forbids inside a
          // transaction (currently CREATE INDEX CONCURRENTLY IF NOT EXISTS).
          // The migration advisory lock still serializes runners. A crash after
          // the operation but before the ledger insert is safe on re-run.
          for (const statement of splitNoTransactionMigration(sql)) {
            if (statement.startsWith(EXECUTE_RETURNED_STATEMENTS_MARKER)) {
              const generator = statement.slice(EXECUTE_RETURNED_STATEMENTS_MARKER.length).trim();
              const generated = await db.query(generator);
              for (const row of generated.rows as Array<{ statement?: unknown }>) {
                if (typeof row.statement !== "string" || row.statement.length === 0) {
                  throw new Error(`${file} returned an invalid generated migration statement`);
                }
                await db.query(row.statement);
              }
            } else {
              await db.query(statement);
            }
          }
          await db.query("insert into schema_migrations (id) values ($1)", [file]);
        } else {
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
