import path from "node:path";

import { GenericContainer, type StartedTestContainer } from "testcontainers";

import { createPool } from "@agency_hub_core/db";

import { runMigrations } from "../../packages/db/src/migrate-runner.ts";
import { READ_ONLY_ROLE_PASSWORD, TEMPLATE_DATABASE, TEST_DB_ADMIN_URL_KEY } from "./db-context.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./timeouts.ts";

async function waitForDatabaseReady(pool: ReturnType<typeof createPool>) {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await pool.query("select 1");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Postgres did not accept queries in time", {
    cause: lastError instanceof Error ? lastError : undefined,
  });
}

/** One Postgres per vitest run (per CI shard). The 145 migrations are applied
 * ONCE, by the PRODUCTION runner — so the template build is now also the only
 * place that proves the real migrator installs the whole chain (the retired
 * `applyTestMigrations` was a hand-kept fork without its safety asserts).
 * Test databases are then `CREATE DATABASE ... TEMPLATE` clones: ~0.2s against
 * ~6.5s for a private container plus a full migrate, 309 times per full run.
 *
 * Docker being unavailable is NOT fatal here: the container failure is
 * swallowed and no admin URL is provided, which leaves `acquireTestPrerequisite`
 * in helpers/prerequisites.ts to skip-or-throw exactly as it did before. */
export default async function setup({ provide }: {
  provide: (key: string, value: unknown) => void;
}) {
  let container: StartedTestContainer | null = null;
  provide("testDbContainerId", null);

  // One reaper (Ryuk) per test process. Testcontainers otherwise shares one
  // between every process on a Docker daemon, behind a lock file in
  // os.tmpdir(). The PC's runners share the daemon but each has its own
  // TMPDIR, so the jobs of one CI run raced for it: a job could take a
  // sibling's reaper while that container was running but not yet listening.
  // Docker's port proxy accepts such a connection and drops it, and
  // Testcontainers never waits for the reaper's ACK, so the job labelled its
  // cluster with a session whose reaper had never counted it. 10 s after that
  // reaper's real clients finished, it removed the cluster under the running
  // shard: "Connection terminated unexpectedly", then ECONNREFUSED for every
  // later file (8 of 89 full PC runs, 03-08.10). A reaper started under this
  // variable carries a label, and Testcontainers never offers a labelled
  // reaper to another process, so this one and each worker that starts a
  // container itself start their own, as a hosted runner's job does. A
  // running reaper of a process without the variable is still taken. The
  // variable is undocumented: tests/testcontainers-reaper.integration.test.ts
  // fails if an upgrade drops either half.
  process.env.TESTCONTAINERS_RYUK_TEST_LABEL ??= "true";

  try {
    // HUB_TEST_PG_TMPFS=1 (ci.yml sets it on the PC's shard steps): PGDATA, pg_wal
    // included, lives in a tmpfs instead of the image's volume on disk. Same
    // cluster, same tests; only where its files are written, and a WAL cap
    // that fits the tmpfs. The default max_wal_size (1GB) equals the tmpfs:
    // a burst of WAL (each CREATE DATABASE ... TEMPLATE clone writes the
    // template into WAL) could fill it, and Postgres PANICs on ENOSPC, which
    // fails the whole shard like a flake. 256MB keeps the WAL well inside it
    // beside the cluster's ~270 MiB peak; fsync is off, so the extra
    // checkpoints cost little.
    const tmpfs = process.env.HUB_TEST_PG_TMPFS === "1";
    const postgres = new GenericContainer("postgres:16")
      .withEnvironment({
        POSTGRES_DB: "postgres",
        POSTGRES_USER: "postgres",
        POSTGRES_PASSWORD: "postgres",
      })
      // Durability is worthless here — the cluster is thrown away at the end of
      // the run — and its cost is not: a shared, long-lived cluster answers a
      // write slower than the fresh container each file used to get, which
      // showed up as egress-resolver's pacing test seeing 1 of 6 pacers claim a
      // slot in 60ms instead of 6. #188 measured this class of tuning at ~40%
      // and dropped it only because stopping a container under a live pool
      // raised FATAL 57P01 into a pool with no listener; createPool absorbs
      // that now, which is the same precondition #239 rests on.
      //
      // autovacuum=off: resetIntegrationDatabase empties tables with DELETE,
      // and a vacuum or analyze fired by its dead tuples would change heap
      // layout and planner stats at an arbitrary point in a file. Its lock
      // would also hold the next reset for deadlock_timeout.
      .withCommand([
        "postgres",
        "-c", "fsync=off",
        "-c", "synchronous_commit=off",
        "-c", "full_page_writes=off",
        "-c", "autovacuum=off",
        ...(tmpfs ? ["-c", "max_wal_size=256MB"] : []),
      ])
      .withStartupTimeout(INTEGRATION_TEST_TIMEOUT_MS)
      .withExposedPorts(5432);
    // The size only caps the tmpfs: a shard's cluster peaked at ~270 MiB, and
    // the memory counts against the CI slice as shmem while it is used.
    if (tmpfs) {
      postgres.withTmpFs({ "/var/lib/postgresql/data": "rw,size=1024m" });
    }
    container = await postgres.start();
    // Docker's events carry the same id and session label: a cluster that
    // disappears mid-run can be traced from the job log to what ended it.
    console.log(
      `[global-setup] test Postgres ${container.getId().slice(0, 12)}, Testcontainers session ${container.getLabels()["org.testcontainers.session-id"] ?? "unknown"}`,
    );
  } catch (error) {
    // Not fatal: helpers/prerequisites.ts turns a missing cluster into the same
    // skip-or-throw it always did. Logged so a real Docker fault is visible
    // instead of surfacing later as "no test Postgres was provided".
    console.warn(
      `[global-setup] no test Postgres: ${error instanceof Error ? error.message : String(error)}`,
    );
    provide(TEST_DB_ADMIN_URL_KEY, null);
    return async () => undefined;
  }

  provide("testDbContainerId", container.getId());
  const base = `postgres://postgres:postgres@${container.getHost()}:${container.getMappedPort(5432)}`;
  const adminUrl = `${base}/postgres`;
  const adminPool = createPool(adminUrl);

  try {
    await waitForDatabaseReady(adminPool);
    await adminPool.query(`create database "${TEMPLATE_DATABASE}" template template0`);

    const templatePool = createPool(`${base}/${TEMPLATE_DATABASE}`);
    // A single session, not the pool: withMigrationLock holds a session-scoped
    // advisory lock, so a pool that spread the lock and the unlock across two
    // connections would never release it.
    const templateClient = await templatePool.connect();
    try {
      await runMigrations({
        db: templateClient,
        migrationsDir: path.resolve("packages/db/migrations"),
      });
    } finally {
      templateClient.release();
      await templatePool.end();
    }

    // The production `read_only` role, created once for the whole run: two
    // test files may share this cluster at the same time, and a suite that
    // created, re-passworded or dropped a cluster-wide role would pull it out
    // from under the other. Created AFTER the template is migrated, so clones
    // start with no grants to it, exactly as before.
    await adminPool.query(`create role read_only login password '${READ_ONLY_ROLE_PASSWORD}'`);
  } catch (error) {
    await adminPool.end().catch(() => undefined);
    await container.stop().catch(() => undefined);
    throw error;
  }

  await adminPool.end();
  provide(TEST_DB_ADMIN_URL_KEY, adminUrl);

  return async () => {
    await container?.stop().catch(() => undefined);
  };
}
