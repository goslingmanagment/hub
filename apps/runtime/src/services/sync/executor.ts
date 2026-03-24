import { setTimeout as delay } from "node:timers/promises";

import {
  ensureSyncStreamStateRows,
  findPageById,
  listRunnableSyncStreamStatesForPage,
  markSyncPageAuthFailed,
  recordSyncStreamChunkFailure,
  recordSyncStreamChunkStarted,
  recordSyncStreamChunkSucceeded,
  recordSyncStreamChunkYielded,
  startSyncRun,
  type SyncControlStream,
  type SyncStreamStateRow,
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

function buildContinuationResult(
  platformAccountId: number,
  stream: SyncControlStream | null,
  runId: number | null,
  kind: SyncPageChunkResult["kind"],
  nextRows: SyncStreamStateRow[],
): SyncPageChunkResult {
  return {
    kind,
    platformAccountId,
    stream,
    runId,
    needsContinuation: nextRows.length > 0,
    continuationPriority: nextRows[0]?.effectivePriority ?? null,
  };
}

async function createChunkTelemetry(
  app: AppContext,
  streamState: SyncStreamStateRow,
) {
  const storedPage = await findPageById(app.db, streamState.platformAccountId);
  if (!storedPage) {
    throw new Error(`Page ${streamState.platformAccountId} not found`);
  }

  const run = await startSyncRun(app.db, {
    platformAccountId: storedPage.page.id,
    stream: streamState.stream,
    trigger: streamState.pendingReason,
  });
  const telemetry = new SyncRunTelemetry(app, {
    runId: run.id,
    platformAccountId: storedPage.page.id,
    pageLabel: storedPage.page.label,
    provider: storedPage.page.platform,
    stream: streamState.stream,
    trigger: streamState.pendingReason,
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

export async function executeNextSyncPageChunk(
  app: AppContext,
  platformAccountId: number,
): Promise<SyncPageChunkResult> {
  await ensureSyncStreamStateRows(app.db, { platformAccountId });

  const runnableRows = await listRunnableSyncStreamStatesForPage(app.db, platformAccountId);
  const streamState = runnableRows[0];
  if (!streamState) {
    return {
      kind: "idle",
      platformAccountId,
      stream: null,
      runId: null,
      needsContinuation: false,
      continuationPriority: null,
    };
  }

  const { storedPage, run, telemetry } = await createChunkTelemetry(app, streamState);
  const budget = new SyncChunkBudget();
  await recordSyncStreamChunkStarted(app.db, platformAccountId, streamState.stream);
  let pageContext: Awaited<ReturnType<typeof resolveExecutorPageContext>> | null = null;
  const runHeartbeat = setInterval(() => {
    void telemetry.recordWorkerHeartbeat().catch((error) => {
      app.logger.warn(
        { err: error, runId: run.id, platformAccountId, stream: streamState.stream },
        "Failed to record sync worker heartbeat",
      );
    });
  }, SYNC_RUN_HEARTBEAT_MS);

  try {
    pageContext = await resolveExecutorPageContext(app, streamState.platformAccountId);
    const result = await executeStreamChunk(app, {
      pageContext,
      streamState,
      syncRunId: run.id,
      telemetry,
      budget,
    });

    if (result.satisfied) {
      await recordSyncStreamChunkSucceeded(app.db, {
        platformAccountId,
        stream: streamState.stream,
        satisfied: true,
        targetRevision: streamState.desiredRevision,
        clearRequestPayload: "clearRequestPayload" in result ? result.clearRequestPayload : undefined,
      });
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
        stream: streamState.stream,
      });
      const nextRows = await listRunnableSyncStreamStatesForPage(app.db, platformAccountId);
      return buildContinuationResult(platformAccountId, streamState.stream, run.id, "success", nextRows);
    }

    await recordSyncStreamChunkYielded(app.db, platformAccountId, streamState.stream);
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
      stream: streamState.stream,
    });
    const nextRows = await listRunnableSyncStreamStatesForPage(app.db, platformAccountId);
    return buildContinuationResult(platformAccountId, streamState.stream, run.id, "yielded", nextRows);
  } catch (error) {
    const failure = normalizeSyncError(error, {
      endpoint: streamState.stream,
      action: `executing ${streamState.stream} sync chunk`,
    });
    const provider = pageContext?.platform ?? telemetry.metadata.provider;
    const pageLabel = pageContext?.page.label ?? telemetry.metadata.pageLabel;
    const hasProxy = pageContext ? pageContext.proxy !== null : storedPage.proxy !== null;

    await persistFailedSyncPayload(app, {
      platformAccountId,
      syncRunId: run.id,
      endpoint: streamState.stream,
      platform: provider,
      failure,
    });

    if (isAuthError(error)) {
      await markSyncPageAuthFailed(app.db, {
        platformAccountId,
        errorCode: failure.error.code,
        errorSummary: failure.summary,
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
        stream: streamState.stream,
        runId: run.id,
        needsContinuation: false,
        continuationPriority: null,
      };
    }

    await recordSyncStreamChunkFailure(app.db, {
      platformAccountId,
      stream: streamState.stream,
      errorCode: failure.error.code,
      errorSummary: failure.summary,
    });
    await telemetry.finish("failed", failure, {
      chunkStatus: "failed",
    });
    await notifySyncChunkFailureIncident(app, {
      platformAccountId,
      pageLabel,
      platform: provider,
      stream: streamState.stream,
      runId: run.id,
      hasProxy,
      previousConsecutiveFailures: streamState.consecutiveFailures,
      errorCode: failure.error.code,
      errorSummary: failure.summary,
    });
    const nextRows = await listRunnableSyncStreamStatesForPage(app.db, platformAccountId);
    return buildContinuationResult(platformAccountId, streamState.stream, run.id, "failed", nextRows);
  } finally {
    clearInterval(runHeartbeat);
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
