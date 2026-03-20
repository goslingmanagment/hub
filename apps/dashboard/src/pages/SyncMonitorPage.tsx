import type { SyncMonitorResponse } from "@agency_hub_core/contracts";
import { useSyncMonitor } from "@/api/queries";
import { PLATFORM_COLORS } from "@/lib/constants";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

const STATUS_STYLES: Record<string, string> = {
  running: "bg-[#dbeafe] text-[#1e40af]",
  idle: "bg-[#f5f5f4] text-[#57534e]",
  completed: "bg-[#d1fae5] text-[#065f46]",
  failed: "bg-[#fee2e2] text-[#991b1b]",
  paused: "bg-[#fef3c7] text-[#92400e]",
  auth_failed: "bg-[#fee2e2] text-[#991b1b]",
  disabled: "bg-[#e7e5e4] text-[#78716c]",
};

const STREAM_LABELS: Record<string, string> = {
  light: "Light",
  transactions: "Transactions",
  subscribers: "Subscribers",
  dm_conversations: "DM Conversations",
  dm_messages: "DM Messages",
  followers: "Followers",
  followers_reconcile: "Followers Reconcile",
};

function numberText(value: number) {
  return value.toLocaleString();
}

function SummaryCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string | number;
  tone?: "default" | "danger" | "warning";
}) {
  const toneClass = tone === "danger"
    ? "text-danger"
    : tone === "warning"
      ? "text-warning-dark"
      : "text-text-primary";

  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-text-muted">
        {label}
      </div>
      <div className={`mt-2 text-2xl font-bold tabular-nums ${toneClass}`}>{value}</div>
    </div>
  );
}

function StatusPill({ label, kind }: { label: string; kind: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLES[kind] ?? STATUS_STYLES.idle}`}
    >
      {label}
    </span>
  );
}

function SmallFlag({ children, tone = "neutral" }: { children: string; tone?: "neutral" | "warning" | "danger" }) {
  const toneClass = tone === "danger"
    ? "bg-[#fee2e2] text-[#991b1b]"
    : tone === "warning"
      ? "bg-[#fef3c7] text-[#92400e]"
      : "bg-hover-alt text-text-secondary";

  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${toneClass}`}>
      {children}
    </span>
  );
}

function ProviderHealth({ provider }: { provider: SyncMonitorResponse["overall"]["providers"][number] }) {
  const platformCfg = PLATFORM_COLORS[provider.platform];
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className="inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold"
            style={{ backgroundColor: platformCfg.bg, color: platformCfg.text }}
          >
            {platformCfg.label}
          </span>
          <StatusPill label={provider.rateHealth.state} kind={provider.rateHealth.state === "limited" ? "failed" : provider.rateHealth.state === "warning" ? "paused" : "completed"} />
        </div>
        <div className="text-right text-[12px] text-text-muted tabular-nums">
          <div>429s {provider.recent429s}</div>
          <div>5xx {provider.recent5xxs}</div>
        </div>
      </div>
      <div className="mt-2 text-[12px] text-text-muted">
        Last 429 {provider.rateHealth.last429At ? formatRelativeTime(provider.rateHealth.last429At) : "none"}
      </div>
    </div>
  );
}

function StreamRow({ stream }: { stream: SyncMonitorResponse["pages"][number]["streams"][number] }) {
  const flags = [
    stream.stalled ? { label: "stalled", tone: "danger" as const } : null,
    stream.pending ? { label: "pending", tone: "warning" as const } : null,
    stream.backoffUntil ? { label: "backoff", tone: "warning" as const } : null,
    stream.rateHealth.state === "limited"
      ? { label: "rate limited", tone: "danger" as const }
      : stream.rateHealth.state === "warning"
        ? { label: "rate warn", tone: "warning" as const }
        : null,
  ].filter(Boolean) as Array<{ label: string; tone: "warning" | "danger" }>;

  return (
    <div className="rounded-lg border border-border-light bg-hover-alt/40 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-[13px] font-semibold text-text-primary">
              {STREAM_LABELS[stream.stream] ?? stream.stream}
            </div>
            <StatusPill label={stream.status.replace("_", " ")} kind={stream.status} />
          </div>
          <div className="mt-1 text-[12px] text-text-muted">
            Last success {stream.lastSuccessAt ? formatRelativeTime(stream.lastSuccessAt) : "never"}
            {stream.lastCompletion ? ` • last run ${formatDateTime(stream.lastCompletion.finishedAt)}` : ""}
          </div>
        </div>
        <div className="text-right text-[12px] text-text-muted tabular-nums">
          <div>{stream.activeRun ? `active ${formatRelativeTime(stream.activeRun.startedAt)}` : stream.lastCompletion ? `${Math.round((stream.lastCompletion.durationMs ?? 0) / 1000)}s` : "—"}</div>
          <div>ok/p/f {stream.recentRuns.success}/{stream.recentRuns.partial}/{stream.recentRuns.failed}</div>
        </div>
      </div>

      {stream.progress && (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-3 text-[12px]">
            <span className="text-text-secondary">{stream.progress.label}</span>
            <span className="tabular-nums text-text-muted">
              {stream.progress.percent === null ? "—" : `${stream.progress.percent.toFixed(1)}%`}
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${Math.max(4, Math.min(stream.progress.percent ?? 4, 100))}%` }}
            />
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <SmallFlag>{`429 ${stream.recentErrors.total429s}`}</SmallFlag>
        <SmallFlag>{`5xx ${stream.recentErrors.total5xxs}`}</SmallFlag>
        <SmallFlag>{`failed ${stream.recentErrors.failedRuns}`}</SmallFlag>
        {flags.map((flag) => (
          <SmallFlag key={flag.label} tone={flag.tone}>{flag.label}</SmallFlag>
        ))}
      </div>

      {stream.lastErrorSummary && (
        <div className="mt-2 text-[12px] text-danger">{stream.lastErrorSummary}</div>
      )}
    </div>
  );
}

function PageCard({ page }: { page: SyncMonitorResponse["pages"][number] }) {
  const platformCfg = PLATFORM_COLORS[page.platform];

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-text-primary">{page.pageLabel}</h2>
            <span
              className="inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold"
              style={{ backgroundColor: platformCfg.bg, color: platformCfg.text }}
            >
              {platformCfg.label}
            </span>
          </div>
          <div className="mt-1 text-[12px] text-text-muted">
            {page.modelName}
            {page.username ? ` • @${page.username}` : ""}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {page.summary.stalledStreams > 0 && <SmallFlag tone="danger">{`${page.summary.stalledStreams} stalled`}</SmallFlag>}
          {page.summary.failedStreams > 0 && <SmallFlag tone="danger">{`${page.summary.failedStreams} failed`}</SmallFlag>}
          {page.summary.runningStreams > 0 && <SmallFlag>{`${page.summary.runningStreams} running`}</SmallFlag>}
          {page.summary.pendingStreams > 0 && <SmallFlag tone="warning">{`${page.summary.pendingStreams} pending`}</SmallFlag>}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 text-[12px] text-text-secondary sm:grid-cols-6">
        <div><span className="block text-text-muted">Fans</span><span className="font-semibold tabular-nums">{numberText(page.counts.fans)}</span></div>
        <div><span className="block text-text-muted">Followers</span><span className="font-semibold tabular-nums">{numberText(page.counts.followers)}</span></div>
        <div><span className="block text-text-muted">Subscribers</span><span className="font-semibold tabular-nums">{numberText(page.counts.subscribers)}</span></div>
        <div><span className="block text-text-muted">Tx</span><span className="font-semibold tabular-nums">{numberText(page.counts.transactions)}</span></div>
        <div><span className="block text-text-muted">Conversations</span><span className="font-semibold tabular-nums">{numberText(page.counts.conversations)}</span></div>
        <div><span className="block text-text-muted">Messages</span><span className="font-semibold tabular-nums">{numberText(page.counts.messages)}</span></div>
      </div>

      <div className="mt-4 space-y-2">
        {page.streams.map((stream) => (
          <StreamRow key={stream.stream} stream={stream} />
        ))}
      </div>
    </section>
  );
}

export function SyncMonitorPage() {
  const { data, isLoading } = useSyncMonitor();

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center py-24">
        <span className="text-sm text-text-muted">Loading...</span>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-extrabold text-text-primary">Sync Monitor</h1>
        <p className="mt-1 text-sm text-text-muted">
          Live sync coverage and health across visible pages. Updated {formatRelativeTime(data.generatedAt)}.
        </p>
      </div>

      <section className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <SummaryCard label="Pages" value={data.overall.pages} />
        <SummaryCard label="Running" value={data.overall.runningStreams} />
        <SummaryCard label="Failed" value={data.overall.failedStreams} tone={data.overall.failedStreams > 0 ? "danger" : "default"} />
        <SummaryCard label="Stalled" value={data.overall.stalledStreams} tone={data.overall.stalledStreams > 0 ? "danger" : "default"} />
        <SummaryCard label="Recent 429s" value={data.overall.recentErrors.total429s} tone={data.overall.recentErrors.total429s > 0 ? "warning" : "default"} />
        <SummaryCard label="Recent 5xx" value={data.overall.recentErrors.total5xxs} tone={data.overall.recentErrors.total5xxs > 0 ? "danger" : "default"} />
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        {data.overall.providers.map((provider) => (
          <ProviderHealth key={provider.platform} provider={provider} />
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        {data.pages.map((page) => (
          <PageCard key={page.pageId} page={page} />
        ))}
      </section>

      <section className="rounded-xl border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text-primary">Recent Sync Events</h2>
        </div>
        <div className="divide-y divide-border-light">
          {data.recentEvents.length === 0 ? (
            <div className="px-4 py-6 text-sm text-text-muted">No recent events in the selected window.</div>
          ) : (
            data.recentEvents.map((event) => (
              <div key={event.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill label={event.severity} kind={event.severity === "error" ? "failed" : event.severity === "warn" ? "paused" : "idle"} />
                  <span className="text-[12px] text-text-muted">
                    {event.pageLabel} / {STREAM_LABELS[event.stream] ?? event.stream}
                  </span>
                  <span className="text-[12px] text-text-muted">{formatDateTime(event.emittedAt)}</span>
                </div>
                <div className="mt-1 text-sm text-text-primary">{event.message}</div>
                <div className="mt-1 text-[12px] text-text-muted">{event.eventType}</div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
