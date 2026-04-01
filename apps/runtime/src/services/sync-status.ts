import type { SyncUxSummary } from "@agency_hub_core/contracts";
import {
  ensurePageSyncStates,
  getSyncStreamsForPlatform,
  listSyncMonitorStreamRows,
  listPageSyncStates,
  listVisiblePages,
  type PageSyncState,
  SYNC_DOMAIN_POLICY,
  SYNC_STREAM_POLICY,
  type SyncDomain,
  type SyncStream,
  type SyncMonitorStreamRow,
} from "@agency_hub_core/db";
import { buildProxyEgressKey } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";

export const SYNC_DOMAIN_BLOCKS = [
  "connection",
  "financials",
  "audience",
  "messages_live",
  "messages_history",
] as const satisfies readonly SyncDomain[];

export type SyncDomainBlockKey = typeof SYNC_DOMAIN_BLOCKS[number];

export type SyncDomainBlockState =
  | "not_started"
  | "scheduled"
  | "syncing"
  | "backfilling"
  | "up_to_date"
  | "retrying"
  | "delayed"
  | "failed"
  | "paused"
  | "not_available";

export interface SyncDomainProgress {
  label: string;
  current: number;
  total: number | null;
  unit: string;
  percent: number | null;
  percentValid: boolean;
  details: Record<string, unknown>;
}

export interface SyncStatusReason {
  code: string | null;
  summary: string | null;
  waitingFor: string[] | null;
}

export type SyncStreamRole = "primary" | "supporting";

export interface SyncTaskReadStatus {
  stream: SyncStream;
  domain: SyncDomainBlockKey;
  runtimeState: PageSyncState["status"] | "not_started";
  state: Exclude<SyncDomainBlockState, "not_available">;
  workClass: "live" | "history" | "maintenance" | null;
  phase: string | null;
  requestedSeq: number;
  appliedSeq: number;
  succeededAt: string | null;
  progressedAt: string | null;
  failedAt: string | null;
  nextDueAt: string | null;
  nextRetryAt: string | null;
  queueAgeSeconds: number | null;
  freshnessAgeSeconds: number | null;
  isFresh: boolean;
  progress: SyncDomainProgress | null;
  needsAttention: boolean;
  statusReason: SyncStatusReason | null;
  error: {
    code: string | null;
    summary: string | null;
    failedAt: string | null;
    consecutiveFailures: number;
  } | null;
}

type QueueContext = {
  activeSiblingStreams: SyncStream[];
};

export interface SyncDomainBlockStatus {
  block: SyncDomainBlockKey;
  state: SyncDomainBlockState;
  succeededAt: string | null;
  progress: SyncDomainProgress | null;
  progressStream: SyncStream | null;
  progressRole: SyncStreamRole | null;
  error: {
    stream: SyncStream | null;
    code: string | null;
    summary: string | null;
    failedAt: string | null;
    consecutiveFailures: number;
  } | null;
  statusReason: SyncStatusReason | null;
  primaryFresh: boolean;
  needsAttention: boolean;
  nextDueAt: string | null;
  nextRetryAt: string | null;
  intervals: Array<{
    stream: SyncStream;
    cadenceSeconds: number;
  }>;
  metrics: Record<string, unknown>;
  connectionStatus: "connected" | "not_connected" | "error" | null;
  substreams: Array<{
    stream: SyncStream;
    role: SyncStreamRole;
    state: Exclude<SyncDomainBlockState, "not_available">;
    succeededAt: string | null;
    nextDueAt: string | null;
    nextRetryAt: string | null;
    cadenceSeconds: number;
    isFresh: boolean;
    needsAttention: boolean;
    statusReason: SyncStatusReason | null;
    error: {
      stream: SyncStream | null;
      code: string | null;
      summary: string | null;
      failedAt: string | null;
      consecutiveFailures: number;
    } | null;
  }>;
  tasks: SyncTaskReadStatus[];
}

export interface SyncStatusPage {
  pageId: number;
  pageLabel: string;
  platform: "fansly" | "onlyfans";
  modelSlug: string;
  modelName: string;
  username: string | null;
  displayName: string | null;
  blocks: Record<SyncDomainBlockKey, SyncDomainBlockStatus>;
  syncUx: SyncUxSummary;
}

export interface SyncStatusSnapshot {
  generatedAt: string;
  pages: SyncStatusPage[];
}

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function ageSeconds(value: Date | null | undefined, now: Date) {
  if (!value) {
    return null;
  }

  return Math.max(0, Math.floor((now.getTime() - value.getTime()) / 1000));
}

function percent(current: number, total: number | null) {
  if (total === null || total <= 0) {
    return null;
  }

  return Math.max(0, Math.min(100, (current / total) * 100));
}

function latestIso(values: Array<Date | null | undefined>) {
  let latest: Date | null = null;
  for (const value of values) {
    if (!value) {
      continue;
    }
    if (!latest || value.getTime() > latest.getTime()) {
      latest = value;
    }
  }

  return iso(latest);
}

function earliestIso(values: Array<Date | null | undefined>) {
  let earliest: Date | null = null;
  for (const value of values) {
    if (!value) {
      continue;
    }
    if (!earliest || value.getTime() < earliest.getTime()) {
      earliest = value;
    }
  }

  return iso(earliest);
}

function computeNextDueAt(task: PageSyncState) {
  return new Date(((task.lastScheduledSlot + 1) * task.cadenceSeconds + task.slotOffsetSeconds) * 1000);
}

function parseDependencyWaitingFor(summary: string | null | undefined): string[] | null {
  if (!summary || !summary.startsWith("Waiting for ")) {
    return null;
  }

  const waitingFor = summary
    .slice("Waiting for ".length)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return waitingFor.length > 0 ? waitingFor : null;
}

function buildRuntimeGroupId(page: {
  platform: "fansly" | "onlyfans";
  proxyUrl: string | null;
}) {
  return `${page.platform}:${buildProxyEgressKey(page.proxyUrl ? { url: page.proxyUrl } : null)}`;
}

function hasActiveProgress(task: PageSyncState, now: Date) {
  if (task.status !== "running") {
    return false;
  }

  const policy = SYNC_STREAM_POLICY[task.stream];
  const lastActiveAt = task.progressedAt ?? task.startedAt;
  if (!lastActiveAt) {
    return false;
  }

  return (now.getTime() - lastActiveAt.getTime()) <= policy.progressStallThresholdMs;
}

function sortTasksByPolicyOrder(tasks: Iterable<SyncStream>) {
  return [...new Set(tasks)].sort((left, right) => SYNC_STREAM_POLICY[left].streamIndex - SYNC_STREAM_POLICY[right].streamIndex);
}

function buildStatusReason(
  code: string | null | undefined,
  summary: string | null | undefined,
  waitingFor?: string[] | null,
): SyncStatusReason | null {
  const normalizedCode = code ?? null;
  const normalizedSummary = summary ?? null;
  const normalizedWaitingFor = waitingFor ?? null;
  if (!normalizedCode && !normalizedSummary && !normalizedWaitingFor) {
    return null;
  }

  return {
    code: normalizedCode,
    summary: normalizedSummary,
    waitingFor: normalizedWaitingFor,
  };
}

function buildDelayedDomainReason(input: {
  block: SyncDomainBlockKey;
  state: SyncDomainBlockState;
  statusReason: SyncStatusReason | null;
  messagesHistoryComplete: boolean;
}): SyncStatusReason | null {
  if (input.statusReason || input.state !== "delayed") {
    return input.statusReason;
  }

  if (input.block === "messages_history" && !input.messagesHistoryComplete) {
    return buildStatusReason(
      "history_incomplete",
      "Conversation history is still catching up.",
    );
  }

  return null;
}

function buildTaskError(
  task: PageSyncState,
  statusReason: SyncStatusReason | null,
): SyncTaskReadStatus["error"] {
  const code = task.lastErrorCode ?? task.blockerCode ?? task.blockerKind ?? statusReason?.code ?? null;
  const summary = task.lastErrorSummary ?? task.blockerMessage ?? statusReason?.summary ?? null;
  if (!code && !summary && !task.failedAt) {
    return null;
  }

  return {
    code,
    summary,
    failedAt: iso(task.failedAt),
    consecutiveFailures: task.consecutiveFailures,
  };
}

function firstAttentionTask(tasks: SyncTaskReadStatus[]) {
  return tasks.find((task) => task.needsAttention) ?? null;
}

function hasPendingWork(task: SyncTaskReadStatus) {
  return task.requestedSeq > task.appliedSeq ||
    task.runtimeState === "pending" ||
    task.runtimeState === "retrying";
}

function taskRoleForBlock(policy: (typeof SYNC_DOMAIN_POLICY)[SyncDomainBlockKey], stream: SyncStream): SyncStreamRole {
  return policy.primaryStreams.includes(stream) ? "primary" : "supporting";
}

function pickProgressTask(
  tasks: SyncTaskReadStatus[],
  policy: (typeof SYNC_DOMAIN_POLICY)[SyncDomainBlockKey],
  primaryFresh: boolean,
) {
  const withProgress = tasks.filter((task) => task.progress !== null);
  if (withProgress.length === 0) {
    return null;
  }

  if (primaryFresh) {
  return withProgress.find((task) => taskRoleForBlock(policy, task.stream) === "supporting") ?? withProgress[0] ?? null;
  }

  return withProgress[0] ?? null;
}

function summary(state: SyncUxSummary["state"], input: {
  label: string;
  headline: string;
  detail?: string | null;
  progressLabel?: string | null;
  nextRetryAt?: string | null;
  updatedAt?: string | null;
  requiresAction?: boolean;
}): SyncUxSummary {
  return {
    state,
    label: input.label,
    headline: input.headline,
    detail: input.detail ?? null,
    progressLabel: input.progressLabel ?? null,
    nextRetryAt: input.nextRetryAt ?? null,
    updatedAt: input.updatedAt ?? null,
    requiresAction: input.requiresAction ?? false,
  };
}

function isHealthyQueueWaitingBlock(block: SyncDomainBlockStatus) {
  return block.state === "scheduled" && block.statusReason?.code === "queue_waiting" && block.primaryFresh;
}

function isHealthyDisplayBlock(block: SyncDomainBlockStatus) {
  return block.state === "up_to_date" || isHealthyQueueWaitingBlock(block);
}

export function mapDomainBlockToSyncUx(block: SyncDomainBlockStatus): SyncUxSummary {
  const updatedAt = latestIso(block.tasks.map((task) => (
    task.progressedAt ? new Date(task.progressedAt) : task.succeededAt ? new Date(task.succeededAt) : null
  )));
  const progressLabel = block.progress?.label ?? null;
  const reasonSummary = block.statusReason?.summary ?? block.error?.summary ?? null;
  const reasonCode = block.statusReason?.code ?? block.error?.code ?? null;

  switch (block.state) {
    case "failed":
      return summary("attention", {
        label: reasonCode === "credentials_invalid" ? "Reconnect" : "Needs attention",
        headline: reasonCode === "credentials_invalid"
          ? "Reconnect to resume sync"
          : "Sync needs attention",
        detail: reasonSummary ?? "Sync cannot continue until the blocker is cleared.",
        progressLabel,
        updatedAt,
        requiresAction: reasonCode === "credentials_invalid",
      });
    case "delayed":
      if (reasonCode === "history_incomplete" || reasonCode === "unmet_dependency") {
        return summary("catching_up", {
          label: "Catching up",
          headline: "Sync is catching up",
          detail: reasonSummary ?? "Historical data is still being filled in.",
          progressLabel,
          updatedAt,
        });
      }
      return summary("attention", {
        label: "Delayed",
        headline: "Sync is delayed",
        detail: reasonSummary ?? "Sync is not making expected progress.",
        progressLabel,
        updatedAt,
      });
    case "syncing":
      return summary("syncing", {
        label: "Syncing",
        headline: "Syncing now",
        detail: "Sync is actively processing fresh data.",
        progressLabel,
        updatedAt,
      });
    case "backfilling":
      return summary("catching_up", {
        label: "Backfilling",
        headline: "Sync is catching up",
        detail: "Historical data is still being filled in.",
        progressLabel,
        updatedAt,
      });
    case "scheduled":
      if (reasonCode === "queue_waiting" && block.primaryFresh) {
        return summary("healthy", {
          label: "Up to date",
          headline: "Up to date",
          detail: "Current data is up to date while another sync continues in the background.",
          progressLabel,
          updatedAt,
        });
      }
      return summary("catching_up", {
        label: "Queued",
        headline: "Queued to continue",
        detail: reasonCode === "queue_waiting"
          ? "Queued behind another sync that is actively making progress."
          : "Sync work is queued and within the normal wait budget.",
        progressLabel,
        updatedAt,
      });
    case "retrying":
      return summary("retrying", {
        label: "Retrying",
        headline: "Retrying automatically",
        detail: "A temporary issue occurred. Sync will resume automatically.",
        progressLabel,
        nextRetryAt: block.nextRetryAt,
        updatedAt,
      });
    case "paused":
      return summary("off", {
        label: "Paused",
        headline: "Sync is paused",
        detail: "This sync is intentionally paused.",
        progressLabel,
        updatedAt,
      });
    case "not_started":
      return summary("setup", {
        label: "Not started",
        headline: "Preparing first sync",
        detail: "This sync has not finished its first successful run yet.",
        progressLabel,
        updatedAt,
      });
    case "not_available":
      return summary("off", {
        label: "Not available",
        headline: "Not available",
        detail: "This sync domain is not available for this platform.",
        updatedAt,
      });
    case "up_to_date":
    default:
      return summary("healthy", {
        label: "Up to date",
        headline: "Up to date",
        detail: "This sync is current.",
        progressLabel,
        updatedAt,
      });
  }
}

function buildPageSyncUx(blocks: SyncDomainBlockStatus[]) {
  const supportedBlocks = blocks.filter((block) => block.state !== "not_available");
  if (supportedBlocks.length === 0) {
    return summary("off", {
      label: "Not available",
      headline: "Not available",
      detail: "No sync domains are available for this page.",
    });
  }

  const requiresReconnect = supportedBlocks.find((block) => block.statusReason?.code === "credentials_invalid");
  if (requiresReconnect) {
    return summary("attention", {
      label: "Reconnect",
      headline: "Reconnect to resume sync",
      detail: requiresReconnect.statusReason?.summary ?? "Fresh credentials are required before sync can continue.",
      updatedAt: mapDomainBlockToSyncUx(requiresReconnect).updatedAt,
      requiresAction: true,
    });
  }

  const failed = supportedBlocks.find((block) => block.state === "failed");
  if (failed) {
    return mapDomainBlockToSyncUx(failed);
  }

  const delayed = supportedBlocks.find((block) => block.state === "delayed");
  if (delayed) {
    return mapDomainBlockToSyncUx(delayed);
  }

  const activeBlock = supportedBlocks.find((block) => block.state === "syncing" || block.state === "backfilling");
  if (activeBlock) {
    const otherBlocksHealthy = supportedBlocks
      .filter((block) => block !== activeBlock)
      .every(isHealthyDisplayBlock);
    if (otherBlocksHealthy) {
      return summary("syncing", {
        label: "Syncing",
        headline: "Syncing now",
        detail: "Background sync is actively processing pending work.",
        progressLabel: activeBlock.progress?.label ?? null,
        updatedAt: mapDomainBlockToSyncUx(activeBlock).updatedAt,
      });
    }

    return mapDomainBlockToSyncUx(activeBlock);
  }

  const retrying = supportedBlocks.find((block) => block.state === "retrying");
  if (retrying) {
    return mapDomainBlockToSyncUx(retrying);
  }

  const scheduled = supportedBlocks.find((block) => block.state === "scheduled");
  if (scheduled) {
    return mapDomainBlockToSyncUx(scheduled);
  }

  if (supportedBlocks.every((block) => block.state === "paused")) {
    return summary("off", {
      label: "Paused",
      headline: "Sync is paused",
        detail: "All supported sync domains are paused.",
        updatedAt: latestIso(supportedBlocks.map((block) => (
        block.succeededAt ? new Date(block.succeededAt) : null
      ))),
    });
  }

  if (supportedBlocks.every((block) => block.state === "not_started")) {
    return summary("setup", {
      label: "Not started",
      headline: "Preparing first sync",
      detail: "Initial sync has not completed yet.",
    });
  }

  return summary("healthy", {
    label: "Up to date",
    headline: "Up to date",
    detail: "All supported sync domains are current.",
    updatedAt: latestIso(supportedBlocks.map((block) => (
      block.succeededAt ? new Date(block.succeededAt) : null
    ))),
  });
}

function buildProgressFromPayload(
  task: PageSyncState,
  monitorRow: SyncMonitorStreamRow | null,
): SyncDomainProgress | null {
  const payload = task.progress ?? {};

  if (typeof payload.pageCount === "number" && typeof payload.offset === "number") {
    const total = Math.max(payload.pageCount, 0);
    const current = Math.max(0, Math.min(payload.offset, total));
    const unit = task.stream === "dm_conversations" ? "conversations" : task.stream === "subscribers"
      ? "subscribers"
      : "followers";
    return {
      label: `${current.toLocaleString()} / ${total.toLocaleString()} ${unit}`,
      current,
      total,
      unit,
      percent: percent(current, total),
      percentValid: total > 0,
      details: payload,
    };
  }

  if (typeof payload.providerReportedTotal === "number" && typeof payload.offset === "number") {
    const total = Math.max(payload.providerReportedTotal, 0);
    const current = Math.max(0, Math.min(payload.offset, total));
    return {
      label: `${current.toLocaleString()} / ${total.toLocaleString()} conversations`,
      current,
      total,
      unit: "conversations",
      percent: percent(current, total),
      percentValid: total > 0,
      details: payload,
    };
  }

  if (typeof payload.totalMonths === "number" && typeof payload.completedMonths === "number") {
    const total = Math.max(payload.totalMonths, 0);
    const current = Math.max(0, Math.min(payload.completedMonths, total));
    return {
      label: `${current.toLocaleString()} / ${total.toLocaleString()} months`,
      current,
      total,
      unit: "months",
      percent: percent(current, total),
      percentValid: total > 0,
      details: payload,
    };
  }

  if (task.stream === "transactions" && typeof payload.processedTransactions === "number") {
    const current = Math.max(0, payload.processedTransactions + (typeof payload.processedChargebacks === "number"
      ? payload.processedChargebacks
      : 0));
    return {
      label: `${current.toLocaleString()} items backfilled`,
      current,
      total: null,
      unit: "items",
      percent: null,
      percentValid: false,
      details: payload,
    };
  }

  if (task.stream === "dm_messages" && monitorRow) {
    const total = monitorRow.dmEligibleConversationCount;
    const current = monitorRow.dmBackfillCompleteConversationCount;
    const lagging = monitorRow.dmLaggingConversationCount;
    if (total > 0 || current > 0 || lagging > 0) {
      const label = lagging > 0
        ? `${current.toLocaleString()} / ${total.toLocaleString()} conversations ready, ${lagging.toLocaleString()} lagging`
        : `${current.toLocaleString()} / ${total.toLocaleString()} conversations ready`;
      return {
        label,
        current,
        total,
        unit: "conversations",
        percent: percent(current, total),
        percentValid: total > 0,
        details: {
          ...payload,
          laggingConversationCount: lagging,
        },
      };
    }
  }

  if (typeof payload.processedMessages === "number") {
    return {
      label: `${payload.processedMessages.toLocaleString()} messages processed`,
      current: Math.max(payload.processedMessages, 0),
      total: null,
      unit: "messages",
      percent: null,
      percentValid: false,
      details: payload,
    };
  }

  return null;
}

function deriveTaskState(
  task: PageSyncState,
  monitorRow: SyncMonitorStreamRow | null,
  now: Date,
  queueContext?: QueueContext,
): SyncTaskReadStatus {
  const policy = SYNC_STREAM_POLICY[task.stream];
  const queueAgeSeconds = task.requestSeq > task.appliedSeq && task.requestedAt
    ? ageSeconds(task.requestedAt, now)
    : null;
  const freshnessAgeSeconds = ageSeconds(task.succeededAt, now);
  const progressStalled = task.status === "running" &&
    task.progressedAt !== null &&
    (now.getTime() - task.progressedAt.getTime()) > policy.progressStallThresholdMs;
  const queueDelayed = queueAgeSeconds !== null &&
    (queueAgeSeconds * 1000) > policy.queueDelayThresholdMs;
  const nextDueAt = computeNextDueAt(task);
  const progress = buildProgressFromPayload(task, monitorRow);

  let state: Exclude<SyncDomainBlockState, "not_available">;
  let statusReason: SyncStatusReason | null = null;

  if (task.status === "paused") {
    state = "paused";
    statusReason = buildStatusReason("paused", "Sync is paused.");
  } else if (task.status === "blocked") {
    if (task.blockerKind === "dependency") {
      state = "delayed";
      statusReason = buildStatusReason(
        task.blockerCode ?? "unmet_dependency",
        task.blockerMessage ?? "Waiting for prerequisite sync work.",
        parseDependencyWaitingFor(task.blockerMessage),
      );
    } else {
      state = "failed";
      statusReason = buildStatusReason(
        task.blockerCode ?? task.blockerKind ?? "blocked",
        task.blockerMessage ?? task.lastErrorSummary ?? "Sync is blocked.",
      );
    }
  } else if (task.status === "retrying") {
    state = "retrying";
    statusReason = buildStatusReason(
      task.retryKind ?? "retrying",
      task.lastErrorSummary ?? "Retrying automatically.",
    );
  } else if (task.status === "running") {
    if (progressStalled) {
      state = "delayed";
      statusReason = buildStatusReason("progress_stalled", "Sync is running but not making progress.");
    } else if ((task.workClass ?? policy.defaultWorkClass) === "live") {
      state = "syncing";
    } else {
      state = "backfilling";
    }
  } else if (task.requestSeq > task.appliedSeq || task.status === "pending") {
    if ((queueContext?.activeSiblingStreams.length ?? 0) > 0) {
      state = "scheduled";
      statusReason = buildStatusReason(
        "queue_waiting",
        "Queued - will start after current sync completes.",
        queueContext?.activeSiblingStreams ?? null,
      );
    } else if (queueDelayed) {
      state = "delayed";
      statusReason = buildStatusReason(
        "queue_delayed",
        "Queued too long with no active sync making progress.",
      );
    } else {
      state = "scheduled";
    }
  } else if (task.succeededAt === null && task.requestSeq === 0) {
    state = "not_started";
  } else if (task.succeededAt !== null && policy.freshnessSlaSeconds !== null && freshnessAgeSeconds !== null &&
    freshnessAgeSeconds > policy.freshnessSlaSeconds) {
    state = "delayed";
    statusReason = buildStatusReason("stale", "Last successful sync is older than the freshness target.");
  } else {
    state = "up_to_date";
  }

  const isFresh = policy.freshnessSlaSeconds === null
    ? task.succeededAt !== null
    : freshnessAgeSeconds !== null && freshnessAgeSeconds <= policy.freshnessSlaSeconds;
  const error = state === "failed" || state === "retrying"
    ? buildTaskError(task, statusReason)
    : null;

  return {
    stream: task.stream,
    domain: policy.domain,
    runtimeState: task.succeededAt === null && task.requestSeq === 0 ? "not_started" : task.status,
    state,
    workClass: task.workClass ?? policy.defaultWorkClass,
    phase: task.phase,
    requestedSeq: task.requestSeq,
    appliedSeq: task.appliedSeq,
    succeededAt: iso(task.succeededAt),
    progressedAt: iso(task.progressedAt),
    failedAt: iso(task.failedAt),
    nextDueAt: iso(nextDueAt),
    nextRetryAt: iso(task.retryAt),
    queueAgeSeconds,
    freshnessAgeSeconds,
    isFresh,
    progress,
    needsAttention: state === "failed" || state === "delayed",
    statusReason,
    error,
  };
}

function isFreshEnough(task: SyncTaskReadStatus) {
  return task.isFresh;
}

function deriveDomainState(
  block: SyncDomainBlockKey,
  page: Awaited<ReturnType<typeof listVisiblePages>>[number],
  tasks: SyncTaskReadStatus[],
  monitorRows: SyncMonitorStreamRow[],
): SyncDomainBlockStatus {
  const policy = SYNC_DOMAIN_POLICY[block];
  const supportedTasks = tasks;
  if (supportedTasks.length === 0) {
    return {
      block,
      state: "not_available",
      succeededAt: null,
      progress: null,
      progressStream: null,
      progressRole: null,
      error: null,
      statusReason: null,
      primaryFresh: false,
      needsAttention: false,
      nextDueAt: null,
      nextRetryAt: null,
      intervals: [],
      metrics: {},
      connectionStatus: null,
      substreams: [],
      tasks: [],
    };
  }

  const primaryTasks = supportedTasks.filter((task) => policy.primaryStreams.includes(task.stream));
  const supportingTasks = supportedTasks.filter((task) => policy.supportingStreams.includes(task.stream));
  const earliestRetryAt = earliestIso(supportedTasks.map((task) => (
    task.nextRetryAt ? new Date(task.nextRetryAt) : null
  )));
  const earliestNextDueAt = earliestIso(supportedTasks.map((task) => (
    task.nextDueAt ? new Date(task.nextDueAt) : null
  )));
  const succeededAt = latestIso(supportedTasks.map((task) => (
    task.succeededAt ? new Date(task.succeededAt) : null
  )));
  const primaryPending = primaryTasks.some(hasPendingWork);
  const supportingPending = supportingTasks.some(hasPendingWork);
  const anyPrimaryPaused = primaryTasks.some((task) => task.runtimeState === "paused");
  const anyPrimaryFailed = primaryTasks.some((task) => task.state === "failed");
  const anyPrimaryDelayed = primaryTasks.some((task) => task.state === "delayed");
  const anyPrimaryLiveRunning = primaryTasks.some((task) =>
    task.runtimeState === "running" && task.workClass === "live"
  );
  const anyPrimaryHistoryRunning = primaryTasks.some((task) =>
    task.runtimeState === "running" && task.workClass !== "live"
  );
  const anyPrimaryRetrying = primaryTasks.some((task) => task.runtimeState === "retrying");
  const anySupportingLiveRunning = supportingTasks.some((task) =>
    task.runtimeState === "running" && task.workClass === "live"
  );
  const anySupportingHistoryRunning = supportingTasks.some((task) =>
    task.runtimeState === "running" && task.workClass !== "live"
  );
  const anySupportingRetrying = supportingTasks.some((task) => task.runtimeState === "retrying");
  const allPrimaryNeverSucceeded = primaryTasks.every((task) => task.succeededAt === null);
  const allPrimaryFresh = primaryTasks.every(isFreshEnough);
  const primaryFresh = allPrimaryFresh;
  const messagesMonitorRow = monitorRows.find((row) => row.stream === "dm_messages") ?? monitorRows[0] ?? null;
  const messagesHistoryComplete = messagesMonitorRow
    ? messagesMonitorRow.dmEligibleConversationCount === 0 ||
      (messagesMonitorRow.dmBackfillCompleteConversationCount >= messagesMonitorRow.dmEligibleConversationCount &&
        messagesMonitorRow.dmLaggingConversationCount === 0)
    : !primaryPending;

  let state: SyncDomainBlockState;
  if (allPrimaryNeverSucceeded && !primaryPending && !supportingPending && !anySupportingHistoryRunning && !anySupportingLiveRunning) {
    state = "not_started";
  } else if (anyPrimaryPaused) {
    state = "paused";
  } else if (anyPrimaryFailed) {
    state = "failed";
  } else if (anyPrimaryDelayed) {
    state = "delayed";
  } else if (anyPrimaryLiveRunning) {
    state = "syncing";
  } else if (anyPrimaryHistoryRunning) {
    state = "backfilling";
  } else if (anyPrimaryRetrying) {
    state = "retrying";
  } else if (primaryPending) {
    state = "scheduled";
  } else if (anySupportingLiveRunning || anySupportingHistoryRunning) {
    state = anySupportingLiveRunning ? "syncing" : "backfilling";
  } else if (anySupportingRetrying) {
    state = "retrying";
  } else if (supportingPending) {
    state = "scheduled";
  } else {
    const domainUpToDate = (() => {
      switch (block) {
        case "connection":
          return page.hasCredentials && allPrimaryFresh;
        case "financials":
          return allPrimaryFresh;
        case "audience":
          return allPrimaryFresh;
        case "messages_live":
          return allPrimaryFresh;
        case "messages_history":
          return !primaryPending && !anyPrimaryDelayed && messagesHistoryComplete;
      }
    })();

    state = domainUpToDate ? "up_to_date" : "delayed";
  }

  const progressTask = block === "messages_history"
    ? primaryTasks.find((task) => task.stream === "dm_messages") ?? null
    : pickProgressTask(supportedTasks, policy, primaryFresh);
  const progress = block === "messages_history" && messagesMonitorRow
    ? {
      label: messagesMonitorRow.dmEligibleConversationCount === 0
        ? "No conversation backlog"
        : `${messagesMonitorRow.dmBackfillCompleteConversationCount.toLocaleString()} / ${
          messagesMonitorRow.dmEligibleConversationCount.toLocaleString()
        } conversations ready${
          messagesMonitorRow.dmLaggingConversationCount > 0
            ? `, ${messagesMonitorRow.dmLaggingConversationCount.toLocaleString()} lagging`
            : ""
        }`,
      current: messagesMonitorRow.dmBackfillCompleteConversationCount,
      total: messagesMonitorRow.dmEligibleConversationCount,
      unit: "conversations",
      percent: percent(
        messagesMonitorRow.dmBackfillCompleteConversationCount,
        messagesMonitorRow.dmEligibleConversationCount,
      ),
      percentValid: messagesMonitorRow.dmEligibleConversationCount > 0,
      details: {
        laggingConversationCount: messagesMonitorRow.dmLaggingConversationCount,
        messageCount: messagesMonitorRow.dmMessageCount,
      },
    } satisfies SyncDomainProgress
    : progressTask?.progress ?? null;
  const progressStream = progress ? progressTask?.stream ?? null : null;
  const progressRole = progressStream ? taskRoleForBlock(policy, progressStream) : null;

  const metricsRow = monitorRows[0] ?? null;
  const metrics = (() => {
    switch (block) {
      case "connection":
        return {};
      case "financials":
        return {
          transactionCount: metricsRow?.transactionCount ?? 0,
        };
      case "audience":
        return {
          subscriberCount: page.subscriberCount ?? 0,
          followerCount: page.followerCount ?? 0,
        };
      case "messages_live":
        return {
          visibleConversationCount: metricsRow?.dmConversationCount ?? 0,
        };
      case "messages_history":
        return {
          eligibleConversationCount: metricsRow?.dmEligibleConversationCount ?? 0,
          readyConversationCount: metricsRow?.dmBackfillCompleteConversationCount ?? 0,
          laggingConversationCount: metricsRow?.dmLaggingConversationCount ?? 0,
          messageCount: metricsRow?.dmMessageCount ?? 0,
        };
    }
  })();

  const primaryReasonTask = firstAttentionTask(primaryTasks) ?? primaryTasks.find((task) => task.statusReason !== null) ?? null;
  const supportingReasonTask = firstAttentionTask(supportingTasks) ??
    supportingTasks.find((task) => task.statusReason !== null) ??
    null;
  const activeReasonTask = primaryReasonTask ?? supportingReasonTask;
  const statusReason = buildDelayedDomainReason({
    block,
    state,
    statusReason: activeReasonTask?.statusReason ?? null,
    messagesHistoryComplete,
  });
  const errorTask = state === "failed" || state === "retrying"
    ? primaryTasks.find((task) => task.error !== null) ?? supportingTasks.find((task) => task.error !== null) ?? null
    : null;
  const error = errorTask?.error
    ? {
      stream: errorTask.stream,
      code: errorTask.error.code,
      summary: errorTask.error.summary,
      failedAt: errorTask.error.failedAt,
      consecutiveFailures: errorTask.error.consecutiveFailures,
    }
    : null;

  const connectionStatus = block === "connection"
    ? !page.hasCredentials
      ? "not_connected"
      : state === "failed" || state === "delayed"
        ? "error"
        : "connected"
    : null;

  return {
    block,
    state,
    succeededAt,
    progress,
    progressStream,
    progressRole,
    error,
    statusReason,
    primaryFresh,
    needsAttention: state === "failed" || state === "delayed",
    nextDueAt: earliestNextDueAt,
    nextRetryAt: earliestRetryAt,
    intervals: supportedTasks.map((task) => ({
      stream: task.stream,
      cadenceSeconds: SYNC_STREAM_POLICY[task.stream].cadenceSeconds,
    })),
    metrics,
    connectionStatus,
    substreams: supportedTasks.map((task) => ({
      stream: task.stream,
      role: taskRoleForBlock(policy, task.stream),
      state: task.state,
      succeededAt: task.succeededAt,
      nextDueAt: task.nextDueAt,
      nextRetryAt: task.nextRetryAt,
      cadenceSeconds: SYNC_STREAM_POLICY[task.stream].cadenceSeconds,
      isFresh: task.isFresh,
      needsAttention: task.needsAttention,
      statusReason: task.statusReason,
      error: task.error
        ? {
          stream: task.stream,
          code: task.error.code,
          summary: task.error.summary,
          failedAt: task.error.failedAt,
          consecutiveFailures: task.error.consecutiveFailures,
        }
        : null,
    })),
    tasks: supportedTasks,
  };
}

export async function getSyncStatusSnapshot(
  app: AppContext,
  input?: {
    pageIds?: number[];
    pageLabel?: string;
    now?: Date;
  },
): Promise<SyncStatusSnapshot> {
  const now = input?.now ?? new Date();
  const allVisiblePages = await listVisiblePages(app.db);
  const scopedPages = (() => {
    const pageIds = input?.pageIds ? new Set(input.pageIds) : null;
    return allVisiblePages.filter((page) => {
      if (pageIds && !pageIds.has(page.id)) {
        return false;
      }
      if (input?.pageLabel && page.label !== input.pageLabel) {
        return false;
      }
      return true;
    });
  })();
  const scopedPageIds = scopedPages.map((page) => page.id);
  if (scopedPageIds.length === 0) {
    return {
      generatedAt: now.toISOString(),
      pages: [],
    };
  }

  if (input?.pageIds || input?.pageLabel || scopedPageIds.length === 1) {
    await Promise.all(scopedPageIds.map((pageId) => ensurePageSyncStates(app.db, {
      pageId,
      now,
    })));
  } else {
    await ensurePageSyncStates(app.db, { now });
  }

  const [taskRows, monitorRows] = await Promise.all([
    listPageSyncStates(app.db),
    listSyncMonitorStreamRows(app.db, {
      pageIds: scopedPageIds,
      windowStart: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      streams: [...getSyncStreamsForPlatform("fansly")],
    }),
  ]);

  const visiblePageIds = new Set(allVisiblePages.map((page) => page.id));
  const pagesById = new Map(allVisiblePages.map((page) => [page.id, page] as const));
  const runtimeGroupByPageId = new Map(
    allVisiblePages.map((page) => [page.id, buildRuntimeGroupId(page)] as const),
  );
  const activeStreamsByGroupId = new Map<string, Set<SyncStream>>();
  for (const taskRow of taskRows) {
    if (!visiblePageIds.has(taskRow.pageId) || !hasActiveProgress(taskRow, now)) {
      continue;
    }

    const page = pagesById.get(taskRow.pageId);
    if (!page) {
      continue;
    }

    const groupId = runtimeGroupByPageId.get(page.id) ?? buildRuntimeGroupId(page);
    const current = activeStreamsByGroupId.get(groupId) ?? new Set<SyncStream>();
    current.add(taskRow.stream);
    activeStreamsByGroupId.set(groupId, current);
  }

  const taskRowsByPageTask = new Map(
    taskRows
      .filter((row) => scopedPageIds.includes(row.pageId))
      .map((row) => [`${row.pageId}:${row.stream}`, row] as const),
  );
  const monitorRowsByPageTask = new Map(
    monitorRows.map((row) => [`${row.pageId}:${row.stream}`, row] as const),
  );

  return {
    generatedAt: now.toISOString(),
    pages: scopedPages.map((page) => {
      const supportedTasks = getSyncStreamsForPlatform(page.platform);
      const blocks = Object.fromEntries(SYNC_DOMAIN_BLOCKS.map((block) => {
        const domainTasks = supportedTasks
          .filter((stream) => SYNC_DOMAIN_POLICY[block].primaryStreams.includes(stream) || SYNC_DOMAIN_POLICY[block].supportingStreams.includes(stream))
          .map((stream) => {
            const taskRow = taskRowsByPageTask.get(`${page.id}:${stream}`);
            const monitorRow = monitorRowsByPageTask.get(`${page.id}:${stream}`) ?? null;
            const effectiveTaskRow = taskRow ?? {
              pageId: page.id,
              stream,
              status: "idle",
              requestSeq: 0,
              leasedSeq: null,
              appliedSeq: 0,
              requestSource: null,
              requestPayload: {},
              cadenceSeconds: SYNC_STREAM_POLICY[stream].cadenceSeconds,
              slotOffsetSeconds: 0,
              lastScheduledSlot: 0,
              requestedAt: null,
              enqueuedAt: null,
              startedAt: null,
              progressedAt: null,
              finishedAt: null,
              succeededAt: null,
              failedAt: null,
              retryKind: null,
              retryAt: null,
              blockerKind: null,
              blockerCode: null,
              blockerMessage: null,
              blockedAt: null,
              phase: null,
              workClass: SYNC_STREAM_POLICY[stream].defaultWorkClass,
              progress: {},
              leaseOwner: null,
              leaseToken: null,
              leaseHeartbeatAt: null,
              leaseExpiresAt: null,
              consecutiveFailures: 0,
              lastErrorCode: null,
              lastErrorSummary: null,
              createdAt: now,
              updatedAt: now,
            } satisfies PageSyncState;

            const groupId = runtimeGroupByPageId.get(page.id) ?? buildRuntimeGroupId(page);
            const activeSiblingStreams = sortTasksByPolicyOrder(activeStreamsByGroupId.get(groupId) ?? []);

            return deriveTaskState(effectiveTaskRow, monitorRow, now, {
              activeSiblingStreams,
            });
          });
        const domainMonitorRows = monitorRows.filter((row) =>
          row.pageId === page.id &&
          domainTasks.some((task) => task.stream === row.stream)
        );

        return [block, deriveDomainState(block, page, domainTasks, domainMonitorRows)] as const;
      })) as Record<SyncDomainBlockKey, SyncDomainBlockStatus>;

      const blockList = SYNC_DOMAIN_BLOCKS.map((block) => blocks[block]);
      return {
        pageId: page.id,
        pageLabel: page.label,
        platform: page.platform,
        modelSlug: page.modelSlug,
        modelName: page.modelName,
        username: page.username,
        displayName: page.displayName,
        blocks,
        syncUx: buildPageSyncUx(blockList),
      } satisfies SyncStatusPage;
    }),
  };
}
