import {
  deleteCheckpoints,
  deletePageTopSpenders,
  ensureSyncTaskRows,
  findPageByLabel,
  pauseSyncTasks,
  requestSyncTaskGenerations,
  resetPageDmSyncState,
  resetSyncTasks,
  resolveSyncTaskPriority,
  resumeSyncTasks,
  type SyncControlStream,
} from "@agency_hub_core/db";
import { buildProxyEgressKey, type Platform } from "@agency_hub_core/shared";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, NotFoundError } from "./errors.ts";
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
  lastFailedAt: string | null;
  consecutiveFailures: number;
};

type SyncBlockStatusReason = SyncStatusReason;

type SyncBlockInterval = {
  stream: SyncControlStream;
  cadenceSeconds: number;
};

type SyncBlockSubstream = {
  stream: SyncControlStream;
  role: SyncStreamRole;
  state: Exclude<SyncBlockState, "not_available">;
  lastSuccessAt: string | null;
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
  | "auth_failed";

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
  lastSuccessAt: string | null;
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

const BLOCK_TASKS: Record<SyncBlockKey, readonly SyncControlStream[]> = {
  connection: ["light"],
  financials: ["transactions", "top_spenders"],
  audience: ["subscribers", "followers", "followers_reconcile"],
  messages_live: ["dm_conversations"],
  messages_history: ["dm_messages"],
};

function supportedBlocksForPlatform(platform: Platform) {
  return platform === "fansly"
    ? [...SYNC_DOMAIN_BLOCKS]
    : ["connection", "financials"] satisfies SyncBlockKey[];
}

function blockTasksForPlatform(platform: Platform, block: SyncBlockKey) {
  if (!supportedBlocksForPlatform(platform).includes(block)) {
    return [] as SyncControlStream[];
  }

  return [...BLOCK_TASKS[block]];
}

function toBlockStatus(block: SyncDomainBlockStatus): SyncBlockStatus {
  return {
    block: block.block,
    state: block.state,
    lastSuccessAt: block.lastSuccessAt,
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
        lastFailedAt: block.error.lastFailedAt,
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
      lastSuccessAt: substream.lastSuccessAt,
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
          lastFailedAt: substream.error.lastFailedAt,
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
      code: "auth_failed",
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

  const queuedTooLong = blocks.find((block) => block.needsAttention && block.statusReason?.code === "queue_delayed");
  if (queuedTooLong) {
    return {
      code: "worker_offline",
      severity: "warning",
      headline: "Sync is delayed",
      detail: queuedTooLong.statusReason?.summary ?? "Queued sync work is waiting longer than expected.",
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

async function enqueueBlockWakeup(
  boss: Pick<PgBoss, "send">,
  input: {
    platformAccountId: number;
    platform: Platform;
    proxyUrl: string | null;
    tasks: SyncControlStream[];
    reason: "manual" | "reset";
  },
) {
  const priority = input.tasks.reduce((current, task) => {
    return Math.max(current, resolveSyncTaskPriority(task, input.reason));
  }, 0);

  return sendSyncPageWakeup(boss, {
    platformAccountId: input.platformAccountId,
    priority,
    provider: input.platform,
    egressKey: buildProxyEgressKey(input.proxyUrl ? { url: input.proxyUrl } : null),
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
  const tasks = blockTasksForPlatform(stored.page.platform, input.block);
  if (tasks.length === 0) {
    throw new BadRequestError(`Sync domain "${input.block}" is not available on ${stored.page.platform}`);
  }

  await ensureSyncTaskRows(app.db, {
    platformAccountId: stored.page.id,
    now,
  });
  const requested = await requestSyncTaskGenerations(app.db, {
    platformAccountId: stored.page.id,
    tasks,
    source: "manual",
    requestedByActor: "sync_blocks",
    now,
  });
  await enqueueBlockWakeup(boss, {
    platformAccountId: stored.page.id,
    platform: stored.page.platform,
    proxyUrl: stored.proxy?.url ?? null,
    tasks,
    reason: "manual",
  });

  return {
    accepted: true as const,
    action: "trigger" as const,
    pageLabel: stored.page.label,
    block: input.block,
    revisions: requested.map((revision) => ({
      stream: revision.task,
      desiredRevision: revision.desiredGeneration,
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
  const tasks = blockTasksForPlatform(stored.page.platform, input.block);
  if (tasks.length === 0) {
    throw new BadRequestError(`Sync domain "${input.block}" is not available on ${stored.page.platform}`);
  }

  await ensureSyncTaskRows(app.db, {
    platformAccountId: stored.page.id,
    now,
  });
  await pauseSyncTasks(app.db, {
    platformAccountId: stored.page.id,
    tasks,
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
  input: {
    pageLabel: string;
    block: SyncBlockKey;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const stored = await getPageOrThrow(app, input.pageLabel);
  const tasks = blockTasksForPlatform(stored.page.platform, input.block);
  if (tasks.length === 0) {
    throw new BadRequestError(`Sync domain "${input.block}" is not available on ${stored.page.platform}`);
  }

  await ensureSyncTaskRows(app.db, {
    platformAccountId: stored.page.id,
    now,
  });
  await resumeSyncTasks(app.db, {
    platformAccountId: stored.page.id,
    tasks,
    now,
  });

  return {
    accepted: true as const,
    action: "resume" as const,
    pageLabel: stored.page.label,
    block: input.block,
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
  const now = input.now ?? new Date();
  const stored = await getPageOrThrow(app, input.pageLabel);
  const tasks = blockTasksForPlatform(stored.page.platform, input.block);
  if (tasks.length === 0) {
    throw new BadRequestError(`Sync domain "${input.block}" is not available on ${stored.page.platform}`);
  }

  await ensureSyncTaskRows(app.db, {
    platformAccountId: stored.page.id,
    now,
  });
  await deleteCheckpoints(app.db, {
    platformAccountId: stored.page.id,
    streams: tasks,
  });

  if (input.block === "messages_history") {
    await resetPageDmSyncState(app.db, stored.page.id);
  }
  if (input.block === "financials") {
    await deletePageTopSpenders(app.db, stored.page.id);
  }

  await resetSyncTasks(app.db, {
    platformAccountId: stored.page.id,
    tasks,
    now,
  });
  const requested = await requestSyncTaskGenerations(app.db, {
    platformAccountId: stored.page.id,
    tasks,
    source: "reset",
    requestedByActor: "sync_blocks_reset",
    now,
  });
  await enqueueBlockWakeup(boss, {
    platformAccountId: stored.page.id,
    platform: stored.page.platform,
    proxyUrl: stored.proxy?.url ?? null,
    tasks,
    reason: "reset",
  });

  return {
    accepted: true as const,
    action: "reset" as const,
    pageLabel: stored.page.label,
    block: input.block,
    revisions: requested.map((revision) => ({
      stream: revision.task,
      desiredRevision: revision.desiredGeneration,
    })),
  };
}
