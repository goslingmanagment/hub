import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  acquirePageSyncLease,
  blockPageSync,
  clearPageSyncLease,
  completePageSync,
  ensurePageSyncStates,
  findPageById,
  heartbeatPageSyncLease,
  listRunnableOfapiCapturePages,
  listRunnablePageSync,
  PageSyncLeaseLostError,
  retryPageSync,
  resolvePageSyncPriority,
  runWithPageSyncExecutionContext,
  skipPageSync,
  startSyncRun,
  type PageSyncLease,
  type SyncRequestSource,
  type SyncStream,
  type SyncWorkClass,
  yieldPageSync,
  getSyncStreamsForPlatform,
  pausePageSyncForAuth,
} from "@agency_hub_core/db";
import { FanslyApiError, FanslyProxyMissingError } from "@agency_hub_core/fansly";
import type { Db as PgBossDb, JobWithMetadata, PgBoss } from "pg-boss";

import type { AppContext } from "../../bootstrap.ts";
import { ProxyMissingError } from "../errors.ts";
import {
  executeOfapiCaptureJobChunk,
  isOfapiBackgroundCaptureRunnable,
} from "../ofapi-capture-jobs.ts";
import { OfapiApiError, ofapiAccountNotFound } from "../ofapi.ts";
import {
  notifyAuthFailedIncident,
  notifyOfapiGlobalIncident,
  notifySyncChunkFailureIncident,
  resolveOfapiGlobalIncident,
  resolveSyncChunkRecoveryIncidents,
} from "../notification-incidents.ts";
import { resolveStoredProxyEgressKey } from "../page-context.ts";
import {
  sendSyncPageWakeup,
  SYNC_PAGE_EXECUTE_EXPIRE_SECONDS,
  SYNC_PAGE_EXECUTE_QUEUE,
  SYNC_PAGE_EXECUTE_RETRY_LIMIT,
  type SyncPageExecutePayload,
} from "../sync-queue.ts";
import { pageSyncDependencyInput } from "./dependencies.ts";
import {
  buildNormalizedSyncError,
  FanslyPurchaseHistoryContractError,
  FollowersReconcileConsistencyError,
} from "./errors.ts";
import { executeStreamChunk, resolveExecutorPageContext } from "./executor-handlers.ts";
import { SyncChunkBudget } from "./chunk-budget.ts";
import { pauseDisabledOnlyFansDmPollingForPage } from "./onlyfans-dm-polling.ts";
import {
  PostsCaptureConfigurationError,
  PostsCaptureJobBlockedError,
} from "./posts.ts";
import { SyncRunTelemetry } from "./observability.ts";
import { persistFailedSyncPayload } from "./shared.ts";

const PAGE_EXECUTOR_IDLE_POLL_MS = 1_000;
const PAGE_EXECUTOR_HEARTBEAT_MS = 15_000;
const SYNC_RUN_HEARTBEAT_MS = 30_000;
const SYNC_TASK_LEASE_TTL_MS = 120_000;
const MAX_LOCAL_EXECUTOR_CHUNKS = 500;
const SYNC_PAGE_EXECUTE_HANDOFF_GUARD_MS = 60_000;

export interface SyncPageChunkResult {
  kind: "idle" | "success" | "skipped" | "yielded" | "failed" | "blocked";
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
  if (error instanceof FanslyApiError) {
    return error.status === 401 || error.status === 403;
  }

  return false;
}

function normalizeRunSource(source: SyncRequestSource | null) {
  return source ?? "scheduled";
}

async function resolveContinuationPriority(
  app: Pick<AppContext, "db" | "config">,
  platformAccountId: number,
) {
  const pages = await listRunnablePageSync(app.db, new Date());
  const legacyPriority = pages.find((page) => page.pageId === platformAccountId)?.priority ?? null;
  if (!isOfapiBackgroundCaptureRunnable(app.config)) {
    return legacyPriority;
  }
  const capturePages = await listRunnableOfapiCapturePages(app.db);
  const capturePriority = capturePages.find((page) => page.pageId === platformAccountId)?.priority
    ?? null;
  if (legacyPriority === null) return capturePriority;
  if (capturePriority === null) return legacyPriority;
  return Math.max(legacyPriority, capturePriority);
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
  storedPage: NonNullable<Awaited<ReturnType<typeof findPageById>>>,
) {
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

/**
 * Decision #245: OFAPI `402 Payment Required` is the credit pool running dry —
 * an account-wide operations state, not a network blip. The stream keeps its
 * ordinary bounded retry (OFAPI does not charge a 402-rejected request, so the
 * probe is free and the lane heals itself after a top-up) but under its own
 * retry class so the monitor names the cause. The owner hears about it ONCE:
 * the executor opens the SAME global latch the credit-ledger monitor uses
 * (`ofapi_low_credit:global`, deliberately no subKey — two latches for one
 * pool would mean two Telegram messages and a monitor that cannot close the
 * executor's), suppresses the per-stream threshold alert for this class, and
 * resolves the latch only from a chunk that actually got an OFAPI response —
 * a partial yielded by the credit floor or the daily budget BEFORE any request
 * proves nothing about the pool and must not read as recovery.
 */
export const OFAPI_INSUFFICIENT_CREDITS_RETRY_CLASS = "ofapi_insufficient_credits";
export const OFAPI_INSUFFICIENT_CREDITS_INCIDENT = { kind: "ofapi_low_credit" } as const;

function classifyOfapiApiError(
  error: OfapiApiError,
  failure: ReturnType<typeof buildNormalizedSyncError>,
): ReturnType<typeof classifyTaskFailure> {
  const status = error.status;
  if (ofapiAccountNotFound(status, error.body)) return {
    mode: "blocked", blockerType: "manual_action_required", blockerCode: "ofapi_account_not_found",
    blockerReason: "OFAPI account binding is unavailable",
  };
  if (status === null) {
    // A transport failure before any status: the one shape the old generic
    // fallback described correctly.
    return { mode: "retry", retryClass: "transient_network" };
  }
  if (status === 402) {
    return { mode: "retry", retryClass: OFAPI_INSUFFICIENT_CREDITS_RETRY_CLASS };
  }
  if (status === 429) {
    return { mode: "retry", retryClass: "rate_limit" };
  }
  if (status >= 500) {
    return { mode: "retry", retryClass: "provider_5xx" };
  }
  if (status === 401 || status === 403) {
    // Our OFAPI key or the account mapping, never the page's own platform
    // session: park the stream for an operator, do not pause the page for a
    // re-login it cannot perform.
    return {
      mode: "blocked",
      blockerType: "manual_action_required",
      blockerCode: `ofapi_http_${status}`,
      blockerReason: failure.summary,
    };
  }
  if (status >= 400) {
    return {
      mode: "blocked",
      blockerType: "provider_bad_data",
      blockerCode: `ofapi_http_${status}`,
      blockerReason: failure.summary,
    };
  }
  return { mode: "retry", retryClass: "transient_network" };
}

async function resolveOfapiCreditsIncidentIfRecovered(
  app: Pick<AppContext, "config" | "db" | "logger">,
  taskLease: { retryKind: string | null },
  budget: Pick<SyncChunkBudget, "totalRequests">,
  recoveredAt: Date,
) {
  if (taskLease.retryKind !== OFAPI_INSUFFICIENT_CREDITS_RETRY_CLASS) {
    return;
  }
  if (budget.totalRequests === 0) {
    // Yielded before the first request (credit floor, daily budget, wall
    // clock): the pool was never consulted, so nothing recovered.
    return;
  }
  await resolveOfapiGlobalIncident(app, { ...OFAPI_INSUFFICIENT_CREDITS_INCIDENT, recoveredAt });
}

function classifyTaskFailure(
  error: unknown,
  failure: ReturnType<typeof buildNormalizedSyncError>,
  input: {
    previousConsecutiveFailures: number;
    previousRetryKind: string | null;
  },
): {
  mode: "retry" | "blocked";
  retryClass?: string;
  blockerType?: string;
  blockerCode?: string;
  blockerReason?: string;
} {
  if (error instanceof PostsCaptureJobBlockedError) {
    return {
      mode: "blocked",
      blockerType: "manual_action_required",
      blockerCode: `ofapi_capture_job_${error.reasonCode}`,
      blockerReason: failure.summary,
    };
  }

  if (error instanceof PostsCaptureConfigurationError) {
    return {
      mode: "retry",
      retryClass: "configuration_wait",
    };
  }

  // W3.1 (decision #124): a refused proxyless resolution is a config state,
  // not a transient — park the stream (manual action: assign a proxy) instead
  // of hot-retrying a guaranteed refusal every cycle.
  if (error instanceof ProxyMissingError || error instanceof FanslyProxyMissingError) {
    return {
      mode: "blocked",
      blockerType: "manual_action_required",
      blockerCode: "proxy_missing",
      blockerReason: failure.summary,
    };
  }

  if (error instanceof FollowersReconcileConsistencyError) {
    if (error.retryable) {
      return {
        mode: "retry",
        retryClass: "followers_reconcile_snapshot_drift",
      };
    }
    return {
      mode: "blocked",
      blockerType: "provider_bad_data",
      blockerCode: error.code,
      blockerReason: failure.summary,
    };
  }

  if (error instanceof FanslyPurchaseHistoryContractError) {
    return {
      mode: "blocked",
      blockerType: "provider_bad_data",
      blockerCode: error.code,
      blockerReason: failure.summary,
    };
  }

  if (error instanceof FanslyApiError) {
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

    if (error.status === 404) {
      const previous404Failures = input.previousRetryKind === "provider_404"
        ? input.previousConsecutiveFailures
        : 0;
      if (previous404Failures < 2) {
        return {
          mode: "retry",
          retryClass: "provider_404",
        };
      }

      return {
        mode: "blocked",
        blockerType: "provider_bad_data",
        blockerCode: "provider_404_exhausted",
        blockerReason: failure.summary,
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

  if (error instanceof OfapiApiError) {
    return classifyOfapiApiError(error, failure);
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

function sanitizeProgressPayload(stats: Record<string, unknown> | undefined) {
  if (!stats || Object.keys(stats).length === 0) {
    return {};
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

  return next;
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
    gatedSkip?: string | null;
    stats?: Record<string, unknown>;
  },
) {
  // A ramp-gated chunk issued zero requests. Treating it as progress moved
  // progressed_at on every cycle and made a frozen stream look alive.
  if (result.gatedSkip) return false;
  return result.satisfied || Boolean(result.stats && Object.keys(result.stats).length > 0);
}
export async function executeNextSyncPageChunk(
  app: AppContext,
  platformAccountId: number,
): Promise<SyncPageChunkResult> {
  const dependencyInput = pageSyncDependencyInput(app);
  await ensurePageSyncStates(app.db, { pageId: platformAccountId, ...dependencyInput });
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

  const storedPage = await findPageById(app.db, taskLease.pageId);
  if (!storedPage) {
    // The page was tombstoned between scheduling and lease acquisition (the
    // planner filters on status='active' are the primary guard). Release the
    // lease as paused and go idle — a deleted page must never loop the
    // executor through throw/reclaim cycles.
    await clearPageSyncLease(app.db, {
      pageId: platformAccountId,
      stream: taskLease.stream,
      leaseToken: taskLease.leaseToken ?? "",
      nextStatus: "paused",
    });
    app.logger.warn(
      { platformAccountId, stream: taskLease.stream },
      "Sync lease acquired for a missing or tombstoned page — lease released, stream paused",
    );
    return {
      kind: "idle",
      platformAccountId,
      stream: null,
      runId: null,
      needsContinuation: false,
      continuationPriority: null,
    };
  }

  const { run, telemetry } = await createChunkTelemetry(app, taskLease, storedPage);
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
    const pageContext = await resolveExecutorPageContext(app, taskLease.pageId, taskLease.stream);
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

    const progress = sanitizeProgressPayload(result.stats);
    const phase = resolveCurrentPhase(result.stats);
    const workClass = resolveCurrentWorkClass(taskLease, result.stats);
    const progressAt = hasMeaningfulProgress(result) ? new Date() : taskLease.progressedAt;

    if (result.satisfied) {
      const skipped = Boolean(result.gatedSkip);
      const held = !skipped && Boolean(result.qualityHold);
      const applied = skipped || held
        ? await skipPageSync(app.db, {
          pageId: platformAccountId,
          stream: taskLease.stream,
          requestSeq: taskLease.leasedSeq ?? taskLease.requestSeq,
          leaseToken: taskLease.leaseToken ?? "",
          phase,
          workClass,
          progress,
          ...dependencyInput,
        })
        : await completePageSync(app.db, {
          pageId: platformAccountId,
          stream: taskLease.stream,
          requestSeq: taskLease.leasedSeq ?? taskLease.requestSeq,
          leaseToken: taskLease.leaseToken ?? "",
          progressedAt: progressAt,
          phase,
          workClass,
          progress,
          ...dependencyInput,
        });
      if (!applied) {
        return buildLeaseLostResult(telemetry, platformAccountId, run.id);
      }

      if (skipped) {
        // The run outcome must not read as a success either: sync_runs feeds
        // buildStreamSyncUx and the CLI snapshot. And a gated skip must NOT
        // resolve incidents — resolveSyncChunkRecoveryIncidents closes
        // stream_failed_threshold, which would clear an alert while the
        // failure streak it was raised for is still on the row untouched.
        await telemetry.finish("skipped", result.gatedSkip, {
          chunkBudget: {
            requestCount: budget.totalRequests,
            elapsedMs: budget.elapsedMs,
          },
          ...result.stats,
          // Written AFTER the spread so a handler cannot clobber it, and under
          // its own key rather than reusing `stats.skipped`: this is the marker
          // a UX state is keyed on. The `skipped` OUTCOME is NOT that marker —
          // recordSkipped (lost lease) has been writing that outcome for every
          // stream since long before ramp gates existed.
          gatedSkip: result.gatedSkip,
        });
      } else if (held) {
        await telemetry.finish("skipped", result.qualityHold, {
          chunkBudget: {
            requestCount: budget.totalRequests,
            elapsedMs: budget.elapsedMs,
          },
          ...result.stats,
          qualityHold: result.qualityHold,
        });
      } else {
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
        await resolveOfapiCreditsIncidentIfRecovered(app, taskLease, budget, recoveredAt);
      }

      // Shared tail on purpose: this "success" is the CHUNK SCHEDULER's
      // outcome, not the sync's. A gated skip has nothing to retry, so telling
      // the scheduler otherwise would only spin the executor.
      const continuationPriority = await resolveContinuationPriority(app, platformAccountId);
      return buildContinuationResult(
        platformAccountId,
        taskLease.stream,
        run.id,
        skipped || held ? "skipped" : "success",
        continuationPriority,
      );
    }

    // Request priority is an admission boost, not a lease on the queue. A
    // generic partial run consumes that boost in one chunk and re-enters as
    // scheduled work; otherwise a long manual/onboarding backfill can create
    // an endless chain of high-priority successors and starve its egress
    // peers. Handlers may still choose an explicit continuation source.
    const continuationRequestSource = result.continuationRequestSource ?? "scheduled";
    const yieldResult = await yieldPageSync(app.db, {
      pageId: platformAccountId,
      stream: taskLease.stream,
      requestSeq: taskLease.leasedSeq ?? taskLease.requestSeq,
      leaseToken: taskLease.leaseToken ?? "",
      progressedAt: progressAt,
      phase,
      workClass,
      progress,
      retryAt: result.continuationRetryAt ?? null,
      dispatchSource: continuationRequestSource,
    });
    if (!yieldResult.updated) {
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
    await resolveOfapiCreditsIncidentIfRecovered(app, taskLease, budget, recoveredAt);
    // A newer request OR another stream on this page may already be runnable.
    // Immediate page work wins over this stream's delayed yield; otherwise a
    // deferred retry stays only in page_sync_states for the planner to wake.
    const immediateContinuationPriority = await resolveContinuationPriority(app, platformAccountId);
    const continuationRetryAt = yieldResult.superseded || immediateContinuationPriority !== null
      ? null
      : result.continuationRetryAt ?? null;
    const continuationPriority = immediateContinuationPriority ?? (continuationRetryAt
      ? resolvePageSyncPriority(taskLease.stream, continuationRequestSource)
      : null);
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

    const failure = buildNormalizedSyncError(error, {
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
      // Stage 26: a dead session is dead for the WHOLE page — park every
      // stream (paused + blocker_kind='auth') so no other stream keeps
      // burning quota against it. Successful re-verify restores via
      // clearPageSyncAuthBlock (handleSuccessfulPageVerificationRecovery).
      try {
        await pausePageSyncForAuth(app.db, {
          pageId: platformAccountId,
          streams: getSyncStreamsForPlatform(provider),
          blockerCode: "credentials_invalid",
          blockerMessage: failure.summary,
          now: failedAt,
        });
      } catch (pauseError) {
        app.logger.warn(
          { platformAccountId, err: pauseError },
          "Auth-dead page pause failed; the failing stream stays blocked",
        );
      }
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

    const classified = classifyTaskFailure(error, failure, {
      previousConsecutiveFailures: taskLease.consecutiveFailures,
      previousRetryKind: taskLease.retryKind,
    });
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
    if (classified.retryClass === OFAPI_INSUFFICIENT_CREDITS_RETRY_CLASS) {
      // One pool, one alarm: the per-stream threshold alert is skipped so the
      // owner does not get "stream failed 3x" per OFAPI stream on top of it.
      await notifyOfapiGlobalIncident(app, {
        ...OFAPI_INSUFFICIENT_CREDITS_INCIDENT,
        errorSummary: `OFAPI rejected a request with 402 Payment Required (insufficient credits): ${failure.summary}`,
        occurredAt: failedAt,
      });
    } else {
      await notifySyncChunkFailureIncident(app, {
        platformAccountId,
        pageLabel,
        platform: provider,
        stream: taskLease.stream,
        runId: run.id,
        hasProxy,
        previousConsecutiveFailures: taskLease.consecutiveFailures,
        forceOpen: classified.mode === "blocked",
        errorCode: failure.error.code,
        errorSummary: failure.summary,
        occurredAt: failedAt,
      });
    }
    const continuationPriority = classified.mode === "retry"
      ? await resolveContinuationPriority(app, platformAccountId)
      : null;
    return buildContinuationResult(platformAccountId, taskLease.stream, run.id, "failed", continuationPriority);
  } finally {
    clearInterval(runHeartbeat);
    clearInterval(leaseHeartbeat);
  }
}

export async function executeNextPageWorkChunk(
  app: AppContext,
  platformAccountId: number,
): Promise<SyncPageChunkResult> {
  if (isOfapiBackgroundCaptureRunnable(app.config)) {
    const [legacyPages, capturePages] = await Promise.all([
      listRunnablePageSync(app.db, new Date()),
      listRunnableOfapiCapturePages(app.db),
    ]);
    const legacyPriority = legacyPages.find((page) => page.pageId === platformAccountId)?.priority
      ?? null;
    const capturePriority = capturePages.find((page) => page.pageId === platformAccountId)?.priority
      ?? null;
    if (
      capturePriority !== null &&
      (legacyPriority === null || capturePriority >= legacyPriority)
    ) {
      const captured = await executeOfapiCaptureJobChunk(app, platformAccountId);
      const continuationPriority = await resolveContinuationPriority(app, platformAccountId);
      return buildContinuationResult(
        platformAccountId,
        null,
        null,
        captured.kind,
        continuationPriority,
      );
    }
  }
  return executeNextSyncPageChunk(app, platformAccountId);
}

function readPgBossAffected(response: unknown): number {
  if (
    typeof response === "object" &&
    response !== null &&
    "affected" in response &&
    typeof response.affected === "number" &&
    Number.isInteger(response.affected)
  ) {
    return response.affected;
  }

  // pg-boss 12.14 returns { jobs, requested, affected } at runtime, but its
  // published CommandResponse type is empty. Fail closed if that runtime
  // contract changes; otherwise ownership would silently become ambiguous.
  throw new Error("pg-boss completion response did not contain an integer affected count");
}

export async function processSyncPageExecuteJob(
  app: AppContext,
  boss: Pick<PgBoss, "complete" | "send">,
  input: {
    job: Pick<
      JobWithMetadata<SyncPageExecutePayload>,
      "id" | "data" | "groupId" | "startedOn" | "expireInSeconds" | "retryLimit" | "singletonKey"
    >;
  },
) {
  // One queue job owns exactly one chunk. Continuations always return to
  // pg-boss, which is the sole fairness arbiter for pages sharing an egress
  // group. Never drain locally: doing so bypasses queue priority/group
  // scheduling and turns one slow page into a group-wide wedge.
  const isGrandfatheredAttempt =
    input.job.expireInSeconds !== SYNC_PAGE_EXECUTE_EXPIRE_SECONDS ||
    input.job.retryLimit !== SYNC_PAGE_EXECUTE_RETRY_LIMIT ||
    input.job.singletonKey !== String(input.job.data.platformAccountId);
  const grandfatheredWakeupTarget = isGrandfatheredAttempt
    ? await resolveSyncPageWakeupTarget(app, input.job.data.platformAccountId)
    : null;
  const grandfatheredPriority = grandfatheredWakeupTarget
    ? await resolveContinuationPriority(app, input.job.data.platformAccountId) ?? 0
    : null;
  const result = isGrandfatheredAttempt
    ? buildContinuationResult(
      input.job.data.platformAccountId,
      null,
      null,
      "idle",
      grandfatheredPriority,
    )
    : await executeNextPageWorkChunk(app, input.job.data.platformAccountId);

  if (isGrandfatheredAttempt) {
    app.logger.warn(
      {
        jobId: input.job.id,
        platformAccountId: input.job.data.platformAccountId,
        expireInSeconds: input.job.expireInSeconds,
        retryLimit: input.job.retryLimit,
        singletonKey: input.job.singletonKey,
      },
      "Detected grandfathered sync page wakeup; attempting atomic rollover before vendor work",
    );
  }

  let wakeupTarget: Awaited<ReturnType<typeof resolveSyncPageWakeupTarget>> = grandfatheredWakeupTarget;
  if (
    !wakeupTarget &&
    result.needsContinuation &&
    result.continuationPriority !== null &&
    !result.continuationRetryAt
  ) {
    wakeupTarget = await resolveSyncPageWakeupTarget(app, result.platformAccountId);
  }

  // complete -> send must be atomic. Sending first self-collides with the
  // active parent in an exclusive queue; completing first without a shared
  // transaction creates a crash gap. pg-boss explicitly supports a caller-
  // supplied DB wrapper for both commands, so the active row leaves the
  // partial unique index and its stable-lane child enters it in one commit.
  const client = await app.pool.connect();
  let transactionOpen = false;
  let releaseError: Error | undefined;
  try {
    // started_on and the expiry transition are owned by PostgreSQL. Compare
    // them to the same clock here: process time can be skewed enough to either
    // abandon a live job or mutate one after pg-boss has expired it.
    const deadlineCheck = await client.query<{ safe: boolean }>(
      `
        select clock_timestamp() <
               $1::timestamptz
               + ($2::double precision * interval '1 second')
               - ($3::double precision * interval '1 millisecond') as "safe"
      `,
      [
        input.job.startedOn,
        input.job.expireInSeconds,
        SYNC_PAGE_EXECUTE_HANDOFF_GUARD_MS,
      ],
    );
    if (deadlineCheck.rows[0]?.safe !== true) {
      app.logger.warn(
        {
          jobId: input.job.id,
          platformAccountId: result.platformAccountId,
          startedOn: input.job.startedOn,
          expireInSeconds: input.job.expireInSeconds,
        },
        "Sync page execute job crossed its safe handoff deadline; planner will reconcile durable page state",
      );
      return result;
    }

    await client.query("begin");
    transactionOpen = true;
    const queueDb: PgBossDb = {
      executeSql: (text, values) => client.query(text, values),
    };
    const completion = await boss.complete(
      SYNC_PAGE_EXECUTE_QUEUE,
      input.job.id,
      null,
      { db: queueDb },
    );
    if (readPgBossAffected(completion) !== 1) {
      await client.query("rollback");
      transactionOpen = false;
      app.logger.warn(
        { jobId: input.job.id, platformAccountId: result.platformAccountId },
        "Sync page execute job no longer owns its queue attempt; skipping handoff",
      );
      return result;
    }

    if (wakeupTarget && result.continuationPriority !== null) {
      await sendSyncPageWakeup(boss, {
        platformAccountId: result.platformAccountId,
        priority: result.continuationPriority,
        provider: wakeupTarget.provider,
        egressKey: wakeupTarget.egressKey,
        db: queueDb,
      });
    }

    await client.query("commit");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("rollback");
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error
          ? rollbackError
          : new Error(String(rollbackError));
        throw new AggregateError(
          [error, releaseError],
          "Sync page queue handoff failed and its transaction could not be rolled back",
          { cause: rollbackError },
        );
      }
    }
    throw error;
  } finally {
    // A client whose rollback failed must be destroyed, never returned to the
    // shared pool with an unknown/open transaction state.
    client.release(releaseError);
  }

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
          // Page jobs are FIFO within the available groups. Strict numeric
          // priority has no aging in pg-boss: a continuously replaced
          // priority-30 page can starve an older priority-25 singleton
          // forever, including after that page receives a manual request.
          // Stream priority remains durable inside page_sync_states; the
          // fixed page singleton and tail-inserted successor provide the
          // cross-page fairness quantum.
          priority: false,
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
    const result = await executeNextPageWorkChunk(app, platformAccountId);
    if (result.kind === "idle") {
      return result;
    }

    if (!result.needsContinuation) {
      return result;
    }
  }

  throw new Error(`Sync page executor exceeded ${maxChunks} local chunks for page ${platformAccountId}`);
}
