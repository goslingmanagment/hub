import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

import { createDb, createFanslyPage, createModel, createPool, storeFanslySession } from "@agency_hub_core/db";
import { createLogger, encryptJson, type FanslySessionBundle } from "@agency_hub_core/shared";
import type { PoolClient } from "pg";
import { inject } from "vitest";

import { TEMPLATE_DATABASE, TEST_DB_ADMIN_URL_KEY } from "./db-context.ts";
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
      // Normal clones are already migrated by global setup. Only partial
      // schemas need to load the production migration runner in a worker.
      const { runMigrations } = await import("../../packages/db/src/migrate-runner.ts");
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
        // Deliberately NOT `with (force)`. FORCE terminates whatever is still
        // connected, and a connection this harness did not create — pg-boss
        // opens its own, outside createPool and so outside its background-error
        // absorber — turns that into an unhandled FATAL 57P01 that fails a job
        // where every test passed. That is the #188 hazard, and createPool's
        // absorber does not cover it.
        //
        // So the drop is polite: it reclaims the clone when nothing holds it,
        // and when something does it reports and moves on. The leftover
        // database costs disk until the container dies with the run; a red run
        // on a green suite costs a great deal more.
        await adminPool.query(`drop database if exists "${databaseName}"`)
          .catch((error: unknown) => {
            console.warn(
              `[test-db] ${databaseName} left behind (something still holds it): `
              + `${error instanceof Error ? error.message : String(error)}`,
            );
          });
        await adminPool.end().catch(() => undefined);
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    await adminPool.query(`drop database if exists "${databaseName}"`)
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

/** Empties every table a test can have written, the way
 * `truncate ... restart identity cascade` does, without giving each of the
 * ~280 tables and ~850 indexes a new file on every call (~0.1-0.25 s a reset):
 *
 * - Every table is first locked in ACCESS EXCLUSIVE mode, the lock TRUNCATE
 *   takes: a transaction still in flight from the previous test (a writer, a
 *   reader that writes later, a SELECT ... FOR UPDATE claimer) finishes first
 *   and its rows are then emptied, instead of committing into the next test or
 *   deadlocking the reset. Measured cost is the same as SHARE.
 * - `delete` runs only on tables with pages. A table no row has reached
 *   since the clone was made has none, so it costs no scan.
 * - `session_replication_role = replica` (local to this transaction) skips
 *   every user and foreign-key trigger: tables empty in any order, and nothing
 *   cascades or refuses.
 * - Only sequences owned by a column restart, as under `restart identity`,
 *   and only once they have handed out a value. Standalone sequences keep
 *   theirs, as they always did.
 *
 * The rows end up exactly as after TRUNCATE; the storage does not. Deleted rows
 * stay as dead tuples and index entries (global-setup turns autovacuum off, so
 * nothing reclaims them mid-file), and pg_class keeps its counts. Query plans
 * read those, so a file that asserts plans or buffer counts asks for
 * `physical: true`. */
const LOGICAL_RESET_SQL = `
do $reset$
declare
  locks text;
  target regclass;
begin
  perform set_config('session_replication_role', 'replica', true);
  select 'lock table ' || string_agg(c.oid::regclass::text, ', ' order by c.relname) || ' in access exclusive mode'
    into locks
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relname not in ('schema_migrations', 'platforms');
  if locks is not null then
    execute locks;
  end if;
  for target in
    select c.oid::regclass
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname not in ('schema_migrations', 'platforms')
      and pg_relation_size(c.oid) > 0
  loop
    execute format('delete from %s', target);
  end loop;
  for target in
    select distinct q.seqrelid::regclass
    from pg_depend d
    join pg_sequence q on q.seqrelid = d.objid
    join pg_class t on t.oid = d.refobjid
    join pg_namespace n on n.oid = t.relnamespace
    where d.classid = 'pg_class'::regclass
      and d.refclassid = 'pg_class'::regclass
      and d.deptype in ('a', 'i')
      and n.nspname = 'public'
      and t.relkind in ('r', 'p')
      and t.relname not in ('schema_migrations', 'platforms')
      and pg_sequence_last_value(q.seqrelid) is not null
  loop
    execute format('alter sequence %s restart', target);
  end loop;
end
$reset$`;

async function truncateIntegrationTables(pool: ReturnType<typeof createPool>) {
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

  if (tableNames.length > 0) {
    await pool.query(`truncate ${tableNames.join(", ")} restart identity cascade`);
  }
}

export async function resetIntegrationDatabase(
  pool: ReturnType<typeof createPool>,
  options?: {
    /** TRUNCATE every table instead: fresh files, empty indexes and pg_class
     * reset to "never analyzed". Only for files that assert query plans or
     * buffer counts; it costs ~20x the default reset. */
    physical?: boolean;
  },
) {
  await pool.query("drop schema if exists pgboss cascade");

  // platforms is reference data seeded by migration 0068 (Stage 18) — pages
  // rows FK into it, so a reset must keep the vocabulary rows.
  if (options?.physical === true) {
    await truncateIntegrationTables(pool);
  } else {
    await pool.query(LOGICAL_RESET_SQL);
  }
  // Governed OFAPI transports opt into the fail-closed disk gate. Integration
  // fixtures get an explicit fresh healthy sample; tests for missing/stale/
  // breached storage delete or replace this singleton themselves.
  await seedHealthyStorageSample(pool);
  // Explicit fixture reset of the migration-owned singleton. Runtime never
  // reconstructs a missing policy state from env or enables a lost policy.
  await pool.query(`do $$ begin if to_regclass('ofapi_collection_state') is not null then
    insert into ofapi_collection_state(id) values(1) on conflict(id) do nothing;
  end if; end $$`);
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
