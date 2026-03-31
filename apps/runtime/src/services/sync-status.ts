import type { SyncUxSummary } from "@agency_hub_core/contracts";
import {
  DOMAIN_POLICY,
  TASK_POLICY,
  ensureSyncTaskRows,
  getSyncTasksForPlatform,
  listSyncMonitorStreamRows,
  listSyncTaskRows,
  listVisiblePages,
  type SyncMonitorStreamRow,
  type SyncTaskRow,
  type SyncV2Domain,
  type SyncV2Task,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";

export const SYNC_DOMAIN_BLOCKS = [
  "connection",
  "financials",
  "audience",
  "messages_live",
  "messages_history",
] as const satisfies readonly SyncV2Domain[];

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

export interface SyncTaskReadStatus {
  task: SyncV2Task;
  domain: SyncDomainBlockKey;
  runtimeState: SyncTaskRow["status"] | "not_started";
  state: Exclude<SyncDomainBlockState, "not_available">;
  workClass: "live" | "history" | "maintenance" | null;
  phase: string | null;
  desiredGeneration: number;
  appliedGeneration: number;
  lastSuccessAt: string | null;
  lastProgressAt: string | null;
  lastFailureAt: string | null;
  nextDueAt: string | null;
  nextRetryAt: string | null;
  queueAgeSeconds: number | null;
  freshnessAgeSeconds: number | null;
  progress: SyncDomainProgress | null;
  needsAttention: boolean;
  reasonCode: string | null;
  reasonText: string | null;
  error: {
    code: string | null;
    summary: string | null;
    lastFailedAt: string | null;
    consecutiveFailures: number;
  } | null;
}

export interface SyncDomainBlockStatus {
  block: SyncDomainBlockKey;
  state: SyncDomainBlockState;
  lastSuccessAt: string | null;
  progress: SyncDomainProgress | null;
  error: {
    stream: SyncV2Task | null;
    code: string | null;
    summary: string | null;
    lastFailedAt: string | null;
    consecutiveFailures: number;
  } | null;
  needsAttention: boolean;
  nextDueAt: string | null;
  nextRetryAt: string | null;
  intervals: Array<{
    stream: SyncV2Task;
    cadenceSeconds: number;
  }>;
  metrics: Record<string, unknown>;
  connectionStatus: "connected" | "not_connected" | "error" | null;
  substreams: Array<{
    stream: SyncV2Task;
    state: Exclude<SyncDomainBlockState, "not_available">;
    lastSuccessAt: string | null;
    nextDueAt: string | null;
    nextRetryAt: string | null;
    cadenceSeconds: number;
    needsAttention: boolean;
    error: {
      stream: SyncV2Task | null;
      code: string | null;
      summary: string | null;
      lastFailedAt: string | null;
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

function computeNextDueAt(task: SyncTaskRow) {
  return new Date(((task.lastScheduledSlot + 1) * task.scheduleIntervalSeconds + task.slotOffsetSeconds) * 1000);
}

function firstTaskWithProgress(tasks: SyncTaskReadStatus[]) {
  return tasks.find((task) => task.progress !== null) ?? null;
}

function firstAttentionTask(tasks: SyncTaskReadStatus[]) {
  return tasks.find((task) => task.needsAttention) ?? null;
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

export function mapDomainBlockToSyncUx(block: SyncDomainBlockStatus): SyncUxSummary {
  const updatedAt = latestIso(block.tasks.map((task) => (
    task.lastProgressAt ? new Date(task.lastProgressAt) : task.lastSuccessAt ? new Date(task.lastSuccessAt) : null
  )));
  const progressLabel = block.progress?.label ?? null;

  switch (block.state) {
    case "failed":
      return summary("attention", {
        label: block.error?.code === "credentials_invalid" ? "Reconnect" : "Needs attention",
        headline: block.error?.code === "credentials_invalid"
          ? "Reconnect to resume sync"
          : "Sync needs attention",
        detail: block.error?.summary ?? "Sync cannot continue until the blocker is cleared.",
        progressLabel,
        updatedAt,
        requiresAction: block.error?.code === "credentials_invalid",
      });
    case "delayed":
      return summary("attention", {
        label: "Delayed",
        headline: "Sync is delayed",
        detail: block.error?.summary ?? "Sync is not making expected progress.",
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
      return summary("catching_up", {
        label: "Scheduled",
        headline: "Queued to continue",
        detail: "Sync work is queued and within the normal wait budget.",
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

  const requiresReconnect = supportedBlocks.find((block) => block.error?.code === "credentials_invalid");
  if (requiresReconnect) {
    return summary("attention", {
      label: "Reconnect",
      headline: "Reconnect to resume sync",
      detail: requiresReconnect.error?.summary ?? "Fresh credentials are required before sync can continue.",
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

  const syncing = supportedBlocks.find((block) => block.state === "syncing");
  if (syncing) {
    return mapDomainBlockToSyncUx(syncing);
  }

  const backfilling = supportedBlocks.find((block) => block.state === "backfilling");
  if (backfilling) {
    return mapDomainBlockToSyncUx(backfilling);
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
        block.lastSuccessAt ? new Date(block.lastSuccessAt) : null
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
      block.lastSuccessAt ? new Date(block.lastSuccessAt) : null
    ))),
  });
}

function buildProgressFromPayload(
  task: SyncTaskRow,
  monitorRow: SyncMonitorStreamRow | null,
): SyncDomainProgress | null {
  const payload = task.progressPayload ?? {};

  if (typeof payload.pageCount === "number" && typeof payload.offset === "number") {
    const total = Math.max(payload.pageCount, 0);
    const current = Math.max(0, Math.min(payload.offset, total));
    const unit = task.task === "dm_conversations" ? "conversations" : task.task === "subscribers"
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

  if (task.task === "transactions" && typeof payload.processedTransactions === "number") {
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

  if (task.task === "dm_messages" && monitorRow) {
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
  task: SyncTaskRow,
  monitorRow: SyncMonitorStreamRow | null,
  now: Date,
): SyncTaskReadStatus {
  const policy = TASK_POLICY[task.task];
  const queueAgeSeconds = task.desiredGeneration > task.appliedGeneration && task.lastRequestedAt
    ? ageSeconds(task.lastRequestedAt, now)
    : null;
  const freshnessAgeSeconds = ageSeconds(task.lastSuccessAt, now);
  const progressStalled = task.status === "running" &&
    task.lastProgressAt !== null &&
    (now.getTime() - task.lastProgressAt.getTime()) > policy.progressStallThresholdMs;
  const queueDelayed = queueAgeSeconds !== null &&
    (queueAgeSeconds * 1000) > policy.queueDelayThresholdMs;
  const nextDueAt = computeNextDueAt(task);
  const progress = buildProgressFromPayload(task, monitorRow);

  let state: Exclude<SyncDomainBlockState, "not_available">;
  let reasonCode: string | null = null;
  let reasonText: string | null = null;

  if (task.status === "paused") {
    state = "paused";
    reasonCode = "paused";
    reasonText = "Sync is paused.";
  } else if (task.status === "blocked") {
    if (task.blockerType === "dependency") {
      state = "delayed";
      reasonCode = task.blockerCode ?? "unmet_dependency";
      reasonText = task.blockerReason ?? "Waiting for prerequisite sync work.";
    } else {
      state = "failed";
      reasonCode = task.blockerCode ?? task.blockerType ?? "blocked";
      reasonText = task.blockerReason ?? task.lastErrorSummary ?? "Sync is blocked.";
    }
  } else if (task.status === "retry_wait") {
    state = "retrying";
    reasonCode = task.retryClass ?? "retry_wait";
    reasonText = task.lastErrorSummary ?? "Retrying automatically.";
  } else if (task.status === "running") {
    if (progressStalled) {
      state = "delayed";
      reasonCode = "progress_stalled";
      reasonText = "Sync is running but not making progress.";
    } else if ((task.currentWorkClass ?? policy.defaultWorkClass) === "live") {
      state = "syncing";
    } else {
      state = "backfilling";
    }
  } else if (task.desiredGeneration > task.appliedGeneration || task.status === "queued") {
    if (queueDelayed) {
      state = "delayed";
      reasonCode = "queue_delayed";
      reasonText = "Sync work has been queued longer than expected.";
    } else {
      state = "scheduled";
    }
  } else if (task.lastSuccessAt === null && task.desiredGeneration === 0) {
    state = "not_started";
  } else if (task.lastSuccessAt !== null && policy.freshnessSlaSeconds !== null && freshnessAgeSeconds !== null &&
    freshnessAgeSeconds > policy.freshnessSlaSeconds) {
    state = "delayed";
    reasonCode = "stale";
    reasonText = "Last successful sync is older than the freshness target.";
  } else {
    state = "up_to_date";
  }

  return {
    task: task.task,
    domain: policy.domain,
    runtimeState: task.lastSuccessAt === null && task.desiredGeneration === 0 ? "not_started" : task.status,
    state,
    workClass: task.currentWorkClass ?? policy.defaultWorkClass,
    phase: task.currentPhase,
    desiredGeneration: task.desiredGeneration,
    appliedGeneration: task.appliedGeneration,
    lastSuccessAt: iso(task.lastSuccessAt),
    lastProgressAt: iso(task.lastProgressAt),
    lastFailureAt: iso(task.lastFailureAt),
    nextDueAt: iso(nextDueAt),
    nextRetryAt: iso(task.retryAt),
    queueAgeSeconds,
    freshnessAgeSeconds,
    progress,
    needsAttention: state === "failed" || state === "delayed",
    reasonCode,
    reasonText,
    error: task.lastErrorCode || task.lastErrorSummary || task.lastFailureAt
      ? {
        code: task.lastErrorCode ?? task.blockerCode ?? task.blockerType ?? reasonCode,
        summary: task.blockerReason ?? task.lastErrorSummary ?? reasonText,
        lastFailedAt: iso(task.lastFailureAt),
        consecutiveFailures: task.consecutiveFailures,
      }
      : null,
  };
}

function isFreshEnough(task: SyncTaskReadStatus) {
  const sla = TASK_POLICY[task.task].freshnessSlaSeconds;
  if (sla === null) {
    return true;
  }
  if (task.lastSuccessAt === null || task.freshnessAgeSeconds === null) {
    return false;
  }

  return task.freshnessAgeSeconds <= sla;
}

function deriveDomainState(
  block: SyncDomainBlockKey,
  page: Awaited<ReturnType<typeof listVisiblePages>>[number],
  tasks: SyncTaskReadStatus[],
  monitorRows: SyncMonitorStreamRow[],
): SyncDomainBlockStatus {
  const policy = DOMAIN_POLICY[block];
  const supportedTasks = tasks;
  if (supportedTasks.length === 0) {
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
      tasks: [],
    };
  }

  const primaryTasks = supportedTasks.filter((task) => policy.primaryTasks.includes(task.task));
  const attentionTask = firstAttentionTask(supportedTasks);
  const earliestRetryAt = earliestIso(supportedTasks.map((task) => (
    task.nextRetryAt ? new Date(task.nextRetryAt) : null
  )));
  const earliestNextDueAt = earliestIso(supportedTasks.map((task) => (
    task.nextDueAt ? new Date(task.nextDueAt) : null
  )));
  const lastSuccessAt = latestIso(supportedTasks.map((task) => (
    task.lastSuccessAt ? new Date(task.lastSuccessAt) : null
  )));
  const anyPending = supportedTasks.some((task) =>
    task.desiredGeneration > task.appliedGeneration ||
    task.runtimeState === "queued" ||
    task.runtimeState === "retry_wait"
  );
  const anyPrimaryPaused = primaryTasks.some((task) => task.runtimeState === "paused");
  const anyPrimaryFailed = primaryTasks.some((task) => task.state === "failed");
  const anyPrimaryLiveRunning = primaryTasks.some((task) =>
    task.runtimeState === "running" && task.workClass === "live"
  );
  const anyHistoryRunning = supportedTasks.some((task) =>
    task.runtimeState === "running" && task.workClass !== "live"
  );
  const anyRetrying = supportedTasks.some((task) => task.runtimeState === "retry_wait");
  const anyDelayed = supportedTasks.some((task) => task.state === "delayed");
  const allPrimaryNeverSucceeded = primaryTasks.every((task) => task.lastSuccessAt === null);
  const allPrimaryFresh = primaryTasks.every(isFreshEnough);
  const messagesMonitorRow = monitorRows.find((row) => row.stream === "dm_messages") ?? monitorRows[0] ?? null;
  const transactionsTask = supportedTasks.find((task) => task.task === "transactions") ?? null;
  const topSpendersTask = supportedTasks.find((task) => task.task === "top_spenders") ?? null;
  const reconcileTask = supportedTasks.find((task) => task.task === "followers_reconcile") ?? null;
  const messagesHistoryComplete = messagesMonitorRow
    ? messagesMonitorRow.dmEligibleConversationCount === 0 ||
      (messagesMonitorRow.dmBackfillCompleteConversationCount >= messagesMonitorRow.dmEligibleConversationCount &&
        messagesMonitorRow.dmLaggingConversationCount === 0)
    : !anyPending;
  const topSpendersLagTooLarge = transactionsTask && topSpendersTask &&
    transactionsTask.lastSuccessAt &&
    topSpendersTask.lastSuccessAt &&
    (new Date(transactionsTask.lastSuccessAt).getTime() - new Date(topSpendersTask.lastSuccessAt).getTime()) >
      (Math.max(TASK_POLICY.transactions.cadenceSeconds, TASK_POLICY.top_spenders.cadenceSeconds) * 1000);
  const reconcileTrustReduced = reconcileTask
    ? reconcileTask.state === "failed" ||
      reconcileTask.state === "delayed" ||
      reconcileTask.runtimeState === "retry_wait"
    : false;

  let state: SyncDomainBlockState;
  if (allPrimaryNeverSucceeded && !anyPending) {
    state = "not_started";
  } else if (anyPrimaryPaused) {
    state = "paused";
  } else if (anyPrimaryFailed) {
    state = "failed";
  } else if (anyPrimaryLiveRunning) {
    state = "syncing";
  } else if (anyHistoryRunning) {
    state = "backfilling";
  } else if (anyRetrying) {
    state = "retrying";
  } else if (anyPending && !anyDelayed) {
    state = "scheduled";
  } else {
    const domainUpToDate = (() => {
      switch (block) {
        case "connection":
          return page.hasCredentials && allPrimaryFresh && !anyPending && !anyDelayed;
        case "financials":
          return allPrimaryFresh && !anyPending && !anyDelayed && !topSpendersLagTooLarge;
        case "audience":
          return allPrimaryFresh && !anyPending && !anyDelayed && !reconcileTrustReduced;
        case "messages_live":
          return allPrimaryFresh && !anyPending && !anyDelayed;
        case "messages_history":
          return !anyPending && !anyDelayed && messagesHistoryComplete;
      }
    })();

    state = domainUpToDate ? "up_to_date" : "delayed";
  }

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
    : firstTaskWithProgress(supportedTasks)?.progress ?? null;

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

  const error = attentionTask
    ? {
      stream: attentionTask.task,
      code: attentionTask.error?.code ?? attentionTask.reasonCode,
      summary: attentionTask.error?.summary ?? attentionTask.reasonText,
      lastFailedAt: attentionTask.error?.lastFailedAt ?? attentionTask.lastFailureAt,
      consecutiveFailures: attentionTask.error?.consecutiveFailures ?? 0,
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
    lastSuccessAt,
    progress,
    error,
    needsAttention: state === "failed" || state === "delayed",
    nextDueAt: earliestNextDueAt,
    nextRetryAt: earliestRetryAt,
    intervals: supportedTasks.map((task) => ({
      stream: task.task,
      cadenceSeconds: TASK_POLICY[task.task].cadenceSeconds,
    })),
    metrics,
    connectionStatus,
    substreams: supportedTasks.map((task) => ({
      stream: task.task,
      state: task.state,
      lastSuccessAt: task.lastSuccessAt,
      nextDueAt: task.nextDueAt,
      nextRetryAt: task.nextRetryAt,
      cadenceSeconds: TASK_POLICY[task.task].cadenceSeconds,
      needsAttention: task.needsAttention,
      error: task.error
        ? {
          stream: task.task,
          code: task.error.code,
          summary: task.error.summary,
          lastFailedAt: task.error.lastFailedAt,
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
  const pages = await listVisiblePages(app.db, input?.pageIds);
  const scopedPages = input?.pageLabel
    ? pages.filter((page) => page.label === input.pageLabel)
    : pages;
  const pageIds = scopedPages.map((page) => page.id);
  if (pageIds.length === 0) {
    return {
      generatedAt: now.toISOString(),
      pages: [],
    };
  }

  if (input?.pageIds || input?.pageLabel || pageIds.length === 1) {
    await Promise.all(pageIds.map((pageId) => ensureSyncTaskRows(app.db, {
      platformAccountId: pageId,
      now,
    })));
  } else {
    await ensureSyncTaskRows(app.db, { now });
  }

  const [taskRows, monitorRows] = await Promise.all([
    listSyncTaskRows(app.db),
    listSyncMonitorStreamRows(app.db, {
      pageIds,
      windowStart: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      streams: [...getSyncTasksForPlatform("fansly")],
    }),
  ]);

  const taskRowsByPageTask = new Map(
    taskRows
      .filter((row) => pageIds.includes(row.platformAccountId))
      .map((row) => [`${row.platformAccountId}:${row.task}`, row] as const),
  );
  const monitorRowsByPageTask = new Map(
    monitorRows.map((row) => [`${row.pageId}:${row.stream}`, row] as const),
  );

  return {
    generatedAt: now.toISOString(),
    pages: scopedPages.map((page) => {
      const supportedTasks = getSyncTasksForPlatform(page.platform);
      const blocks = Object.fromEntries(SYNC_DOMAIN_BLOCKS.map((block) => {
        const domainTasks = supportedTasks
          .filter((task) => DOMAIN_POLICY[block].primaryTasks.includes(task) || DOMAIN_POLICY[block].supportingTasks.includes(task))
          .map((task) => {
            const taskRow = taskRowsByPageTask.get(`${page.id}:${task}`);
            const monitorRow = monitorRowsByPageTask.get(`${page.id}:${task}`) ?? null;
            const effectiveTaskRow = taskRow ?? {
              platformAccountId: page.id,
              task,
              status: "idle",
              desiredGeneration: 0,
              runningGeneration: null,
              appliedGeneration: 0,
              scheduleIntervalSeconds: TASK_POLICY[task].cadenceSeconds,
              slotOffsetSeconds: 0,
              lastScheduledSlot: 0,
              lastRequestedAt: null,
              lastEnqueuedAt: null,
              lastStartedAt: null,
              lastProgressAt: null,
              lastFinishedAt: null,
              lastSuccessAt: null,
              lastFailureAt: null,
              retryClass: null,
              retryAt: null,
              blockerType: null,
              blockerCode: null,
              blockerReason: null,
              blockedSince: null,
              currentPhase: null,
              currentWorkClass: TASK_POLICY[task].defaultWorkClass,
              progressPayload: {},
              leaseOwner: null,
              leaseToken: null,
              leaseHeartbeatAt: null,
              leaseExpiresAt: null,
              consecutiveFailures: 0,
              lastErrorCode: null,
              lastErrorSummary: null,
              createdAt: now,
              updatedAt: now,
            } satisfies SyncTaskRow;

            return deriveTaskState(effectiveTaskRow, monitorRow, now);
          });
        const domainMonitorRows = monitorRows.filter((row) =>
          row.pageId === page.id &&
          domainTasks.some((task) => task.task === row.stream)
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
