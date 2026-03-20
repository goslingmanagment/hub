import { pathToFileURL } from "node:url";

import {
  closeOrphanedSyncRuns,
  deleteExpiredRawPayloads,
  deleteExpiredSyncObservability,
} from "@agency_hub_core/db";
import { PgBoss } from "pg-boss";

import { createAppContext, type AppContext } from "./bootstrap.ts";
import { startSyncPageExecutor } from "./services/sync/executor.ts";
import { runSyncPlannerCycle } from "./services/sync/planner.ts";
import {
  ensurePlannerSchedule,
  ensureSyncQueues,
  RAW_PAYLOAD_CLEANUP_QUEUE,
  SYNC_PLANNER_QUEUE,
} from "./services/sync-queue.ts";

const WORKER_RESTART_ERROR_SUMMARY = "Worker restarted";

type WorkerBoss = Pick<
  PgBoss,
  "complete" | "createQueue" | "fail" | "fetch" | "schedule" | "send" | "start" | "stop" | "touch" | "work"
>;

export async function startWorkerServices(
  app: AppContext,
  boss: WorkerBoss,
  input?: {
    processStartedAt?: Date;
  },
) {
  const createdQueues = new Set<string>();
  const abortController = new AbortController();
  const processStartedAt = input?.processStartedAt ?? new Date();
  const cleanupFinishedAt = new Date();

  const orphanedRuns = await closeOrphanedSyncRuns(app.db, {
    startedBefore: processStartedAt,
    finishedAt: cleanupFinishedAt,
    errorSummary: WORKER_RESTART_ERROR_SUMMARY,
  });

  app.logger.info({
    processStartedAt,
    finishedAt: cleanupFinishedAt,
    orphanedRunTotal: orphanedRuns.totalCount,
    orphanedRunFailed: orphanedRuns.failedCount,
    orphanedRunPartial: orphanedRuns.partialCount,
  }, "Orphaned sync run startup cleanup complete");

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

  return {
    async shutdown() {
      abortController.abort();
      await executorPromise.catch((error) => {
        app.logger.error({ err: error }, "Sync page executor failed during shutdown");
      });
      await boss.stop();
      await app.close();
    },
  };
}

export async function main() {
  const processStartedAt = new Date();
  const app = await createAppContext();
  const boss = new PgBoss({
    connectionString: app.config.databaseUrl,
  });
  const runtime = await startWorkerServices(app, boss, { processStartedAt });

  const shutdown = async () => {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);

    await runtime.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMainModule = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
