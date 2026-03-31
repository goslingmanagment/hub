import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  acquireNextSyncTaskLeaseForPage,
  blockSyncTaskGeneration,
  completeSyncTaskGeneration,
  ensureSyncTaskRows,
  failSyncTaskGeneration,
  findPageById,
  heartbeatSyncTaskLease,
  listRunnableSyncPagesV2,
  resolveSyncTaskPriority,
  runWithSyncTaskExecutionContext,
  startSyncRun,
  type SyncRequestReason,
  type SyncControlStream,
  type SyncStreamStateRow,
  type SyncTaskLeaseRow,
  type SyncTargetStatus,
  type SyncWorkClass,
  yieldSyncTaskGeneration,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import { OnlyMonsterApiError } from "@agency_hub_core/onlyfans";
import { buildProxyEgressKey } from "@agency_hub_core/shared";
import type { JobWithMetadata, PgBoss } from "pg-boss";

import type { AppContext } from "../../bootstrap.ts";
import {
  notifyAuthFailedIncident,
  notifySyncChunkFailureIncident,
  resolveSyncChunkRecoveryIncidents,
} from "../notification-incidents.ts";
import { SYNC_PAGE_EXECUTE_QUEUE, sendSyncPageWakeup, type SyncPageExecutePayload } from "../sync-queue.ts";
import { normalizeSyncError } from "./errors.ts";
import { executeStreamChunk, resolveExecutorPageContext } from "./executor-handlers.ts";
import { SyncChunkBudget } from "./chunk-budget.ts";
import { SyncRunTelemetry } from "./observability.ts";
import { persistFailedSyncPayload } from "./shared.ts";

const PAGE_EXECUTOR_IDLE_POLL_MS = 1_000;
const PAGE_EXECUTOR_HEARTBEAT_MS = 15_000;
const SYNC_RUN_HEARTBEAT_MS = 30_000;
const SYNC_TASK_LEASE_TTL_MS = 120_000;
const MAX_LOCAL_EXECUTOR_CHUNKS = 500;

export interface SyncPageChunkResult {
  kind: "idle" | "success" | "yielded" | "failed" | "auth_failed";
  platformAccountId: number;
  stream: SyncControlStream | null;
  runId: number | null;
  needsContinuation: boolean;
  continuationPriority: number | null;
}

type PageExecuteBoss = Pick<PgBoss, "complete" | "fail" | "fetch" | "send" | "touch">;

interface ExecutorCoordinator {
  fetchLock: Promise<void>;
  localActiveGroups: Set<string>;
}

function isAuthError(error: unknown) {
  if (error instanceof FanslyApiError || error instanceof OnlyMonsterApiError) {
    return error.status === 401 || error.status === 403;
  }

  return false;
}

function computeNextDueAt(task: SyncTaskLeaseRow) {
  return new Date(((task.lastScheduledSlot + 1) * task.scheduleIntervalSeconds + task.slotOffsetSeconds) * 1000);
}

function mapOperationSourceToLegacyTrigger(source: SyncTaskLeaseRow["operationSource"]): SyncRequestReason {
  if (source === "reset") {
    return "manual";
  }

  return source ?? "scheduled";
}

function toLegacyStreamState(task: SyncTaskLeaseRow): SyncStreamStateRow {
  const pendingReason = mapOperationSourceToLegacyTrigger(task.operationSource);
  const status: SyncTargetStatus = task.status === "paused"
    ? "paused"
    : task.status === "blocked" && task.blockerType === "auth"
      ? "auth_failed"
      : "active";

  return {
    platformAccountId: task.platformAccountId,
    stream: task.task,
    status,
    cadenceSeconds: task.scheduleIntervalSeconds,
    slotOffsetSeconds: task.slotOffsetSeconds,
    nextDueAt: computeNextDueAt(task),
    basePriority: resolveSyncTaskPriority(task.task, "scheduled"),
    effectivePriority: resolveSyncTaskPriority(task.task, task.operationSource ?? "scheduled"),
    pendingReason,
    desiredRevision: task.desiredGeneration,
    satisfiedRevision: task.appliedGeneration,
    desiredAt: task.lastRequestedAt,
    requestPayload: task.requestPayload,
    backoffUntil: task.retryAt ?? new Date(0),
    lastEnqueuedAt: task.lastEnqueuedAt,
    lastStartedAt: task.lastStartedAt,
    lastFinishedAt: task.lastFinishedAt,
    lastSucceededAt: task.lastSuccessAt,
    lastFailedAt: task.lastFailureAt,
    consecutiveFailures: task.consecutiveFailures,
    lastErrorCode: task.lastErrorCode,
    lastErrorSummary: task.lastErrorSummary,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

async function resolveContinuationPriority(
  app: Pick<AppContext, "db">,
  platformAccountId: number,
) {
  const pages = await listRunnableSyncPagesV2(app.db, new Date());
  return pages.find((page) => page.platformAccountId === platformAccountId)?.priority ?? null;
}

function buildContinuationResult(
  platformAccountId: number,
  stream: SyncControlStream | null,
  runId: number | null,
  kind: SyncPageChunkResult["kind"],
  continuationPriority: number | null,
): SyncPageChunkResult {
  return {
    kind,
    platformAccountId,
    stream,
    runId,
    needsContinuation: continuationPriority !== null,
    continuationPriority,
  };
}

async function createChunkTelemetry(
  app: AppContext,
  taskLease: SyncTaskLeaseRow,
) {
  const storedPage = await findPageById(app.db, taskLease.platformAccountId);
  if (!storedPage) {
    throw new Error(`Page ${taskLease.platformAccountId} not found`);
  }

  const trigger = mapOperationSourceToLegacyTrigger(taskLease.operationSource);
  const run = await startTaskRun(app, taskLease, trigger);
  const telemetry = new SyncRunTelemetry(app, {
    runId: run.id,
    platformAccountId: storedPage.page.id,
    pageLabel: storedPage.page.label,
    provider: storedPage.page.platform,
    stream: taskLease.task,
    trigger,
    egressKey: buildProxyEgressKey(storedPage.proxy ? { url: storedPage.proxy.url } : null),
  }, {
    runStartedAt: run.startedAt,
  });
  await telemetry.recordRunStarted();

  return {
    storedPage,
    run,
    telemetry,
  };
}

async function startTaskRun(
  app: AppContext,
  taskLease: SyncTaskLeaseRow,
  trigger: string,
) {
  return startSyncRun(app.db, {
    platformAccountId: taskLease.platformAccountId,
    operationId: taskLease.operationId,
    stream: taskLease.task,
    task: taskLease.task,
    generation: taskLease.runningGeneration ?? taskLease.desiredGeneration,
    leaseToken: taskLease.leaseToken,
    trigger,
  });
}

async function resolveSyncPageWakeupTarget(
  app: Pick<AppContext, "db">,
  platformAccountId: number,
) {
  const page = await findPageById(app.db, platformAccountId);
  if (!page) {
    return null;
  }

  return {
    provider: page.page.platform,
    egressKey: buildProxyEgressKey(page.proxy ? { url: page.proxy.url } : null),
  };
}

function classifyTaskFailure(
  error: unknown,
  failure: ReturnType<typeof normalizeSyncError>,
): {
  mode: "retry" | "blocked";
  retryClass?: string;
  blockerType?: string;
  blockerCode?: string;
  blockerReason?: string;
} {
  if (error instanceof FanslyApiError || error instanceof OnlyMonsterApiError) {
    if (error.status === 429) {
      return {
        mode: "retry",
        retryClass: "rate_limit",
      };
    }

    if (error.status && error.status >= 500) {
      return {
        mode: "retry",
        retryClass: "provider_5xx",
      };
    }

    if (error.status && error.status >= 400) {
      return {
        mode: "blocked",
        blockerType: "provider_bad_data",
        blockerCode: "provider_bad_data",
        blockerReason: failure.summary,
      };
    }
  }

  const lowerCode = failure.error.code?.toLowerCase() ?? "";
  const lowerSummary = failure.summary.toLowerCase();
  if (lowerCode.includes("cursor") || lowerSummary.includes("cursor")) {
    return {
      mode: "blocked",
      blockerType: "invalid_cursor",
      blockerCode: "invalid_cursor",
      blockerReason: failure.summary,
    };
  }

  if (lowerCode === "http_429" || lowerSummary.includes("429")) {
    return {
      mode: "retry",
      retryClass: "rate_limit",
    };
  }

  if (lowerCode.startsWith("http_5") || lowerSummary.includes("timeout")) {
    return {
      mode: "retry",
      retryClass: lowerCode.startsWith("http_5") ? "provider_5xx" : "transient_network",
    };
  }

  if (lowerSummary.includes("manual action") || lowerSummary.includes("shared rate limit")) {
    return {
      mode: "blocked",
      blockerType: "manual_action_required",
      blockerCode: "manual_action_required",
      blockerReason: failure.summary,
    };
  }

  return {
    mode: "retry",
    retryClass: "transient_network",
  };
}

function sanitizeProgressPayload(taskLease: SyncTaskLeaseRow, stats: Record<string, unknown> | undefined) {
  if (!stats || Object.keys(stats).length === 0) {
    return taskLease.progressPayload;
  }

  const next = Object.fromEntries(
    Object.entries(stats)
      .filter(([, value]) => {
        if (value === null) {
          return true;
        }
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          return true;
        }
        if (typeof value === "object" && !Array.isArray(value)) {
          return Object.keys(value as Record<string, unknown>).length <= 8;
        }
        return false;
      })
      .slice(0, 12),
  );

  return {
    ...taskLease.progressPayload,
    ...next,
  };
}

function resolveCurrentPhase(stats: Record<string, unknown> | undefined) {
  const phase = stats?.phase;
  if (typeof phase === "string" && phase.trim().length > 0) {
    return phase;
  }

  const currentMode = stats?.currentMode;
  if (typeof currentMode === "string" && currentMode.trim().length > 0) {
    return currentMode;
  }

  return null;
}

function resolveCurrentWorkClass(taskLease: SyncTaskLeaseRow, stats: Record<string, unknown> | undefined): SyncWorkClass {
  const currentMode = stats?.currentMode;
  if (currentMode === "backfill") {
    return "history";
  }
  if (currentMode === "incremental") {
    return "live";
  }
  return taskLease.currentWorkClass ?? (taskLease.task === "dm_messages"
    ? "history"
    : taskLease.task === "top_spenders" || taskLease.task === "followers_reconcile"
      ? "maintenance"
      : "live");
}

function hasMeaningfulProgress(
  result: {
    satisfied: boolean;
    stats?: Record<string, unknown>;
  },
) {
  return result.satisfied || Boolean(result.stats && Object.keys(result.stats).length > 0);
}
export async function executeNextSyncPageChunk(
  app: AppContext,
  platformAccountId: number,
): Promise<SyncPageChunkResult> {
  await ensureSyncTaskRows(app.db, { platformAccountId });

  const taskLease = await acquireNextSyncTaskLeaseForPage(app.db, {
    platformAccountId,
    workerId: `sync-page-executor:${process.pid}`,
    leaseToken: randomUUID(),
    leaseTtlMs: SYNC_TASK_LEASE_TTL_MS,
  });

  if (!taskLease) {
    return {
      kind: "idle",
      platformAccountId,
      stream: null,
      runId: null,
      needsContinuation: false,
      continuationPriority: null,
    };
  }

  const { storedPage, run, telemetry } = await createChunkTelemetry(app, taskLease);
  const budget = new SyncChunkBudget();
  let leaseFenced = false;
  const runHeartbeat = setInterval(() => {
    void telemetry.recordWorkerHeartbeat().catch((error) => {
      app.logger.warn(
        { err: error, runId: run.id, platformAccountId, stream: taskLease.task },
        "Failed to record sync worker heartbeat",
      );
    });
  }, SYNC_RUN_HEARTBEAT_MS);
  const leaseHeartbeat = setInterval(() => {
    void heartbeatSyncTaskLease(app.db, {
      platformAccountId,
      task: taskLease.task,
      leaseToken: taskLease.leaseToken ?? "",
      leaseTtlMs: SYNC_TASK_LEASE_TTL_MS,
    }).then((owned) => {
      if (!owned) {
        leaseFenced = true;
      }
    }).catch((error) => {
      app.logger.warn(
        { err: error, platformAccountId, stream: taskLease.task },
        "Failed to heartbeat sync task lease",
      );
    });
  }, SYNC_RUN_HEARTBEAT_MS);

  try {
    const pageContext = await resolveExecutorPageContext(app, taskLease.platformAccountId);
    const legacyStreamState = toLegacyStreamState(taskLease);
    const result = await runWithSyncTaskExecutionContext({
      platformAccountId,
      task: taskLease.task,
      generation: taskLease.runningGeneration ?? taskLease.desiredGeneration,
      leaseToken: taskLease.leaseToken ?? "",
    }, async () => executeStreamChunk(app, {
      pageContext,
      streamState: legacyStreamState,
      syncRunId: run.id,
      telemetry,
      budget,
    }));

    if (leaseFenced) {
      await telemetry.recordSkipped("Sync task lease lost");
      return {
        kind: "idle",
        platformAccountId,
        stream: null,
        runId: run.id,
        needsContinuation: false,
        continuationPriority: null,
      };
    }

    const progressPayload = sanitizeProgressPayload(taskLease, result.stats);
    const currentPhase = resolveCurrentPhase(result.stats);
    const currentWorkClass = resolveCurrentWorkClass(taskLease, result.stats);
    const progressAt = hasMeaningfulProgress(result) ? new Date() : taskLease.lastProgressAt;

    if (result.satisfied) {
      const applied = await completeSyncTaskGeneration(app.db, {
        platformAccountId,
        task: taskLease.task,
        generation: taskLease.runningGeneration ?? taskLease.desiredGeneration,
        leaseToken: taskLease.leaseToken ?? "",
        progressAt,
        currentPhase,
        currentWorkClass,
        progressPayload,
      });
      if (!applied) {
        await telemetry.recordSkipped("Sync task lease lost");
        return {
          kind: "idle",
          platformAccountId,
          stream: null,
          runId: run.id,
          needsContinuation: false,
          continuationPriority: null,
        };
      }

      await telemetry.finish("success", null, {
        chunkBudget: {
          requestCount: budget.totalRequests,
          elapsedMs: budget.elapsedMs,
        },
        ...result.stats,
      });
      await resolveSyncChunkRecoveryIncidents(app, {
        platformAccountId,
        pageLabel: pageContext.page.label,
        platform: pageContext.platform,
        stream: taskLease.task,
      });
      const continuationPriority = await resolveContinuationPriority(app, platformAccountId);
      return buildContinuationResult(platformAccountId, taskLease.task, run.id, "success", continuationPriority);
    }

    const yielded = await yieldSyncTaskGeneration(app.db, {
      platformAccountId,
      task: taskLease.task,
      generation: taskLease.runningGeneration ?? taskLease.desiredGeneration,
      leaseToken: taskLease.leaseToken ?? "",
      progressAt,
      currentPhase,
      currentWorkClass,
      progressPayload,
    });
    if (!yielded) {
      await telemetry.recordSkipped("Sync task lease lost");
      return {
        kind: "idle",
        platformAccountId,
        stream: null,
        runId: run.id,
        needsContinuation: false,
        continuationPriority: null,
      };
    }

    await telemetry.finish("partial", null, {
      yieldReason: result.yieldReason,
      chunkBudget: {
        requestCount: budget.totalRequests,
        elapsedMs: budget.elapsedMs,
      },
      ...result.stats,
    });
    await resolveSyncChunkRecoveryIncidents(app, {
      platformAccountId,
      pageLabel: pageContext.page.label,
      platform: pageContext.platform,
      stream: taskLease.task,
    });
    const continuationPriority = await resolveContinuationPriority(app, platformAccountId);
    return buildContinuationResult(platformAccountId, taskLease.task, run.id, "yielded", continuationPriority);
  } catch (error) {
    const failure = normalizeSyncError(error, {
      endpoint: taskLease.task,
      action: `executing ${taskLease.task} sync chunk`,
    });
    const provider = storedPage.page.platform;
    const pageLabel = storedPage.page.label;
    const hasProxy = storedPage.proxy !== null;

    await persistFailedSyncPayload(app, {
      platformAccountId,
      syncRunId: run.id,
      endpoint: taskLease.task,
      platform: provider,
      failure,
    });

    if (isAuthError(error)) {
      await blockSyncTaskGeneration(app.db, {
        platformAccountId,
        task: taskLease.task,
        generation: taskLease.runningGeneration ?? taskLease.desiredGeneration,
        leaseToken: taskLease.leaseToken ?? "",
        blockerType: "auth",
        blockerCode: "credentials_invalid",
        blockerReason: failure.summary,
        errorCode: failure.error.code,
        errorSummary: failure.summary,
        currentPhase: taskLease.currentPhase,
        currentWorkClass: taskLease.currentWorkClass ?? "live",
        progressPayload: taskLease.progressPayload,
      });
      await telemetry.finish("failed", failure, {
        chunkStatus: "auth_failed",
      });
      await notifyAuthFailedIncident(app, {
        platformAccountId,
        pageLabel,
        platform: provider,
        errorCode: failure.error.code,
        errorSummary: failure.summary,
      });
      return {
        kind: "auth_failed",
        platformAccountId,
        stream: taskLease.task,
        runId: run.id,
        needsContinuation: false,
        continuationPriority: null,
      };
    }

    const classified = classifyTaskFailure(error, failure);
    if (classified.mode === "blocked") {
      await blockSyncTaskGeneration(app.db, {
        platformAccountId,
        task: taskLease.task,
        generation: taskLease.runningGeneration ?? taskLease.desiredGeneration,
        leaseToken: taskLease.leaseToken ?? "",
        blockerType: classified.blockerType ?? "manual_action_required",
        blockerCode: classified.blockerCode ?? "manual_action_required",
        blockerReason: classified.blockerReason ?? failure.summary,
        errorCode: failure.error.code,
        errorSummary: failure.summary,
        currentPhase: taskLease.currentPhase,
        currentWorkClass: taskLease.currentWorkClass ?? "live",
        progressPayload: taskLease.progressPayload,
      });
    } else {
      await failSyncTaskGeneration(app.db, {
        platformAccountId,
        task: taskLease.task,
        generation: taskLease.runningGeneration ?? taskLease.desiredGeneration,
        leaseToken: taskLease.leaseToken ?? "",
        retryClass: classified.retryClass ?? "transient_network",
        errorCode: failure.error.code,
        errorSummary: failure.summary,
        currentPhase: taskLease.currentPhase,
        currentWorkClass: taskLease.currentWorkClass ?? "live",
        progressPayload: taskLease.progressPayload,
      });
    }

    await telemetry.finish("failed", failure, {
      chunkStatus: "failed",
    });
    await notifySyncChunkFailureIncident(app, {
      platformAccountId,
      pageLabel,
      platform: provider,
      stream: taskLease.task,
      runId: run.id,
      hasProxy,
      previousConsecutiveFailures: taskLease.consecutiveFailures,
      errorCode: failure.error.code,
      errorSummary: failure.summary,
    });
    const continuationPriority = classified.mode === "retry"
      ? await resolveContinuationPriority(app, platformAccountId)
      : null;
    return buildContinuationResult(platformAccountId, taskLease.task, run.id, "failed", continuationPriority);
  } finally {
    clearInterval(runHeartbeat);
    clearInterval(leaseHeartbeat);
  }
}

export async function processSyncPageExecuteJob(
  app: AppContext,
  boss: Pick<PgBoss, "complete" | "send">,
  input: {
    job: Pick<JobWithMetadata<SyncPageExecutePayload>, "id" | "data" | "groupId">;
  },
) {
  let result = await executeNextSyncPageChunk(app, input.job.data.platformAccountId);
  let localChunks = 1;

  while (result.needsContinuation && result.continuationPriority !== null) {
    if (localChunks >= MAX_LOCAL_EXECUTOR_CHUNKS) {
      throw new Error(
        `Sync page executor exceeded ${MAX_LOCAL_EXECUTOR_CHUNKS} local chunks for page ${result.platformAccountId}`,
      );
    }

    const wakeupTarget = await resolveSyncPageWakeupTarget(app, result.platformAccountId);
    if (wakeupTarget) {
      const wakeupId = await sendSyncPageWakeup(boss, {
        platformAccountId: result.platformAccountId,
        priority: result.continuationPriority,
        provider: wakeupTarget.provider,
        egressKey: wakeupTarget.egressKey,
        dedupe: false,
      });

      if (wakeupId !== null && wakeupId !== undefined) {
        break;
      }
    }

    result = await executeNextSyncPageChunk(app, input.job.data.platformAccountId);
    localChunks += 1;
  }

  await boss.complete(SYNC_PAGE_EXECUTE_QUEUE, input.job.id);

  return result;
}

async function runSyncPageExecutorWorker(
  app: AppContext,
  boss: Pick<PgBoss, "complete" | "fail" | "fetch" | "send" | "touch">,
  input: {
    signal?: AbortSignal;
    coordinator: ExecutorCoordinator;
  },
): Promise<void> {
  while (!input.signal?.aborted) {
    try {
      const previousFetch = input.coordinator.fetchLock;
      let releaseFetchLock!: () => void;
      input.coordinator.fetchLock = new Promise<void>((resolve) => {
        releaseFetchLock = resolve;
      });

      await previousFetch;

      let trackedGroupId: string | null = null;
      let job: JobWithMetadata<SyncPageExecutePayload> | null = null;
      try {
        const activeGroupIds = Array.from(input.coordinator.localActiveGroups);
        const jobs = await boss.fetch<SyncPageExecutePayload>(SYNC_PAGE_EXECUTE_QUEUE, {
          batchSize: 1,
          includeMetadata: true,
          priority: true,
          orderByCreatedOn: true,
          groupConcurrency: 1,
          ignoreGroups: activeGroupIds.length > 0 ? activeGroupIds : null,
        });
        job = jobs[0] ?? null;
        trackedGroupId = typeof job?.groupId === "string" ? job.groupId : null;
        if (trackedGroupId) {
          input.coordinator.localActiveGroups.add(trackedGroupId);
        }
      } finally {
        releaseFetchLock();
      }

      if (!job) {
        await delay(PAGE_EXECUTOR_IDLE_POLL_MS);
        continue;
      }

      const heartbeat = setInterval(() => {
        void boss.touch(SYNC_PAGE_EXECUTE_QUEUE, job.id).catch((error) => {
          app.logger.warn({ err: error, jobId: job.id }, "Failed to heartbeat sync page execute job");
        });
      }, PAGE_EXECUTOR_HEARTBEAT_MS);

      try {
        await processSyncPageExecuteJob(app, boss, { job });
      } catch (error) {
        app.logger.error({ err: error, jobId: job.id }, "Sync page executor job crashed");
        await boss.fail(SYNC_PAGE_EXECUTE_QUEUE, job.id, {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        clearInterval(heartbeat);
        if (trackedGroupId) {
          input.coordinator.localActiveGroups.delete(trackedGroupId);
        }
      }
    } catch (error) {
      if (input.signal?.aborted) {
        break;
      }

      app.logger.error({ err: error }, "Sync page executor loop failed");
      await delay(PAGE_EXECUTOR_IDLE_POLL_MS);
    }
  }
}

export async function startSyncPageExecutor(
  app: AppContext,
  boss: PageExecuteBoss,
  input?: {
    signal?: AbortSignal;
  },
): Promise<void> {
  const coordinator: ExecutorCoordinator = {
    fetchLock: Promise.resolve(),
    localActiveGroups: new Set<string>(),
  };
  const workers = Array.from({ length: app.config.syncPageExecutorConcurrency }, () =>
    runSyncPageExecutorWorker(app, boss, {
      signal: input?.signal,
      coordinator,
    }));

  await Promise.all(workers);
}

export async function runSyncPageExecutorUntilIdle(
  app: AppContext,
  platformAccountId: number,
  input?: {
    maxChunks?: number;
  },
) {
  const maxChunks = input?.maxChunks ?? MAX_LOCAL_EXECUTOR_CHUNKS;
  for (let index = 0; index < maxChunks; index += 1) {
    const result = await executeNextSyncPageChunk(app, platformAccountId);
    if (result.kind === "idle") {
      return result;
    }

    if (!result.needsContinuation) {
      return result;
    }
  }

  throw new Error(`Sync page executor exceeded ${maxChunks} local chunks for page ${platformAccountId}`);
}
