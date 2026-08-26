import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

import { createDb, createFanslyPage, createModel, createPool, storeFanslySession } from "@agency_hub_core/db";
import { createLogger, encryptJson, type FanslySessionBundle } from "@agency_hub_core/shared";
import type { PoolClient } from "pg";
import { inject } from "vitest";

import { runMigrations } from "../../packages/db/src/migrate-runner.ts";

import { TEMPLATE_DATABASE, TEST_DB_ADMIN_URL_KEY } from "./global-setup.ts";
import { acquireTestPrerequisite } from "./prerequisites.ts";

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

/** Hands the caller its own database. A `CREATE DATABASE ... TEMPLATE` clone of
 * the already-migrated template built once per run in helpers/global-setup.ts —
 * ~0.2s, against ~6.5s when every acquisition started a private container and
 * replayed all 145 migrations.
 *
 * `through` still needs a partially-migrated schema, which no template can
 * provide, so that one caller gets an empty database migrated to its bound by
 * the production runner. It stays on the shared cluster: it kills backends by
 * exact pid, not by anything cluster-wide. */
export async function startTestDatabase(input?: {
  through?: string;
}) {
  const adminUrl = inject(TEST_DB_ADMIN_URL_KEY);
  if (typeof adminUrl !== "string") {
    throw new Error(
      "No test Postgres was provided. helpers/global-setup.ts could not start a "
      + "container — is Docker running?",
    );
  }

  const databaseName = `hub_test_${randomUUID().replaceAll("-", "")}`;
  const connectionString = new URL(adminUrl);
  connectionString.pathname = `/${databaseName}`;

  const adminPool = createPool(adminUrl);
  try {
    await adminPool.query(
      input?.through === undefined
        ? `create database "${databaseName}" template "${TEMPLATE_DATABASE}"`
        : `create database "${databaseName}" template template0`,
    );
  } catch (error) {
    await adminPool.end().catch(() => undefined);
    throw error;
  }

  const pool = createPool(connectionString.toString());
  try {
    await waitForDatabaseReady(pool);

    if (input?.through !== undefined) {
      // A single session: withMigrationLock's advisory lock is session-scoped.
      const client = await pool.connect();
      try {
        await runMigrations({
          db: client,
          migrationsDir: path.resolve("packages/db/migrations"),
          through: input.through,
        });
      } finally {
        (client as PoolClient).release();
      }
    }

    const db = createDb(pool);
    // Seeded per clone, never into the template: checked_at is compared against
    // OFAPI_STORAGE_HEALTH_MAX_AGE_MS, so a value frozen at template-build time
    // would age out mid-run and fail governed transports closed.
    await seedHealthyStorageSample(pool);

    return {
      connectionString: connectionString.toString(),
      pool,
      db,
      logger: createLogger("silent"),
      async stop() {
        await pool.end().catch(() => undefined);
        // FORCE: a test that leaked a runtime pool would otherwise block the
        // drop and leave the clone behind for the rest of the run. The 57P01
        // this raises in the leaked pool is absorbed by createPool's background
        // error handler (the decision #188 blocker, fixed since).
        // A drop that fails leaves the clone on the shared cluster for the
        // rest of the run, so it is reported rather than swallowed.
        await adminPool.query(`drop database if exists "${databaseName}" with (force)`)
          .catch((error: unknown) => {
            console.warn(
              `[test-db] could not drop ${databaseName}: `
              + `${error instanceof Error ? error.message : String(error)}`,
            );
          });
        await adminPool.end().catch(() => undefined);
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    await adminPool.query(`drop database if exists "${databaseName}" with (force)`)
      .catch(() => undefined);
    await adminPool.end().catch(() => undefined);
    throw error;
  }
}

export type StartedTestDatabase = Awaited<ReturnType<typeof startTestDatabase>>;

export async function startIntegrationTestDatabase(input?: {
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
