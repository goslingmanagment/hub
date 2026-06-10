import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  closeOrphanedSyncRuns,
  deleteExpiredRawPayloads,
  deleteExpiredSyncObservability,
  getLatestScheduledReportDateOnOrBefore,
  getTelegramSettings,
} from "@agency_hub_core/db";
import { toBusinessDate, UTC_TIME_ZONE, addUtcDays, startOfBusinessDay } from "@agency_hub_core/shared";
import { PgBoss } from "pg-boss";

import type { AppContext } from "./bootstrap.ts";
import {
  ensureOfapiQueues,
  ensureOfapiSchedules,
  startOfapiEventWorker,
} from "./services/ofapi-events.ts";
import { sendDailyRevenueTelegramReport } from "./services/telegram-report.ts";
import { startSyncPageExecutor } from "./services/sync/executor.ts";
import { runSyncPlannerCycle } from "./services/sync/planner.ts";
import {
  ensureTelegramDailyReportSchedule,
  ensurePlannerSchedule,
  ensureSyncQueues,
  ensureWorkboardQueues,
  ensureWorkboardRecomputeSchedule,
  RAW_PAYLOAD_CLEANUP_QUEUE,
  SYNC_PLANNER_QUEUE,
  TELEGRAM_DAILY_REPORT_QUEUE,
  WORKBOARD_CLASSIFY_QUEUE,
  WORKBOARD_RECOMPUTE_QUEUE,
} from "./services/sync-queue.ts";
import { recomputeAllWorkboardPages } from "./services/workboard-v2/recompute.ts";
import { runClosingClassificationAllPages } from "./services/workboard-v2/classify-closing.ts";

const WORKER_RESTART_ERROR_SUMMARY = "Worker restarted";
const WORKER_HEALTH_WRITE_INTERVAL_MS = 30_000;

type WorkerBoss = Pick<
  PgBoss,
  "complete" | "createQueue" | "fail" | "fetch" | "schedule" | "send" | "start" | "stop" | "touch" | "work"
>;

function resolveDueTelegramReportDate(
  now: Date,
  reportHourUtc: number,
) {
  const todayStart = startOfBusinessDay(now, UTC_TIME_ZONE);
  const dueStart = addUtcDays(
    todayStart,
    now.getUTCHours() >= reportHourUtc ? -1 : -2,
  );

  return toBusinessDate(dueStart, UTC_TIME_ZONE);
}

function buildTelegramReportRunTime(reportDate: string) {
  return addUtcDays(new Date(`${reportDate}T00:00:00.000Z`), 1);
}

function listPendingTelegramReportDates(
  latestSentReportDate: string | null,
  dueReportDate: string,
) {
  if (!latestSentReportDate) {
    return [dueReportDate];
  }

  const dates: string[] = [];
  let cursor = addUtcDays(new Date(`${latestSentReportDate}T00:00:00.000Z`), 1);
  while (toBusinessDate(cursor, UTC_TIME_ZONE) <= dueReportDate) {
    dates.push(toBusinessDate(cursor, UTC_TIME_ZONE));
    cursor = addUtcDays(cursor, 1);
  }

  return dates;
}

async function writeWorkerHealthFile(path: string, status: "starting" | "ready" | "stopping") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({
    status,
    timestamp: new Date().toISOString(),
    pid: process.pid,
  })}\n`, "utf8");
}

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
  const healthFilePath = process.env.WORKER_HEALTH_FILE ?? null;

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
  await ensureWorkboardQueues(boss, createdQueues);
  await ensureOfapiQueues(boss, createdQueues);
  await Promise.all([
    ensurePlannerSchedule(boss),
    boss.schedule(RAW_PAYLOAD_CLEANUP_QUEUE, "0 2 * * *"),
    ensureTelegramDailyReportSchedule(boss),
    ensureWorkboardRecomputeSchedule(boss),
    ensureOfapiSchedules(boss),
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

  await boss.work(WORKBOARD_RECOMPUTE_QUEUE, { batchSize: 1 }, async () => {
    const result = await recomputeAllWorkboardPages(app.db, { now: new Date() });
    app.logger.info(result, "Workboard v2 recompute complete");
  });

  await boss.work(WORKBOARD_CLASSIFY_QUEUE, { batchSize: 1 }, async () => {
    if (!app.config.anthropicApiKey) {
      app.logger.info("Workboard v2 closing classifier disabled (no ANTHROPIC_API_KEY)");
      return;
    }
    // Per-page settings (enabled / cap / model) are resolved inside, over env defaults.
    const result = await runClosingClassificationAllPages(app.db, { config: app.config, now: new Date() });
    app.logger.info(result, "Workboard v2 closing classification complete");
  });

  await startOfapiEventWorker(app, boss);

  await boss.work(TELEGRAM_DAILY_REPORT_QUEUE, { batchSize: 1 }, async () => {
    const now = new Date();

    const settings = await getTelegramSettings(app.db, {
      defaultReportHourUtc: app.config.telegramReportHourUtc,
    });
    if (!settings.enabled || !settings.dailyReportEnabled) {
      return;
    }

    const dueReportDate = resolveDueTelegramReportDate(now, settings.reportHourUtc);
    const latestSentReportDate = await getLatestScheduledReportDateOnOrBefore(
      app.db,
      dueReportDate,
    );

    for (const reportDate of listPendingTelegramReportDates(latestSentReportDate, dueReportDate)) {
      const result = await sendDailyRevenueTelegramReport(
        app,
        buildTelegramReportRunTime(reportDate),
      );
      if (result.delivery.status === "failed") {
        throw new Error(`Telegram daily report delivery failed: ${result.delivery.error}`);
      }
    }
  });

  await runSyncPlannerCycle(app, boss);
  const executorPromise = startSyncPageExecutor(app, boss, {
    signal: abortController.signal,
  });
  if (healthFilePath) {
    await writeWorkerHealthFile(healthFilePath, "ready");
  }
  const healthTimer = healthFilePath
    ? setInterval(() => {
      void writeWorkerHealthFile(healthFilePath, "ready").catch((error) => {
        app.logger.warn({ err: error, healthFilePath }, "Failed to update worker health file");
      });
    }, WORKER_HEALTH_WRITE_INTERVAL_MS)
    : null;

  app.logger.info("Worker started");

  return {
    async shutdown() {
      if (healthTimer) {
        clearInterval(healthTimer);
      }
      if (healthFilePath) {
        await writeWorkerHealthFile(healthFilePath, "stopping").catch((error) => {
          app.logger.warn({ err: error, healthFilePath }, "Failed to mark worker health file stopping");
        });
      }
      abortController.abort();
      await executorPromise.catch((error) => {
        app.logger.error({ err: error }, "Sync page executor failed during shutdown");
      });
      await boss.stop();
      await app.close();
    },
  };
}
