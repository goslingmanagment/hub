import type { SyncBlockStatus } from "@agency_hub_core/contracts";
import { formatRelativeTime } from "@/lib/format";

type SyncBlockKey = SyncBlockStatus["block"];
type SyncBlockState = SyncBlockStatus["state"];
type SyncBlockSubstream = SyncBlockStatus["substreams"][number];
type SyncReasonCarrier = Pick<SyncBlockStatus, "statusReason" | "error"> |
  Pick<SyncBlockSubstream, "statusReason" | "error">;

export type { SyncBlockKey, SyncBlockState, SyncBlockSubstream };

interface BlockTone {
  badge: string;
  dot: string;
  text: string;
}

const BLOCK_STATE_TONES: Record<SyncBlockState, BlockTone> = {
  not_started: {
    badge: "border-border bg-hover-alt text-text-secondary",
    dot: "bg-text-muted",
    text: "text-text-secondary",
  },
  scheduled: {
    badge: "border-border bg-hover-alt text-text-secondary",
    dot: "bg-text-secondary",
    text: "text-text-secondary",
  },
  up_to_date: {
    badge: "border-green/30 bg-green/10 text-green",
    dot: "bg-green",
    text: "text-green",
  },
  syncing: {
    badge: "border-[#bfdbfe] bg-[#dbeafe] text-[#1d4ed8]",
    dot: "bg-[#2563eb]",
    text: "text-[#1d4ed8]",
  },
  backfilling: {
    badge: "border-[#bfdbfe] bg-[#eff6ff] text-[#1d4ed8]",
    dot: "bg-[#2563eb]",
    text: "text-[#1d4ed8]",
  },
  retrying: {
    badge: "border-warning/25 bg-warning/10 text-warning-dark",
    dot: "bg-warning-dark",
    text: "text-warning-dark",
  },
  delayed: {
    badge: "border-warning/30 bg-warning/10 text-warning-dark",
    dot: "bg-warning-dark",
    text: "text-warning-dark",
  },
  failed: {
    badge: "border-danger/30 bg-danger/10 text-danger",
    dot: "bg-danger",
    text: "text-danger",
  },
  paused: {
    badge: "border-border bg-card text-text-muted",
    dot: "bg-text-muted",
    text: "text-text-muted",
  },
  not_available: {
    badge: "border-border bg-hover-alt text-text-muted",
    dot: "bg-text-muted/50",
    text: "text-text-muted",
  },
  // A block of a Fansly page: «Синк» shows it with its own cards
  // (`engine/EngineBlocks.tsx`); nothing here formats one.
  engine: {
    badge: "border-accent/30 bg-accent/10 text-accent",
    dot: "bg-accent",
    text: "text-text-secondary",
  },
};

const BLOCK_STATE_LABELS: Record<SyncBlockState, string> = {
  not_started: "Not started",
  scheduled: "Queued",
  up_to_date: "Up to date",
  syncing: "Syncing",
  backfilling: "Backfilling",
  retrying: "Retrying",
  delayed: "Delayed",
  failed: "Failed",
  paused: "Paused",
  not_available: "N/A",
  engine: "Sync Engine",
};

const BLOCK_LABELS: Record<SyncBlockKey, string> = {
  connection: "Connection",
  financials: "Financials",
  audience: "Audience",
  messages_live: "Messages Live",
  messages_history: "Messages History",
};

// A legacy block (any state but `engine`) belongs to a page the legacy
// page-sync executor serves: OnlyFans. A Fansly page's blocks are the Fansly
// Sync Engine's (`state: "engine"`), or not available when the engine does not
// run the page: the «Синк» tab words them itself (`engine/engineBlockDisplay.ts`),
// and nothing here formats a Fansly block or stream.

const BLOCK_DESCRIPTIONS: Record<SyncBlockKey, string> = {
  connection: "Confirms this page's account is still connected and authorized.",
  financials: "Earnings transactions and the top-spenders leaderboard.",
  audience: "Followers and subscribers for this page.",
  messages_live: "Keeps the conversation list current \u2014 new threads and the latest message in each.",
  messages_history: "Backfills and stores the full message contents of each conversation.",
};

// The streams a block lists on a page of the legacy executor. The analytics
// Coverage panel names every lever stream of a Fansly page by the same table;
// a name that is its own words needs no row (`getStreamLabel`).
const STREAM_LABELS: Record<string, string> = {
  light: "connection",
  fan_identities: "fan identities",
  transactions: "transactions",
  top_spenders: "top spenders",
  subscribers: "subscribers",
  followers: "followers",
  followers_reconcile: "follower reconcile",
  dm_conversations: "conversation sync",
  dm_messages: "message history",
  media_stats: "media statistics",
  stats_snapshot: "account statistics",
};

const PROGRESS_STREAM_LABELS: Record<string, string> = {
  fan_identities: "fan identity enrichment",
  top_spenders: "top spenders enrichment",
  dm_conversations: "conversation sync",
};

const BLOCK_ORDER: SyncBlockKey[] = [
  "connection",
  "financials",
  "audience",
  "messages_live",
  "messages_history",
];

function isHealthyQueueWaitingBlock(block: SyncBlockStatus): boolean {
  return block.state === "scheduled" && isQueueWaiting(block) && block.primaryFresh;
}

function isHealthyQueueWaitingSubstream(substream: SyncBlockSubstream): boolean {
  return substream.state === "scheduled" && isQueueWaiting(substream) && substream.isFresh;
}

function getDisplayBlockState(blockOrState: SyncBlockStatus | SyncBlockState): SyncBlockState {
  if (typeof blockOrState === "string") {
    return blockOrState;
  }

  return isHealthyQueueWaitingBlock(blockOrState) ? "up_to_date" : blockOrState.state;
}

export function getBlockTone(blockOrState: SyncBlockStatus | SyncBlockState): BlockTone {
  return BLOCK_STATE_TONES[getDisplayBlockState(blockOrState)];
}

export function getBlockStateLabel(blockOrState: SyncBlockStatus | SyncBlockState): string {
  return BLOCK_STATE_LABELS[getDisplayBlockState(blockOrState)];
}

export function getBlockLabel(block: SyncBlockKey): string {
  return BLOCK_LABELS[block];
}

export function getBlockDescription(block: SyncBlockKey): string {
  return BLOCK_DESCRIPTIONS[block];
}

export function getBlockOrder(): SyncBlockKey[] {
  return BLOCK_ORDER;
}

export function getStreamLabel(stream: string): string {
  return STREAM_LABELS[stream] ?? stream.replaceAll("_", " ");
}

function getProgressStreamLabel(stream: string | null): string | null {
  if (!stream) return null;
  return PROGRESS_STREAM_LABELS[stream] ?? getStreamLabel(stream);
}

export function formatCadence(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  return `${hours}h`;
}

function formatRelativeFuture(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return "now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "in <1m";
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  return `in ${hours}h`;
}

export function formatNextTime(iso: string | null): string | null {
  if (!iso) return null;
  return formatRelativeFuture(iso);
}

function parseDependencyWait(summary: string | null | undefined): string[] {
  if (!summary) return [];
  const prefix = "Waiting for ";
  if (!summary.startsWith(prefix)) return [];
  return summary
    .slice(prefix.length)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function formatDependencyList(streams: string[]): string {
  return streams.map((stream) => getStreamLabel(stream)).join(", ");
}

function getWaitingStreams(item: SyncReasonCarrier): string[] {
  if (item.statusReason?.waitingFor && item.statusReason.waitingFor.length > 0) {
    return item.statusReason.waitingFor;
  }
  if (item.statusReason?.code === "unmet_dependency") {
    return parseDependencyWait(getReasonSummary(item));
  }
  return [];
}

function getReasonCode(item: SyncReasonCarrier): string | null {
  return item.statusReason?.code ?? item.error?.code ?? null;
}

export function getReasonSummary(item: SyncReasonCarrier): string | null {
  return item.statusReason?.summary ?? item.error?.summary ?? null;
}

function getDependencyStreams(item: SyncReasonCarrier): string[] {
  return getWaitingStreams(item);
}

export function isDependencyWait(item: SyncReasonCarrier): boolean {
  return getReasonCode(item) === "unmet_dependency";
}

function isQueueWaiting(item: SyncReasonCarrier): boolean {
  return getReasonCode(item) === "queue_waiting";
}

export function getDependencyWaitDetail(item: SyncReasonCarrier): string | null {
  if (!isDependencyWait(item)) return null;
  const streams = getDependencyStreams(item);
  if (streams.length === 0) return null;
  return formatDependencyList(streams);
}

function hasCompletedMessagesLiveProgress(block: SyncBlockStatus): boolean {
  return (
    block.block === "messages_live" &&
    block.progress != null &&
    block.progress.total != null &&
    block.progress.total > 0 &&
    block.progress.current >= block.progress.total
  );
}

function formatSupportingProgressSummary(block: SyncBlockStatus): string | null {
  if (!block.primaryFresh || block.progressRole !== "supporting") {
    return null;
  }

  const label = getProgressStreamLabel(block.progressStream);
  if (!label) {
    return null;
  }

  if (block.block === "financials") {
    if (block.state === "backfilling") {
      return `Transactions are current; ${label} is catching up`;
    }
    if (block.state === "scheduled") {
      return `Transactions are current; ${label} is queued`;
    }
    if (block.state === "retrying") {
      return `Transactions are current; ${label} is retrying`;
    }
  }

  return null;
}

export function formatBlockProgressCaption(block: SyncBlockStatus): string | null {
  if (!block.progress) return null;

  const source = getProgressStreamLabel(block.progressStream);
  const counts = block.progress.total != null && block.progress.total > 0
    ? `${block.progress.current.toLocaleString()} / ${block.progress.total.toLocaleString()} ${block.progress.unit}`
    : block.progress.label;
  if (!counts) return source;
  return source ? `${source} \u00b7 ${counts}` : counts;
}

export function getBlockProgressFillClass(block: SyncBlockStatus): string {
  if (isHealthyQueueWaitingBlock(block)) {
    return "bg-green";
  }
  return "bg-accent";
}

export function getBlockProgressBarMode(block: SyncBlockStatus): "hidden" | "determinate" | "indeterminate" {
  if (!block.progress) {
    return "hidden";
  }
  if (!["syncing", "backfilling", "scheduled", "retrying"].includes(block.state)) {
    return "hidden";
  }

  if (hasCompletedMessagesLiveProgress(block)) {
    return "hidden";
  }

  if (
    isHealthyQueueWaitingBlock(block) &&
    block.progressRole === "supporting" &&
    block.progress.total != null &&
    block.progress.total > 0 &&
    block.progress.current >= block.progress.total
  ) {
    return "hidden";
  }

  if (block.progress.total != null && block.progress.total > 0) {
    return "determinate";
  }

  if (block.progress.label && ["syncing", "backfilling", "retrying"].includes(block.state)) {
    return "indeterminate";
  }

  return "hidden";
}

export function shouldShowBlockProgressBar(block: SyncBlockStatus): boolean {
  return getBlockProgressBarMode(block) !== "hidden";
}

export function formatBlockSummary(block: SyncBlockStatus): string {
  if (block.state === "not_available") return "Not available";

  if (block.block === "connection") {
    if (block.connectionStatus === "connected") {
      const checked = block.succeededAt
        ? `checked ${formatRelativeTime(block.succeededAt)}`
        : "";
      return `Connected${checked ? ` \u00b7 ${checked}` : ""}`;
    }
    if (block.connectionStatus === "error" || block.state === "failed") {
      const reason = getReasonSummary(block) ?? "connection error";
      return `Connection failed: ${reason}`;
    }
    if (block.connectionStatus === "not_connected") {
      return "Not connected";
    }
  }

  if (block.state === "paused") {
    const last = block.succeededAt
      ? `paused \u00b7 last synced ${formatRelativeTime(block.succeededAt)}`
      : "Paused";
    return last;
  }

  if (block.state === "not_started") {
    return "Not started";
  }

  if (block.state === "failed") {
    if (getReasonCode(block) === "progress_stalled") {
      if (block.progress?.total != null && block.progress.total > 0) {
        return `Sync stalled at ${block.progress.current.toLocaleString()}/${block.progress.total.toLocaleString()} ${block.progress.unit}`;
      }
      if (block.progress?.label) {
        return `Sync stalled at ${block.progress.label}`;
      }
      return "Sync stalled";
    }
    const reason = getReasonSummary(block) ?? "sync error";
    const failures = block.error?.consecutiveFailures ?? 0;
    return failures > 1 ? `${reason} (${failures} failures)` : reason;
  }

  if (block.state === "delayed") {
    if (isDependencyWait(block)) {
      const waitingOn = getDependencyStreams(block);
      if (waitingOn.length === 1) {
        return `Waiting for ${getStreamLabel(waitingOn[0])} to finish first`;
      }
      return "Waiting for prerequisite syncs to finish first";
    }
    if (getReasonCode(block) === "queue_delayed") {
      return "Queued too long with no active sync making progress";
    }
    return getReasonSummary(block) ?? "Sync is delayed";
  }

  if (isHealthyQueueWaitingBlock(block)) {
    const waitingOn = getWaitingStreams(block);
    if (waitingOn.length === 1) {
      return `Up to date \u00b7 waiting for ${getStreamLabel(waitingOn[0])} to finish`;
    }
    return "Up to date \u00b7 queued behind active sync work";
  }

  if (block.state === "scheduled" && isQueueWaiting(block)) {
    const waitingOn = getWaitingStreams(block);
    if (waitingOn.length === 1) {
      return `Queued \u2014 ${getStreamLabel(waitingOn[0])} is running`;
    }
    return "Queued \u2014 will start after current sync completes";
  }

  const supportingProgressSummary = formatSupportingProgressSummary(block);
  if (supportingProgressSummary) {
    return supportingProgressSummary;
  }

  const progressPrefix = block.state === "backfilling"
    ? "Backfilling\u2026"
    : block.state === "scheduled"
      ? "Queued\u2026"
      : block.state === "retrying"
      ? "Retrying\u2026"
      : "Syncing\u2026";

  if (hasCompletedMessagesLiveProgress(block)) {
    if (block.state === "syncing") {
      return "Finalizing conversation refresh\u2026";
    }
    if (block.state === "backfilling") {
      return "Scanning conversations\u2026";
    }
    if (block.state === "scheduled") {
      return "Conversation sync queued";
    }
    if (block.state === "retrying") {
      const nextRetry = block.nextRetryAt ? formatRelativeFuture(block.nextRetryAt) : null;
      return nextRetry ? `Retrying conversation sync ${nextRetry}` : "Retrying conversation sync\u2026";
    }
  }

  if (
    (block.state === "syncing" || block.state === "backfilling" || block.state === "retrying" || block.state === "scheduled") &&
    block.progress
  ) {
    const { current, total, unit, label } = block.progress;
    if (total != null && total > 0) {
      return `${progressPrefix} ${current.toLocaleString()}/${total.toLocaleString()} ${unit}`;
    }
    if (label) return `${progressPrefix} ${label}`;
    return progressPrefix;
  }

  if (block.state === "syncing") {
    return "Syncing\u2026";
  }

  if (block.state === "backfilling") {
    return "Backfilling\u2026";
  }

  if (block.state === "scheduled") {
    return "Queued to continue";
  }

  if (block.state === "retrying") {
    const nextRetry = block.nextRetryAt ? formatRelativeFuture(block.nextRetryAt) : null;
    return nextRetry ? `Retrying ${nextRetry}` : "Retrying\u2026";
  }

  const metricCount = getMetricCount(block);
  const updated = block.succeededAt
    ? `Updated ${formatRelativeTime(block.succeededAt)}`
    : "Never synced";
  return metricCount ? `${updated} \u00b7 ${metricCount}` : updated;
}

function getMetricCount(block: SyncBlockStatus): string | null {
  const m = block.metrics;
  if (!m || typeof m !== "object") return null;

  const keys = BLOCK_METRIC_KEYS[block.block] ?? ["count"];
  for (const key of keys) {
    const count = m[key as keyof typeof m];
    if (typeof count === "number" && count >= 0) {
      const label = METRIC_LABELS[block.block] ?? "";
      return `${count.toLocaleString()}${label ? ` ${label}` : ""}`;
    }
  }
  return null;
}

const METRIC_LABELS: Partial<Record<SyncBlockKey, string>> = {
  financials: "transactions",
  audience: "subscribers",
  messages_live: "conversations",
};

const BLOCK_METRIC_KEYS: Partial<Record<SyncBlockKey, readonly string[]>> = {
  financials: ["transactionCount", "count"],
  audience: ["subscriberCount", "count"],
  messages_live: ["visibleConversationCount", "count"],
};

export function getSubstreamTone(substream: SyncBlockSubstream): BlockTone {
  if (isHealthyQueueWaitingSubstream(substream)) {
    return BLOCK_STATE_TONES.up_to_date;
  }
  if (isDependencyWait(substream)) {
    return BLOCK_STATE_TONES.scheduled;
  }
  if (substream.state === "delayed") {
    const code = getReasonCode(substream);
    if (code === "queue_delayed" || code === "progress_stalled" || code === "stale") {
      return BLOCK_STATE_TONES.delayed;
    }
  }
  if (substream.state === "scheduled") {
    return BLOCK_STATE_TONES.scheduled;
  }
  return getBlockTone(substream.state);
}

export function formatSubstreamStateLabel(substream: SyncBlockSubstream): string {
  const code = getReasonCode(substream);

  if (substream.state === "delayed") {
    if (code === "unmet_dependency") {
      const detail = getDependencyWaitDetail(substream);
      return detail ? `Waiting \u00b7 ${detail}` : "Waiting";
    }
    if (code === "queue_delayed") {
      return "Delayed \u00b7 queue stalled";
    }
    if (code === "progress_stalled") {
      return "Stalled \u00b7 no progress";
    }
    if (code === "stale") {
      return "Out of date";
    }
    return "Delayed";
  }

  if (substream.state === "scheduled") {
    if (code === "queue_waiting") {
      if (isHealthyQueueWaitingSubstream(substream)) {
        const waitingOn = getWaitingStreams(substream);
        if (waitingOn.length === 1) {
          return `Up to date \u00b7 waiting for ${getStreamLabel(waitingOn[0])}`;
        }
        return "Up to date \u00b7 queued behind active sync work";
      }
      const waitingOn = getWaitingStreams(substream);
      if (waitingOn.length === 1) {
        return `Waiting \u00b7 ${getStreamLabel(waitingOn[0])}`;
      }
      return "Waiting";
    }
    return "Queued";
  }

  if (substream.state === "failed") {
    return code === "credentials_invalid" ? "Reconnect" : "Failed";
  }

  return getBlockStateLabel(substream.state);
}

export function needsVisualAttention(block: SyncBlockStatus): boolean {
  if (isDependencyWait(block)) {
    return false;
  }

  return (
    block.needsAttention ||
    block.state === "failed" ||
    block.state === "delayed"
  );
}
