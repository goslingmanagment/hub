import { Fragment, useState } from "react";
import type { SyncRunItem } from "@agency_hub_core/contracts";
import { Link } from "react-router";
import { useAuthMe, useAdminSyncTrigger, useAdminSyncRuns, useAdminSyncRunDetail } from "@/api/queries";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { getSyncUxTone } from "@/components/shared/SyncUxBadge";
import { formatRelativeTime } from "@/lib/format";
import { toast } from "sonner";
import { useSyncTabData } from "./useSyncTabData";
import type { SyncTabPage, FreshnessItem, ErrorItem, ActivityEntry } from "./useSyncTabData";

const STALENESS_CLASS: Record<string, string> = {
  fresh: "text-green",
  stale: "text-warning-dark",
  "very-stale": "text-danger",
};

function StatusBadge({ page }: { page: SyncTabPage }) {
  const tone = getSyncUxTone(page.badgeState);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${tone.badge}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      {page.primaryStatus}
    </span>
  );
}

function FreshnessRow({ item }: { item: FreshnessItem }) {
  if (item.isActive && item.activeLabel) {
    return (
      <div className="grid grid-cols-[7rem_1fr] gap-x-3 py-1.5">
        <span className="text-xs font-medium text-text-secondary">{item.label}</span>
        <span className="text-xs font-medium text-[#1d4ed8]">{item.activeLabel}</span>
      </div>
    );
  }

  const timeText = item.lastUpdated ? formatRelativeTime(item.lastUpdated) : "Never synced";
  const timeClass = STALENESS_CLASS[item.staleness];

  return (
    <div className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-0.5 py-1.5">
      <span className="text-xs font-medium text-text-secondary">{item.label}</span>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className={`text-xs font-medium ${timeClass}`}>{timeText}</span>
        <span className="text-xs text-text-muted">{item.countText}</span>
      </div>
      {item.progress && item.progress.total > 0 && (
        <>
          <span />
          <div className="flex items-center gap-2 mt-0.5">
            <div className="h-1.5 flex-1 max-w-[180px] rounded-full bg-hover-alt overflow-hidden">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${Math.min(100, item.progress.percent ?? 0)}%` }}
              />
            </div>
            <span className="text-[11px] text-text-muted">
              {item.progress.current.toLocaleString()} / {item.progress.total.toLocaleString()} synced
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function ErrorPanel({ errors }: { errors: ErrorItem[] }) {
  if (errors.length === 0) return null;
  return (
    <div className="mt-3 rounded-lg border border-danger/20 bg-danger/[0.04] px-3 py-2.5">
      {errors.map((err, i) => (
        <div key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
          <span className="text-danger font-medium">{err.message}</span>
          {err.actionLink && (
            <Link
              to={err.actionLink}
              className="font-semibold text-accent hover:underline"
            >
              {err.actionLabel ?? "Fix"}
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}

function ActivityLog({ entries }: { entries: ActivityEntry[] }) {
  const [open, setOpen] = useState(false);

  if (entries.length === 0) return null;

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
      >
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>{"\u25B6"}</span>
        Recent activity ({entries.length})
      </button>
      {open && (
        <div className="mt-1.5 space-y-0.5">
          {entries.map((entry, i) => (
            <div key={i} className="flex gap-3 text-xs py-0.5">
              <span className="shrink-0 w-[6.5rem] tabular-nums text-text-muted">{entry.timestamp}</span>
              <span className={entry.isFailed ? "text-danger" : "text-text-secondary"}>{entry.summary}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PageCard({
  page,
  onSyncData,
  onSyncMessages,
  isTriggerPending,
}: {
  page: SyncTabPage;
  onSyncData: () => void;
  onSyncMessages: () => void;
  isTriggerPending: boolean;
}) {
  const isFansly = page.platform === "fansly";

  return (
    <div className="rounded-xl border border-border bg-card px-5 py-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-text-primary">{page.pageLabel}</span>
            <PlatformBadge platform={page.platform} />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <StatusBadge page={page} />
            {page.supportingText && (
              <span className="text-xs text-text-muted">{page.supportingText}</span>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSyncData}
            disabled={isTriggerPending || page.isSyncingData}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-40"
          >
            {page.isSyncingData ? "Syncing Data\u2026" : "Sync Data"}
          </button>
          {isFansly && (
            <button
              type="button"
              onClick={onSyncMessages}
              disabled={isTriggerPending || page.isSyncingMessages}
              className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:bg-hover disabled:opacity-40"
            >
              {page.isSyncingMessages ? "Syncing Messages\u2026" : "Sync Messages"}
            </button>
          )}
        </div>
      </div>

      {/* Freshness grid */}
      <div className="mt-4 border-t border-border pt-3">
        {page.freshness.map((item) => (
          <FreshnessRow key={item.label} item={item} />
        ))}
      </div>

      {/* Errors */}
      <ErrorPanel errors={page.errors} />

      {/* Activity log */}
      <ActivityLog entries={page.activity} />
    </div>
  );
}

const RUN_STATUS_STYLES: Record<string, string> = {
  success: "bg-[#d1fae5] text-[#065f46]",
  partial: "bg-[#fef3c7] text-[#92400e]",
  failed: "bg-[#fee2e2] text-[#991b1b]",
  running: "bg-[#dbeafe] text-[#1e40af]",
  skipped: "bg-[#e5e7eb] text-[#374151]",
};

function formatDuration(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt || !finishedAt) return "\u2014";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function RunDetail({ runId }: { runId: number }) {
  const { data, isLoading } = useAdminSyncRunDetail(runId);

  if (isLoading) {
    return (
      <div className="px-6 py-4 bg-hover-alt/40">
        <span className="text-text-muted text-sm">Loading run details...</span>
      </div>
    );
  }

  if (!data) return null;

  const events = data.events ?? [];
  const runError = data.run.errorSummary;

  return (
    <div className="px-6 py-4 bg-hover-alt/40 space-y-3">
      <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
        Events ({events.length})
      </h4>
      {events.length === 0 ? (
        <p className="text-sm text-text-muted">No events recorded.</p>
      ) : (
        <div className="space-y-1">
          {events.map((evt: any, idx: number) => (
            <div key={idx} className="flex items-start gap-3 text-sm">
              <span className="text-text-muted whitespace-nowrap text-xs">
                {evt.emittedAt ? formatRelativeTime(evt.emittedAt) : ""}
              </span>
              <span
                className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                  evt.severity === "error"
                    ? "bg-[#fee2e2] text-[#991b1b]"
                    : evt.severity === "warn"
                      ? "bg-[#fef3c7] text-[#92400e]"
                      : "bg-[#e5e7eb] text-[#374151]"
                }`}
              >
                {evt.severity}
              </span>
              <span className="text-text-secondary">{evt.message ?? evt.type ?? ""}</span>
            </div>
          ))}
        </div>
      )}
      {runError && (
        <pre className="text-xs text-text-muted bg-bg rounded-lg p-3 overflow-x-auto">
          {runError}
        </pre>
      )}
    </div>
  );
}

function DiagnosticsSection() {
  const [open, setOpen] = useState(false);
  const [expandedRunId, setExpandedRunId] = useState<number | null>(null);
  const { data: runs, isLoading } = useAdminSyncRuns({ limit: 100 });

  return (
    <div className="mt-6 border-t border-border pt-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
      >
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>{"\u25B6"}</span>
        Sync diagnostics
      </button>

      {open && (
        <div className="mt-3">
          {isLoading ? (
            <p className="text-sm text-text-muted">Loading...</p>
          ) : (
            <section className="overflow-hidden rounded-xl border border-border bg-card">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-hover-alt">
                    {["Page", "Platform", "Stream", "Status", "Started", "Duration", "Error"].map(
                      (col) => (
                        <th
                          key={col}
                          className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted"
                        >
                          {col}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {(!runs || runs.length === 0) && (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-sm text-text-muted">
                        No sync runs found.
                      </td>
                    </tr>
                  )}
                  {(runs ?? []).map((run: SyncRunItem) => {
                    const isExpanded = expandedRunId === run.runId;
                    return (
                      <Fragment key={run.runId}>
                        <tr
                          className="cursor-pointer border-t border-border transition-colors hover:bg-hover"
                          onClick={() => setExpandedRunId(isExpanded ? null : run.runId)}
                        >
                          <td className="px-4 py-3 text-sm text-text-primary font-medium">
                            {run.pageLabel ?? "\u2014"}
                          </td>
                          <td className="px-4 py-3 text-sm text-text-secondary">
                            {run.platform ?? "\u2014"}
                          </td>
                          <td className="px-4 py-3 text-sm text-text-secondary">
                            {run.stream ?? run.scope ?? "\u2014"}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${RUN_STATUS_STYLES[run.status] ?? RUN_STATUS_STYLES.skipped}`}
                            >
                              {run.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-text-secondary whitespace-nowrap">
                            {run.startedAt ? formatRelativeTime(run.startedAt) : "\u2014"}
                          </td>
                          <td className="px-4 py-3 text-sm text-text-secondary whitespace-nowrap">
                            {formatDuration(run.startedAt, run.finishedAt)}
                          </td>
                          <td className="px-4 py-3 text-sm text-danger max-w-xs truncate">
                            {run.errorSummary ?? ""}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={7} className="p-0">
                              <RunDetail runId={run.runId} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

export function SyncTab() {
  const { pages, isLoading } = useSyncTabData();
  const triggerSync = useAdminSyncTrigger();
  const { data: auth } = useAuthMe();
  const isOwner = auth?.user.role === "owner";

  async function handleSyncData(pageLabel: string) {
    try {
      await triggerSync.mutateAsync({ pageLabel, scope: "data" });
      toast.success(`Sync started for ${pageLabel}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to start sync");
    }
  }

  async function handleSyncMessages(pageLabel: string) {
    try {
      await triggerSync.mutateAsync({ pageLabel, scope: "messages" });
      toast.success(`Sync started for ${pageLabel}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to start sync");
    }
  }

  if (isLoading) {
    return <p className="text-sm text-text-muted">Loading sync status...</p>;
  }

  if (pages.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        No pages configured.{" "}
        <Link to="/settings?tab=pages" className="text-accent hover:underline">
          Add a page
        </Link>{" "}
        to start syncing.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-sm font-bold text-text-primary">Sync</h2>
      </div>

      <div className="space-y-3">
        {pages.map((page) => (
          <PageCard
            key={page.pageId}
            page={page}
            onSyncData={() => handleSyncData(page.pageLabel)}
            onSyncMessages={() => handleSyncMessages(page.pageLabel)}
            isTriggerPending={triggerSync.isPending}
          />
        ))}
      </div>

      {isOwner && <DiagnosticsSection />}
    </div>
  );
}
