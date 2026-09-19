import path from "node:path";

import { GenericContainer, type StartedTestContainer } from "testcontainers";

import { createPool } from "@agency_hub_core/db";

import { runMigrations } from "../../packages/db/src/migrate-runner.ts";
import { TEMPLATE_DATABASE, TEST_DB_ADMIN_URL_KEY } from "./db-context.ts";
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

  try {
    container = await new GenericContainer("postgres:16")
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
      .withCommand([
        "postgres",
        "-c", "fsync=off",
        "-c", "synchronous_commit=off",
        "-c", "full_page_writes=off",
      ])
      .withStartupTimeout(INTEGRATION_TEST_TIMEOUT_MS)
      .withExposedPorts(5432)
      .start();
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
