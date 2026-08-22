import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  closeOrphanedSyncRuns: vi.fn(),
  deleteExpiredPendingDeviceTokens: vi.fn(),
  deleteExpiredRawPayloads: vi.fn(),
  deleteExpiredSyncObservability: vi.fn(),
  getLatestScheduledReportDateOnOrBefore: vi.fn(),
  getTelegramSettings: vi.fn(),
  // Voice-notes recovery jobs (Task 7): the nightly raw-payload cleanup handler
  // and the minutely sweep worker reach into @agency_hub_core/db for these.
  purgeExpiredVoiceNoteAudio: vi.fn(),
  releaseStaleIndeterminateVoiceBudgets: vi.fn(),
  sweepVoiceNotes: vi.fn(),
  settleVoiceCharBudget: vi.fn(),
}));

const executorMocks = vi.hoisted(() => ({
  startSyncPageExecutor: vi.fn(),
}));

const telegramReportMocks = vi.hoisted(() => ({
  sendDailyRevenueTelegramReport: vi.fn(),
}));

const queueMocks = vi.hoisted(() => ({
  ensurePlannerSchedule: vi.fn(),
  ensureSyncQueues: vi.fn(),
  reconcileQueueRetention: vi.fn(),
  ensureTelegramDailyReportSchedule: vi.fn(),
  ensureWorkboardQueues: vi.fn(),
  ensureWorkboardRecomputeSchedule: vi.fn(),
}));

const plannerMocks = vi.hoisted(() => ({
  runSyncPlannerCycle: vi.fn(),
}));

const ofapiEventMocks = vi.hoisted(() => ({
  ensureOfapiQueues: vi.fn(),
  ensureOfapiSchedules: vi.fn(),
  startOfapiEventWorker: vi.fn(),
}));

const ofapiCreditMocks = vi.hoisted(() => ({
  ensureOfapiCreditQueues: vi.fn(),
  ensureOfapiCreditSchedules: vi.fn(),
  startOfapiCreditWorker: vi.fn(),
  isOfapiCreditLedgerEnabled: vi.fn(() => false),
  createOfapiCreditSpendSink: vi.fn(() => async () => {}),
  runOfapiCreditBurnMonitor: vi.fn(),
}));

const ofapiCommandMocks = vi.hoisted(() => ({
  ensureOfapiCommandQueues: vi.fn(),
  ensureOfapiCommandSchedules: vi.fn(),
  startOfapiCommandWorker: vi.fn(),
}));

const linkStatsMocks = vi.hoisted(() => ({
  ensureOfapiLinkStatsQueue: vi.fn(),
  ensureOfapiLinkStatsSchedule: vi.fn(),
  startOfapiLinkStatsWorker: vi.fn(),
  runOfapiLinkStatsReconcile: vi.fn(),
}));

const ofapiDmAnalyticsMocks = vi.hoisted(() => ({
  ensureOfapiDmAnalyticsQueues: vi.fn(),
  ensureOfapiDmAnalyticsSchedules: vi.fn(),
  startOfapiDmAnalyticsWorker: vi.fn(),
}));

const dbDiskAlertMocks = vi.hoisted(() => ({
  DB_DISK_USAGE_CHECK_QUEUE: "db.disk-usage.check",
  ensureDbDiskUsageQueue: vi.fn(),
  ensureDbDiskUsageSchedule: vi.fn(),
  runDbDiskUsageCheck: vi.fn(),
}));

const observationsPartitionMocks = vi.hoisted(() => ({
  OBSERVATIONS_PARTITIONS_QUEUE: "observations.partitions.ensure",
  ensureObservationsPartitionQueue: vi.fn(),
  ensureObservationsPartitionSchedule: vi.fn(),
  runObservationsPartitionCheck: vi.fn(),
}));

const canonicalizeDriverMocks = vi.hoisted(() => ({
  CANONICALIZE_SWEEP_QUEUE: "canonicalize.sweep",
  ensureCanonicalizeQueues: vi.fn(),
  ensureCanonicalizeSchedule: vi.fn(),
  runCanonicalization: vi.fn(),
}));

// WP-F1(0): the projection registry imports each projector's NAME, event types
// and rebuild alongside its run function, so these mocks carry them too. That
// is the registry doing its job — a projector whose rebuild is missing is now a
// type error rather than a silent omission.
const messageArchiveMocks = vi.hoisted(() => ({
  MESSAGE_ARCHIVE_SWEEP_QUEUE: "projections.message-archive.sweep",
  MESSAGE_EVENT_TYPES: new Set(["message.received", "message.sent"]),
  ensureMessageArchiveQueues: vi.fn(),
  ensureMessageArchiveSchedule: vi.fn(),
  runMessageArchiveProjection: vi.fn(),
}));

const messageArchiveRebuildMocks = vi.hoisted(() => ({
  buildMessageArchiveShadow: vi.fn(),
}));

const coverageProjectionMocks = vi.hoisted(() => ({
  OFAPI_MESSAGE_COVERAGE_PROJECTION: "ofapi_message_coverage_v1",
  runOfapiMessageCoverageProjection: vi.fn(),
}));

const fanEarningsMocks = vi.hoisted(() => ({
  FAN_EARNINGS_PROJECTION: "fan_earnings_stats",
  runFanEarningsProjection: vi.fn(),
  rebuildFanEarningsProjection: vi.fn(),
}));

const creatorPostsMocks = vi.hoisted(() => ({
  CREATOR_POSTS_PROJECTION: "creator_posts",
  runCreatorPostsProjection: vi.fn(),
  rebuildCreatorPostsProjection: vi.fn(),
}));

const mediaPlaneMocks = vi.hoisted(() => ({
  MEDIA_PLANE_PROJECTION: "media_plane",
  runMediaPlaneProjection: vi.fn(),
  rebuildMediaPlaneProjection: vi.fn(),
}));

const fanslyStatsProjectionMocks = vi.hoisted(() => ({
  FANSLY_STATS_PROJECTION: "fansly_stats",
  runFanslyStatsProjection: vi.fn(),
  rebuildFanslyStatsProjection: vi.fn(),
}));

const aiAcceptanceMocks = vi.hoisted(() => ({
  runAiAcceptanceProjection: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => dbMocks);
vi.mock("../apps/runtime/src/bootstrap.ts", () => ({
  createAppContext: vi.fn(),
}));
vi.mock("../apps/runtime/src/services/sync/executor.ts", () => executorMocks);
vi.mock("../apps/runtime/src/services/telegram-report.ts", () => telegramReportMocks);
vi.mock("../apps/runtime/src/services/sync/planner.ts", () => ({
  runSyncPlannerCycle: plannerMocks.runSyncPlannerCycle,
}));
vi.mock("../apps/runtime/src/services/ofapi-events.ts", () => ofapiEventMocks);
vi.mock("../apps/runtime/src/services/ofapi-credits.ts", () => ofapiCreditMocks);
vi.mock("../apps/runtime/src/services/ofapi-command-executor.ts", () => ofapiCommandMocks);
vi.mock("../apps/runtime/src/services/ofapi-dm-analytics.ts", () => ofapiDmAnalyticsMocks);
vi.mock("../apps/runtime/src/services/db-disk-alert.ts", () => dbDiskAlertMocks);
vi.mock("../apps/runtime/src/services/observations-partitions.ts", () => observationsPartitionMocks);
vi.mock("../apps/runtime/src/services/canonicalize-driver.ts", () => canonicalizeDriverMocks);
vi.mock("../apps/runtime/src/services/projections/message-archive.ts", () => messageArchiveMocks);
vi.mock(
  "../apps/runtime/src/services/projections/ofapi-message-coverage.ts",
  () => coverageProjectionMocks,
);
vi.mock(
  "../apps/runtime/src/services/projections/message-archive-rebuild.ts",
  () => messageArchiveRebuildMocks,
);
vi.mock("../apps/runtime/src/services/projections/fan-earnings.ts", () => fanEarningsMocks);
vi.mock("../apps/runtime/src/services/projections/media-plane.ts", () => mediaPlaneMocks);
vi.mock(
  "../apps/runtime/src/services/projections/fansly-stats.ts",
  () => fanslyStatsProjectionMocks,
);
vi.mock("../apps/runtime/src/services/projections/creator-posts.ts", () => creatorPostsMocks);
vi.mock("../apps/runtime/src/services/projections/ai-acceptance.ts", () => aiAcceptanceMocks);
vi.mock("../apps/runtime/src/services/ofapi-chargebacks-sync.ts", () => ({
  OFAPI_CHARGEBACKS_RECONCILE_QUEUE: "ofapi.chargebacks.reconcile",
  ensureOfapiChargebacksQueue: vi.fn(),
  ensureOfapiChargebacksSchedule: vi.fn(),
  startOfapiChargebacksWorker: vi.fn(),
  runOfapiChargebacksReconcile: vi.fn(),
}));
vi.mock("../apps/runtime/src/services/ofapi-link-stats-sync.ts", () => ({
  OFAPI_LINK_STATS_RECONCILE_QUEUE: "ofapi.link-stats.reconcile",
  ensureOfapiLinkStatsQueue: linkStatsMocks.ensureOfapiLinkStatsQueue,
  ensureOfapiLinkStatsSchedule: linkStatsMocks.ensureOfapiLinkStatsSchedule,
  startOfapiLinkStatsWorker: linkStatsMocks.startOfapiLinkStatsWorker,
  runOfapiLinkStatsReconcile: linkStatsMocks.runOfapiLinkStatsReconcile,
}));
vi.mock("../apps/runtime/src/services/sync-queue.ts", () => ({
  ensureQueueCreated: vi.fn(async () => {}),
  ensureTelegramDailyReportSchedule: queueMocks.ensureTelegramDailyReportSchedule,
  ensurePlannerSchedule: queueMocks.ensurePlannerSchedule,
  ensureSyncQueues: queueMocks.ensureSyncQueues,
  reconcileQueueRetention: queueMocks.reconcileQueueRetention,
  ensureWorkboardQueues: queueMocks.ensureWorkboardQueues,
  ensureWorkboardRecomputeSchedule: queueMocks.ensureWorkboardRecomputeSchedule,
  RAW_PAYLOAD_CLEANUP_QUEUE: "raw-payload-cleanup",
  SYNC_PLANNER_QUEUE: "sync-planner",
  TELEGRAM_DAILY_REPORT_QUEUE: "telegram.daily-report",
  WORKBOARD_RECOMPUTE_QUEUE: "workboard.recompute",
  WORKBOARD_CLASSIFY_QUEUE: "workboard.classify-closing",
  WORKBOARD_FAN_RECOMPUTE_QUEUE: "workboard.fan-recompute",
}));
vi.mock("../apps/runtime/src/services/golden-signals.ts", () => ({
  OPS_METRICS_SAMPLE_QUEUE: "ops.metrics.sample",
  ensureOpsMetricsQueue: vi.fn(),
  ensureOpsMetricsSchedule: vi.fn(),
  startGoldenSignalWorker: vi.fn(async () => "gs-worker"),
  runGoldenSignalSample: vi.fn(),
}));
vi.mock("../apps/runtime/src/services/sync/targeted-thread-backfill.ts", () => ({
  TARGETED_THREAD_BACKFILL_QUEUE: "sync.thread.backfill",
  ensureTargetedThreadBackfillQueue: vi.fn(),
  parseTargetedThreadBackfillJob: vi.fn(() => null),
  runTargetedThreadBackfill: vi.fn(),
}));
vi.mock("../apps/runtime/src/services/workboard-event-recompute.ts", () => ({
  startWorkboardEventRecompute: vi.fn(() => ({ stop: vi.fn(async () => undefined) })),
  runWorkboardFanRecompute: vi.fn(),
}));

import { startWorkerServices } from "../apps/runtime/src/worker-services.ts";

function getTelegramWorkHandler(boss: {
  work: ReturnType<typeof vi.fn>;
}) {
  const workCalls = boss.work.mock.calls as unknown as Array<[string, unknown, () => Promise<unknown>]>;
  const telegramWorkCall = workCalls.find(([queueName]) => queueName === "telegram.daily-report");
  const handler = telegramWorkCall?.[2];

  if (!handler) {
    throw new Error("Expected telegram.daily-report handler to be registered");
  }

  return handler;
}

function getRawPayloadCleanupHandler(boss: {
  work: ReturnType<typeof vi.fn>;
}) {
  const workCalls = boss.work.mock.calls as unknown as Array<[string, unknown, () => Promise<unknown>]>;
  const workCall = workCalls.find(([queueName]) => queueName === "raw-payload-cleanup");
  const handler = workCall?.[2];
  if (!handler) {
    throw new Error("Expected raw-payload-cleanup handler to be registered");
  }
  return handler;
}

function getMessageArchiveSweepHandler(boss: {
  work: ReturnType<typeof vi.fn>;
}) {
  const workCalls = boss.work.mock.calls as unknown as Array<[
    string,
    unknown,
    () => Promise<unknown>,
  ]>;
  const workCall = workCalls.find(
    ([queueName]) => queueName === "projections.message-archive.sweep",
  );
  const handler = workCall?.[2];
  if (!handler) throw new Error("Expected message-archive sweep handler to be registered");
  return handler;
}

describe("worker startup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T11:00:00.000Z"));

    for (const mock of Object.values(dbMocks)) {
      mock.mockReset();
    }
    for (const mock of Object.values(executorMocks)) {
      mock.mockReset();
    }
    for (const mock of Object.values(telegramReportMocks)) {
      mock.mockReset();
    }
    for (const mock of Object.values(queueMocks)) {
      mock.mockReset();
    }
    for (const mock of Object.values(ofapiCommandMocks)) {
      mock.mockReset();
      mock.mockResolvedValue(undefined);
    }
    for (const mock of Object.values(ofapiDmAnalyticsMocks)) {
      mock.mockReset();
      mock.mockResolvedValue(undefined);
    }
    dbDiskAlertMocks.ensureDbDiskUsageQueue.mockReset();
    dbDiskAlertMocks.ensureDbDiskUsageQueue.mockResolvedValue(undefined);
    dbDiskAlertMocks.ensureDbDiskUsageSchedule.mockReset();
    dbDiskAlertMocks.ensureDbDiskUsageSchedule.mockResolvedValue(undefined);
    dbDiskAlertMocks.runDbDiskUsageCheck.mockReset();
    dbDiskAlertMocks.runDbDiskUsageCheck.mockResolvedValue(null);
    observationsPartitionMocks.ensureObservationsPartitionQueue.mockReset();
    observationsPartitionMocks.ensureObservationsPartitionQueue.mockResolvedValue(undefined);
    observationsPartitionMocks.ensureObservationsPartitionSchedule.mockReset();
    observationsPartitionMocks.ensureObservationsPartitionSchedule.mockResolvedValue(undefined);
    observationsPartitionMocks.runObservationsPartitionCheck.mockReset();
    observationsPartitionMocks.runObservationsPartitionCheck.mockResolvedValue({ ensured: [], leadMonths: 3, failed: false });
    plannerMocks.runSyncPlannerCycle.mockReset();
    messageArchiveMocks.runMessageArchiveProjection.mockReset();
    coverageProjectionMocks.runOfapiMessageCoverageProjection.mockReset();
    fanEarningsMocks.runFanEarningsProjection.mockReset();
    creatorPostsMocks.runCreatorPostsProjection.mockReset();
    mediaPlaneMocks.runMediaPlaneProjection.mockReset();
    mediaPlaneMocks.runMediaPlaneProjection.mockResolvedValue({ media: 0, orders: 0, offers: 0 });
    fanslyStatsProjectionMocks.runFanslyStatsProjection.mockReset();
    fanslyStatsProjectionMocks.runFanslyStatsProjection.mockResolvedValue({ applied: 0 });
    aiAcceptanceMocks.runAiAcceptanceProjection.mockReset();

    dbMocks.closeOrphanedSyncRuns.mockResolvedValue({
      totalCount: 2,
      failedCount: 1,
      partialCount: 1,
    });
    queueMocks.ensurePlannerSchedule.mockResolvedValue(undefined);
    queueMocks.ensureSyncQueues.mockResolvedValue(undefined);
    executorMocks.startSyncPageExecutor.mockResolvedValue(undefined);
    plannerMocks.runSyncPlannerCycle.mockResolvedValue([]);
    dbMocks.getLatestScheduledReportDateOnOrBefore.mockResolvedValue(null);
    // Inert voice-notes recovery stubs: match the real return shapes so the
    // nightly-retention and sweep handlers run as no-ops (nothing to release).
    dbMocks.purgeExpiredVoiceNoteAudio.mockResolvedValue(0);
    dbMocks.releaseStaleIndeterminateVoiceBudgets.mockResolvedValue([]);
    dbMocks.sweepVoiceNotes.mockResolvedValue({
      abandonedQueued: 0,
      leaseExpired: 0,
      abandonedQueuedRows: [],
    });
    dbMocks.settleVoiceCharBudget.mockResolvedValue(undefined);
    telegramReportMocks.sendDailyRevenueTelegramReport.mockResolvedValue({
      delivery: {
        status: "sent",
        chatId: "6065935464",
        messageId: 1,
      },
      report: {
        reportDate: "2026-03-20",
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs orphan cleanup once before queues and executor startup", async () => {
    const processStartedAt = new Date("2026-03-20T16:00:00.000Z");
    const order: string[] = [];
    const app = {
      db: {},
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
      config: {
        syncObservabilityRetentionDays: 30,
        telegramEnabled: false,
        telegramReportHourUtc: 9,
      },
      close: vi.fn(async () => {
        order.push("app.close");
      }),
    };
    const boss = {
      start: vi.fn(async () => {
        order.push("boss.start");
      }),
      stop: vi.fn(async () => {
        order.push("boss.stop");
      }),
      schedule: vi.fn(async () => {
        order.push("boss.schedule");
      }),
      work: vi.fn(async (queueName: string) => {
        order.push(`boss.work:${queueName}`);
      }),
      complete: vi.fn(),
      fail: vi.fn(),
      fetch: vi.fn(),
      send: vi.fn(),
      touch: vi.fn(),
      // The notification outbox reconciles its own queue options on boot
      // (createQueue cannot change an existing queue's expiry), so the
      // boss stub must answer the read-back with the expected shape.
      updateQueue: vi.fn(async () => {}),
      getQueue: vi.fn(async () => ({
        name: "notifications.delivery-outbox.sweep",
        policy: "exclusive",
        expireInSeconds: 600,
        heartbeatSeconds: 30,
        retryLimit: 0,
      })),
    };

    dbMocks.closeOrphanedSyncRuns.mockImplementation(async () => {
      order.push("cleanup");
      return {
        totalCount: 2,
        failedCount: 1,
        partialCount: 1,
      };
    });
    queueMocks.ensureSyncQueues.mockImplementation(async () => {
      order.push("ensureSyncQueues");
    });
    queueMocks.ensurePlannerSchedule.mockImplementation(async () => {
      order.push("ensurePlannerSchedule");
    });
    plannerMocks.runSyncPlannerCycle.mockImplementation(async () => {
      order.push("runSyncPlannerCycle");
      return [];
    });
    executorMocks.startSyncPageExecutor.mockImplementation(async () => {
      order.push("startSyncPageExecutor");
    });

    const runtime = await startWorkerServices(app as never, boss as never, { processStartedAt });

    expect(dbMocks.closeOrphanedSyncRuns).toHaveBeenCalledTimes(1);
    expect(dbMocks.closeOrphanedSyncRuns).toHaveBeenCalledWith({}, {
      startedBefore: processStartedAt,
      finishedAt: expect.any(Date),
      errorSummary: "Worker restarted",
    });
    expect(order.indexOf("cleanup")).toBeLessThan(order.indexOf("boss.start"));
    expect(order.indexOf("cleanup")).toBeLessThan(order.indexOf("ensureSyncQueues"));
    expect(order.indexOf("cleanup")).toBeLessThan(order.indexOf("startSyncPageExecutor"));
    expect(order.indexOf("runSyncPlannerCycle")).toBeGreaterThan(order.indexOf("ensureSyncQueues"));
    expect(order.indexOf("runSyncPlannerCycle")).toBeLessThan(order.indexOf("startSyncPageExecutor"));
    expect(app.logger.info).toHaveBeenCalledWith(expect.objectContaining({
      processStartedAt,
      orphanedRunTotal: 2,
      orphanedRunFailed: 1,
      orphanedRunPartial: 1,
    }), "Orphaned sync run startup cleanup complete");
    // Stage 25: schedules are the scheduler role's job, never the worker's.
    expect(queueMocks.ensureTelegramDailyReportSchedule).not.toHaveBeenCalled();
    expect(ofapiCommandMocks.ensureOfapiCommandQueues).toHaveBeenCalledWith(
      boss,
      expect.any(Set),
    );
    expect(ofapiCommandMocks.ensureOfapiCommandSchedules).not.toHaveBeenCalled();
    expect(ofapiCommandMocks.startOfapiCommandWorker).toHaveBeenCalledWith(app, boss);
    expect(linkStatsMocks.ensureOfapiLinkStatsQueue).toHaveBeenCalledWith(
      boss,
      expect.any(Set),
    );
    expect(linkStatsMocks.startOfapiLinkStatsWorker).toHaveBeenCalledWith(app, boss);
    expect(linkStatsMocks.ensureOfapiLinkStatsSchedule).not.toHaveBeenCalled();
    expect(ofapiDmAnalyticsMocks.ensureOfapiDmAnalyticsQueues).toHaveBeenCalledWith(
      boss,
      expect.any(Set),
    );
    expect(ofapiDmAnalyticsMocks.ensureOfapiDmAnalyticsSchedules).not.toHaveBeenCalled();
    expect(ofapiDmAnalyticsMocks.startOfapiDmAnalyticsWorker).toHaveBeenCalledWith(app, boss);
    expect(app.logger.info).toHaveBeenCalledWith("Worker started");

    await expect(getRawPayloadCleanupHandler(boss)()).resolves.toBeUndefined();
    expect(dbMocks.deleteExpiredPendingDeviceTokens).toHaveBeenCalledTimes(1);
    expect(dbMocks.deleteExpiredPendingDeviceTokens).toHaveBeenCalledWith(
      app.db,
      new Date("2026-03-23T11:00:00.000Z"),
    );

    await runtime.shutdown();

    expect(boss.stop).toHaveBeenCalledTimes(1);
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it("isolates a poison coverage event from unrelated projection consumers", async () => {
    const app = {
      db: {},
      logger: { info: vi.fn(), error: vi.fn() },
      config: {
        syncObservabilityRetentionDays: 30,
        telegramEnabled: false,
        telegramReportHourUtc: 9,
      },
      close: vi.fn(async () => {}),
    };
    const boss = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      schedule: vi.fn(async () => {}),
      work: vi.fn(async () => {}),
      complete: vi.fn(),
      fail: vi.fn(),
      fetch: vi.fn(),
      send: vi.fn(),
      touch: vi.fn(),
      // The notification outbox reconciles its own queue options on boot
      // (createQueue cannot change an existing queue's expiry), so the
      // boss stub must answer the read-back with the expected shape.
      updateQueue: vi.fn(async () => {}),
      getQueue: vi.fn(async () => ({
        name: "notifications.delivery-outbox.sweep",
        policy: "exclusive",
        expireInSeconds: 600,
        heartbeatSeconds: 30,
        retryLimit: 0,
      })),
    };
    messageArchiveMocks.runMessageArchiveProjection.mockResolvedValue({ eventsSeen: 0 });
    coverageProjectionMocks.runOfapiMessageCoverageProjection.mockRejectedValue(
      new Error("poison coverage fact"),
    );
    fanEarningsMocks.runFanEarningsProjection.mockResolvedValue({ upserted: 1 });
    creatorPostsMocks.runCreatorPostsProjection.mockResolvedValue({ upserted: 1 });
    aiAcceptanceMocks.runAiAcceptanceProjection.mockResolvedValue({ projected: 1 });

    const runtime = await startWorkerServices(app as never, boss as never);
    await expect(getMessageArchiveSweepHandler(boss)()).resolves.toBeUndefined();
    expect(fanEarningsMocks.runFanEarningsProjection).toHaveBeenCalledTimes(1);
    expect(creatorPostsMocks.runCreatorPostsProjection).toHaveBeenCalledTimes(1);
    expect(aiAcceptanceMocks.runAiAcceptanceProjection).toHaveBeenCalledTimes(1);
    // WP-F1(0): the tick is registry-driven, so the error line now carries the
    // projection name alongside the error. The property under test is unchanged
    // and is the one that matters — one poison fact must not starve the
    // neighbours that share this pg-boss handler.
    expect(app.logger.error).toHaveBeenCalledWith(
      { error: expect.any(Error), projection: "ofapi_message_coverage_v1" },
      "OFAPI message-coverage projection sweep failed",
    );
    await runtime.shutdown();
  });

  it("registers the Telegram daily report schedule when Telegram is enabled", async () => {
    const app = {
      db: {},
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
      config: {
        syncObservabilityRetentionDays: 30,
        telegramEnabled: true,
        telegramReportHourUtc: 7,
      },
      close: vi.fn(async () => {}),
    };
    const boss = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      schedule: vi.fn(async () => {}),
      work: vi.fn(async () => {}),
      complete: vi.fn(),
      fail: vi.fn(),
      fetch: vi.fn(),
      send: vi.fn(),
      touch: vi.fn(),
      // The notification outbox reconciles its own queue options on boot
      // (createQueue cannot change an existing queue's expiry), so the
      // boss stub must answer the read-back with the expected shape.
      updateQueue: vi.fn(async () => {}),
      getQueue: vi.fn(async () => ({
        name: "notifications.delivery-outbox.sweep",
        policy: "exclusive",
        expireInSeconds: 600,
        heartbeatSeconds: 30,
        retryLimit: 0,
      })),
    };

    const runtime = await startWorkerServices(app as never, boss as never);

    expect(queueMocks.ensureSyncQueues).toHaveBeenCalledWith(boss, expect.any(Set));
    // Stage 25: cron registration moved to the scheduler role — the worker
    // creates queues and consumes, but never registers schedules.
    expect(queueMocks.ensurePlannerSchedule).not.toHaveBeenCalled();
    expect(plannerMocks.runSyncPlannerCycle).toHaveBeenCalledWith(app, boss);
    expect(queueMocks.ensureTelegramDailyReportSchedule).not.toHaveBeenCalled();
    expect(boss.work).toHaveBeenCalledWith(
      "telegram.daily-report",
      { batchSize: 1 },
      expect.any(Function),
    );

    await runtime.shutdown();
  });

  it("catches up yesterday's report after the worker misses the scheduled hour", async () => {
    vi.setSystemTime(new Date("2026-03-23T11:00:00.000Z"));
    const reportHourUtc = 9;
    const app = {
      db: {},
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
      config: {
        syncObservabilityRetentionDays: 30,
        telegramEnabled: true,
        telegramReportHourUtc: reportHourUtc,
      },
      close: vi.fn(async () => {}),
    };
    const boss = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      schedule: vi.fn(async () => {}),
      work: vi.fn(async () => {}),
      complete: vi.fn(),
      fail: vi.fn(),
      fetch: vi.fn(),
      send: vi.fn(),
      touch: vi.fn(),
      // The notification outbox reconciles its own queue options on boot
      // (createQueue cannot change an existing queue's expiry), so the
      // boss stub must answer the read-back with the expected shape.
      updateQueue: vi.fn(async () => {}),
      getQueue: vi.fn(async () => ({
        name: "notifications.delivery-outbox.sweep",
        policy: "exclusive",
        expireInSeconds: 600,
        heartbeatSeconds: 30,
        retryLimit: 0,
      })),
    };

    dbMocks.getTelegramSettings.mockResolvedValue({
      enabled: true,
      dailyReportEnabled: true,
      reportHourUtc,
    });

    dbMocks.getLatestScheduledReportDateOnOrBefore.mockResolvedValue("2026-03-21");

    const runtime = await startWorkerServices(app as never, boss as never);
    const handler = getTelegramWorkHandler(boss);

    await expect(handler()).resolves.toBeUndefined();
    expect(dbMocks.getLatestScheduledReportDateOnOrBefore).toHaveBeenCalledWith({}, "2026-03-22");
    expect(telegramReportMocks.sendDailyRevenueTelegramReport).toHaveBeenCalledTimes(1);
    expect(telegramReportMocks.sendDailyRevenueTelegramReport).toHaveBeenCalledWith(
      app,
      new Date("2026-03-23T00:00:00.000Z"),
    );

    await runtime.shutdown();
  });

  it("catches up multiple trailing missing report dates in order", async () => {
    vi.setSystemTime(new Date("2026-03-25T11:00:00.000Z"));
    const app = {
      db: {},
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
      config: {
        syncObservabilityRetentionDays: 30,
        telegramEnabled: true,
        telegramReportHourUtc: 9,
      },
      close: vi.fn(async () => {}),
    };
    const boss = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      schedule: vi.fn(async () => {}),
      work: vi.fn(async () => {}),
      complete: vi.fn(),
      fail: vi.fn(),
      fetch: vi.fn(),
      send: vi.fn(),
      touch: vi.fn(),
      // The notification outbox reconciles its own queue options on boot
      // (createQueue cannot change an existing queue's expiry), so the
      // boss stub must answer the read-back with the expected shape.
      updateQueue: vi.fn(async () => {}),
      getQueue: vi.fn(async () => ({
        name: "notifications.delivery-outbox.sweep",
        policy: "exclusive",
        expireInSeconds: 600,
        heartbeatSeconds: 30,
        retryLimit: 0,
      })),
    };

    dbMocks.getTelegramSettings.mockResolvedValue({
      enabled: true,
      dailyReportEnabled: true,
      reportHourUtc: 9,
    });
    dbMocks.getLatestScheduledReportDateOnOrBefore.mockResolvedValue("2026-03-22");

    const runtime = await startWorkerServices(app as never, boss as never);
    const handler = getTelegramWorkHandler(boss);

    await expect(handler()).resolves.toBeUndefined();
    expect(dbMocks.getLatestScheduledReportDateOnOrBefore).toHaveBeenCalledWith({}, "2026-03-24");
    expect(telegramReportMocks.sendDailyRevenueTelegramReport).toHaveBeenNthCalledWith(
      1,
      app,
      new Date("2026-03-24T00:00:00.000Z"),
    );
    expect(telegramReportMocks.sendDailyRevenueTelegramReport).toHaveBeenNthCalledWith(
      2,
      app,
      new Date("2026-03-25T00:00:00.000Z"),
    );

    await runtime.shutdown();
  });

  it("does not send yesterday's report before the configured hour arrives", async () => {
    vi.setSystemTime(new Date("2026-03-23T08:00:00.000Z"));
    const app = {
      db: {},
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
      config: {
        syncObservabilityRetentionDays: 30,
        telegramEnabled: true,
        telegramReportHourUtc: 9,
      },
      close: vi.fn(async () => {}),
    };
    const boss = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      schedule: vi.fn(async () => {}),
      work: vi.fn(async () => {}),
      complete: vi.fn(),
      fail: vi.fn(),
      fetch: vi.fn(),
      send: vi.fn(),
      touch: vi.fn(),
      // The notification outbox reconciles its own queue options on boot
      // (createQueue cannot change an existing queue's expiry), so the
      // boss stub must answer the read-back with the expected shape.
      updateQueue: vi.fn(async () => {}),
      getQueue: vi.fn(async () => ({
        name: "notifications.delivery-outbox.sweep",
        policy: "exclusive",
        expireInSeconds: 600,
        heartbeatSeconds: 30,
        retryLimit: 0,
      })),
    };

    dbMocks.getTelegramSettings.mockResolvedValue({
      enabled: true,
      dailyReportEnabled: true,
      reportHourUtc: 9,
    });
    dbMocks.getLatestScheduledReportDateOnOrBefore.mockResolvedValue("2026-03-21");

    const runtime = await startWorkerServices(app as never, boss as never);
    const handler = getTelegramWorkHandler(boss);

    await expect(handler()).resolves.toBeUndefined();
    expect(dbMocks.getLatestScheduledReportDateOnOrBefore).toHaveBeenCalledWith({}, "2026-03-21");
    expect(telegramReportMocks.sendDailyRevenueTelegramReport).not.toHaveBeenCalled();

    await runtime.shutdown();
  });

  it("throws when a scheduled Telegram report delivery fails so the job can retry", async () => {
    vi.setSystemTime(new Date("2026-03-23T11:00:00.000Z"));
    const reportHourUtc = 9;
    const app = {
      db: {},
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
      config: {
        syncObservabilityRetentionDays: 30,
        telegramEnabled: true,
        telegramReportHourUtc: reportHourUtc,
      },
      close: vi.fn(async () => {}),
    };
    const boss = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      schedule: vi.fn(async () => {}),
      work: vi.fn(async () => {}),
      complete: vi.fn(),
      fail: vi.fn(),
      fetch: vi.fn(),
      send: vi.fn(),
      touch: vi.fn(),
      // The notification outbox reconciles its own queue options on boot
      // (createQueue cannot change an existing queue's expiry), so the
      // boss stub must answer the read-back with the expected shape.
      updateQueue: vi.fn(async () => {}),
      getQueue: vi.fn(async () => ({
        name: "notifications.delivery-outbox.sweep",
        policy: "exclusive",
        expireInSeconds: 600,
        heartbeatSeconds: 30,
        retryLimit: 0,
      })),
    };

    dbMocks.getTelegramSettings.mockResolvedValue({
      enabled: true,
      dailyReportEnabled: true,
      reportHourUtc,
    });
    dbMocks.getLatestScheduledReportDateOnOrBefore.mockResolvedValue("2026-03-21");
    telegramReportMocks.sendDailyRevenueTelegramReport.mockResolvedValue({
      delivery: {
        status: "failed",
        error: "connection refused",
      },
      report: {
        reportDate: "2026-03-20",
      },
    });

    const runtime = await startWorkerServices(app as never, boss as never);
    const handler = getTelegramWorkHandler(boss);
    await expect(handler()).rejects.toThrow("Telegram daily report delivery failed: connection refused");
    expect(dbMocks.getTelegramSettings).toHaveBeenCalledWith({}, {
      defaultReportHourUtc: reportHourUtc,
    });
    expect(dbMocks.getLatestScheduledReportDateOnOrBefore).toHaveBeenCalledWith({}, "2026-03-22");
    expect(telegramReportMocks.sendDailyRevenueTelegramReport).toHaveBeenCalledWith(
      app,
      new Date("2026-03-23T00:00:00.000Z"),
    );

    await runtime.shutdown();
  });
});
