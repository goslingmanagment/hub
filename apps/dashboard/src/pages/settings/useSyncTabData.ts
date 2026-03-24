import type { SyncMonitorResponse, SyncRunItem, SyncUxSummary } from "@agency_hub_core/contracts";
import { useSyncMonitor, useAdminSyncRuns } from "@/api/queries";
import { formatRelativeTime } from "@/lib/format";

// --- Types ---

type SyncUxState = SyncUxSummary["state"];
type MonitorPage = SyncMonitorResponse["pages"][number];
type MonitorStream = MonitorPage["streams"][number];

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

const DATA_STREAMS = ["light", "transactions", "subscribers", "followers"];
const MESSAGE_STREAMS = ["dm_conversations", "dm_messages"];
const EXCLUDED_ACTIVITY_STREAMS = new Set(["light", "followers_reconcile", "cleanup"]);
const EXCLUDED_ACTIVITY_STATUSES = new Set(["skipped", "running"]);

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

function computeStaleness(lastSuccessAt: string | null): "fresh" | "stale" | "very-stale" {
  if (!lastSuccessAt) return "very-stale";
  const hours = (Date.now() - new Date(lastSuccessAt).getTime()) / 3_600_000;
  if (hours > 48) return "very-stale";
  if (hours > 24) return "stale";
  return "fresh";
}

function olderTimestamp(a: string | null, b: string | null): string | null {
  if (!a || !b) return null;
  return new Date(a).getTime() < new Date(b).getTime() ? a : b;
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
    staleness: computeStaleness(txStream?.lastSuccessAt ?? null),
    countText: `${page.counts.transactions.toLocaleString()} transactions`,
    progress: null,
    isActive: txActive,
    activeLabel: txActive ? `Syncing\u2026 ${page.counts.transactions.toLocaleString()} transactions so far` : null,
  });

  if (isFansly) {
    const fStream = findStream(page.streams, "followers");
    const fProgress = fStream?.progress ?? null;
    const fActive = isRunning(fStream);
    const fSyncing = fProgress && fProgress.total && fProgress.current < fProgress.total;
    items.push({
      label: "Followers",
      lastUpdated: fStream?.lastSuccessAt ?? null,
      staleness: computeStaleness(fStream?.lastSuccessAt ?? null),
      countText: fSyncing
        ? `${fProgress.current.toLocaleString()} / ${fProgress.total!.toLocaleString()} followers`
        : `${page.counts.followers.toLocaleString()} followers`,
      progress: fSyncing
        ? { current: fProgress.current, total: fProgress.total!, percent: fProgress.percent }
        : null,
      isActive: fActive,
      activeLabel: fActive && fProgress
        ? `Syncing\u2026 ${fProgress.current.toLocaleString()} / ${(fProgress.total ?? 0).toLocaleString()} followers`
        : fActive ? `Syncing\u2026` : null,
    });

    const sStream = findStream(page.streams, "subscribers");
    const sActive = isRunning(sStream);
    items.push({
      label: "Subscribers",
      lastUpdated: sStream?.lastSuccessAt ?? null,
      staleness: computeStaleness(sStream?.lastSuccessAt ?? null),
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
      staleness: computeStaleness(msgLastUpdated),
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
  const lower = raw.toLowerCase();
  if (lower.includes("401") || lower.includes("403") || lower.includes("auth") || lower.includes("unauthorized")) {
    return "Credentials may have expired";
  }
  if (lower.includes("429") || lower.includes("rate")) {
    return "Rate limited \u2014 sync will retry automatically";
  }
  if (lower.includes("500") || lower.includes("502") || lower.includes("503") || lower.includes("server")) {
    const platformLabel = platform === "fansly" ? "Fansly" : "OnlyFans";
    return `Failed to fetch ${category.toLowerCase()} \u2014 ${platformLabel} returned server errors`;
  }
  return `Failed to sync ${category.toLowerCase()} \u2014 will retry automatically`;
}

function buildErrors(page: MonitorPage): ErrorItem[] {
  const errors: ErrorItem[] = [];
  const seen = new Set<string>();

  if (page.syncUx.requiresAction) {
    errors.push({
      category: "Credentials",
      message: "Credentials may have expired",
      actionLink: "/settings?tab=credentials",
      actionLabel: "Update credentials",
    });
    return errors;
  }

  for (const stream of page.streams) {
    const category = STREAM_CATEGORY[stream.stream];
    if (!category || stream.consecutiveFailures === 0) continue;
    if (seen.has(category)) continue;
    seen.add(category);

    if (stream.recentErrors.total429s > 0) {
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
      const scan = stats.scan as Record<string, unknown> | undefined;
      if (!scan) return null;
      const processed = (scan.processedTransactions as number) ?? 0;
      const chargebacks = (scan.processedChargebacks as number) ?? 0;
      const total = processed + chargebacks;
      return total > 0 ? `${total.toLocaleString()} transactions` : null;
    }
    if (stream === "subscribers") {
      const cp = stats.checkpoint as Record<string, Record<string, unknown>> | undefined;
      const offset = cp?.after?.offset as number | undefined;
      return offset != null && offset > 0 ? `${offset.toLocaleString()} subscribers` : null;
    }
    if (stream === "followers") {
      const cp = stats.checkpoint as Record<string, Record<string, unknown>> | undefined;
      const offset = cp?.after?.offset as number | undefined;
      return offset != null && offset > 0 ? `${offset.toLocaleString()} followers` : null;
    }
    if (stream === "dm_conversations") {
      const cp = stats.checkpoint as Record<string, Record<string, unknown>> | undefined;
      const offset = cp?.after?.offset as number | undefined;
      return offset != null && offset > 0 ? `${offset.toLocaleString()} conversations` : null;
    }
  } catch {
    // stats shape varies; don't crash
  }
  return null;
}

function humanizeRunError(errorSummary: string | null): string {
  if (!errorSummary) return "unknown error";
  const lower = errorSummary.toLowerCase();
  if (lower.includes("401") || lower.includes("403") || lower.includes("auth")) return "credentials error";
  if (lower.includes("429") || lower.includes("rate")) return "rate limited";
  if (lower.includes("500") || lower.includes("502") || lower.includes("503")) return "server error";
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
