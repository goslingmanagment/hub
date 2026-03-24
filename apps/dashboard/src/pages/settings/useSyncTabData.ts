import type { SyncMonitorResponse, SyncRunItem, SyncUxSummary } from "@agency_hub_core/contracts";
import { useSyncMonitor, useAdminSyncRuns } from "@/api/queries";
import { formatRelativeTime } from "@/lib/format";

// --- Types ---

type SyncUxState = SyncUxSummary["state"];
type MonitorPage = SyncMonitorResponse["pages"][number];
type MonitorStream = MonitorPage["streams"][number];
type FreshnessKey = "revenue" | "followers" | "subscribers" | "messages";

export interface SyncTabPage {
  pageLabel: string;
  pageId: number;
  platform: "fansly" | "onlyfans";
  modelName: string;
  username: string | null;
  primaryStatus: string;
  badgeState: SyncUxState;
  supportingText: string | null;
  syncUx: SyncUxSummary;
  freshness: FreshnessItem[];
  errors: ErrorItem[];
  activity: ActivityEntry[];
  isSyncingData: boolean;
  isSyncingMessages: boolean;
}

export interface FreshnessItem {
  label: string;
  lastUpdated: string | null;
  staleness: "fresh" | "stale" | "very-stale";
  countText: string;
  progress: { current: number; total: number; percent: number | null } | null;
  isActive: boolean;
  activeLabel: string | null;
}

export interface ErrorItem {
  category: string;
  message: string;
  actionLink?: string;
  actionLabel?: string;
}

export interface ActivityEntry {
  timestamp: string;
  category: string;
  summary: string;
  isFailed: boolean;
}

// --- Constants ---

const PRIMARY_STATUS: Record<SyncUxState, string> = {
  healthy: "Up to date",
  syncing: "Syncing...",
  catching_up: "Syncing...",
  retrying: "Syncing...",
  attention: "Needs attention",
  setup: "Syncing...",
  off: "Paused",
};

const BADGE_STATE: Record<SyncUxState, SyncUxState> = {
  healthy: "healthy",
  syncing: "syncing",
  catching_up: "syncing",
  retrying: "syncing",
  attention: "attention",
  setup: "syncing",
  off: "off",
};

const STREAM_CATEGORY: Record<string, string | null> = {
  light: null,
  transactions: "Revenue",
  subscribers: "Subscribers",
  followers: "Followers",
  followers_reconcile: null,
  dm_conversations: "Messages",
  dm_messages: "Messages",
  cleanup: null,
};

const ACTIVITY_CATEGORY: Record<string, string | null> = {
  light: null,
  transactions: "Revenue",
  subscribers: "Subscribers",
  followers: "Followers",
  followers_reconcile: null,
  dm_conversations: "Conversations",
  dm_messages: "Messages",
  cleanup: null,
};

const DATA_STREAMS = ["light", "transactions", "subscribers", "followers", "followers_reconcile"];
const MESSAGE_STREAMS = ["dm_conversations", "dm_messages"];
const EXCLUDED_ACTIVITY_STREAMS = new Set(["light", "followers_reconcile", "cleanup"]);
const EXCLUDED_ACTIVITY_STATUSES = new Set(["skipped", "running"]);
const FRESHNESS_THRESHOLDS_HOURS: Record<FreshnessKey, { staleAfter: number; veryStaleAfter: number }> = {
  revenue: { staleAfter: 2, veryStaleAfter: 6 },
  followers: { staleAfter: 24, veryStaleAfter: 72 },
  subscribers: { staleAfter: 2, veryStaleAfter: 6 },
  messages: { staleAfter: 4, veryStaleAfter: 12 },
};

// --- Helpers ---

export function getPagePrimaryStatus(state: SyncUxState): string {
  return PRIMARY_STATUS[state];
}

export function getPageBadgeState(state: SyncUxState): SyncUxState {
  return BADGE_STATE[state];
}

function getSupportingText(syncUx: SyncUxSummary): string | null {
  switch (syncUx.state) {
    case "healthy":
      return syncUx.updatedAt ? `Updated ${formatRelativeTime(syncUx.updatedAt)}` : null;
    case "syncing":
      return syncUx.progressLabel ?? null;
    case "catching_up":
      return "More data queued \u2014 will continue automatically";
    case "retrying":
      return syncUx.detail ?? "Retrying after an error";
    case "attention":
      return syncUx.headline;
    case "setup":
      return "Initial sync in progress";
    case "off":
    default:
      return null;
  }
}

function computeStaleness(
  lastSuccessAt: string | null,
  key: FreshnessKey,
): "fresh" | "stale" | "very-stale" {
  if (!lastSuccessAt) return "very-stale";
  const hours = (Date.now() - new Date(lastSuccessAt).getTime()) / 3_600_000;
  const thresholds = FRESHNESS_THRESHOLDS_HOURS[key];
  if (hours > thresholds.veryStaleAfter) return "very-stale";
  if (hours > thresholds.staleAfter) return "stale";
  return "fresh";
}

function olderTimestamp(a: string | null, b: string | null): string | null {
  if (!a || !b) return null;
  return new Date(a).getTime() < new Date(b).getTime() ? a : b;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getProgressPercent(
  progress: { current: number; total: number; percent: number | null },
): number {
  if (progress.percent != null && Number.isFinite(progress.percent)) {
    return progress.percent;
  }
  return progress.total > 0 ? (progress.current / progress.total) * 100 : 0;
}

function formatProgressLabel(
  progress: { current: number; total: number; percent: number | null },
  unit: string,
): string {
  return `${progress.current.toLocaleString()} / ${progress.total.toLocaleString()} ${unit}`;
}

function hasKnownProgressTotal(
  progress: MonitorStream["progress"] | null,
): progress is NonNullable<MonitorStream["progress"]> & { total: number } {
  return progress != null && typeof progress.total === "number" && progress.total > 0;
}

function includesAny(lower: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => lower.includes(pattern));
}

function isAuthLikeError(raw: string | null): boolean {
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return includesAny(lower, [
    "401",
    "403",
    "unauthorized",
    "forbidden",
    "auth_failed",
    "session expired",
    "expired session",
    "token expired",
    "credentials expired",
    "credential",
  ]);
}

function isRateLimitLikeError(raw: string | null): boolean {
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return includesAny(lower, ["429", "rate limit", "rate-limit", "rate limited"]);
}

function isServerLikeError(raw: string | null): boolean {
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return includesAny(lower, ["500", "502", "503", "504", "server", "temporary failure"]);
}

function isNetworkLikeError(raw: string | null): boolean {
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return includesAny(lower, [
    "proxy",
    "timeout",
    "timed out",
    "network",
    "socket",
    "econn",
    "connect failed",
    "connection reset",
    "connection refused",
    "dns",
    "unavailable",
  ]);
}

function getCheckpointState(stats: Record<string, unknown>, stream: string): Record<string, unknown> | null {
  const checkpoint = asRecord(stats.checkpoint);
  const after = asRecord(checkpoint?.after);
  const entry = asRecord(after?.[stream]);
  return asRecord(entry?.state);
}

function findStream(streams: MonitorStream[], name: string): MonitorStream | undefined {
  return streams.find((s) => s.stream === name);
}

function isRunning(stream: MonitorStream | undefined): boolean {
  return stream?.activeRun != null;
}

function buildFreshness(page: MonitorPage): FreshnessItem[] {
  const items: FreshnessItem[] = [];
  const isFansly = page.platform === "fansly";

  const txStream = findStream(page.streams, "transactions");
  const txActive = isRunning(txStream);
  items.push({
    label: "Revenue",
    lastUpdated: txStream?.lastSuccessAt ?? null,
    staleness: computeStaleness(txStream?.lastSuccessAt ?? null, "revenue"),
    countText: `${page.counts.transactions.toLocaleString()} transactions`,
    progress: null,
    isActive: txActive,
    activeLabel: txActive ? `Syncing\u2026 ${page.counts.transactions.toLocaleString()} transactions so far` : null,
  });

  if (isFansly) {
    const fStream = findStream(page.streams, "followers");
    const fReconcileStream = findStream(page.streams, "followers_reconcile");
    const progressSource = fStream?.progress ?? fReconcileStream?.progress ?? null;
    const fActive = isRunning(fStream) || isRunning(fReconcileStream);
    const fProgress = hasKnownProgressTotal(progressSource)
      ? {
        current: progressSource.current,
        total: progressSource.total,
        percent: getProgressPercent(progressSource),
      }
      : null;
    const fSyncing = fProgress && fProgress.current < fProgress.total;
    items.push({
      label: "Followers",
      lastUpdated: fStream?.lastSuccessAt ?? null,
      staleness: computeStaleness(fStream?.lastSuccessAt ?? null, "followers"),
      countText: fSyncing
        ? formatProgressLabel(fProgress, "followers")
        : `${page.counts.followers.toLocaleString()} followers`,
      progress: fSyncing ? fProgress : null,
      isActive: fActive,
      activeLabel: fActive && fProgress
        ? `Syncing\u2026 ${formatProgressLabel(fProgress, "followers")}`
        : fActive && isRunning(fReconcileStream)
          ? "Syncing\u2026 reconciling follower list"
          : fActive
            ? "Syncing\u2026"
            : null,
    });

    const sStream = findStream(page.streams, "subscribers");
    const sActive = isRunning(sStream);
    items.push({
      label: "Subscribers",
      lastUpdated: sStream?.lastSuccessAt ?? null,
      staleness: computeStaleness(sStream?.lastSuccessAt ?? null, "subscribers"),
      countText: `${page.counts.subscribers.toLocaleString()} active`,
      progress: null,
      isActive: sActive,
      activeLabel: sActive ? `Syncing\u2026 ${page.counts.subscribers.toLocaleString()} so far` : null,
    });

    const convStream = findStream(page.streams, "dm_conversations");
    const msgStream = findStream(page.streams, "dm_messages");
    const msgLastUpdated = olderTimestamp(
      convStream?.lastSuccessAt ?? null,
      msgStream?.lastSuccessAt ?? null,
    );
    const msgActive = isRunning(convStream) || isRunning(msgStream);
    items.push({
      label: "Messages",
      lastUpdated: msgLastUpdated,
      staleness: computeStaleness(msgLastUpdated, "messages"),
      countText: `${page.counts.messages.toLocaleString()} messages \u00b7 ${page.counts.conversations.toLocaleString()} conversations`,
      progress: null,
      isActive: msgActive,
      activeLabel: msgActive
        ? `Syncing\u2026 ${page.counts.messages.toLocaleString()} messages so far`
        : null,
    });
  }

  return items;
}

function humanizeError(category: string, raw: string | null, platform: string): string {
  if (!raw) return `Failed to sync ${category.toLowerCase()} \u2014 will retry automatically`;
  if (isAuthLikeError(raw)) {
    return "Credentials may have expired";
  }
  if (isRateLimitLikeError(raw)) {
    return "Rate limited \u2014 sync will retry automatically";
  }
  if (isServerLikeError(raw)) {
    const platformLabel = platform === "fansly" ? "Fansly" : "OnlyFans";
    return `Failed to fetch ${category.toLowerCase()} \u2014 ${platformLabel} returned server errors`;
  }
  if (isNetworkLikeError(raw)) {
    return `Network issue syncing ${category.toLowerCase()} \u2014 will retry automatically`;
  }
  return `Failed to sync ${category.toLowerCase()} \u2014 will retry automatically`;
}

function buildErrors(page: MonitorPage): ErrorItem[] {
  const errors: ErrorItem[] = [];
  const seen = new Set<string>();
  const hasCredentialsIssue = page.syncUx.requiresAction;

  if (hasCredentialsIssue) {
    errors.push({
      category: "Credentials",
      message: "Credentials may have expired",
      actionLink: "/settings?tab=credentials",
      actionLabel: "Update credentials",
    });
    seen.add("Credentials");
  }

  for (const stream of page.streams) {
    const category = STREAM_CATEGORY[stream.stream];
    if (!category || stream.consecutiveFailures === 0) continue;
    if (hasCredentialsIssue && isAuthLikeError(stream.lastErrorSummary)) continue;
    if (seen.has(category)) continue;
    seen.add(category);

    if (stream.recentErrors.total429s > 0 || isRateLimitLikeError(stream.lastErrorSummary)) {
      errors.push({
        category,
        message: `${category} sync is being rate limited \u2014 will retry automatically`,
      });
    } else {
      errors.push({
        category,
        message: humanizeError(category, stream.lastErrorSummary, page.platform),
      });
    }
  }

  return errors;
}

function formatActivityTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

  if (d.toDateString() === now.toDateString()) return `Today ${time}`;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;

  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

function extractCount(stream: string, stats: Record<string, unknown>): string | null {
  try {
    if (stream === "transactions") {
      const scan = asRecord(stats.scan);
      if (!scan) return null;
      const processed = asNumber(scan.processedTransactions) ?? 0;
      const chargebacks = asNumber(scan.processedChargebacks) ?? 0;
      const total = processed + chargebacks;
      return total > 0 ? `${total.toLocaleString()} transactions` : null;
    }
    if (stream === "subscribers") {
      const state = getCheckpointState(stats, "subscribers");
      const offset = asNumber(state?.offset);
      return offset != null && offset > 0 ? `${offset.toLocaleString()} subscribers` : null;
    }
    if (stream === "followers") {
      const state = getCheckpointState(stats, "followers");
      const offset = asNumber(state?.offset);
      return offset != null && offset > 0 ? `${offset.toLocaleString()} followers` : null;
    }
    if (stream === "dm_conversations") {
      const state = getCheckpointState(stats, "dm_conversations");
      const offset = asNumber(state?.offset);
      return offset != null && offset > 0 ? `${offset.toLocaleString()} conversations` : null;
    }
  } catch {
    // stats shape varies; don't crash
  }
  return null;
}

function humanizeRunError(errorSummary: string | null): string {
  if (!errorSummary) return "unknown error";
  if (isAuthLikeError(errorSummary)) return "credentials error";
  if (isRateLimitLikeError(errorSummary)) return "rate limited";
  if (isServerLikeError(errorSummary)) return "server error";
  if (isNetworkLikeError(errorSummary)) return "network error";
  return "sync error";
}

function buildActivity(runs: SyncRunItem[], pageLabel: string): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const run of runs) {
    if (run.pageLabel !== pageLabel) continue;
    if (EXCLUDED_ACTIVITY_STREAMS.has(run.stream)) continue;
    if (EXCLUDED_ACTIVITY_STATUSES.has(run.status)) continue;

    const category = ACTIVITY_CATEGORY[run.stream];
    if (!category) continue;

    const ts = run.finishedAt ?? run.startedAt;
    const isFailed = run.status === "failed";
    const count = extractCount(run.stream, run.stats as Record<string, unknown>);

    let summary: string;
    if (isFailed) {
      summary = `${category} sync failed \u00b7 ${humanizeRunError(run.errorSummary)} \u00b7 will retry`;
    } else if (run.status === "partial") {
      summary = count
        ? `${category} sync progressed \u00b7 ${count} \u00b7 continuing automatically`
        : `${category} sync progressed \u00b7 continuing automatically`;
    } else {
      summary = count ? `${category} synced \u00b7 ${count}` : `${category} synced`;
    }

    entries.push({ timestamp: formatActivityTime(ts), category, summary, isFailed });
    if (entries.length >= 20) break;
  }
  return entries;
}

// --- Hook ---

export function useSyncTabData() {
  const { data: monitor, isLoading: monitorLoading } = useSyncMonitor();
  const { data: runs } = useAdminSyncRuns({ limit: 100 });

  const pages: SyncTabPage[] = (monitor?.pages ?? []).map((page) => {
    const state = page.syncUx.state;
    const allRuns = runs ?? [];

    return {
      pageLabel: page.pageLabel,
      pageId: page.pageId,
      platform: page.platform,
      modelName: page.modelName,
      username: page.username,
      primaryStatus: PRIMARY_STATUS[state],
      badgeState: BADGE_STATE[state],
      supportingText: getSupportingText(page.syncUx),
      syncUx: page.syncUx,
      freshness: buildFreshness(page),
      errors: buildErrors(page),
      activity: buildActivity(allRuns, page.pageLabel),
      isSyncingData: DATA_STREAMS.some((s) => isRunning(findStream(page.streams, s))),
      isSyncingMessages: MESSAGE_STREAMS.some((s) => isRunning(findStream(page.streams, s))),
    };
  });

  return { pages, isLoading: monitorLoading && !monitor };
}
