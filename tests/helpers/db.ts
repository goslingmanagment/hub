import { readFile, readdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

import { createDb, createFanslyPage, createModel, createPool, storeFanslySession } from "@agency_hub_core/db";
import { createLogger, encryptJson, type FanslySessionBundle } from "@agency_hub_core/shared";
import type { PoolClient } from "pg";
import { GenericContainer } from "testcontainers";

import { acquireTestPrerequisite } from "./prerequisites.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./timeouts.ts";

const DATABASE_READY_TIMEOUT_MS = 10_000;
const DATABASE_READY_POLL_MS = 100;

async function waitForDatabaseReady(pool: ReturnType<typeof createPool>) {
  const deadline = Date.now() + DATABASE_READY_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await pool.query("select 1");
      return;
    } catch (error) {
      lastError = error;
      await sleep(DATABASE_READY_POLL_MS);
    }
  }

  throw new Error(`Postgres did not accept queries within ${DATABASE_READY_TIMEOUT_MS}ms`, {
    cause: lastError instanceof Error ? lastError : undefined,
  });
}

async function seedHealthyStorageSample(pool: ReturnType<typeof createPool>) {
  const relation = await pool.query<{ name: string | null }>(
    "select to_regclass('public.ofapi_storage_health_state')::text as name",
  );
  if (!relation.rows[0]?.name) {
    return;
  }
  await pool.query(`
    insert into ofapi_storage_health_state (
      id, healthy, breached, checked_at,
      used_bytes, free_bytes, total_bytes, error, updated_at
    ) values (1, true, false, clock_timestamp(), 1, 9, 10, null, clock_timestamp())
    on conflict (id) do update set
      healthy = excluded.healthy,
      breached = excluded.breached,
      checked_at = excluded.checked_at,
      used_bytes = excluded.used_bytes,
      free_bytes = excluded.free_bytes,
      total_bytes = excluded.total_bytes,
      error = excluded.error,
      updated_at = excluded.updated_at
  `);
}

export async function startTestDatabase(input?: {
  from?: string;
  through?: string;
}) {
  const container = await new GenericContainer("postgres:16")
    .withEnvironment({
      POSTGRES_DB: "testdb",
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
    })
    .withStartupTimeout(INTEGRATION_TEST_TIMEOUT_MS)
    .withExposedPorts(5432)
    .start();
  const connectionString = `postgres://postgres:postgres@${container.getHost()}:${container.getMappedPort(5432)}/testdb`;
  const pool = createPool(connectionString);
  try {
    await waitForDatabaseReady(pool);

    const db = createDb(pool);
    await applyTestMigrations(pool, input);
    await seedHealthyStorageSample(pool);

    return {
      container,
      connectionString,
      pool,
      db,
      logger: createLogger("silent"),
      async stop() {
        await pool.end();
        await container.stop();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    await container.stop().catch(() => undefined);
    throw error;
  }
}

export type StartedTestDatabase = Awaited<ReturnType<typeof startTestDatabase>>;

export async function startIntegrationTestDatabase(input?: {
  from?: string;
  through?: string;
}) {
  return acquireTestPrerequisite(
    () => startTestDatabase(input),
    {
      prerequisite: "Docker-backed Postgres for integration tests",
      reason: "These tests use Testcontainers and require local Docker access.",
    },
  );
}

export async function resetIntegrationDatabase(pool: ReturnType<typeof createPool>) {
  await pool.query("drop schema if exists pgboss cascade");

  // platforms is reference data seeded by migration 0068 (Stage 18) — pages
  // rows FK into it, so a reset must keep the vocabulary rows.
  const tableRows = await pool.query<{ quoted_name: string }>(`
    select quote_ident(tablename) as quoted_name
    from pg_tables
    where schemaname = 'public'
      and tablename <> 'schema_migrations'
      and tablename <> 'platforms'
    order by tablename asc
  `);

  const tableNames = tableRows.rows
    .map((row) => row.quoted_name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);

  if (tableNames.length === 0) {
    return;
  }

  await pool.query(`truncate ${tableNames.join(", ")} restart identity cascade`);
  // Governed OFAPI transports opt into the fail-closed disk gate. Integration
  // fixtures get an explicit fresh healthy sample; tests for missing/stale/
  // breached storage delete or replace this singleton themselves.
  await seedHealthyStorageSample(pool);
}

export async function applyTestMigrations(
  pool: ReturnType<typeof createPool>,
  input?: {
    from?: string;
    through?: string;
  },
) {
  const client = await pool.connect();

  try {
    await client.query(`
      create table if not exists schema_migrations (
        id text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const migrationsDir = path.resolve("packages/db/migrations");
    const files = (await readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    if (input?.from && !files.includes(input.from)) {
      throw new Error(`Migration "${input.from}" was not found`);
    }
    if (input?.through && !files.includes(input.through)) {
      throw new Error(`Migration "${input.through}" was not found`);
    }

    const selected = files.filter((file) => (
      (input?.from ? file >= input.from : true) &&
      (input?.through ? file <= input.through : true)
    ));

    for (const file of selected) {
      const migration = await readFile(path.join(migrationsDir, file), "utf8");
      if (migration.startsWith("-- agency-hub:no-transaction")) {
        const statements = migration.split("-- agency-hub:statement")
          .slice(1)
          .map((statement) => statement.trim())
          .filter(Boolean);
        if (statements.length === 0) {
          throw new Error(`Non-transactional test migration ${file} has no delimited statements`);
        }
        for (const statement of statements) {
          const generatorMarker = "-- agency-hub:execute-returned-statements";
          if (statement.startsWith(generatorMarker)) {
            const generated = await client.query<{ statement: string }>(
              statement.slice(generatorMarker.length).trim(),
            );
            for (const row of generated.rows) {
              await client.query(row.statement);
            }
          } else {
            await client.query(statement);
          }
        }
        await client.query("insert into schema_migrations (id) values ($1)", [file]);
        continue;
      }
      await client.query("begin");
      try {
        await client.query(migration);
        await client.query("insert into schema_migrations (id) values ($1)", [file]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    (client as PoolClient).release();
  }
}

export async function seedFanslyPage(
  db: ReturnType<typeof createDb>,
  encryptionKey: Buffer,
  encryptionKeyVersion = 1,
  pageLabel = "lora-main",
) {
  const model = await createModel(db, {
    slug: "lora",
    name: "Lora",
  });
  const page = await createFanslyPage(db, {
    modelId: model.id,
    label: pageLabel,
  });
  const session: FanslySessionBundle = {
    authorization: "token",
    fanslyClientId: "client-id",
    fanslyClientCheck: "client-check",
    fanslySessionId: "session-id",
  };

  await storeFanslySession(
    db,
    page.id,
    JSON.stringify(encryptJson(session, encryptionKey, encryptionKeyVersion)),
    encryptionKeyVersion,
  );

  return { model, page, session };
}
