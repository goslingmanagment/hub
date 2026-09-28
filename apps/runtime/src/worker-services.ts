import { startFanslyWsWorker } from "./services/fansly-ws/worker.ts";
import { ensureOfapiMediaQueue, OFAPI_MEDIA_SWEEP_QUEUE, runOfapiMediaUploadSweep } from "./services/ofapi-media-worker.ts";
import { ensureOfapiBindingReconcileQueue, OFAPI_BINDING_RECONCILE_QUEUE, runOfapiBindingReconcile } from "./services/ofapi-binding-reconcile.ts";
import { ensureOfapiCollectionQueues, startOfapiCollectionWorker } from "./services/ofapi-collection-runner.ts";
import { ofapiCollectionHandlers } from "./services/ofapi-collection-handlers.ts";
import { ensureOfapiTypedExportQueue, OFAPI_TYPED_EXPORT_SWEEP_QUEUE, runOfapiTypedExportSweep } from "./services/ofapi-typed-export-worker.ts";
import {
  closeOrphanedSyncRuns,
  deleteExpiredPendingDeviceTokens,
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
  CAPTURE_PAYLOAD_PARITY_QUEUE,
  ensureCapturePayloadParityQueue,
  runCapturePayloadParityCheck,
} from "./services/capture-payload-parity.ts";
import {
  CANONICALIZE_SWEEP_BUDGET_MS,
  CANONICALIZE_SWEEP_QUEUE,
  DM_RECONCILE_SWEEP_QUEUE,
  ensureCanonicalizeQueues,
  runCanonicalization,
} from "./services/canonicalize-driver.ts";
import {
  MESSAGE_ARCHIVE_SWEEP_QUEUE,
  ensureMessageArchiveQueues,
} from "./services/projections/message-archive.ts";
import {
  PROJECTION_DEBT_SWEEP_QUEUE,
  ensureProjectionDebtQueue,
  runProjectionDebtSweep,
} from "./services/projection-debt-sweep.ts";
import {
  VOICE_NOTES_SWEEP_QUEUE,
  ensureVoiceNotesSweepQueue,
  runVoiceNotesNightlyRetention,
  runVoiceNotesSweep,
} from "./services/voice-notes-sweep.ts";
import {
  AI_MEDIA_DESCRIBE_SWEEP_QUEUE,
  ensureAiMediaDescribeSweepQueue,
  runAiMediaDescribeSweepJob,
} from "./services/ai-media-describe/sweep.ts";
import { createFanslyFastLane } from "./services/ai-media-describe/fansly-fast-lane.ts";
import { startAiMediaDescribeLoop } from "./services/ai-media-describe/loop.ts";
import { runDmCorrectionsReconcile } from "./services/dm-corrections-reconciler.ts";
import { runOfapiDmReadthroughReconcile } from "./services/ofapi-dm-readthrough.ts";
import { runOfapiCaptureMaterialization } from "./services/ofapi-capture-materialization.ts";
import { runAiAcceptanceProjection } from "./services/projections/ai-acceptance.ts";
import {
  PROJECTION_TICK_BUDGET_MS,
  runProjectionTick,
} from "./services/projections/registry.ts";
import { startDomainEventsSmokeConsumer } from "./services/domain-events-smoke.ts";
import {
  ensureOfapiChargebacksQueue,
  startOfapiChargebacksWorker,
} from "./services/ofapi-chargebacks-sync.ts";
import {
  ensureOfapiLinkStatsQueue,
  startOfapiLinkStatsWorker,
} from "./services/ofapi-link-stats-sync.ts";
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
import {
  AGENT_HYDRATION_QUEUE,
  ensureAgentHydrationQueue,
  runAgentHydrationCycle,
  settleAgentHydrationFromBackfill,
} from "./services/agent-hydration.ts";
import { startSyncPageExecutor } from "./services/sync/executor.ts";
import {
  ensureTargetedThreadBackfillQueue,
  parseTargetedThreadBackfillJob,
  runTargetedThreadBackfill,
  TARGETED_THREAD_BACKFILL_QUEUE,
} from "./services/sync/targeted-thread-backfill.ts";
import { runSyncPlannerCycle } from "./services/sync/planner.ts";
import {
  ensureSyncQueues,
  reconcileQueueRetention,
  RAW_PAYLOAD_CLEANUP_QUEUE,
  SYNC_PLANNER_QUEUE,
  TELEGRAM_DAILY_REPORT_QUEUE,
} from "./services/sync-queue.ts";
import { ensureOpsMetricsQueue, startGoldenSignalWorker } from "./services/golden-signals.ts";
import {
  ensureNotificationDeliveryOutboxQueue,
  startNotificationDeliveryOutboxWorker,
} from "./services/notification-delivery-outbox.ts";
import {
  ensureNotificationPagingSweepQueue,
  startNotificationPagingSweepWorker,
} from "./services/notification-paging-sweep.ts";
import { sendScheduledAlertDigest } from "./services/notification-digest.ts";
import { ensureTieringQueue, startTieringWorker } from "./services/tiering/index.ts";

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

/**
 * [D1]'s trigger threshold (F1(0).4). One minute of wall clock on a queue whose
 * schedule is `* * * * *` means the tick no longer fits in its own slot — the
 * condition the deferred typed ledger read exists to fix. Deliberately a LOG
 * line and not a latch: the deferral needs a signal, not a circuit breaker.
 */
const PROJECTION_TICK_DURATION_ALERT_MS = 45_000;

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

  const startupDiskHealth = await runDbDiskUsageCheck(app);
  if (startupDiskHealth) {
    app.logger.info(startupDiskHealth, "Startup disk usage check complete");
  }

  await boss.start();
  await ensureSyncQueues(boss, createdQueues);
  await ensureOfapiQueues(boss, createdQueues);
  await ensureOfapiCreditQueues(boss, createdQueues);
  await ensureOfapiChargebacksQueue(boss, createdQueues);
  await ensureOfapiLinkStatsQueue(boss, createdQueues);
  await ensureOfapiPendingReconcileQueue(boss, createdQueues);
  await ensureOfapiCommandQueues(boss, createdQueues);
  await ensureOfapiDmAnalyticsQueues(boss, createdQueues);
  await ensureOfapiTypedExportQueue(boss, createdQueues);
  await ensureOfapiMediaQueue(boss, createdQueues);
  await ensureOfapiBindingReconcileQueue(boss, createdQueues);
  await ensureOfapiCollectionQueues(boss, createdQueues);
  await ensureDbDiskUsageQueue(boss, createdQueues);
  await ensureObservationsPartitionQueue(boss, createdQueues);
  await ensureCapturePayloadParityQueue(boss, createdQueues);
  await ensureCanonicalizeQueues(boss, createdQueues);
  await ensureMessageArchiveQueues(boss, createdQueues);
  await ensureProjectionDebtQueue(boss, createdQueues);
  await ensureVoiceNotesSweepQueue(boss, createdQueues);
  await ensureAiMediaDescribeSweepQueue(boss, createdQueues);
  await ensureOpsMetricsQueue(boss, createdQueues);
  await ensureNotificationDeliveryOutboxQueue(boss, createdQueues);
  await ensureNotificationPagingSweepQueue(boss, createdQueues);
  await ensureTargetedThreadBackfillQueue(boss, createdQueues);
  await ensureAgentHydrationQueue(boss, createdQueues);
  // Hoisted out of the worker-startup section below (it used to sit next to
  // startTieringWorker): every queue this role creates must exist before the
  // retention reconcile, and creation is idempotent wherever it runs.
  await ensureTieringQueue(boss, createdQueues);
  // S7: LAST, after every queue above exists — updateQueue on a queue that has
  // not been created yet matches zero rows.
  await reconcileQueueRetention(boss);
  // Stage 25: cron registration moved to the scheduler role (leader-elected;
  // services/schedules.ts) — workers only create queues and consume.

  await boss.work(OFAPI_MEDIA_SWEEP_QUEUE, { batchSize: 1 }, async () => { await runOfapiMediaUploadSweep(app); });
  await boss.work(OFAPI_TYPED_EXPORT_SWEEP_QUEUE, { batchSize: 1 }, async () => { await runOfapiTypedExportSweep(app); });
  await boss.work(OFAPI_BINDING_RECONCILE_QUEUE, { batchSize: 1 }, async () => {
    // Decision 382: custody continuity by creator identity. A silent run
    // (nothing seeded, rebound, attached or waiting) logs nothing.
    const result = await runOfapiBindingReconcile(app);
    if (result.skipped !== null) {
      if (result.skipped !== "disabled") app.logger.warn({ skipped: result.skipped }, "OFAPI binding reconcile skipped");
      return;
    }
    if (result.actions.length + result.waiting.length + result.identityMismatches.length + result.duplicates.length > 0) {
      app.logger.info(result, "OFAPI binding reconcile complete");
    }
  });

  await boss.work(SYNC_PLANNER_QUEUE, {
    batchSize: 1,
    includeMetadata: true,
  }, async () => {
    await runSyncPlannerCycle(app, boss);
  });

  // Slice C′: owner-initiated targeted thread backfill. One job = one bounded
  // run of ONE thread under the page's real dm_messages sync lease; the queue
  // policy keeps at most one job per thread queued or active.
  await boss.work(TARGETED_THREAD_BACKFILL_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const payload = parseTargetedThreadBackfillJob(job.data);
      if (!payload) {
        app.logger.error({ jobId: job.id, data: job.data },
          "Targeted thread backfill job carried no usable threadId");
        continue;
      }
      const result = await runTargetedThreadBackfill(app, payload);
      // Slice C: a run that answered a hydration request settles it here, with
      // the outcome in hand. A crash before this leaves the request
      // `dispatching` until the stuck sweeper closes it — the correct order of
      // failure: an unsettled request is visible, a wrongly-settled one is not.
      if (payload.hydrationRequestRef !== undefined) {
        await settleAgentHydrationFromBackfill(app, payload.hydrationRequestRef, result);
      }
      app.logger.info({ jobId: job.id, ...result }, "Targeted thread backfill job complete");
    }
  });

  // Slice C: the hydration executor. It expires, sweeps, reconciles and — only
  // when `agentHydrationMode` is `dispatch` — hands approvals to the backfill
  // queue or to an ofapi capture job. It never calls a vendor itself.
  await boss.work(AGENT_HYDRATION_QUEUE, { batchSize: 1 }, async () => {
    const cycle = await runAgentHydrationCycle(app, boss);
    const autoActed = cycle.autoApprove !== null
      && (cycle.autoApprove.considered > 0 || cycle.autoApprove.approved > 0);
    if (
      cycle.dispatched > 0 || cycle.swept > 0 || cycle.expired > 0 || cycle.reconciled > 0
      || autoActed || cycle.autoHeld > 0
    ) {
      app.logger.info(cycle, "Agent hydration cycle complete");
    }
  });

  await boss.work(RAW_PAYLOAD_CLEANUP_QUEUE, { batchSize: 1 }, async () => {
    // THIS HANDLER IS TIMED, SUBSTEP BY SUBSTEP, because it failed four
    // consecutive nights (2026-08-22..25) with `handler execution exceeded
    // 900s` and nothing in the log said WHICH of its five acts was the cost.
    // The pg-boss expiry (900 s, the queue's default) is unchanged: the sweep
    // now bounds ITSELF (SYNC_OBSERVABILITY_PRUNE_BUDGET_MS) so the cap is a
    // backstop rather than the thing that decides the outcome.
    const now = new Date();
    const timings: Record<string, number> = {};
    const timed = async <T>(step: string, body: () => Promise<T>): Promise<T> => {
      const startedAt = Date.now();
      try {
        return await body();
      } finally {
        timings[`${step}Ms`] = Date.now() - startedAt;
      }
    };

    // Raw payloads are captured facts and are never deleted on a schedule: this
    // job keeps its historical queue name but no longer touches
    // sync_raw_payloads. Only the owner-initiated erasure removes them.

    // Pending device credentials are deliberately short-lived custody, not an
    // audit fact. Reuse the already-scheduled nightly retention job so crashed
    // Desktop reservations cannot accumulate forever.
    await timed("pendingDeviceTokens", () => deleteExpiredPendingDeviceTokens(app.db, now));
    const observability = await timed("syncObservability", () => deleteExpiredSyncObservability(
      app.db,
      new Date(now.getTime() - app.config.syncObservabilityRetentionDays * 24 * 60 * 60 * 1000),
    ));
    // Voice-notes retention rides the nightly cleanup: purge audio bytes older
    // than 7 days and release the reservations of long-stale indeterminate rows.
    const voiceRetention = await timed("voiceNotes", () => runVoiceNotesNightlyRetention(app, now));

    const summary = {
      ...timings,
      totalMs: Object.values(timings).reduce((sum, value) => sum + value, 0),
      syncObservability: {
        cutoff: observability.cutoff.toISOString(),
        deletedAttempts: observability.deletedAttempts,
        deletedEvents: observability.deletedEvents,
        deletedRuns: observability.deletedRuns,
        budgetExhausted: observability.budgetExhausted,
        steps: observability.steps,
      },
      voiceRetention,
    };
    if (observability.budgetExhausted) {
      // Not a failure — the sweep is resumable and tomorrow finds less to do.
      // It IS the one outcome worth a warning, because a budget exhausted every
      // night means the backlog is growing faster than the window removes it.
      app.logger.warn(summary, "Nightly retention sweep hit its wall-clock budget");
    } else {
      app.logger.info(summary, "Nightly retention sweep complete");
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

  // G5 slice 1: the CAS dual-write parity proof. Logs its own telemetry line
  // (and skips entirely when the canary is off), so nothing is logged here.
  await boss.work(CAPTURE_PAYLOAD_PARITY_QUEUE, { batchSize: 1 }, async () => {
    await runCapturePayloadParityCheck(app);
  });

  await boss.work(CANONICALIZE_SWEEP_QUEUE, { batchSize: 1 }, async () => {
    const startedAt = Date.now();
    // W5.3 (B3): the minutely sweep is the ONLY caller that resumes from the
    // per-family cursor; CLI/replay runs stay cursor-free.
    const result = await runCanonicalization(app, {
      useSweepCursor: true,
      // Defect 2026-08-22: a full pass over every family stopped fitting in
      // pg-boss's 900s handler expiration, so the job was killed, restarted
      // immediately and killed again — and the families at the end of the
      // registry sat at parse_version 0 for a quarter of an hour. The budget
      // ends a long run BETWEEN pages, well short of the expiration, and the
      // driver's rotation hands the families this tick skipped the head of
      // the next one.
      maxDurationMs: CANONICALIZE_SWEEP_BUDGET_MS,
    });
    const durationMs = Date.now() - startedAt;
    if (result.scanned > 0) {
      app.logger.info({ ...result, durationMs }, "Canonicalization sweep complete");
    }
    if (result.truncatedByBudget) {
      // The tick-duration signal for THIS queue (the sibling of the projection
      // tick's [D1] alert below): a run that keeps hitting its budget is a
      // minute that no longer holds the corpus, and the named families are the
      // ones paying for it. Warn, never a latch — nothing here is broken, and
      // the next tick starts with the skipped families.
      app.logger.warn(
        {
          durationMs,
          budgetMs: CANONICALIZE_SWEEP_BUDGET_MS,
          skippedFamilies: result.skippedFamilies,
          scanned: result.scanned,
          stamped: result.stamped,
        },
        "Canonicalization sweep hit its wall-clock budget; families skipped this tick "
          + "take the head of the next run",
      );
    }
  });

  // Defect 2026-08-22: these three used to run at the END of the canonicalize
  // sweep's handler, which meant a sweep killed at the queue's expiration
  // never reached them at all. Same minutely cadence, its own job — the ONLY
  // thing they ever shared with the sweep was the tick.
  await boss.work(DM_RECONCILE_SWEEP_QUEUE, { batchSize: 1 }, async () => {
    // PR4: the readthrough reconcile projector (it is NOT a canonicalizer
    // family — see ofapi-dm-readthrough).
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
    // WP-F1(0): table-driven. The registry is the list of projections, their
    // event types, their tables and their state class — six hand-written
    // try/catch blocks used to be that list, and a projector registered in
    // neither this file nor the CLI is a table that silently stops filling.
    // Each entry stays isolated in its own try/catch inside runProjectionTick:
    // every projection owns its watermark, so a poison fact in one must stay
    // retryable without starving the neighbours sharing this pg-boss tick. A
    // failed run is retried account by account, so one page's poison fact
    // does not park the other pages of the same projection either.
    const startedAt = Date.now();
    const tick = await runProjectionTick(app, {
      // Defect 2026-08-22: isolation is not fairness. A full pass over the
      // registry stopped fitting in pg-boss's 900s handler expiration once
      // WP-F6's v6 drain and the F1..F7 families landed, so the job was killed
      // mid-pass, restarted at the head and killed again — and the projections
      // at the END of the registry never ran: `page_payout_requests` stayed
      // empty with 91 payout.observed events already in the ledger. The budget
      // ends a long tick BETWEEN projections, well short of the expiration, and
      // the registry's rotation hands the projections this tick skipped the
      // head of the next one.
      maxDurationMs: PROJECTION_TICK_BUDGET_MS,
    });
    const outcomes = tick.outcomes;

    // [D1]'s NAMED TRIGGER (F1(0).4). The typed ledger read was deferred on the
    // argument that each projector reads only its delta since its own
    // watermark; this line is what turns that from an assumption into something
    // that reports itself. A tick that spends longer than the threshold on the
    // shared queue reopens the deferral as its own change.
    const tickMs = outcomes.reduce((sum, outcome) => sum + outcome.durationMs, 0);
    if (tickMs >= PROJECTION_TICK_DURATION_ALERT_MS) {
      app.logger.warn(
        {
          tickMs,
          thresholdMs: PROJECTION_TICK_DURATION_ALERT_MS,
          slowest: [...outcomes]
            .sort((left, right) => right.durationMs - left.durationMs)
            .slice(0, 3)
            .map((outcome) => ({ projection: outcome.name, durationMs: outcome.durationMs })),
        },
        "Projection tick exceeded its duration budget — [D1] typed ledger read trigger",
      );
    }

    if (tick.truncatedByBudget) {
      // The starvation signal, and the sibling of the canonicalize sweep's
      // budget warn. A tick that keeps truncating is a minute that no longer
      // holds the registry, and the named projections are the ones paying for
      // it. Warn, never a latch — nothing here is broken, every projection that
      // ran advanced its watermark, and the next tick starts with the skipped
      // ones. It does NOT replace the [D1] alert above: that one still fires on
      // the time actually spent, just less often now that the tick has a lid.
      app.logger.warn(
        {
          durationMs: Date.now() - startedAt,
          budgetMs: PROJECTION_TICK_BUDGET_MS,
          skippedProjections: tick.skippedProjections,
          ran: outcomes.map((outcome) => outcome.name),
        },
        "Projection tick hit its wall-clock budget; projections skipped this tick take the "
          + "head of the next one",
      );
    }

    try {
      // Observation-driven, not ledger-driven: it walks `observations` by id, so
      // it has no eventTypes to declare and is deliberately NOT in the registry.
      const acceptance = await runAiAcceptanceProjection(app);
      if (acceptance.projected > 0) {
        app.logger.info(acceptance, "AI acceptance projection sweep complete");
      }
    } catch (error) {
      app.logger.error({ error }, "AI acceptance projection sweep failed");
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

  await boss.work(VOICE_NOTES_SWEEP_QUEUE, { batchSize: 1 }, async () => {
    // Minutely: reclaim abandoned queued + lease-expired dispatched voice-note
    // renders to indeterminate, refunding certainly-unbilled reservations.
    const result = await runVoiceNotesSweep(app);
    if (result.abandonedQueued > 0 || result.leaseExpired > 0 || result.budgetsReleased > 0) {
      app.logger.info(result, "Voice notes sweep complete");
    }
  });

  await boss.work(AI_MEDIA_DESCRIBE_SWEEP_QUEUE, { batchSize: 1 }, async () => {
    // Minutely AI media describer (docs/runbooks/ai-media-describe.md). Ids,
    // statuses and counts only — never a URL or a description in the log.
    const result = await runAiMediaDescribeSweepJob(app);
    if (result.claimed > 0) {
      app.logger.info(result, "AI media describe sweep complete");
    }
  });

  // Stage 21: the v2 conformance instrument — permanent, read-only (one
  // checkpoint row), unconditional like the sweeps.
  // Describe within seconds (AI_MEDIA_DESCRIBE_LOOP_ENABLED); shares the
  // minutely job's slot, so still one image at a time from this process.
  const aiMediaDescribeLoop = startAiMediaDescribeLoop(app);

  // AI media fast lane (AI_MEDIA_DESCRIBE_FANSLY_FAST_LANE_MODE, off): told
  // about each committed B0 frame; reads a fan's fresh media conversation.
  const fanslyFastLane = createFanslyFastLane(app);
  const fanslyWs = startFanslyWsWorker(app, { onCaptured: fanslyFastLane.onCaptured });
  const domainEventsSmoke = startDomainEventsSmokeConsumer(app);
  await startGoldenSignalWorker(app, boss);
  await startNotificationDeliveryOutboxWorker(app, boss);
  await startNotificationPagingSweepWorker(app, boss);
  await startTieringWorker(app, boss);

  const releaseOfapiEventWorkerLock = await startOfapiEventWorker(app, boss);
  await startOfapiCreditWorker(app, boss);
  await startOfapiChargebacksWorker(app, boss);
  await startOfapiLinkStatsWorker(app, boss);
  await startOfapiPendingReconcileWorker(app, boss);
  await startOfapiCommandWorker(app, boss);
  await startOfapiDmAnalyticsWorker(app, boss);
  await startOfapiCollectionWorker(app, boss, ofapiCollectionHandlers);

  await boss.work(TELEGRAM_DAILY_REPORT_QUEUE, { batchSize: 1 }, async () => {
    const now = new Date();

    const settings = await getTelegramSettings(app.db, {
      defaultReportHourUtc: app.config.telegramReportHourUtc,
    });
    if (!settings.enabled) {
      return;
    }
    const dueReportDate = resolveDueTelegramReportDate(now, settings.reportHourUtc);

    if (settings.dailyReportEnabled) {
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
    }

    // Decision 381: the alert digest rides at the same hour, after the money.
    // It is idempotent per due date and skips itself when there is nothing to
    // say; its failure must never cost the revenue report a retry.
    try {
      await sendScheduledAlertDigest(app, { reportDate: dueReportDate, now });
    } catch (error) {
      app.logger.warn({ err: error }, "Alert digest failed; continuing");
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
      await aiMediaDescribeLoop.stop().catch((error) => {
        app.logger.warn({ err: error }, "AI media describe loop failed during shutdown");
      });
      await fanslyWs.stop();
      await fanslyFastLane.stop().catch((error) => {
        app.logger.warn({ err: error }, "AI media fast lane failed during shutdown");
      });
      await domainEventsSmoke.stop().catch((error) => {
        app.logger.warn({ err: error }, "v2 smoke consumer failed during shutdown");
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
