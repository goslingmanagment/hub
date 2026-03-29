import {
  deleteCheckpoints,
  deletePageTopSpenders,
  ensureSyncStreamStateRows,
  findPageByLabel,
  listSyncMonitorStreamRows,
  listVisiblePages,
  requestSyncStreamRevisions,
  resetPageDmSyncState,
  resetSyncStreamStateRows,
  resolveSyncRequestPriority,
  setSyncStreamStatuses,
  SYNC_STREAM_CONFIG,
  type SyncAuditStream,
  type SyncControlStream,
  type SyncMonitorStreamRow,
} from "@agency_hub_core/db";
import { buildProxyEgressKey, type Platform } from "@agency_hub_core/shared";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../bootstrap.ts";
import { listConnectionStatuses, type ConnectionStatus } from "./connections.ts";
import { BadRequestError, NotFoundError } from "./errors.ts";
import { sendSyncPageWakeup } from "./sync-queue.ts";

export type SyncBlockKey =
  | "connection"
  | "top_spenders"
  | "transactions"
  | "subscribers"
  | "followers"
  | "messages";

export type SyncBlockState =
  | "up_to_date"
  | "syncing"
  | "catching_up"
  | "retrying"
  | "error"
  | "paused"
  | "waiting"
  | "auth_failed"
  | "not_available";

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
  stream: SyncAuditStream | null;
  code: string | null;
  summary: string | null;
  lastFailedAt: string | null;
  consecutiveFailures: number;
};

type SyncBlockInterval = {
  stream: SyncControlStream;
  cadenceSeconds: number;
};

type SyncBlockSubstream = {
  stream: SyncControlStream;
  state: Exclude<SyncBlockState, "not_available">;
  lastSuccessAt: string | null;
  nextDueAt: string | null;
  nextRetryAt: string | null;
  cadenceSeconds: number;
  needsAttention: boolean;
  error: SyncBlockError | null;
};

export type SyncBlockStatus = {
  block: SyncBlockKey;
  state: SyncBlockState;
  lastSuccessAt: string | null;
  progress: SyncBlockProgress | null;
  error: SyncBlockError | null;
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
  blocks: Record<SyncBlockKey, SyncBlockStatus>;
};

type SyncBlockOverviewResponse = {
  generatedAt: string;
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

const BLOCK_STREAMS = {
  connection: ["light"],
  top_spenders: ["top_spenders"],
  transactions: ["transactions"],
  subscribers: ["subscribers"],
  followers: ["followers"],
  messages: ["dm_conversations", "dm_messages"],
} as const satisfies Record<SyncBlockKey, readonly SyncControlStream[]>;

const BLOCK_STREAMS_WITH_MAINTENANCE = {
  connection: ["light"],
  top_spenders: ["top_spenders"],
  transactions: ["transactions"],
  subscribers: ["subscribers"],
  followers: ["followers", "followers_reconcile"],
  messages: ["dm_conversations", "dm_messages"],
} as const satisfies Record<SyncBlockKey, readonly SyncControlStream[]>;

const OVERVIEW_STREAMS = [
  "light",
  "top_spenders",
  "transactions",
  "subscribers",
  "followers",
  "dm_conversations",
  "dm_messages",
] as const satisfies readonly SyncControlStream[];

const BLOCK_STATE_PRIORITY: Record<SyncBlockState, number> = {
  not_available: 0,
  up_to_date: 1,
  waiting: 2,
  catching_up: 3,
  syncing: 4,
  retrying: 5,
  error: 6,
  paused: 7,
  auth_failed: 8,
};

function asRecord(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNullableString(value: unknown) {
  return value === null || typeof value === "string" ? value : null;
}

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function earliestIso(values: Array<Date | null | undefined>) {
  const timestamps = values.filter((value): value is Date => Boolean(value));
  if (timestamps.length === 0) {
    return null;
  }

  return new Date(Math.min(...timestamps.map((value) => value.getTime()))).toISOString();
}

function latestIso(values: Array<Date | null | undefined>) {
  const timestamps = values.filter((value): value is Date => Boolean(value));
  if (timestamps.length === 0) {
    return null;
  }

  return new Date(Math.max(...timestamps.map((value) => value.getTime()))).toISOString();
}

function connectionStatusFor(status: ConnectionStatus): SimpleConnectionStatus {
  if (status === "error") {
    return "error";
  }

  if (status === "active" || status === "stale") {
    return "connected";
  }

  return "not_connected";
}

function isBlockSupported(platform: Platform, block: SyncBlockKey) {
  if (platform === "fansly") {
    return true;
  }

  return block === "connection" || block === "transactions";
}

function deriveRowBlockState(
  row: SyncMonitorStreamRow,
  now: Date,
): Exclude<SyncBlockState, "not_available"> {
  if (row.targetStatus === "auth_failed") {
    return "auth_failed";
  }
  if (row.targetStatus === "paused" || row.targetStatus === "disabled") {
    return "paused";
  }
  if (row.runningRunId !== null) {
    return "syncing";
  }
  if (row.backoffUntil && row.backoffUntil.getTime() > now.getTime() && row.consecutiveFailures > 0) {
    return "retrying";
  }
  if ((row.desiredRevision ?? 0) > (row.satisfiedRevision ?? 0)) {
    return row.lastSucceededAt ? "catching_up" : "waiting";
  }
  if (
    row.lastFailedAt &&
    (!row.lastSucceededAt || row.lastFailedAt.getTime() >= row.lastSucceededAt.getTime())
  ) {
    return "error";
  }
  if (row.lastSucceededAt) {
    return "up_to_date";
  }
  return "waiting";
}

function needsAttention(row: SyncMonitorStreamRow) {
  return row.consecutiveFailures >= 3;
}

function errorForRow(row: SyncMonitorStreamRow): SyncBlockError | null {
  if (!row.lastErrorCode && !row.lastErrorSummary && !row.lastFailedAt) {
    return null;
  }

  return {
    stream: row.stream,
    code: row.lastErrorCode,
    summary: row.lastErrorSummary,
    lastFailedAt: iso(row.lastFailedAt),
    consecutiveFailures: row.consecutiveFailures,
  };
}

function progressForTopSpenders(row: SyncMonitorStreamRow): SyncBlockProgress | null {
  const checkpoint = asRecord(row.checkpointState);
  if (checkpoint?.mode !== "bootstrap") {
    return null;
  }

  const total = asNumber(checkpoint.totalMonths);
  const current = asNumber(checkpoint.completedMonths);
  if (total === null || current === null) {
    return null;
  }

  return {
    label: `${current} of ${total} months bootstrapped`,
    current,
    total,
    unit: "months",
    percent: total > 0 ? (current / total) * 100 : null,
    details: {
      pendingWindows: Array.isArray(checkpoint.pendingWindows) ? checkpoint.pendingWindows.length : 0,
      mode: checkpoint.mode,
    },
  };
}

function progressForPageCountCheckpoint(
  row: SyncMonitorStreamRow,
  unit: string,
) {
  const checkpoint = asRecord(row.checkpointState);
  const current = asNumber(checkpoint?.pageCount);
  const total = asNumber(checkpoint?.providerReportedTotal) ??
    asNumber(checkpoint?.sourceFollowerCount);
  if (current === null) {
    return null;
  }

  return {
    label: total === null
      ? `${current} ${unit} processed`
      : `${current} of ${total} ${unit} processed`,
    current,
    total,
    unit,
    percent: total && total > 0 ? (current / total) * 100 : null,
    details: {
      checkpoint: checkpoint ?? {},
    },
  } satisfies SyncBlockProgress;
}

function progressForMessages(
  rowByStream: Map<SyncControlStream, SyncMonitorStreamRow>,
) {
  const conversations = rowByStream.get("dm_conversations");
  if (!conversations || conversations.dmEligibleConversationCount === 0) {
    return null;
  }

  const current = conversations.dmBackfillCompleteConversationCount;
  const total = conversations.dmEligibleConversationCount;
  return {
    label: `${current} of ${total} conversations backfilled`,
    current,
    total,
    unit: "conversations",
    percent: total > 0 ? (current / total) * 100 : null,
    details: {
      laggingConversations: conversations.dmLaggingConversationCount,
      visibleConversations: conversations.dmConversationCount,
    },
  } satisfies SyncBlockProgress;
}

function combinedState(states: Exclude<SyncBlockState, "not_available">[]) {
  if (states.length === 0) {
    return "waiting" as const;
  }

  return states.reduce((current, next) => {
    return BLOCK_STATE_PRIORITY[next] > BLOCK_STATE_PRIORITY[current] ? next : current;
  });
}

function pickBlockError(rows: SyncMonitorStreamRow[]): SyncBlockError | null {
  const candidates = rows
    .filter((row) => errorForRow(row) !== null)
    .sort((a, b) => {
      const left = a.lastFailedAt?.getTime() ?? 0;
      const right = b.lastFailedAt?.getTime() ?? 0;
      return right - left;
    });
  return candidates[0] ? errorForRow(candidates[0]) : null;
}

function buildUnsupportedBlock(block: SyncBlockKey): SyncBlockStatus {
  return {
    block,
    state: "not_available",
    lastSuccessAt: null,
    progress: null,
    error: null,
    needsAttention: false,
    nextDueAt: null,
    nextRetryAt: null,
    intervals: [],
    metrics: {},
    connectionStatus: null,
    substreams: [],
  };
}

function buildSingleStreamBlock(
  block: Exclude<SyncBlockKey, "messages" | "connection">,
  row: SyncMonitorStreamRow,
  now: Date,
): SyncBlockStatus {
  return {
    block,
    state: deriveRowBlockState(row, now),
    lastSuccessAt: iso(row.lastSucceededAt),
    progress: block === "top_spenders"
      ? progressForTopSpenders(row)
      : block === "subscribers"
        ? progressForPageCountCheckpoint(row, "subscribers")
        : block === "followers"
          ? progressForPageCountCheckpoint(row, "followers")
          : null,
    error: errorForRow(row),
    needsAttention: needsAttention(row),
    nextDueAt: iso(row.nextDueAt),
    nextRetryAt: row.backoffUntil && row.backoffUntil.getTime() > now.getTime()
      ? row.backoffUntil.toISOString()
      : null,
    intervals: [{
      stream: row.stream,
      cadenceSeconds: row.cadenceSeconds ?? SYNC_STREAM_CONFIG[row.stream].cadenceSeconds,
    }],
    metrics: block === "transactions"
      ? { transactionCount: row.transactionCount }
      : block === "subscribers"
        ? { subscriberCount: row.subscriberCount }
        : block === "followers"
          ? { followerCount: row.followerCount }
          : {
            totalMonths: asNumber(asRecord(row.checkpointState)?.totalMonths),
            completedMonths: asNumber(asRecord(row.checkpointState)?.completedMonths),
            pendingWindows: Array.isArray(asRecord(row.checkpointState)?.pendingWindows)
              ? (asRecord(row.checkpointState)?.pendingWindows as unknown[]).length
              : 0,
          },
    connectionStatus: null,
    substreams: [{
      stream: row.stream,
      state: deriveRowBlockState(row, now),
      lastSuccessAt: iso(row.lastSucceededAt),
      nextDueAt: iso(row.nextDueAt),
      nextRetryAt: row.backoffUntil && row.backoffUntil.getTime() > now.getTime()
        ? row.backoffUntil.toISOString()
        : null,
      cadenceSeconds: row.cadenceSeconds ?? SYNC_STREAM_CONFIG[row.stream].cadenceSeconds,
      needsAttention: needsAttention(row),
      error: errorForRow(row),
    }],
  };
}

function buildConnectionBlock(
  row: SyncMonitorStreamRow | undefined,
  connectionStatus: ConnectionStatus | null,
  now: Date,
): SyncBlockStatus {
  const simpleStatus = connectionStatus ? connectionStatusFor(connectionStatus) : "not_connected";
  const state = row
    ? (row.runningRunId !== null
      ? "syncing"
      : row.targetStatus === "auth_failed"
        ? "auth_failed"
        : simpleStatus === "error"
          ? "error"
          : simpleStatus === "connected"
            ? "up_to_date"
            : "waiting")
    : "waiting";

  return {
    block: "connection",
    state,
    lastSuccessAt: iso(row?.lastSucceededAt),
    progress: null,
    error: row ? errorForRow(row) : null,
    needsAttention: row ? needsAttention(row) : false,
    nextDueAt: iso(row?.nextDueAt),
    nextRetryAt: row?.backoffUntil && row.backoffUntil.getTime() > now.getTime()
      ? row.backoffUntil.toISOString()
      : null,
    intervals: [{
      stream: "light",
      cadenceSeconds: row?.cadenceSeconds ?? SYNC_STREAM_CONFIG.light.cadenceSeconds,
    }],
    metrics: {},
    connectionStatus: simpleStatus,
    substreams: row
      ? [{
        stream: "light",
        state: deriveRowBlockState(row, now),
        lastSuccessAt: iso(row.lastSucceededAt),
        nextDueAt: iso(row.nextDueAt),
        nextRetryAt: row.backoffUntil && row.backoffUntil.getTime() > now.getTime()
          ? row.backoffUntil.toISOString()
          : null,
        cadenceSeconds: row.cadenceSeconds ?? SYNC_STREAM_CONFIG.light.cadenceSeconds,
        needsAttention: needsAttention(row),
        error: errorForRow(row),
      }]
      : [],
  };
}

function buildMessagesBlock(
  rowByStream: Map<SyncControlStream, SyncMonitorStreamRow>,
  now: Date,
): SyncBlockStatus {
  const rows = [
    rowByStream.get("dm_conversations"),
    rowByStream.get("dm_messages"),
  ].filter((row): row is SyncMonitorStreamRow => Boolean(row));
  const states = rows.map((row) => deriveRowBlockState(row, now));
  const needsAttentionValue = rows.some((row) => needsAttention(row));

  return {
    block: "messages",
    state: combinedState(states),
    lastSuccessAt: earliestIso(rows.map((row) => row.lastSucceededAt)),
    progress: progressForMessages(rowByStream),
    error: pickBlockError(rows),
    needsAttention: needsAttentionValue,
    nextDueAt: earliestIso(rows.map((row) => row.nextDueAt)),
    nextRetryAt: earliestIso(
      rows.map((row) => row.backoffUntil && row.backoffUntil.getTime() > now.getTime()
        ? row.backoffUntil
        : null),
    ),
    intervals: [
      {
        stream: "dm_conversations",
        cadenceSeconds: rowByStream.get("dm_conversations")?.cadenceSeconds ??
          SYNC_STREAM_CONFIG.dm_conversations.cadenceSeconds,
      },
      {
        stream: "dm_messages",
        cadenceSeconds: rowByStream.get("dm_messages")?.cadenceSeconds ??
          SYNC_STREAM_CONFIG.dm_messages.cadenceSeconds,
      },
    ],
    metrics: {
      visibleConversationCount: rowByStream.get("dm_conversations")?.dmConversationCount ?? 0,
      eligibleConversationCount: rowByStream.get("dm_conversations")?.dmEligibleConversationCount ?? 0,
      backfillCompleteConversationCount: rowByStream.get("dm_conversations")?.dmBackfillCompleteConversationCount ?? 0,
      laggingConversationCount: rowByStream.get("dm_conversations")?.dmLaggingConversationCount ?? 0,
      storedMessageCount: rowByStream.get("dm_messages")?.dmMessageCount ?? 0,
    },
    connectionStatus: null,
    substreams: rows.map((row) => ({
      stream: row.stream,
      state: deriveRowBlockState(row, now),
      lastSuccessAt: iso(row.lastSucceededAt),
      nextDueAt: iso(row.nextDueAt),
      nextRetryAt: row.backoffUntil && row.backoffUntil.getTime() > now.getTime()
        ? row.backoffUntil.toISOString()
        : null,
      cadenceSeconds: row.cadenceSeconds ?? SYNC_STREAM_CONFIG[row.stream].cadenceSeconds,
      needsAttention: needsAttention(row),
      error: errorForRow(row),
    })),
  };
}

function rowMapForPage(rows: SyncMonitorStreamRow[]) {
  return new Map(rows.map((row) => [row.stream, row] satisfies [SyncControlStream, SyncMonitorStreamRow]));
}

async function buildPageBlocks(
  app: AppContext,
  input: {
    pageIds?: number[];
    pageLabel?: string;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  await ensureSyncStreamStateRows(app.db, { now });
  const pages = await listVisiblePages(app.db, input.pageIds);
  const filteredPages = input.pageLabel
    ? pages.filter((page) => page.label === input.pageLabel)
    : pages;
  if (filteredPages.length === 0) {
    return [] as SyncBlocksPageItem[];
  }

  const rows = await listSyncMonitorStreamRows(app.db, {
    pageIds: filteredPages.map((page) => page.id),
    pageLabel: input.pageLabel,
    streams: [...OVERVIEW_STREAMS],
  });
  const rowsByPageId = new Map<number, SyncMonitorStreamRow[]>();
  for (const row of rows) {
    const current = rowsByPageId.get(row.pageId) ?? [];
    current.push(row);
    rowsByPageId.set(row.pageId, current);
  }

  const connections = await listConnectionStatuses(app, {
    pages: filteredPages,
    syncUxByPageId: new Map(),
  });
  const connectionByPageId = new Map(connections.map((connection) => [connection.id, connection.connectionStatus]));

  return filteredPages.map((page) => {
    const pageRows = rowsByPageId.get(page.id) ?? [];
    const rowByStream = rowMapForPage(pageRows);
    const blocks = {
      connection: buildConnectionBlock(
        rowByStream.get("light"),
        connectionByPageId.get(page.id) ?? null,
        now,
      ),
      top_spenders: isBlockSupported(page.platform, "top_spenders")
        ? buildSingleStreamBlock("top_spenders", rowByStream.get("top_spenders")!, now)
        : buildUnsupportedBlock("top_spenders"),
      transactions: buildSingleStreamBlock("transactions", rowByStream.get("transactions")!, now),
      subscribers: isBlockSupported(page.platform, "subscribers")
        ? buildSingleStreamBlock("subscribers", rowByStream.get("subscribers")!, now)
        : buildUnsupportedBlock("subscribers"),
      followers: isBlockSupported(page.platform, "followers")
        ? buildSingleStreamBlock("followers", rowByStream.get("followers")!, now)
        : buildUnsupportedBlock("followers"),
      messages: isBlockSupported(page.platform, "messages")
        ? buildMessagesBlock(rowByStream, now)
        : buildUnsupportedBlock("messages"),
    } satisfies Record<SyncBlockKey, SyncBlockStatus>;

    return {
      pageId: page.id,
      pageLabel: page.label,
      platform: page.platform,
      modelSlug: page.modelSlug,
      modelName: page.modelName,
      username: page.username,
      displayName: page.displayName,
      blocks,
    } satisfies SyncBlocksPageItem;
  });
}

function blockStreamsForAction(
  platform: Platform,
  block: SyncBlockKey,
  action: "trigger" | "pause" | "resume" | "reset",
) {
  if (!isBlockSupported(platform, block)) {
    throw new BadRequestError(`Block "${block}" is not available for ${platform} pages`);
  }

  return [...(action === "trigger" ? BLOCK_STREAMS[block] : BLOCK_STREAMS_WITH_MAINTENANCE[block])];
}

async function enqueueBlockWakeup(
  app: AppContext,
  boss: Pick<PgBoss, "send">,
  input: {
    platformAccountId: number;
    platform: Platform;
    proxyUrl: string | null;
    blockStreams: SyncControlStream[];
    reason: "manual";
  },
) {
  const rows = await listSyncMonitorStreamRows(app.db, {
    pageIds: [input.platformAccountId],
    streams: input.blockStreams,
  });
  const activeRows = rows.filter((row) => row.targetStatus === "active");
  if (activeRows.length === 0) {
    return null;
  }

  const priority = input.blockStreams.reduce((current, stream) => {
    return Math.max(current, resolveSyncRequestPriority(stream, input.reason));
  }, 0);

  return sendSyncPageWakeup(boss, {
    platformAccountId: input.platformAccountId,
    priority,
    provider: input.platform,
    egressKey: buildProxyEgressKey(input.proxyUrl ? { url: input.proxyUrl } : null),
  });
}

async function getPageOrThrow(
  app: AppContext,
  pageLabel: string,
) {
  const stored = await findPageByLabel(app.db, pageLabel);
  if (!stored) {
    throw new NotFoundError(`Page "${pageLabel}" not found`);
  }
  return stored;
}

export async function getSyncBlocksOverview(
  app: AppContext,
  input?: {
    pageIds?: number[];
    now?: Date;
  },
): Promise<SyncBlockOverviewResponse> {
  const now = input?.now ?? new Date();
  const pages = await buildPageBlocks(app, {
    pageIds: input?.pageIds,
    now,
  });

  return {
    generatedAt: now.toISOString(),
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
  const now = input.now ?? new Date();
  const pages = await buildPageBlocks(app, {
    pageIds: input.pageIds,
    pageLabel: input.pageLabel,
    now,
  });
  const page = pages[0];
  if (!page) {
    throw new NotFoundError(`Page "${input.pageLabel}" not found`);
  }

  return {
    generatedAt: now.toISOString(),
    page,
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
    },
    block: blocks.page.blocks.messages,
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
  const streams = blockStreamsForAction(stored.page.platform, input.block, "trigger");

  await ensureSyncStreamStateRows(app.db, {
    platformAccountId: stored.page.id,
    now,
  });
  const revisions = await requestSyncStreamRevisions(app.db, {
    platformAccountId: stored.page.id,
    streams,
    reason: "manual",
    preserveAuthFailed: true,
    now,
  });
  await enqueueBlockWakeup(app, boss, {
    platformAccountId: stored.page.id,
    platform: stored.page.platform,
    proxyUrl: stored.proxy?.url ?? null,
    blockStreams: streams,
    reason: "manual",
  });

  return {
    accepted: true as const,
    action: "trigger" as const,
    pageLabel: stored.page.label,
    block: input.block,
    revisions,
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
  const streams = blockStreamsForAction(stored.page.platform, input.block, "pause");

  await ensureSyncStreamStateRows(app.db, {
    platformAccountId: stored.page.id,
    now,
  });
  await setSyncStreamStatuses(app.db, {
    platformAccountId: stored.page.id,
    streams,
    status: "paused",
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
  const streams = blockStreamsForAction(stored.page.platform, input.block, "resume");

  await ensureSyncStreamStateRows(app.db, {
    platformAccountId: stored.page.id,
    now,
  });
  await setSyncStreamStatuses(app.db, {
    platformAccountId: stored.page.id,
    streams,
    status: "active",
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
  const streams = blockStreamsForAction(stored.page.platform, input.block, "reset");

  await ensureSyncStreamStateRows(app.db, {
    platformAccountId: stored.page.id,
    now,
  });
  await deleteCheckpoints(app.db, {
    platformAccountId: stored.page.id,
    streams,
  });

  if (input.block === "messages") {
    await resetPageDmSyncState(app.db, stored.page.id);
  }
  if (input.block === "top_spenders") {
    await deletePageTopSpenders(app.db, stored.page.id);
  }

  await resetSyncStreamStateRows(app.db, {
    platformAccountId: stored.page.id,
    streams,
    now,
  });
  const revisions = await requestSyncStreamRevisions(app.db, {
    platformAccountId: stored.page.id,
    streams,
    reason: "manual",
    preserveAuthFailed: true,
    now,
  });
  await enqueueBlockWakeup(app, boss, {
    platformAccountId: stored.page.id,
    platform: stored.page.platform,
    proxyUrl: stored.proxy?.url ?? null,
    blockStreams: streams.filter((stream) => stream !== "followers_reconcile"),
    reason: "manual",
  });

  return {
    accepted: true as const,
    action: "reset" as const,
    pageLabel: stored.page.label,
    block: input.block,
    revisions,
  };
}
