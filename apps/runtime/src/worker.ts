import { deleteExpiredRawPayloads, deleteExpiredSyncObservability } from "@agency_hub_core/db";
import { PgBoss } from "pg-boss";

import { createAppContext } from "./bootstrap.ts";
import { startSyncPageExecutor } from "./services/sync/executor.ts";
import { runSyncPlannerCycle } from "./services/sync/planner.ts";
import {
  ensurePlannerSchedule,
  ensureSyncQueues,
  RAW_PAYLOAD_CLEANUP_QUEUE,
  SYNC_PLANNER_QUEUE,
} from "./services/sync-queue.ts";

async function main() {
  const app = await createAppContext();
  const boss = new PgBoss({
    connectionString: app.config.databaseUrl,
  });
  const createdQueues = new Set<string>();
  const abortController = new AbortController();

  await boss.start();
  await ensureSyncQueues(boss, createdQueues);
  await Promise.all([
    ensurePlannerSchedule(boss),
    boss.schedule(RAW_PAYLOAD_CLEANUP_QUEUE, "0 2 * * *"),
  ]);

  await boss.work(SYNC_PLANNER_QUEUE, {
    batchSize: 1,
    includeMetadata: true,
  }, async () => {
    await runSyncPlannerCycle(app, boss);
  });

  await boss.work(RAW_PAYLOAD_CLEANUP_QUEUE, { batchSize: 1 }, async () => {
    await deleteExpiredRawPayloads(app.db, new Date());
    await deleteExpiredSyncObservability(
      app.db,
      new Date(Date.now() - app.config.syncObservabilityRetentionDays * 24 * 60 * 60 * 1000),
    );
  });

  const executorPromise = startSyncPageExecutor(app, boss, {
    signal: abortController.signal,
  });

  app.logger.info("Worker started");

  const shutdown = async () => {
    abortController.abort();
    await executorPromise.catch((error) => {
      app.logger.error({ err: error }, "Sync page executor failed during shutdown");
    });
    await boss.stop();
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
