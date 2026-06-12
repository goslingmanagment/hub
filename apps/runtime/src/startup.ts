import { createPool } from "@agency_hub_core/db";
import { loadConfig } from "@agency_hub_core/shared";

import { runMigrations } from "../../../packages/db/src/migrate-runner.ts";
import { runApiRuntime } from "./api-runtime.ts";
import { runWorkerRuntime } from "./worker-runtime.ts";

const MIGRATION_LOCK_KEY_1 = 31415;
const MIGRATION_LOCK_KEY_2 = 27182;

async function runStartupMigrations() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const client = await pool.connect();

  try {
    await client.query("select pg_advisory_lock($1, $2)", [
      MIGRATION_LOCK_KEY_1,
      MIGRATION_LOCK_KEY_2,
    ]);
    await runMigrations({
      databaseUrl: config.databaseUrl,
      db: client,
    });
  } finally {
    await client.query("select pg_advisory_unlock($1, $2)", [
      MIGRATION_LOCK_KEY_1,
      MIGRATION_LOCK_KEY_2,
    ]).catch(() => undefined);
    client.release();
    await pool.end().catch(() => undefined);
  }
}

function resolveRole() {
  const role = process.argv[2] ?? process.env.AGENCY_HUB_ROLE ?? "worker";
  if (role !== "api" && role !== "worker") {
    throw new Error(`Unsupported Agency Hub runtime role "${role}"`);
  }

  return role;
}

export async function main() {
  const role = resolveRole();
  await runStartupMigrations();

  if (role === "api") {
    await runApiRuntime();
    return;
  }

  await runWorkerRuntime();
}

main().catch((error) => {
  console.error(error);
  // Explicit exit: after boss.start() pg-boss handles keep the event loop
  // alive, so setting exitCode alone leaves a zombie process that Docker's
  // restart policy (which acts only on exit) never recovers (audit B8).
  process.exit(1);
});
