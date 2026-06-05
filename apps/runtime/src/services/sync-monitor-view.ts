import type { SyncMonitorSnapshot } from "./sync-monitor.ts";

type TimestampValue = string | null | undefined;

function parseDate(value: TimestampValue) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatMs(ms: number) {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m${remainderSeconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function formatAge(value: TimestampValue, now = new Date()) {
  const parsed = parseDate(value);
  if (!parsed) {
    return "-";
  }

  return formatMs(Math.max(0, now.getTime() - parsed.getTime()));
}

function formatDuration(ms: number | null | undefined) {
  if (typeof ms !== "number") {
    return "-";
  }
  return formatMs(ms);
}

function truncate(value: string, width: number) {
  if (value.length <= width) {
    return value;
  }
  if (width <= 1) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 1)}…`;
}

function pad(value: string, width: number) {
  return truncate(value, width).padEnd(width, " ");
}

function providerSummary(snapshot: SyncMonitorSnapshot) {
  if (snapshot.overall.providers.length === 0) {
    return "-";
  }

  return snapshot.overall.providers
    .map((provider) => `${provider.platform}:${provider.rateHealth.state}`)
    .join(" ");
}

function rowFlags(input: {
  stalled: boolean;
  pending: boolean;
  retryAt: string | null;
  deepBackfill?: { stalled: boolean } | null;
}) {
  const flags = [];
  if (input.stalled) flags.push("stalled");
  if (input.pending) flags.push("pending");
  if (input.retryAt) flags.push("retrying");
  if (input.deepBackfill?.stalled) flags.push("deep-stalled");
  return flags.length > 0 ? flags.join(",") : "-";
}

function rowDuration(stream: SyncMonitorSnapshot["pages"][number]["streams"][number], now = new Date()) {
  if (stream.activeRun) {
    return formatAge(stream.activeRun.startedAt, now);
  }
  return formatDuration(stream.lastCompletion?.durationMs);
}

function rowLast(stream: SyncMonitorSnapshot["pages"][number]["streams"][number], now = new Date()) {
  if (stream.activeRun) {
    return formatAge(stream.activeRun.lastActivityAt, now);
  }
  return formatAge(stream.lastCompletion?.finishedAt, now);
}

function renderRows(snapshot: SyncMonitorSnapshot, now = new Date()) {
  const lines = [
    `${pad("page", 14)} ${pad("stream", 20)} ${pad("status", 11)} ${pad("progress", 32)} ${pad("last", 8)} ${pad("dur", 8)} ${pad("ok/p/f", 10)} ${pad("429/5xx/f", 12)} flags`,
  ];

  for (const page of snapshot.pages) {
    for (const stream of page.streams) {
      lines.push([
        pad(page.pageLabel, 14),
        pad(stream.stream, 20),
        pad(stream.status, 11),
        pad(stream.progress?.label ?? "-", 32),
        pad(rowLast(stream, now), 8),
        pad(rowDuration(stream, now), 8),
        pad(
          `${stream.recentRuns.success}/${stream.recentRuns.partial}/${stream.recentRuns.failed}`,
          10,
        ),
        pad(
          `${stream.recentErrors.total429s}/${stream.recentErrors.total5xxs}/${stream.recentErrors.failedRuns}`,
          12,
        ),
        rowFlags(stream),
      ].join(" "));
    }
  }

  return lines.join("\n");
}

export function renderSyncMonitor(snapshot: SyncMonitorSnapshot, now = new Date()) {
  const lines = [
    `Sync Monitor ${snapshot.generatedAt}`,
    `Window: last ${snapshot.window.hours}h since ${snapshot.window.startedAt}`,
    `Pages=${snapshot.overall.pages} Streams=${snapshot.overall.streams} Running=${snapshot.overall.runningStreams} Blocked=${snapshot.overall.blockedStreams} Stalled=${snapshot.overall.stalledStreams} Pending=${snapshot.overall.pendingStreams} Retrying=${snapshot.overall.retryingStreams}`,
    `Totals: fans=${snapshot.overall.counts.fans} tx=${snapshot.overall.counts.transactions} followers=${snapshot.overall.counts.followers} subscribers=${snapshot.overall.counts.subscribers} conv=${snapshot.overall.counts.conversations} msg=${snapshot.overall.counts.messages}`,
    `Recent: ok=${snapshot.overall.recentRuns.success} partial=${snapshot.overall.recentRuns.partial} failed=${snapshot.overall.recentRuns.failed} 429=${snapshot.overall.recentErrors.total429s} 5xx=${snapshot.overall.recentErrors.total5xxs} retries=${snapshot.overall.recentErrors.retryAttempts}`,
    `Providers: ${providerSummary(snapshot)}`,
    "",
    renderRows(snapshot, now),
  ];

  return lines.join("\n");
}
