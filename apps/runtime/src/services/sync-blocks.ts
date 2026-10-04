import {
  deleteCheckpoints,
  deletePageTopSpenders,
  ensurePageSyncStates,
  findPageByLabel,
  listPageSyncStates,
  pausePageSync,
  requestPageSync as requestPageSyncRows,
  resetPageDmSyncState,
  resetPageSync,
  resolvePageSyncPriority,
  resumePageSync,
  SYNC_DOMAIN_POLICY,
  type LegacyExecutorStream,
  type SyncStream,
} from "@agency_hub_core/db";
import type { Platform } from "@agency_hub_core/shared";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, ConflictError, LegacySyncRetiredError, NotFoundError } from "./errors.ts";
import { resolveStoredProxyEgressKey } from "./page-context.ts";
import { pageSyncDependencyInput } from "./sync/dependencies.ts";
import {
  getSyncStatusSnapshot,
  SYNC_DOMAIN_BLOCKS,
  type SyncDomainBlockKey,
  type SyncDomainBlockState,
  type SyncDomainBlockStatus,
  type SyncStatusReason,
  type SyncStreamRole,
  type SyncStatusPage,
} from "./sync-status.ts";
import { sendSyncPageWakeup } from "./sync-queue.ts";
import { assertLegacyExecutorServes } from "./sync-control.ts";
import {
  engineOwnedSyncPage,
  pauseEngineStreams,
  requeueEngineStreams,
  resetEngineFollowersReconcile,
  triggerEngineStreams,
  type EngineLeverOutcome,
} from "./sync-engine-levers.ts";
import { engineBlockStreams } from "./sync-status-engine.ts";

export type SyncBlockKey = SyncDomainBlockKey;
export type SyncBlockState = SyncDomainBlockState;
export type SimpleConnectionStatus = "connected" | "not_connected" | "error";

type SyncBlockProgress = {
  label: string;
  current: number;
  total: number | null;
  unit: string;
  percent: number | null;
  details: Record<string, unknown>;
};

type SyncBlockError = {
  stream: string | null;
  code: string | null;
  summary: string | null;
  failedAt: string | null;
  consecutiveFailures: number;
};

type SyncBlockStatusReason = SyncStatusReason;

type SyncBlockInterval = {
  stream: SyncStream;
  cadenceSeconds: number;
};

type SyncBlockSubstream = {
  stream: SyncStream;
  role: SyncStreamRole;
  state: Exclude<SyncBlockState, "not_available">;
  succeededAt: string | null;
  nextDueAt: string | null;
  nextRetryAt: string | null;
  cadenceSeconds: number;
  isFresh: boolean;
  needsAttention: boolean;
  statusReason: SyncBlockStatusReason | null;
  error: SyncBlockError | null;
};

export type SyncDiagnosisCode =
  | "worker_offline"
  | "stalled_run"
  | "auth_blocked";

export type SyncDiagnosisSeverity = "warning" | "error";

export type SyncDiagnosisActionKind =
  | "worker"
  | "credentials"
  | "sync_settings";

export type SyncDiagnosis = {
  code: SyncDiagnosisCode;
  severity: SyncDiagnosisSeverity;
  headline: string;
  detail: string;
  actionKind: SyncDiagnosisActionKind | null;
};

export type SyncBlockStatus = {
  block: SyncBlockKey;
  state: SyncBlockState;
  /** The page's engine mode, exactly when `state` is `engine`. */
  engineMode?: "handover" | "live";
  succeededAt: string | null;
  progress: SyncBlockProgress | null;
  progressStream: string | null;
  progressRole: SyncStreamRole | null;
  error: SyncBlockError | null;
  statusReason: SyncBlockStatusReason | null;
  primaryFresh: boolean;
  needsAttention: boolean;
  nextDueAt: string | null;
  nextRetryAt: string | null;
  intervals: SyncBlockInterval[];
  metrics: Record<string, unknown>;
  connectionStatus: SimpleConnectionStatus | null;
  substreams: SyncBlockSubstream[];
};

export type SyncBlocksPageItem = {
  pageId: number;
  pageLabel: string;
  platform: Platform;
  modelSlug: string;
  modelName: string;
  username: string | null;
  displayName: string | null;
  diagnosis: SyncDiagnosis | null;
  blocks: Record<SyncBlockKey, SyncBlockStatus>;
};

type SyncBlockOverviewResponse = {
  generatedAt: string;
  diagnosis: SyncDiagnosis | null;
  pages: SyncBlocksPageItem[];
};

type SyncBlockPageResponse = {
  generatedAt: string;
  page: SyncBlocksPageItem;
};

type SyncMessagesBlockResponse = {
  generatedAt: string;
  page: Omit<SyncBlocksPageItem, "blocks">;
  block: SyncBlockStatus;
};

const ONLYFANS_HISTORY_RETIRED_MESSAGE =
  "OnlyFans legacy message-history crawler is permanently retired; durable OF mirror jobs own history acquisition";
const PERMANENTLY_RETIRED_SYNC_BLOCKS = new Set<`${Platform}:${SyncBlockKey}`>([
  "onlyfans:messages_history",
]);

function assertLegacyOnlyFansHistoryNotRequested(
  platform: Platform,
  block: SyncBlockKey,
) {
  // This is an explicit product-policy guard, not a consequence of the
  // current adapter capability set. Future mirror streams must not silently
  // reactivate these legacy buttons by changing registry metadata.
  if (PERMANENTLY_RETIRED_SYNC_BLOCKS.has(`${platform}:${block}`)) {
    throw new ConflictError(ONLYFANS_HISTORY_RETIRED_MESSAGE);
  }
}

/** The legacy streams a block lever requests on a page the legacy executor
 *  serves: the block's streams of the status blocks. A block with none is not
 *  available there. (On a page the Fansly Sync Engine owns the lever moves the
 *  registry keys of the block's lever streams, `engineBlockStreams`.) */
function legacyBlockTasks(platform: Platform, block: SyncBlockKey): LegacyExecutorStream[] {
  const tasks = [...SYNC_DOMAIN_POLICY[block].primaryStreams, ...SYNC_DOMAIN_POLICY[block].supportingStreams];
  if (tasks.length === 0) {
    throw new BadRequestError(`Sync domain "${block}" is not available on ${platform}`);
  }
  return tasks;
}

function toBlockStatus(block: SyncDomainBlockStatus): SyncBlockStatus {
  return {
    block: block.block,
    state: block.state,
    ...(block.engineMode === undefined ? {} : { engineMode: block.engineMode }),
    succeededAt: block.succeededAt,
    progress: block.progress
      ? {
        label: block.progress.label,
        current: block.progress.current,
        total: block.progress.total,
        unit: block.progress.unit,
        percent: block.progress.percent,
        details: block.progress.details,
      }
      : null,
    progressStream: block.progressStream,
    progressRole: block.progressRole,
    error: block.error
      ? {
        stream: block.error.stream,
        code: block.error.code,
        summary: block.error.summary,
        failedAt: block.error.failedAt,
        consecutiveFailures: block.error.consecutiveFailures,
      }
      : null,
    statusReason: block.statusReason,
    primaryFresh: block.primaryFresh,
    needsAttention: block.needsAttention,
    nextDueAt: block.nextDueAt,
    nextRetryAt: block.nextRetryAt,
    intervals: block.intervals.map((interval) => ({
      stream: interval.stream,
      cadenceSeconds: interval.cadenceSeconds,
    })),
    metrics: block.metrics,
    connectionStatus: block.connectionStatus,
    substreams: block.substreams.map((substream) => ({
      stream: substream.stream,
      role: substream.role,
      state: substream.state,
      succeededAt: substream.succeededAt,
      nextDueAt: substream.nextDueAt,
      nextRetryAt: substream.nextRetryAt,
      cadenceSeconds: substream.cadenceSeconds,
      isFresh: substream.isFresh,
      needsAttention: substream.needsAttention,
      statusReason: substream.statusReason,
      error: substream.error
        ? {
          stream: substream.error.stream,
          code: substream.error.code,
          summary: substream.error.summary,
          failedAt: substream.error.failedAt,
          consecutiveFailures: substream.error.consecutiveFailures,
        }
        : null,
    })),
  };
}

function diagnosisForPage(page: SyncStatusPage): SyncDiagnosis | null {
  const blocks = Object.values(page.blocks);
  const authBlock = blocks.find((block) => block.needsAttention && block.statusReason?.code === "credentials_invalid");
  if (authBlock) {
    return {
      code: "auth_blocked",
      severity: "error",
      headline: "Reconnect credentials",
      detail: authBlock.statusReason?.summary ?? "Credentials must be refreshed before sync can continue.",
      actionKind: "credentials",
    };
  }

  const stalledBlock = blocks.find((block) => block.needsAttention && block.statusReason?.code === "progress_stalled");
  if (stalledBlock) {
    return {
      code: "stalled_run",
      severity: "error",
      headline: "Sync stalled",
      detail: stalledBlock.statusReason?.summary ?? "A sync worker stopped making progress.",
      actionKind: "sync_settings",
    };
  }

  const nonConnectionBlocks = blocks.filter((block) => block.block !== "connection");
  const hasHealthyPrimaryData = nonConnectionBlocks.some((block) => block.primaryFresh);
  const hasActiveSyncWork = nonConnectionBlocks.some((block) =>
    block.state === "syncing" || block.state === "backfilling" || block.state === "retrying"
  );
  const queuedTooLong = blocks.find((block) => block.needsAttention && block.statusReason?.code === "queue_delayed");
  if (queuedTooLong && !hasHealthyPrimaryData && !hasActiveSyncWork) {
    return {
      code: "worker_offline",
      severity: "warning",
      headline: "Sync is delayed",
      detail: queuedTooLong.statusReason?.summary ?? "Queued sync work is stalled with no active progress.",
      actionKind: "worker",
    };
  }

  return null;
}

function toBlocksPage(page: SyncStatusPage): SyncBlocksPageItem {
  const blocks = Object.fromEntries(
    SYNC_DOMAIN_BLOCKS.map((block) => [block, toBlockStatus(page.blocks[block])]),
  ) as Record<SyncBlockKey, SyncBlockStatus>;

  return {
    pageId: page.pageId,
    pageLabel: page.pageLabel,
    platform: page.platform,
    modelSlug: page.modelSlug,
    modelName: page.modelName,
    username: page.username,
    displayName: page.displayName,
    diagnosis: diagnosisForPage(page),
    blocks,
  };
}

async function getPageOrThrow(app: AppContext, pageLabel: string) {
  const stored = await findPageByLabel(app.db, pageLabel);
  if (!stored) {
    throw new NotFoundError(`Page "${pageLabel}" not found`);
  }

  return stored;
}

/** A block lever's answer on an engine page: what the engine lever did. */
function engineBlockResponse<A extends "trigger" | "pause" | "resume" | "reset">(
  action: A,
  pageLabel: string,
  block: SyncBlockKey,
  outcome: EngineLeverOutcome,
) {
  return {
    accepted: true as const,
    action,
    pageLabel,
    block,
    requests: [] as Array<{ stream: SyncStream; requestedSeq: number }>,
    engine: { mode: outcome.mode, resources: outcome.resources, affected: outcome.affected },
  };
}

async function enqueueBlockWakeup(
  boss: Pick<PgBoss, "send">,
  input: {
    platformAccountId: number;
    platform: Platform;
    egressKey: string;
    tasks: SyncStream[];
    reason: "manual" | "reset";
  },
) {
  const priority = input.tasks.reduce((current, task) => {
    return Math.max(current, resolvePageSyncPriority(task, input.reason));
  }, 0);

  return sendSyncPageWakeup(boss, {
    platformAccountId: input.platformAccountId,
    priority,
    provider: input.platform,
    egressKey: input.egressKey,
  });
}

export async function getSyncBlocksOverview(
  app: AppContext,
  input?: {
    pageIds?: number[];
    now?: Date;
  },
): Promise<SyncBlockOverviewResponse> {
  const snapshot = await getSyncStatusSnapshot(app, {
    pageIds: input?.pageIds,
    now: input?.now,
    // The list view does not need the 24h monitor rollup of the streams.
    includeMonitorRows: false,
  });
  const pages = snapshot.pages.map((page) => toBlocksPage(page));

  return {
    generatedAt: snapshot.generatedAt,
    diagnosis: pages.find((page) => page.diagnosis !== null)?.diagnosis ?? null,
    pages,
  };
}

export async function getPageSyncBlocks(
  app: AppContext,
  input: {
    pageLabel: string;
    pageIds?: number[];
    now?: Date;
  },
): Promise<SyncBlockPageResponse> {
  const snapshot = await getSyncStatusSnapshot(app, {
    pageIds: input.pageIds,
    pageLabel: input.pageLabel,
    now: input.now,
  });
  const page = snapshot.pages[0];
  if (!page) {
    throw new NotFoundError(`Page "${input.pageLabel}" not found`);
  }

  return {
    generatedAt: snapshot.generatedAt,
    page: toBlocksPage(page),
  };
}

export async function getPageMessagesSyncBlock(
  app: AppContext,
  input: {
    pageLabel: string;
    pageIds?: number[];
    now?: Date;
  },
): Promise<SyncMessagesBlockResponse> {
  const blocks = await getPageSyncBlocks(app, input);
  return {
    generatedAt: blocks.generatedAt,
    page: {
      pageId: blocks.page.pageId,
      pageLabel: blocks.page.pageLabel,
      platform: blocks.page.platform,
      modelSlug: blocks.page.modelSlug,
      modelName: blocks.page.modelName,
      username: blocks.page.username,
      displayName: blocks.page.displayName,
      diagnosis: blocks.page.diagnosis,
    },
    block: blocks.page.blocks.messages_history,
  };
}

export async function triggerSyncBlock(
  app: AppContext,
  boss: Pick<PgBoss, "send">,
  input: {
    pageLabel: string;
    block: SyncBlockKey;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const stored = await getPageOrThrow(app, input.pageLabel);
  assertLegacyOnlyFansHistoryNotRequested(stored.page.platform, input.block);
  const dependencyInput = pageSyncDependencyInput(app);
  const engine = await engineOwnedSyncPage(app.db, stored.page.id);
  if (engine !== null) {
    return engineBlockResponse(
      "trigger", stored.page.label, input.block,
      await triggerEngineStreams(app.db, engine, engineBlockStreams(input.block)),
    );
  }
  assertLegacyExecutorServes(stored.page);
  const tasks = legacyBlockTasks(stored.page.platform, input.block);

  await ensurePageSyncStates(app.db, {
    pageId: stored.page.id,
    now,
    ...dependencyInput,
  });
  const requests = await requestPageSyncRows(app.db, {
    pageId: stored.page.id,
    streams: tasks,
    source: "manual",
    now,
    ...dependencyInput,
  });
  await enqueueBlockWakeup(boss, {
    platformAccountId: stored.page.id,
    platform: stored.page.platform,
    egressKey: resolveStoredProxyEgressKey(stored.proxy),
    tasks,
    reason: "manual",
  });

  return {
    accepted: true as const,
    action: "trigger" as const,
    pageLabel: stored.page.label,
    block: input.block,
    requests: requests.map((request) => ({
      stream: request.stream,
      requestedSeq: request.requestedSeq,
    })),
  };
}

export async function pauseSyncBlock(
  app: AppContext,
  input: {
    pageLabel: string;
    block: SyncBlockKey;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const stored = await getPageOrThrow(app, input.pageLabel);
  assertLegacyOnlyFansHistoryNotRequested(stored.page.platform, input.block);
  const dependencyInput = pageSyncDependencyInput(app);
  const engine = await engineOwnedSyncPage(app.db, stored.page.id);
  if (engine !== null) {
    return engineBlockResponse(
      "pause", stored.page.label, input.block,
      await pauseEngineStreams(app.db, engine, engineBlockStreams(input.block), "pause"),
    );
  }
  assertLegacyExecutorServes(stored.page);
  const tasks = legacyBlockTasks(stored.page.platform, input.block);

  await ensurePageSyncStates(app.db, {
    pageId: stored.page.id,
    now,
    ...dependencyInput,
  });
  await pausePageSync(app.db, {
    pageId: stored.page.id,
    streams: tasks,
    now,
  });

  return {
    accepted: true as const,
    action: "pause" as const,
    pageLabel: stored.page.label,
    block: input.block,
  };
}

export async function resumeSyncBlock(
  app: AppContext,
  boss: Pick<PgBoss, "send">,
  input: {
    pageLabel: string;
    block: SyncBlockKey;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const stored = await getPageOrThrow(app, input.pageLabel);
  assertLegacyOnlyFansHistoryNotRequested(stored.page.platform, input.block);
  const dependencyInput = pageSyncDependencyInput(app);
  const engine = await engineOwnedSyncPage(app.db, stored.page.id);
  if (engine !== null) {
    return engineBlockResponse(
      "resume", stored.page.label, input.block,
      await pauseEngineStreams(app.db, engine, engineBlockStreams(input.block), "resume"),
    );
  }
  assertLegacyExecutorServes(stored.page);
  const tasks = legacyBlockTasks(stored.page.platform, input.block);

  await ensurePageSyncStates(app.db, {
    pageId: stored.page.id,
    now,
    ...dependencyInput,
  });
  const currentStates = await listPageSyncStates(app.db, {
    pageId: stored.page.id,
    streams: tasks,
  });
  const pausedStreams = new Set(
    currentStates
      .filter((state) => state.status === "paused")
      .map((state) => state.stream),
  );
  const resumableTasks = tasks.filter((task) => pausedStreams.has(task));
  await resumePageSync(app.db, {
    pageId: stored.page.id,
    streams: resumableTasks,
    now,
  });
  const requests = resumableTasks.length > 0
    ? await requestPageSyncRows(app.db, {
      pageId: stored.page.id,
      streams: resumableTasks,
      source: "manual",
      now,
      ...dependencyInput,
    })
    : [];
  if (resumableTasks.length > 0) {
    await enqueueBlockWakeup(boss, {
      platformAccountId: stored.page.id,
      platform: stored.page.platform,
      egressKey: resolveStoredProxyEgressKey(stored.proxy),
      tasks: resumableTasks,
      reason: "manual",
    });
  }

  return {
    accepted: true as const,
    action: "resume" as const,
    pageLabel: stored.page.label,
    block: input.block,
    requests: requests.map((request) => ({
      stream: request.stream,
      requestedSeq: request.requestedSeq,
    })),
  };
}

export async function resetSyncBlock(
  app: AppContext,
  boss: Pick<PgBoss, "send">,
  input: {
    pageLabel: string;
    block: SyncBlockKey;
    now?: Date;
  },
) {
  const stored = await getPageOrThrow(app, input.pageLabel);
  // An engine page: its legacy state is frozen and never rewritten (J5); the
  // block's quarantined engine work is requeued instead — nothing is deleted,
  // so the destruction door below does not apply.
  const engine = await engineOwnedSyncPage(app.db, stored.page.id);
  if (engine !== null) {
    return engineBlockResponse(
      "reset", stored.page.label, input.block,
      await requeueEngineStreams(app.db, engine, engineBlockStreams(input.block)),
    );
  }
  assertLegacyExecutorServes(stored.page);

  // Stage 2 destruction-door guard: the messages_history reset would
  // hard-delete every stored DM for the page (resetPageDmSyncState) with no
  // archive to recover from. Disabled until the message archive exists
  // (Stage 10); checkpoint/top-spender resets below stay available.
  if (input.block === "messages_history") {
    throw new ConflictError(
      "Message-history reset is disabled: it would irreversibly delete every stored DM for this page. It returns once the message archive exists (kernel Stage 10).",
    );
  }

  const now = input.now ?? new Date();
  const dependencyInput = pageSyncDependencyInput(app);
  const tasks = legacyBlockTasks(stored.page.platform, input.block);

  await ensurePageSyncStates(app.db, {
    pageId: stored.page.id,
    now,
    ...dependencyInput,
  });
  const requests = await app.db.transaction(async (tx) => {
    const dbTx = tx as typeof app.db;

    await resetPageSync(dbTx, {
      pageId: stored.page.id,
      streams: tasks,
      now,
    });
    await deleteCheckpoints(dbTx, {
      platformAccountId: stored.page.id,
      streams: tasks,
    });

    if (input.block === "messages_history") {
      await resetPageDmSyncState(dbTx, stored.page.id);
    }
    if (input.block === "financials") {
      await deletePageTopSpenders(dbTx, stored.page.id);
    }

    return requestPageSyncRows(dbTx, {
      pageId: stored.page.id,
      streams: tasks,
      source: "reset",
      now,
      ...dependencyInput,
    });
  });
  await enqueueBlockWakeup(boss, {
    platformAccountId: stored.page.id,
    platform: stored.page.platform,
    egressKey: resolveStoredProxyEgressKey(stored.proxy),
    tasks,
    reason: "reset",
  });

  return {
    accepted: true as const,
    action: "reset" as const,
    pageLabel: stored.page.label,
    block: input.block,
    requests: requests.map((request) => ({
      stream: request.stream,
      requestedSeq: request.requestedSeq,
    })),
  };
}

/** Unblock only the follower membership walk on the page the Fansly Sync
 * Engine owns (`resetEngineFollowersReconcile`): the walk's row is cancelled
 * and a fresh owner demand starts a new generation from offset zero. Unlike
 * the dashboard's audience reset, the incremental followers/subscribers
 * cursors stay. Any other Fansly page is refused (409 `legacy_sync_retired`):
 * the legacy followers_reconcile handler is gone since step 4 (S4-17). */
export async function resetFollowersReconcileStream(
  app: AppContext,
  input: { pageLabel: string },
) {
  const stored = await getPageOrThrow(app, input.pageLabel);
  if (stored.page.platform !== "fansly") {
    throw new BadRequestError("Follower reconcile is available only on Fansly pages");
  }
  const engine = await engineOwnedSyncPage(app.db, stored.page.id);
  if (engine === null) {
    throw new LegacySyncRetiredError({ pageLabel: stored.page.label, platform: stored.page.platform });
  }
  const reset = await resetEngineFollowersReconcile(app.db, engine);
  return {
    accepted: true as const,
    action: "reset" as const,
    pageLabel: stored.page.label,
    stream: "followers_reconcile" as const,
    requests: [{ stream: "followers_reconcile" as const, requestedSeq: reset.demandRevision }],
  };
}
