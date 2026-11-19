import { createPool } from "@agency_hub_core/db";
import { loadConfig } from "@agency_hub_core/shared";

import { runMigrations } from "../../../packages/db/src/migrate-runner.ts";

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

function resolveRole() {
  const role = process.argv[2] ?? process.env.AGENCY_HUB_ROLE ?? "worker";
  // 'scheduler' owns cron registration + firing (leader-elected);
  // workers and the api run pg-boss with schedule: false. 'sync' is the Fansly
  // Sync Engine's own process (no pg-boss).
  if (role !== "api" && role !== "worker" && role !== "scheduler" && role !== "sync") {
    throw new Error(`Unsupported Agency Hub runtime role "${role}"`);
  }

  return role;
}

// A role loads only its own code: the production bundle is split into chunks
// (scripts/build-production.mjs), so importing a role's module pulls in that
// role's graph alone. It is imported before the migrations, where the static
// imports evaluated it before.
async function loadRole(role: ReturnType<typeof resolveRole>) {
  if (role === "api") {
    return (await import("./api-runtime.ts")).runApiRuntime;
  }
  if (role === "scheduler") {
    return (await import("./scheduler-runtime.ts")).runSchedulerRuntime;
  }
  if (role === "sync") {
    return (await import("./sync/main.ts")).runSyncRuntime;
  }

  return (await import("./worker-runtime.ts")).runWorkerRuntime;
}

export async function main() {
  if (process.argv[2] === "print-public-capabilities") {
    // Still loads every role's code (and so every package they import, the
    // native bindings included): CI's capability manifest smoke and the
    // deploy's candidate probe run this command in the image, the one load of
    // the whole bundle before any container is swapped, and the image's
    // compile-cache warm-up (Dockerfile, the dist-only overlay) runs it to
    // cache every role's chunks.
    await import("./api-runtime.ts");
    await import("./scheduler-runtime.ts");
    await import("./services/compatible-client-sdks.ts");
    const { PUBLIC_RUNTIME_CAPABILITIES } = await import("./services/public-capabilities.ts");
    await import("./sync/main.ts");
    await import("./worker-runtime.ts");
    process.stdout.write(`${JSON.stringify(PUBLIC_RUNTIME_CAPABILITIES)}\n`);
    return;
  }
  if (process.argv[2] === "print-compatible-client-sdks") {
    const { describeCompatibleClientSdks } = await import("./services/compatible-client-sdks.ts");
    process.stdout.write(`${JSON.stringify(describeCompatibleClientSdks())}\n`);
    return;
  }

  const role = resolveRole();
  const runRole = await loadRole(role);
  await runStartupMigrations();
  await runRole();
}

main().catch((error) => {
  console.error(error);
  // Explicit exit: after boss.start() pg-boss handles keep the event loop
  // alive, so setting exitCode alone leaves a zombie process that Docker's
  // restart policy (which acts only on exit) never recovers (audit B8).
  process.exit(1);
});
