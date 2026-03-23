import { useLayoutEffect, useRef, useState } from "react";
import type { SyncMonitorResponse, SyncRequestsResponse } from "@agency_hub_core/contracts";
import { ApiError } from "@/api/client";
import { usePageConversationMessages, useSyncMonitor, useSyncRequests } from "@/api/queries";
import { PLATFORM_COLORS } from "@/lib/constants";
import { formatDateTime, formatRelativeTime, formatUsdFromCents } from "@/lib/format";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type StreamItem = SyncMonitorResponse["pages"][number]["streams"][number];
type PageItem = SyncMonitorResponse["pages"][number];
type EventItem = SyncMonitorResponse["recentEvents"][number];
type RequestItem = SyncRequestsResponse[number];
type ActivityTab = "events" | "requests";
type LiveRequestsWindow = "1m" | "5m" | "15m";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const STREAM_LABELS: Record<string, string> = {
  light: "Light",
  transactions: "Transactions",
  subscribers: "Subscribers",
  dm_conversations: "DM Conversations",
  dm_messages: "DM Messages",
  followers: "Followers",
  followers_reconcile: "Followers Reconcile",
  cleanup: "Cleanup",
};

const LIVE_REQUEST_WINDOWS: Array<{ key: LiveRequestsWindow; label: string; windowMs: number }> = [
  { key: "1m", label: "Last 1m", windowMs: 60_000 },
  { key: "5m", label: "Last 5m", windowMs: 5 * 60_000 },
  { key: "15m", label: "Last 15m", windowMs: 15 * 60_000 },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** A stream is "healthy" when it's done/idle with no flags or errors. */
function isStreamHealthy(s: StreamItem): boolean {
  if (s.status === "running" || s.status === "failed" || s.status === "auth_failed" || s.status === "paused") {
    return false;
  }
  return (
    !s.stalled &&
    s.recentErrors.failedRuns === 0 &&
    s.recentErrors.total429s === 0 &&
    s.recentErrors.total5xxs === 0 &&
    !s.lastErrorSummary
  );
}

function computeHeroStatus(overall: SyncMonitorResponse["overall"]): {
  level: "healthy" | "warning" | "critical";
  label: string;
} {
  const issues = overall.failedStreams + overall.stalledStreams;
  if (issues > 0) return { level: "critical", label: `${issues} ${issues === 1 ? "Issue" : "Issues"} Detected` };

  const warnings = overall.recentErrors.total429s + overall.recentErrors.total5xxs;
  if (warnings > 0) return { level: "warning", label: "Warnings" };

  return { level: "healthy", label: "All Systems Healthy" };
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

function computeEta(stream: StreamItem): string | null {
  if (!stream.progress?.percent || stream.progress.percent <= 0 || !stream.activeRun) return null;
  const elapsed = Date.now() - new Date(stream.activeRun.startedAt).getTime();
  const remaining = (elapsed / stream.progress.percent) * (100 - stream.progress.percent);
  if (remaining <= 0 || !isFinite(remaining)) return null;
  return formatDuration(remaining);
}

function streamActivityLabel(stream: StreamItem): string {
  if (stream.stalled && stream.activeRun) {
    return `No activity ${formatDuration(Date.now() - new Date(stream.activeRun.lastActivityAt).getTime())}`;
  }

  if (stream.status === "running" && stream.activeRun) {
    return `Running ${formatDuration(Date.now() - new Date(stream.activeRun.startedAt).getTime())}`;
  }

  return stream.lastSuccessAt ? formatRelativeTime(stream.lastSuccessAt) : "";
}

function num(v: number): string {
  return v.toLocaleString();
}

function formatRequestTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatRequestMetric(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  return formatDuration(ms);
}

function requestRowClasses(item: RequestItem): string {
  if (item.httpStatusCode === 429) {
    return "bg-warning/10";
  }
  if (item.httpStatusCode !== null && item.httpStatusCode >= 500) {
    return "bg-danger/10";
  }
  return "bg-card";
}

function requestBadgeClasses(item: RequestItem): string {
  if (item.httpStatusCode === 429) {
    return "border-warning/40 bg-warning/12 text-warning-dark";
  }
  if (item.httpStatusCode !== null && item.httpStatusCode >= 500) {
    return "border-danger/30 bg-danger/12 text-danger";
  }
  return "border-border bg-hover-alt text-text-secondary";
}

function requestBadgeText(item: RequestItem): string {
  if (item.httpStatusCode !== null) {
    return String(item.httpStatusCode);
  }
  return item.status.toUpperCase();
}

function requestRowKey(item: RequestItem): string {
  return `${item.timestamp}:${item.pageLabel}:${item.stream}:${item.operation}:${item.attemptNumber}`;
}

function isExpandableRequest(item: RequestItem): boolean {
  return item.operation === "messages" && item.groupId !== null;
}

function senderRoleLabel(role: "fan" | "model" | "system" | "unknown"): string {
  switch (role) {
    case "fan":
      return "Fan";
    case "model":
      return "Model";
    case "system":
      return "System";
    case "unknown":
      return "Unknown";
  }
}

/* ------------------------------------------------------------------ */
/*  LiveDot – pulsing indicator that data is live                      */
/* ------------------------------------------------------------------ */

function LiveDot({ level }: { level: "healthy" | "warning" | "critical" }) {
  const color = level === "critical" ? "bg-danger" : level === "warning" ? "bg-warning" : "bg-green";
  return (
    <span className="relative flex h-3 w-3 shrink-0">
      <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-50 ${color}`} />
      <span className={`relative inline-flex h-3 w-3 rounded-full ${color}`} />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Chevron icon                                                       */
/* ------------------------------------------------------------------ */

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`h-4 w-4 text-text-muted transition-transform duration-150 ${open ? "rotate-180" : ""}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Hero banner                                                        */
/* ------------------------------------------------------------------ */

function HeroBanner({ data }: { data: SyncMonitorResponse }) {
  const hero = computeHeroStatus(data.overall);
  const border =
    hero.level === "critical"
      ? "border-danger/30"
      : hero.level === "warning"
        ? "border-warning/30"
        : "border-green/25";
  const bg =
    hero.level === "critical" ? "bg-danger/5" : hero.level === "warning" ? "bg-warning/5" : "bg-green/5";

  return (
    <div className={`rounded-xl border ${border} ${bg} px-6 py-5`}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <LiveDot level={hero.level} />
          <h1 className="text-xl font-extrabold text-text-primary">{hero.label}</h1>
        </div>
        <span className="shrink-0 text-[13px] text-text-muted">
          Updated {formatRelativeTime(data.generatedAt)}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-text-secondary">
        <span>
          {data.overall.pages} {data.overall.pages === 1 ? "page" : "pages"}
        </span>
        <span className="text-text-muted">·</span>
        <span>{data.overall.streams} streams</span>
        {data.overall.runningStreams > 0 && (
          <span className="font-medium text-[#1e40af]">{data.overall.runningStreams} running</span>
        )}
        {data.overall.failedStreams > 0 && (
          <span className="font-medium text-danger">{data.overall.failedStreams} failed</span>
        )}
        {data.overall.stalledStreams > 0 && (
          <span className="font-medium text-danger">{data.overall.stalledStreams} stalled</span>
        )}
        {data.overall.pendingStreams > 0 && (
          <span className="font-medium text-warning-dark">{data.overall.pendingStreams} pending</span>
        )}
        {data.overall.recentErrors.total429s > 0 && (
          <span className="font-medium text-warning-dark">{data.overall.recentErrors.total429s} rate limits</span>
        )}
        {data.overall.recentErrors.total5xxs > 0 && (
          <span className="font-medium text-danger">{data.overall.recentErrors.total5xxs} server errors</span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Provider health strip                                              */
/* ------------------------------------------------------------------ */

function ProviderStrip({ providers }: { providers: SyncMonitorResponse["overall"]["providers"] }) {
  if (providers.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-3">
      {providers.map((p) => {
        const cfg = PLATFORM_COLORS[p.platform];
        const bad = p.recent429s > 0 || p.recent5xxs > 0;
        return (
          <div
            key={p.platform}
            className={`flex items-center gap-3 rounded-lg border px-4 py-2.5 ${
              bad ? "border-warning/30 bg-warning/5" : "border-border bg-card"
            }`}
          >
            <span
              className="inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold"
              style={{ backgroundColor: cfg.bg, color: cfg.text }}
            >
              {cfg.label}
            </span>
            <span
              className={`text-[13px] font-medium ${
                p.recent429s > 0
                  ? "text-danger"
                  : p.recent5xxs > 0
                    ? "text-warning-dark"
                    : "text-green"
              }`}
            >
              {p.recent429s > 0
                ? "Rate Limited"
                : p.recent5xxs > 0
                  ? "Rate Warning"
                  : "Healthy"}
            </span>
            {(p.recent429s > 0 || p.recent5xxs > 0) && (
              <span className="text-[12px] text-text-muted tabular-nums">
                {[p.recent429s > 0 && `${p.recent429s} 429s`, p.recent5xxs > 0 && `${p.recent5xxs} 5xx`]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Stream progress bar (bigger, with ETA)                             */
/* ------------------------------------------------------------------ */

function StreamProgress({ stream }: { stream: StreamItem }) {
  if (!stream.progress) return null;
  const pct = stream.progress.percent ?? 0;
  const eta = computeEta(stream);

  return (
    <div className="mt-2.5">
      <div className="flex items-baseline justify-between text-[12px]">
        <span className="text-text-secondary">{stream.progress.label}</span>
        <span className="tabular-nums text-text-muted">
          {stream.progress.percent != null ? `${stream.progress.percent.toFixed(1)}%` : "—"}
          {eta && <span className="ml-2 text-text-secondary">~{eta} remaining</span>}
        </span>
      </div>
      <div className="mt-1.5 h-3 overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-700 ease-out"
          style={{ width: `${Math.max(2, Math.min(pct, 100))}%` }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Attention stream row (running / failed / flagged)                  */
/* ------------------------------------------------------------------ */

function AttentionStreamRow({ stream }: { stream: StreamItem }) {
  const isFailed = stream.status === "failed" || stream.status === "auth_failed" || stream.stalled;
  const isRunning = stream.status === "running";

  const pillBg = isFailed ? "bg-danger/10" : isRunning ? "bg-[#dbeafe]" : "bg-warning/10";
  const pillText = isFailed ? "text-danger" : isRunning ? "text-[#1e40af]" : "text-warning-dark";
  const statusLabel = stream.stalled ? "Stalled" : stream.status.replace("_", " ");

  return (
    <div
      className={`rounded-lg border px-4 py-3 ${
        isFailed ? "border-danger/20 bg-danger/[0.03]" : "border-border-light bg-hover-alt/40"
      }`}
    >
      {/* header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-semibold capitalize ${pillBg} ${pillText}`}>
            {statusLabel}
          </span>
          <span className="text-[14px] font-semibold text-text-primary">
            {STREAM_LABELS[stream.stream] ?? stream.stream}
          </span>
        </div>
        <span className="shrink-0 text-[12px] tabular-nums text-text-muted">
          {streamActivityLabel(stream)}
        </span>
      </div>

      {/* progress */}
      <StreamProgress stream={stream} />

      {/* error counters – only when non-zero */}
      {(stream.recentErrors.total429s > 0 ||
        stream.recentErrors.total5xxs > 0 ||
        stream.recentErrors.failedRuns > 0) && (
        <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
          {stream.recentErrors.total429s > 0 && (
            <span className="text-warning-dark">{stream.recentErrors.total429s} rate limits</span>
          )}
          {stream.recentErrors.total5xxs > 0 && (
            <span className="text-danger">{stream.recentErrors.total5xxs} server errors</span>
          )}
          {stream.recentErrors.failedRuns > 0 && (
            <span className="text-danger">{stream.recentErrors.failedRuns} failed runs</span>
          )}
        </div>
      )}

      {/* last error message */}
      {stream.lastErrorSummary && (
        <div className="mt-2 rounded-md bg-danger/5 px-3 py-2 text-[12px] text-danger">
          {stream.lastErrorSummary}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Healthy streams – collapsible summary                              */
/* ------------------------------------------------------------------ */

function HealthyStreamsSummary({
  streams,
  expanded,
  onToggle,
}: {
  streams: StreamItem[];
  expanded: boolean;
  onToggle: () => void;
}) {
  if (streams.length === 0) return null;

  const latestActivity = streams.reduce<string | null>((best, s) => {
    const t = s.lastSuccessAt ?? s.lastCompletion?.finishedAt ?? null;
    if (!t) return best;
    if (!best) return t;
    return new Date(t) > new Date(best) ? t : best;
  }, null);

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center justify-between rounded-lg border border-border-light bg-hover-alt/30 px-4 py-2.5 text-left transition-colors hover:bg-hover-alt"
      >
        <div className="flex items-center gap-2">
          <span className="text-[14px] text-green">✓</span>
          <span className="text-[13px] font-medium text-text-secondary">
            {streams.length === 1 ? "1 stream healthy" : `${streams.length} streams healthy`}
          </span>
          {latestActivity && (
            <span className="text-[12px] text-text-muted">· last activity {formatRelativeTime(latestActivity)}</span>
          )}
        </div>
        <Chevron open={expanded} />
      </button>

      {expanded && (
        <div className="mt-1.5 space-y-px">
          {streams.map((s) => (
            <div key={s.stream} className="flex items-center justify-between rounded-lg px-4 py-2 text-[13px]">
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-green">✓</span>
                <span className="text-text-primary">{STREAM_LABELS[s.stream] ?? s.stream}</span>
                {s.status === "disabled" && <span className="text-[11px] text-text-muted">(disabled)</span>}
              </div>
              <span className="tabular-nums text-[12px] text-text-muted">
                {s.lastSuccessAt ? formatRelativeTime(s.lastSuccessAt) : "—"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page card                                                          */
/* ------------------------------------------------------------------ */

function PageCard({ page }: { page: PageItem }) {
  const [healthyOpen, setHealthyOpen] = useState(false);
  const platformCfg = PLATFORM_COLORS[page.platform];

  const healthy = page.streams.filter(isStreamHealthy);
  const attention = page.streams.filter((s) => !isStreamHealthy(s));
  const hasFailures = page.summary.failedStreams > 0 || page.summary.stalledStreams > 0;

  const counts = [
    page.counts.fans > 0 ? `${num(page.counts.fans)} fans` : null,
    page.counts.followers > 0 ? `${num(page.counts.followers)} followers` : null,
    page.counts.subscribers > 0 ? `${num(page.counts.subscribers)} subs` : null,
    page.counts.transactions > 0 ? `${num(page.counts.transactions)} tx` : null,
    page.counts.conversations > 0 ? `${num(page.counts.conversations)} convos` : null,
    page.counts.messages > 0 ? `${num(page.counts.messages)} msgs` : null,
  ].filter((c): c is string => c !== null);

  return (
    <section className={`rounded-xl border bg-card p-5 ${hasFailures ? "border-danger/20" : "border-border"}`}>
      {/* header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-[17px] font-bold text-text-primary">{page.pageLabel}</h2>
            <span
              className="inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold"
              style={{ backgroundColor: platformCfg.bg, color: platformCfg.text }}
            >
              {platformCfg.label}
            </span>
          </div>
          <div className="mt-1 text-[13px] text-text-muted">
            {page.modelName}
            {page.username ? ` · @${page.username}` : ""}
          </div>
        </div>
      </div>

      {/* compact counts */}
      {counts.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] tabular-nums text-text-secondary">
          {counts.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
      )}

      {/* streams */}
      <div className="mt-4 space-y-2">
        {attention.map((s) => (
          <AttentionStreamRow key={s.stream} stream={s} />
        ))}
        <HealthyStreamsSummary streams={healthy} expanded={healthyOpen} onToggle={() => setHealthyOpen((v) => !v)} />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Events timeline                                                    */
/* ------------------------------------------------------------------ */

function EventTimeline({ events }: { events: EventItem[] }) {
  if (events.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card px-6 py-8 text-center text-[13px] text-text-muted">
        No recent events
      </div>
    );
  }

  const dotColor = (sev: string) =>
    sev === "error" ? "bg-danger" : sev === "warn" ? "bg-warning" : "bg-text-muted";

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-3.5">
        <h2 className="text-[15px] font-bold text-text-primary">Recent Events</h2>
      </div>
      <div className="divide-y divide-border-light">
        {events.map((ev) => (
          <div key={ev.id} className="flex gap-3.5 px-5 py-3.5">
            <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${dotColor(ev.severity)}`} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-text-muted">
                <span className="font-medium text-text-secondary">{ev.pageLabel}</span>
                <span>·</span>
                <span>{STREAM_LABELS[ev.stream] ?? ev.stream}</span>
                <span>·</span>
                <span>{formatRelativeTime(ev.emittedAt)}</span>
              </div>
              <p className="mt-0.5 text-[13px] text-text-primary">{ev.message}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function LiveRequestMessagesPanel({ item }: { item: RequestItem }) {
  const { data, isLoading, error } = usePageConversationMessages(
    item.pageLabel,
    item.groupId,
    { limit: 25 },
  );

  if (isLoading) {
    return (
      <div
        className="mt-3 rounded-xl border border-border bg-hover/50 px-4 py-4 text-sm text-text-muted"
        onClick={(event) => event.stopPropagation()}
      >
        Loading messages...
      </div>
    );
  }

  if (error) {
    const missingConversation = error instanceof ApiError && error.status === 404;
    return (
      <div
        className="mt-3 rounded-xl border border-border bg-hover/50 px-4 py-4 text-sm text-text-muted"
        onClick={(event) => event.stopPropagation()}
      >
        {missingConversation
          ? "Conversation is not cached locally yet."
          : "Unable to load cached conversation messages."}
      </div>
    );
  }

  if (!data || data.messages.length === 0) {
    return (
      <div
        className="mt-3 rounded-xl border border-border bg-hover/50 px-4 py-4 text-sm text-text-muted"
        onClick={(event) => event.stopPropagation()}
      >
        No cached messages to show.
      </div>
    );
  }

  return (
    <div
      className="mt-3 rounded-xl border border-border bg-hover/50 px-4 py-4"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="max-h-[320px] space-y-2 overflow-y-auto">
        {data.messages.map((message) => {
          const isModel = message.senderRole === "model";
          const bubbleClasses = isModel
            ? "bg-accent/15 text-text-primary"
            : message.senderRole === "fan"
              ? "bg-hover text-text-primary"
              : "border border-border bg-card text-text-primary";

          return (
            <div
              key={message.messageId}
              className={`flex ${isModel ? "justify-end" : "justify-start"}`}
            >
              <div className={`max-w-[78%] rounded-lg px-3 py-2 text-[13px] ${bubbleClasses}`}>
                <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                  <span>{senderRoleLabel(message.senderRole)}</span>
                  <span>{formatDateTime(message.createdAt)}</span>
                  {message.tipAmountCents > 0 && (
                    <span className="rounded-full bg-green/15 px-1.5 py-0.5 text-green">
                      Tip {formatUsdFromCents(message.tipAmountCents)}
                    </span>
                  )}
                </div>
                <p className="whitespace-pre-wrap break-words">{message.content || " "}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LiveRequestsPanel({
  items,
  isLoading,
  activeWindow,
  onWindowChange,
}: {
  items: RequestItem[];
  isLoading: boolean;
  activeWindow: LiveRequestsWindow;
  onWindowChange: (window: LiveRequestsWindow) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedToTopRef = useRef(true);
  const previousMetricsRef = useRef({
    itemCount: 0,
    scrollHeight: 0,
  });
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);
  const activeWindowLabel = LIVE_REQUEST_WINDOWS.find((window) => window.key === activeWindow)?.label ?? "Last 5m";

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const previousMetrics = previousMetricsRef.current;
    const nextScrollHeight = element.scrollHeight;

    if (previousMetrics.itemCount > 0) {
      if (pinnedToTopRef.current || element.scrollTop <= 24) {
        element.scrollTop = 0;
      } else {
        const scrollDelta = nextScrollHeight - previousMetrics.scrollHeight;
        if (scrollDelta > 0) {
          element.scrollTop += scrollDelta;
        }
      }
    }

    previousMetricsRef.current = {
      itemCount: items.length,
      scrollHeight: nextScrollHeight,
    };
  }, [items]);

  useLayoutEffect(() => {
    if (expandedRowKey && !items.some((item) => requestRowKey(item) === expandedRowKey)) {
      setExpandedRowKey(null);
    }
  }, [expandedRowKey, items]);

  if (isLoading && items.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card px-6 py-8 text-center text-[13px] text-text-muted">
        Loading live requests…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card px-6 py-8 text-center text-[13px] text-text-muted">
        No recent requests
      </div>
    );
  }

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <div>
          <h2 className="text-[15px] font-bold text-text-primary">Live Requests</h2>
          <p className="mt-0.5 text-[12px] text-text-muted">Polling every 3s · {activeWindowLabel}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            {LIVE_REQUEST_WINDOWS.map((window) => (
              <button
                key={window.key}
                type="button"
                onClick={() => onWindowChange(window.key)}
                className={`rounded-button px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeWindow === window.key
                    ? "bg-[#1a1a1a] text-white"
                    : "border border-border bg-card text-text-secondary hover:bg-hover"
                }`}
              >
                {window.label}
              </button>
            ))}
          </div>
          <span className="text-[12px] text-text-muted">{items.length} shown in {activeWindowLabel.toLowerCase()}</span>
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={(event) => {
          pinnedToTopRef.current = event.currentTarget.scrollTop <= 24;
        }}
        className="max-h-[460px] overflow-y-auto"
      >
        <div className="divide-y divide-border-light">
          {items.map((item) => {
            const rowKey = requestRowKey(item);
            const expandable = isExpandableRequest(item);
            const expanded = expandedRowKey === rowKey;
            const returnedItems = typeof item.returnedItems === "number" ? item.returnedItems : null;

            return (
              <div
                key={rowKey}
                className={`px-5 py-3.5 ${requestRowClasses(item)} ${
                  expandable ? "cursor-pointer transition-colors hover:bg-hover/40" : ""
                } ${expanded ? "border-l-2 border-l-accent" : ""}`}
                onClick={() => {
                  if (!expandable) {
                    return;
                  }
                  setExpandedRowKey((current) => current === rowKey ? null : rowKey);
                }}
                onKeyDown={(event) => {
                  if (!expandable) {
                    return;
                  }
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setExpandedRowKey((current) => current === rowKey ? null : rowKey);
                  }
                }}
                role={expandable ? "button" : undefined}
                tabIndex={expandable ? 0 : undefined}
                aria-expanded={expandable ? expanded : undefined}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-text-muted">
                      <span>{formatRequestTimestamp(item.timestamp)}</span>
                      <span>·</span>
                      <span className="font-medium text-text-secondary">{item.pageLabel}</span>
                      <span>·</span>
                      <span>{STREAM_LABELS[item.stream] ?? item.stream}</span>
                      <span>/</span>
                      <span>{item.operation}</span>
                    </div>
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-text-muted">
                      <span className="rounded-md border border-border bg-hover-alt px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                        {item.method}
                      </span>
                      <span className="min-w-0 truncate font-mono text-[11px] text-text-secondary">
                        {item.endpoint}
                      </span>
                      {item.groupId && (
                        <span
                          className={`rounded-md border border-border px-2 py-0.5 text-[10px] font-medium ${
                            item.partnerUsername
                              ? "bg-hover-alt text-text-secondary"
                              : "bg-card text-text-muted"
                          }`}
                        >
                          {item.partnerUsername ?? item.groupId}
                        </span>
                      )}
                      {item.proxyGapMs !== null && item.proxyGapMs > 0 && (
                        <span className="rounded-md border border-border bg-hover-alt px-2 py-0.5 text-[10px] font-medium text-text-secondary">
                          gap {formatRequestMetric(item.proxyGapMs)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                    <span className={`inline-flex rounded-md border px-2.5 py-1 text-[11px] font-semibold tabular-nums ${requestBadgeClasses(item)}`}>
                      {requestBadgeText(item)}
                    </span>
                    {returnedItems !== null && (
                      <span className="inline-flex rounded-md border border-border bg-hover-alt px-2 py-0.5 text-[10px] font-medium tabular-nums text-text-secondary">
                        {returnedItems.toLocaleString()} msgs
                        {item.syncDone === true && <span className="ml-1 opacity-70">✓</span>}
                      </span>
                    )}
                    {item.durationMs !== null && (
                      <span className="text-[12px] tabular-nums text-text-secondary">
                        {formatRequestMetric(item.durationMs)}
                      </span>
                    )}
                    {item.rateLimitWaitMs !== null && item.rateLimitWaitMs > 0 && (
                      <span className="rounded-md border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning-dark">
                        wait {formatRequestMetric(item.rateLimitWaitMs)}
                      </span>
                    )}
                    {expandable && <Chevron open={expanded} />}
                  </div>
                </div>
                {expanded && <LiveRequestMessagesPanel item={item} />}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ActivitySection({
  activeTab,
  onChange,
  events,
  requests,
  requestsLoading,
  liveRequestsWindow,
  onLiveRequestsWindowChange,
}: {
  activeTab: ActivityTab;
  onChange: (tab: ActivityTab) => void;
  events: EventItem[];
  requests: RequestItem[];
  requestsLoading: boolean;
  liveRequestsWindow: LiveRequestsWindow;
  onLiveRequestsWindowChange: (window: LiveRequestsWindow) => void;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onChange("events")}
          className={`rounded-button px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === "events"
              ? "bg-[#1a1a1a] text-white"
              : "border border-border bg-card text-text-secondary hover:bg-hover"
          }`}
        >
          Events
        </button>
        <button
          type="button"
          onClick={() => onChange("requests")}
          className={`rounded-button px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === "requests"
              ? "bg-[#1a1a1a] text-white"
              : "border border-border bg-card text-text-secondary hover:bg-hover"
          }`}
        >
          Live Requests
        </button>
      </div>
      {activeTab === "events"
        ? <EventTimeline events={events} />
        : (
          <LiveRequestsPanel
            items={requests}
            isLoading={requestsLoading}
            activeWindow={liveRequestsWindow}
            onWindowChange={onLiveRequestsWindowChange}
          />
        )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export function SyncMonitorPage() {
  const [activityTab, setActivityTab] = useState<ActivityTab>("events");
  const [liveRequestsWindow, setLiveRequestsWindow] = useState<LiveRequestsWindow>("5m");
  const { data, isLoading } = useSyncMonitor();
  const selectedWindowMs = LIVE_REQUEST_WINDOWS.find((window) => window.key === liveRequestsWindow)?.windowMs ?? 300_000;
  const { data: requests = [], isLoading: requestsLoading } = useSyncRequests(
    { windowMs: selectedWindowMs, limit: 500 },
    { enabled: activityTab === "requests" },
  );

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center py-24">
        <span className="text-sm text-text-muted">Loading…</span>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <HeroBanner data={data} />
      <ProviderStrip providers={data.overall.providers} />
      <section className="grid gap-4 xl:grid-cols-2">
        {data.pages.map((page) => (
          <PageCard key={page.pageId} page={page} />
        ))}
      </section>
      <ActivitySection
        activeTab={activityTab}
        onChange={setActivityTab}
        events={data.recentEvents}
        requests={requests}
        requestsLoading={requestsLoading}
        liveRequestsWindow={liveRequestsWindow}
        onLiveRequestsWindowChange={setLiveRequestsWindow}
      />
    </div>
  );
}
