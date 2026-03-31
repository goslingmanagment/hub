import type { SyncBlockStatus } from "@agency_hub_core/contracts";
import { formatRelativeTime } from "@/lib/format";

type SyncBlockKey = SyncBlockStatus["block"];
type SyncBlockState = SyncBlockStatus["state"];

export type { SyncBlockKey, SyncBlockState };

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
    badge: "border-warning/25 bg-warning/10 text-warning-dark",
    dot: "bg-warning-dark",
    text: "text-warning-dark",
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
    badge: "border-warning/25 bg-warning/10 text-warning-dark",
    dot: "bg-warning-dark",
    text: "text-warning-dark",
  },
  retrying: {
    badge: "border-warning/35 bg-warning/12 text-warning-dark",
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
};

const BLOCK_STATE_LABELS: Record<SyncBlockState, string> = {
  not_started: "Not started",
  scheduled: "Scheduled",
  up_to_date: "Up to date",
  syncing: "Syncing",
  backfilling: "Backfilling",
  retrying: "Retrying",
  delayed: "Delayed",
  failed: "Failed",
  paused: "Paused",
  not_available: "N/A",
};

const BLOCK_LABELS: Record<SyncBlockKey, string> = {
  connection: "Connection",
  financials: "Financials",
  audience: "Audience",
  messages_live: "Messages Live",
  messages_history: "Messages History",
};

const BLOCK_ORDER: SyncBlockKey[] = [
  "connection",
  "financials",
  "audience",
  "messages_live",
  "messages_history",
];

export function getBlockTone(state: SyncBlockState): BlockTone {
  return BLOCK_STATE_TONES[state];
}

export function getBlockStateLabel(state: SyncBlockState): string {
  return BLOCK_STATE_LABELS[state];
}

export function getBlockLabel(block: SyncBlockKey): string {
  return BLOCK_LABELS[block];
}

export function getBlockOrder(): SyncBlockKey[] {
  return BLOCK_ORDER;
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

export function formatBlockSummary(block: SyncBlockStatus): string {
  if (block.state === "not_available") return "Not available";

  if (block.block === "connection") {
    if (block.connectionStatus === "connected") {
      const checked = block.lastSuccessAt
        ? `checked ${formatRelativeTime(block.lastSuccessAt)}`
        : "";
      return `Connected${checked ? ` \u00b7 ${checked}` : ""}`;
    }
    if (block.connectionStatus === "error" || block.state === "failed") {
      if (block.error?.code === "stalled") {
        return "Connection check stalled";
      }
      const reason = block.error?.summary ?? "connection error";
      return `Connection failed: ${reason}`;
    }
    if (block.connectionStatus === "not_connected") {
      return "Not connected";
    }
  }

  if (block.state === "paused") {
    const last = block.lastSuccessAt
      ? `paused \u00b7 last synced ${formatRelativeTime(block.lastSuccessAt)}`
      : "Paused";
    return last;
  }

  if (block.state === "not_started") {
    return "Not started";
  }

  if (block.state === "failed") {
    if (block.error?.code === "progress_stalled") {
      if (block.progress?.total != null && block.progress.total > 0) {
        return `Sync stalled at ${block.progress.current.toLocaleString()}/${block.progress.total.toLocaleString()} ${block.progress.unit}`;
      }
      if (block.progress?.label) {
        return `Sync stalled at ${block.progress.label}`;
      }
      return "Sync stalled";
    }
    const reason = block.error?.summary ?? "sync error";
    const failures = block.error?.consecutiveFailures ?? 0;
    return failures > 1 ? `${reason} (${failures} failures)` : reason;
  }

  if (block.state === "delayed") {
    return block.error?.summary ?? "Sync is delayed";
  }

  const progressPrefix = block.state === "backfilling"
    ? "Backfilling\u2026"
    : block.state === "scheduled"
      ? "Queued\u2026"
    : block.state === "retrying"
      ? "Retrying\u2026"
      : "Syncing\u2026";

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

  // up_to_date
  const metricCount = getMetricCount(block);
  const updated = block.lastSuccessAt
    ? `Updated ${formatRelativeTime(block.lastSuccessAt)}`
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
  audience: "followers",
  messages_live: "conversations",
  messages_history: "conversations ready",
};

const BLOCK_METRIC_KEYS: Partial<Record<SyncBlockKey, readonly string[]>> = {
  financials: ["transactionCount", "count"],
  audience: ["followerCount", "subscriberCount", "count"],
  messages_live: ["visibleConversationCount", "count"],
  messages_history: ["readyConversationCount", "eligibleConversationCount", "count"],
};

export function needsVisualAttention(block: SyncBlockStatus): boolean {
  return (
    block.needsAttention ||
    block.state === "failed" ||
    block.state === "delayed"
  );
}
