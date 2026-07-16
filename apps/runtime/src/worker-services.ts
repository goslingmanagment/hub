import {
  closeOrphanedSyncRuns,
  deleteExpiredPendingDeviceTokens,
  deleteExpiredRawPayloads,
  deleteExpiredSyncObservability,
  getLatestScheduledReportDateOnOrBefore,
  getTelegramSettings,
} from "@agency_hub_core/db";
import { toBusinessDate, UTC_TIME_ZONE, addUtcDays, startOfBusinessDay } from "@agency_hub_core/shared";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "./bootstrap.ts";
import { writeRuntimeHealthFile } from "./services/runtime-heartbeat.ts";
import {
  DB_DISK_USAGE_CHECK_QUEUE,
  ensureDbDiskUsageQueue,
  runDbDiskUsageCheck,
} from "./services/db-disk-alert.ts";
import {
  OBSERVATIONS_PARTITIONS_QUEUE,
  ensureObservationsPartitionQueue,
  runObservationsPartitionCheck,
} from "./services/observations-partitions.ts";
import {
  CANONICALIZE_SWEEP_QUEUE,
  ensureCanonicalizeQueues,
  runCanonicalization,
} from "./services/canonicalize-driver.ts";
import {
  MESSAGE_ARCHIVE_SWEEP_QUEUE,
  ensureMessageArchiveQueues,
  runMessageArchiveProjection,
} from "./services/projections/message-archive.ts";
import { runOfapiMessageCoverageProjection } from "./services/projections/ofapi-message-coverage.ts";
import {
  PROJECTION_DEBT_SWEEP_QUEUE,
  ensureProjectionDebtQueue,
  runProjectionDebtSweep,
} from "./services/projection-debt-sweep.ts";
import { runDmCorrectionsReconcile } from "./services/dm-corrections-reconciler.ts";
import { runOfapiDmReadthroughReconcile } from "./services/ofapi-dm-readthrough.ts";
import { runOfapiCaptureMaterialization } from "./services/ofapi-capture-materialization.ts";
import { runAiAcceptanceProjection } from "./services/projections/ai-acceptance.ts";
import { runFanEarningsProjection } from "./services/projections/fan-earnings.ts";
import { startDomainEventsSmokeConsumer } from "./services/domain-events-smoke.ts";
import {
  runWorkboardFanRecompute,
  startWorkboardEventRecompute,
  type WorkboardFanRecomputeJob,
} from "./services/workboard-event-recompute.ts";
import {
  ensureOfapiChargebacksQueue,
  startOfapiChargebacksWorker,
} from "./services/ofapi-chargebacks-sync.ts";
import {
  ensureOfapiPendingReconcileQueue,
  startOfapiPendingReconcileWorker,
} from "./services/ofapi-pending-reconcile.ts";
import {
  ensureOfapiCreditQueues,
  startOfapiCreditWorker,
} from "./services/ofapi-credits.ts";
import {
  ensureOfapiCommandQueues,
  startOfapiCommandWorker,
} from "./services/ofapi-command-executor.ts";
import {
  ensureOfapiDmAnalyticsQueues,
  startOfapiDmAnalyticsWorker,
} from "./services/ofapi-dm-analytics.ts";
import {
  ensureOfapiQueues,
  startOfapiEventWorker,
} from "./services/ofapi-events.ts";
import { sendDailyRevenueTelegramReport } from "./services/telegram-report.ts";
import { startSyncPageExecutor } from "./services/sync/executor.ts";
import { runSyncPlannerCycle } from "./services/sync/planner.ts";
import {
  ensureSyncQueues,
  ensureWorkboardQueues,
  RAW_PAYLOAD_CLEANUP_QUEUE,
  SYNC_PLANNER_QUEUE,
  TELEGRAM_DAILY_REPORT_QUEUE,
  WORKBOARD_CLASSIFY_QUEUE,
  WORKBOARD_RECOMPUTE_QUEUE,
  WORKBOARD_FAN_RECOMPUTE_QUEUE,
} from "./services/sync-queue.ts";
import { ensureOpsMetricsQueue, startGoldenSignalWorker } from "./services/golden-signals.ts";
import { ensureTieringQueue, startTieringWorker } from "./services/tiering/index.ts";
import { recomputeAllWorkboardPages } from "./modules/workboard/index.ts";
import { runClosingClassificationAllPages } from "./modules/workboard/index.ts";

const WORKER_RESTART_ERROR_SUMMARY = "Worker restarted";
const WORKER_HEALTH_WRITE_INTERVAL_MS = 30_000;

type WorkerBoss = Pick<
  PgBoss,
  "complete" | "createQueue" | "fail" | "fetch" | "getQueue" | "schedule" | "send" | "start" | "stop" | "touch" | "updateQueue" | "work"
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
  await ensureOfapiCreditQueues(boss, createdQueues);
  await ensureOfapiChargebacksQueue(boss, createdQueues);
  await ensureOfapiPendingReconcileQueue(boss, createdQueues);
  await ensureOfapiCommandQueues(boss, createdQueues);
  await ensureOfapiDmAnalyticsQueues(boss, createdQueues);
  await ensureDbDiskUsageQueue(boss, createdQueues);
  await ensureObservationsPartitionQueue(boss, createdQueues);
  await ensureCanonicalizeQueues(boss, createdQueues);
  await ensureMessageArchiveQueues(boss, createdQueues);
  await ensureProjectionDebtQueue(boss, createdQueues);
  await ensureOpsMetricsQueue(boss, createdQueues);
  // Stage 25: cron registration moved to the scheduler role (leader-elected;
  // services/schedules.ts) — workers only create queues and consume.

  await boss.work(SYNC_PLANNER_QUEUE, {
    batchSize: 1,
    includeMetadata: true,
  }, async () => {
    await runSyncPlannerCycle(app, boss);
  });

  await boss.work(RAW_PAYLOAD_CLEANUP_QUEUE, { batchSize: 1 }, async () => {
    const now = new Date();
    await deleteExpiredRawPayloads(app.db, now);
    // Pending device credentials are deliberately short-lived custody, not an
    // audit fact. Reuse the already-scheduled nightly retention job so crashed
    // Desktop reservations cannot accumulate forever.
    await deleteExpiredPendingDeviceTokens(app.db, now);
    await deleteExpiredSyncObservability(
      app.db,
      new Date(now.getTime() - app.config.syncObservabilityRetentionDays * 24 * 60 * 60 * 1000),
    );
  });

  await boss.work(WORKBOARD_RECOMPUTE_QUEUE, { batchSize: 1 }, async () => {
    // Stage 23: the nightly sweep is the RECONCILER — `changed` is the drift
    // counter and should be zero while the event-driven path keeps up.
    const result = await recomputeAllWorkboardPages(app.db, { now: new Date() });
    if (result.changed > 0) {
      app.logger.warn({ ...result, workboard_reconcile_drift: result.changed },
        "Workboard reconciler found drift — event-driven recompute missed changes");
    } else {
      app.logger.info({ ...result, workboard_reconcile_drift: 0 }, "Workboard reconciler clean");
    }
  });

  await boss.work(WORKBOARD_FAN_RECOMPUTE_QUEUE, { batchSize: 5 }, async (jobs) => {
    for (const job of jobs) {
      const result = await runWorkboardFanRecompute(app, job.data as WorkboardFanRecomputeJob);
      if ("changed" in result && result.changed) {
        app.logger.info({ ...job.data as object, ...result }, "Workboard fan recomputed (event-driven)");
      }
    }
  });

  await boss.work(DB_DISK_USAGE_CHECK_QUEUE, { batchSize: 1 }, async () => {
    const result = await runDbDiskUsageCheck(app);
    if (result) {
      app.logger.info(result, "Disk usage check complete");
    }
  });

  await boss.work(OBSERVATIONS_PARTITIONS_QUEUE, { batchSize: 1 }, async () => {
    const result = await runObservationsPartitionCheck(app);
    app.logger.info(result, "Observations partition check complete");
  });

  await boss.work(CANONICALIZE_SWEEP_QUEUE, { batchSize: 1 }, async () => {
    // W5.3 (B3): the minutely sweep is the ONLY caller that resumes from the
    // per-family cursor; CLI/replay runs stay cursor-free.
    const result = await runCanonicalization(app, { useSweepCursor: true });
    if (result.scanned > 0) {
      app.logger.info(result, "Canonicalization sweep complete");
    }
    // PR4: the readthrough reconcile projector rides the same minutely
    // handler (it is NOT a canonicalizer family — see ofapi-dm-readthrough).
    const readthrough = await runOfapiDmReadthroughReconcile(app);
    if (readthrough.scanned > 0) {
      app.logger.info(readthrough, "Readthrough reconcile sweep complete");
    }
    const captureMaterialization = await runOfapiCaptureMaterialization(app);
    if (captureMaterialization.scanned > 0) {
      app.logger.info(captureMaterialization, "OFAPI capture materialization sweep complete");
    }
    // Wave 2: the corrections reconciler drains material!=emitted into the
    // ledger AFTER the projectors above have merged this minute's material.
    const corrections = await runDmCorrectionsReconcile(app);
    if (corrections.scanned > 0) {
      app.logger.info(corrections, "DM corrections reconcile sweep complete");
    }
  });

  await boss.work(MESSAGE_ARCHIVE_SWEEP_QUEUE, { batchSize: 1 }, async () => {
    const result = await runMessageArchiveProjection(app);
    if (result.eventsSeen > 0) {
      app.logger.info(result, "Message-archive projection sweep complete");
    }
    const coverage = await runOfapiMessageCoverageProjection(app);
    if (coverage.projected > 0) {
      app.logger.info(coverage, "OFAPI message-coverage projection sweep complete");
    }
    const earnings = await runFanEarningsProjection(app);
    if (earnings.upserted > 0) {
      app.logger.info(earnings, "Fan-earnings projection sweep complete");
    }
    const acceptance = await runAiAcceptanceProjection(app);
    if (acceptance.projected > 0) {
      app.logger.info(acceptance, "AI acceptance projection sweep complete");
    }
  });

  await boss.work(PROJECTION_DEBT_SWEEP_QUEUE, { batchSize: 1 }, async () => {
    // #135 A2b: re-run wedged rebuildable-projection recomputes (thread
    // summaries) recorded by the dm_messages executor; quiet when idle.
    const result = await runProjectionDebtSweep(app);
    if (result.scanned > 0) {
      app.logger.info(result, "Projection debt sweep complete");
    }
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

  // Stage 21: the v2 conformance instrument — permanent, read-only (one
  // checkpoint row), unconditional like the sweeps.
  const domainEventsSmoke = startDomainEventsSmokeConsumer(app);
  // Stage 23: domain events → debounced per-fan board recompute.
  const workboardEventRecompute = startWorkboardEventRecompute(app, boss);
  await startGoldenSignalWorker(app, boss);
  await ensureTieringQueue(boss);
  await startTieringWorker(app, boss);

  const releaseOfapiEventWorkerLock = await startOfapiEventWorker(app, boss);
  await startOfapiCreditWorker(app, boss);
  await startOfapiChargebacksWorker(app, boss);
  await startOfapiPendingReconcileWorker(app, boss);
  await startOfapiCommandWorker(app, boss);
  await startOfapiDmAnalyticsWorker(app, boss);

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
    await writeRuntimeHealthFile(healthFilePath, "ready");
  }
  const healthTimer = healthFilePath
    ? setInterval(() => {
      void writeRuntimeHealthFile(healthFilePath, "ready").catch((error) => {
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
        await writeRuntimeHealthFile(healthFilePath, "stopping").catch((error) => {
          app.logger.warn({ err: error, healthFilePath }, "Failed to mark worker health file stopping");
        });
      }
      abortController.abort();
      await domainEventsSmoke.stop().catch((error) => {
        app.logger.warn({ err: error }, "v2 smoke consumer failed during shutdown");
      });
      await workboardEventRecompute.stop().catch((error) => {
        app.logger.warn({ err: error }, "workboard event recompute failed during shutdown");
      });
      await executorPromise.catch((error) => {
        app.logger.error({ err: error }, "Sync page executor failed during shutdown");
      });
      if (releaseOfapiEventWorkerLock) {
        await releaseOfapiEventWorkerLock().catch((error) => {
          app.logger.error({ err: error }, "Failed to release OFAPI event worker lock");
        });
      }
      await boss.stop();
      await app.close();
    },
  };
}
