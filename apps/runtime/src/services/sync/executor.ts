import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  acquirePageSyncLease,
  blockPageSync,
  completePageSync,
  ensurePageSyncStates,
  findPageById,
  heartbeatPageSyncLease,
  listRunnablePageSync,
  PageSyncLeaseLostError,
  retryPageSync,
  resolvePageSyncPriority,
  runWithPageSyncExecutionContext,
  startSyncRun,
  type PageSyncLease,
  type SyncRequestSource,
  type SyncStream,
  type SyncWorkClass,
  yieldPageSync,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import { OnlyMonsterApiError } from "@agency_hub_core/onlyfans";
import type { JobWithMetadata, PgBoss } from "pg-boss";

import type { AppContext } from "../../bootstrap.ts";
import {
  notifyAuthFailedIncident,
  notifySyncChunkFailureIncident,
  resolveSyncChunkRecoveryIncidents,
} from "../notification-incidents.ts";
import { resolveStoredProxyEgressKey } from "../page-context.ts";
import { SYNC_PAGE_EXECUTE_QUEUE, sendSyncPageWakeup, type SyncPageExecutePayload } from "../sync-queue.ts";
import { normalizeSyncError } from "./errors.ts";
import { executeStreamChunk, resolveExecutorPageContext } from "./executor-handlers.ts";
import { SyncChunkBudget } from "./chunk-budget.ts";
import { pauseDisabledOnlyFansDmPollingForPage } from "./onlyfans-dm-polling.ts";
import { SyncRunTelemetry } from "./observability.ts";
import { persistFailedSyncPayload } from "./shared.ts";

const PAGE_EXECUTOR_IDLE_POLL_MS = 1_000;
const PAGE_EXECUTOR_HEARTBEAT_MS = 15_000;
const SYNC_RUN_HEARTBEAT_MS = 30_000;
const SYNC_TASK_LEASE_TTL_MS = 120_000;
const MAX_LOCAL_EXECUTOR_CHUNKS = 500;

export interface SyncPageChunkResult {
  kind: "idle" | "success" | "yielded" | "failed" | "blocked";
  platformAccountId: number;
  stream: SyncStream | null;
  runId: number | null;
  needsContinuation: boolean;
  continuationPriority: number | null;
  continuationRetryAt?: Date | null;
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

function normalizeRunSource(source: SyncRequestSource | null) {
  return source ?? "scheduled";
}

async function resolveContinuationPriority(
  app: Pick<AppContext, "db">,
  platformAccountId: number,
) {
  const pages = await listRunnablePageSync(app.db, new Date());
  return pages.find((page) => page.pageId === platformAccountId)?.priority ?? null;
}

function buildContinuationResult(
  platformAccountId: number,
  stream: SyncStream | null,
  runId: number | null,
  kind: SyncPageChunkResult["kind"],
  continuationPriority: number | null,
  continuationRetryAt: Date | null = null,
): SyncPageChunkResult {
  return {
    kind,
    platformAccountId,
    stream,
    runId,
    needsContinuation: continuationPriority !== null,
    continuationPriority,
    continuationRetryAt,
  };
}

async function buildLeaseLostResult(
  telemetry: SyncRunTelemetry,
  platformAccountId: number,
  runId: number | null,
): Promise<SyncPageChunkResult> {
  await telemetry.recordSkipped("Page sync lease lost");
  return {
    kind: "idle",
    platformAccountId,
    stream: null,
    runId,
    needsContinuation: false,
    continuationPriority: null,
  };
}

async function createChunkTelemetry(
  app: AppContext,
  taskLease: PageSyncLease,
) {
  const storedPage = await findPageById(app.db, taskLease.pageId);
  if (!storedPage) {
    throw new Error(`Page ${taskLease.pageId} not found`);
  }

  const trigger = normalizeRunSource(taskLease.requestSource);
  const run = await startTaskRun(app, taskLease, trigger);
  const telemetry = new SyncRunTelemetry(app, {
    runId: run.id,
    platformAccountId: storedPage.page.id,
    pageLabel: storedPage.page.label,
    provider: storedPage.page.platform,
    stream: taskLease.stream,
    trigger,
    egressKey: taskLease.egressKey,
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
  taskLease: PageSyncLease,
  trigger: SyncRequestSource,
) {
  return startSyncRun(app.db, {
    platformAccountId: taskLease.pageId,
    stream: taskLease.stream,
    generation: taskLease.leasedSeq ?? taskLease.requestSeq,
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
    egressKey: resolveStoredProxyEgressKey(page.proxy),
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

function sanitizeProgressPayload(taskLease: PageSyncLease, stats: Record<string, unknown> | undefined) {
  if (!stats || Object.keys(stats).length === 0) {
    return taskLease.progress;
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
    ...taskLease.progress,
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

function resolveCurrentWorkClass(taskLease: PageSyncLease, stats: Record<string, unknown> | undefined): SyncWorkClass {
  const currentMode = stats?.currentMode;
  if (currentMode === "backfill" || currentMode === "deep_backfill") {
    return "history";
  }
  if (currentMode === "incremental") {
    return "live";
  }
  return taskLease.workClass ?? (taskLease.stream === "dm_messages"
    ? "history"
    : taskLease.stream === "top_spenders" ||
        taskLease.stream === "fan_identities" ||
        taskLease.stream === "followers_reconcile"
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
  await ensurePageSyncStates(app.db, { pageId: platformAccountId });
  await pauseDisabledOnlyFansDmPollingForPage(app, platformAccountId);

  const taskLease = await acquirePageSyncLease(app.db, {
    pageId: platformAccountId,
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
        { err: error, runId: run.id, platformAccountId, stream: taskLease.stream },
        "Failed to record sync worker heartbeat",
      );
    });
  }, SYNC_RUN_HEARTBEAT_MS);
  const leaseHeartbeat = setInterval(() => {
    void heartbeatPageSyncLease(app.db, {
      pageId: platformAccountId,
      stream: taskLease.stream,
      leaseToken: taskLease.leaseToken ?? "",
      leaseTtlMs: SYNC_TASK_LEASE_TTL_MS,
    }).then((owned) => {
      if (!owned) {
        leaseFenced = true;
      }
    }).catch((error) => {
      leaseFenced = true;
      app.logger.warn(
        { err: error, platformAccountId, stream: taskLease.stream },
        "Failed to heartbeat page sync lease",
      );
    });
  }, SYNC_RUN_HEARTBEAT_MS);

  try {
    const pageContext = await resolveExecutorPageContext(app, taskLease.pageId);
    const result = await runWithPageSyncExecutionContext({
      pageId: platformAccountId,
      stream: taskLease.stream,
      requestSeq: taskLease.leasedSeq ?? taskLease.requestSeq,
      leaseToken: taskLease.leaseToken ?? "",
    }, async () => executeStreamChunk(app, {
      pageContext,
      streamState: taskLease,
      syncRunId: run.id,
      telemetry,
      budget,
    }));

    if (leaseFenced) {
      return buildLeaseLostResult(telemetry, platformAccountId, run.id);
    }

    const progress = sanitizeProgressPayload(taskLease, result.stats);
    const phase = resolveCurrentPhase(result.stats);
    const workClass = resolveCurrentWorkClass(taskLease, result.stats);
    const progressAt = hasMeaningfulProgress(result) ? new Date() : taskLease.progressedAt;

    if (result.satisfied) {
      const applied = await completePageSync(app.db, {
        pageId: platformAccountId,
        stream: taskLease.stream,
        requestSeq: taskLease.leasedSeq ?? taskLease.requestSeq,
        leaseToken: taskLease.leaseToken ?? "",
        progressedAt: progressAt,
        phase,
        workClass,
        progress,
      });
      if (!applied) {
        return buildLeaseLostResult(telemetry, platformAccountId, run.id);
      }

      const recoveredAt = new Date();
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
        recoveredAt,
        stream: taskLease.stream,
      });
      const continuationPriority = await resolveContinuationPriority(app, platformAccountId);
      return buildContinuationResult(platformAccountId, taskLease.stream, run.id, "success", continuationPriority);
    }

    const yielded = await yieldPageSync(app.db, {
      pageId: platformAccountId,
      stream: taskLease.stream,
      requestSeq: taskLease.leasedSeq ?? taskLease.requestSeq,
      leaseToken: taskLease.leaseToken ?? "",
      progressedAt: progressAt,
      phase,
      workClass,
      progress,
      retryAt: result.continuationRetryAt ?? null,
      requestSource: result.continuationRequestSource ?? null,
    });
    if (!yielded) {
      return buildLeaseLostResult(telemetry, platformAccountId, run.id);
    }

    const recoveredAt = new Date();
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
      recoveredAt,
      stream: taskLease.stream,
    });
    const continuationRetryAt = result.continuationRetryAt ?? null;
    const continuationRequestSource = result.continuationRequestSource ?? normalizeRunSource(taskLease.requestSource);
    const continuationPriority = continuationRetryAt
      ? resolvePageSyncPriority(taskLease.stream, continuationRequestSource)
      : await resolveContinuationPriority(app, platformAccountId);
    return buildContinuationResult(
      platformAccountId,
      taskLease.stream,
      run.id,
      "yielded",
      continuationPriority,
      continuationRetryAt,
    );
  } catch (error) {
    if (error instanceof PageSyncLeaseLostError) {
      return buildLeaseLostResult(telemetry, platformAccountId, run.id);
    }
    if (leaseFenced) {
      return buildLeaseLostResult(telemetry, platformAccountId, run.id);
    }

    const failure = normalizeSyncError(error, {
      endpoint: taskLease.stream,
      action: `executing ${taskLease.stream} sync chunk`,
    });
    const failedAt = new Date();
    const provider = storedPage.page.platform;
    const pageLabel = storedPage.page.label;
    const hasProxy = storedPage.proxy !== null;

    if (isAuthError(error)) {
      const blockResult = await blockPageSync(app.db, {
        pageId: platformAccountId,
        stream: taskLease.stream,
        requestSeq: taskLease.leasedSeq ?? taskLease.requestSeq,
        leaseToken: taskLease.leaseToken ?? "",
        blockerKind: "auth",
        blockerCode: "credentials_invalid",
        blockerMessage: failure.summary,
        errorCode: failure.error.code,
        errorSummary: failure.summary,
        phase: taskLease.phase,
        workClass: taskLease.workClass ?? "live",
        progress: taskLease.progress,
        now: failedAt,
      });
      if (!blockResult.updated) {
        return buildLeaseLostResult(telemetry, platformAccountId, run.id);
      }
      if (!blockResult.blocked) {
        await telemetry.finish("failed", failure, {
          chunkStatus: "stale_block",
        });
        const continuationPriority = await resolveContinuationPriority(app, platformAccountId);
        return buildContinuationResult(platformAccountId, taskLease.stream, run.id, "failed", continuationPriority);
      }

      await persistFailedSyncPayload(app, {
        platformAccountId,
        syncRunId: run.id,
        endpoint: taskLease.stream,
        platform: provider,
        failure,
      });
      await telemetry.finish("failed", failure, {
        chunkStatus: "blocked",
      });
      await notifyAuthFailedIncident(app, {
        platformAccountId,
        pageLabel,
        platform: provider,
        errorCode: failure.error.code,
        errorSummary: failure.summary,
        occurredAt: failedAt,
      });
      return {
        kind: "blocked",
        platformAccountId,
        stream: taskLease.stream,
        runId: run.id,
        needsContinuation: false,
        continuationPriority: null,
      };
    }

    const classified = classifyTaskFailure(error, failure);
    if (classified.mode === "blocked") {
      const blockResult = await blockPageSync(app.db, {
        pageId: platformAccountId,
        stream: taskLease.stream,
        requestSeq: taskLease.leasedSeq ?? taskLease.requestSeq,
        leaseToken: taskLease.leaseToken ?? "",
        blockerKind: classified.blockerType ?? "manual_action_required",
        blockerCode: classified.blockerCode ?? "manual_action_required",
        blockerMessage: classified.blockerReason ?? failure.summary,
        errorCode: failure.error.code,
        errorSummary: failure.summary,
        phase: taskLease.phase,
        workClass: taskLease.workClass ?? "live",
        progress: taskLease.progress,
        now: failedAt,
      });
      if (!blockResult.updated) {
        return buildLeaseLostResult(telemetry, platformAccountId, run.id);
      }
      if (!blockResult.blocked) {
        await telemetry.finish("failed", failure, {
          chunkStatus: "stale_block",
        });
        const continuationPriority = await resolveContinuationPriority(app, platformAccountId);
        return buildContinuationResult(platformAccountId, taskLease.stream, run.id, "failed", continuationPriority);
      }
    } else {
      const retryResult = await retryPageSync(app.db, {
        pageId: platformAccountId,
        stream: taskLease.stream,
        requestSeq: taskLease.leasedSeq ?? taskLease.requestSeq,
        leaseToken: taskLease.leaseToken ?? "",
        retryKind: classified.retryClass ?? "transient_network",
        errorCode: failure.error.code,
        errorSummary: failure.summary,
        phase: taskLease.phase,
        workClass: taskLease.workClass ?? "live",
        progress: taskLease.progress,
        now: failedAt,
      });
      if (!retryResult.updated) {
        return buildLeaseLostResult(telemetry, platformAccountId, run.id);
      }
      if (!retryResult.retried) {
        await telemetry.finish("failed", failure, {
          chunkStatus: "stale_retry",
        });
        const continuationPriority = await resolveContinuationPriority(app, platformAccountId);
        return buildContinuationResult(platformAccountId, taskLease.stream, run.id, "failed", continuationPriority);
      }
    }

    await persistFailedSyncPayload(app, {
      platformAccountId,
      syncRunId: run.id,
      endpoint: taskLease.stream,
      platform: provider,
      failure,
    });
    await telemetry.finish("failed", failure, {
      chunkStatus: "failed",
    });
    await notifySyncChunkFailureIncident(app, {
      platformAccountId,
      pageLabel,
      platform: provider,
      stream: taskLease.stream,
      runId: run.id,
      hasProxy,
      previousConsecutiveFailures: taskLease.consecutiveFailures,
      errorCode: failure.error.code,
      errorSummary: failure.summary,
      occurredAt: failedAt,
    });
    const continuationPriority = classified.mode === "retry"
      ? await resolveContinuationPriority(app, platformAccountId)
      : null;
    return buildContinuationResult(platformAccountId, taskLease.stream, run.id, "failed", continuationPriority);
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
      const delayedContinuation = result.continuationRetryAt !== null && result.continuationRetryAt !== undefined;
      const wakeupId = await sendSyncPageWakeup(boss, {
        platformAccountId: result.platformAccountId,
        priority: result.continuationPriority,
        provider: wakeupTarget.provider,
        egressKey: wakeupTarget.egressKey,
        dedupe: delayedContinuation ? true : false,
        singletonKey: delayedContinuation
          ? `${result.platformAccountId}:dm-messages-deep-continuation`
          : undefined,
        startAfter: result.continuationRetryAt ?? null,
      });

      if ((wakeupId !== null && wakeupId !== undefined) || delayedContinuation) {
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
