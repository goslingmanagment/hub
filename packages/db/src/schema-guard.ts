import type { Pool } from "pg";
import { resolveMigrationFiles } from "./migrations-dir.ts";

type ColumnShapeRow = {
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};

function normalizeDefaultExpression(value: string | null) {
  return (value ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^\(+/, "")
    .replace(/\)+$/, "");
}

function isEmptyJsonbDefault(value: string | null) {
  return normalizeDefaultExpression(value) === "'{}'::jsonb";
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

function driftError(detail: string) {
  return new Error(
    "Database schema for this runtime is behind or inconsistent. " +
      "Run `pnpm db:migrate` against the same DATABASE_URL used by this process. " +
      `Detail: ${detail}`,
  );
}

export async function assertRuntimeSchemaReady(
  pool: Pick<Pool, "query">,
  input?: {
    migrationsDir?: string;
  },
) {
  const { files: migrationFiles, migrationsDir } = await resolveMigrationFiles({
    migrationsDir: input?.migrationsDir,
  });
  assertUniqueMigrationPrefixes(migrationFiles);
  const latestMigration = migrationFiles.at(-1);

  if (!latestMigration) {
    throw new Error(`No SQL migrations were found in ${migrationsDir}`);
  }

  const migrationTable = await pool.query<{ name: string | null }>(
    "select to_regclass('public.schema_migrations') as name",
  );

  if (migrationTable.rows[0]?.name !== "schema_migrations") {
    throw driftError("schema_migrations table is missing");
  }

  const appliedMigration = await pool.query<{ id: string }>(
    "select id from schema_migrations where id = $1 limit 1",
    [latestMigration],
  );

  if (!appliedMigration.rows[0]?.id) {
    throw driftError(`missing latest migration ${latestMigration}`);
  }

  const requiredTables = await pool.query<{ name: string }>(
    `select table_name as name
       from information_schema.tables
      where table_schema = 'public'
        and table_name in ('pages', 'sync_state', 'sync_cursors')`,
  );

  const requiredNames = new Set(requiredTables.rows.map((row) => row.name));
  for (const name of ["pages", "sync_state", "sync_cursors"]) {
    if (!requiredNames.has(name)) {
      throw driftError(`required table ${name} is missing`);
    }
  }

  const legacyTables = await pool.query<{ name: string }>(
    `select table_name as name
       from information_schema.tables
      where table_schema = 'public'
        and table_name in ('platform_accounts', 'platform_account_proxies', 'sync_stream_state', 'sync_checkpoints')`,
  );

  if (legacyTables.rows.length > 0) {
    throw driftError(`legacy tables still exist: ${legacyTables.rows.map((row) => row.name).join(", ")}`);
  }

  const statsColumn = await pool.query<ColumnShapeRow>(
    `select data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'public'
        and table_name = 'sync_runs'
        and column_name = 'stats'
      limit 1`,
  );

  const column = statsColumn.rows[0];
  if (!column) {
    throw driftError("sync_runs.stats column is missing");
  }

  if (
    column.data_type !== "jsonb" ||
    column.is_nullable !== "NO" ||
    !isEmptyJsonbDefault(column.column_default)
  ) {
    throw driftError(
      "sync_runs.stats must be jsonb NOT NULL DEFAULT '{}'::jsonb " +
        `(got type=${column.data_type}, nullable=${column.is_nullable}, default=${column.column_default ?? "null"})`,
    );
  }
}
