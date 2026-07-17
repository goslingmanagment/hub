import { createPool } from "@agency_hub_core/db";
import { loadConfig } from "@agency_hub_core/shared";

import { runMigrations } from "../../../packages/db/src/migrate-runner.ts";
import { runApiRuntime } from "./api-runtime.ts";
import { runSchedulerRuntime } from "./scheduler-runtime.ts";
import {
  DESKTOP_LIFECYCLE_V2_EVIDENCE,
  validateDesktopLifecycleV2Evidence,
  verifyDesktopLifecycleV2Inventory,
} from "./services/desktop-lifecycle-v2-evidence.ts";
import { PUBLIC_RUNTIME_CAPABILITIES } from "./services/public-capabilities.ts";
import { runWorkerRuntime } from "./worker-runtime.ts";

async function runStartupMigrations() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const client = await pool.connect();

  try {
    await runMigrations({
      databaseUrl: config.databaseUrl,
      db: client,
    });
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
  }
}

async function verifyLifecycleInventory() {
  // Docker Compose already injects .env.production. Keep this machine-readable
  // command's stdout free of dotenv's informational banner.
  const config = loadConfig(process.env, { loadDotEnv: false });
  const pool = createPool(config.databaseUrl);
  try {
    const verified = await verifyDesktopLifecycleV2Inventory(pool);
    process.stdout.write(`${JSON.stringify({ ok: true, verified })}\n`);
  } finally {
    await pool.end();
  }
}

function resolveRole() {
  const role = process.argv[2] ?? process.env.AGENCY_HUB_ROLE ?? "worker";
  // Stage 25: 'scheduler' owns cron registration + firing (leader-elected);
  // workers and the api run pg-boss with schedule: false.
  if (role !== "api" && role !== "worker" && role !== "scheduler") {
    throw new Error(`Unsupported Agency Hub runtime role "${role}"`);
  }

  return role;
}

export async function main() {
  if (process.argv[2] === "print-public-capabilities") {
    process.stdout.write(`${JSON.stringify(PUBLIC_RUNTIME_CAPABILITIES)}\n`);
    return;
  }
  if (process.argv[2] === "print-desktop-lifecycle-v2-evidence") {
    validateDesktopLifecycleV2Evidence();
    process.stdout.write(`${JSON.stringify(DESKTOP_LIFECYCLE_V2_EVIDENCE)}\n`);
    return;
  }
  if (process.argv[2] === "verify-desktop-lifecycle-v2-inventory") {
    await verifyLifecycleInventory();
    return;
  }

  const role = resolveRole();
  await runStartupMigrations();

  if (role === "api") {
    await runApiRuntime();
    return;
  }
  if (role === "scheduler") {
    await runSchedulerRuntime();
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
