import { Link } from "react-router";
import type { SyncRunItem, SyncUxSummary } from "@agency_hub_core/contracts";
import { useAdminConnections, useAdminSyncRuns, useAdminSyncTrigger, useAdminSyncTriggerAll } from "@/api/queries";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { SyncUxBadge, formatSyncUxMeta } from "@/components/shared/SyncUxBadge";
import { getSyncUxDisplayMode } from "@/components/shared/syncUxDisplay";
import { formatDateTime } from "@/lib/format";
import { toast } from "sonner";

const STREAM_LABELS: Record<string, string> = {
  light: "Light sync",
  transactions: "Transactions",
  subscribers: "Subscribers",
  followers: "Followers",
  followers_reconcile: "Followers reconcile",
  dm_conversations: "DM conversations",
  dm_messages: "DM messages",
};

function isAuthErrorSummary(summary: string | null) {
  if (!summary) {
    return false;
  }

  const normalized = summary.toLowerCase();
  return normalized.includes("401") || normalized.includes("403") || normalized.includes("auth");
}

function summaryForRun(run: SyncRunItem): SyncUxSummary {
  if (run.status === "running") {
    return {
      state: "syncing",
      label: "Syncing",
      headline: "Syncing now",
      detail: "This page is actively processing a sync run.",
      progressLabel: null,
      nextRetryAt: null,
      updatedAt: run.startedAt,
      requiresAction: false,
    };
  }

  if (run.status === "partial") {
    return {
      state: "catching_up",
      label: "Catching up",
      headline: "Queued to continue",
      detail: "This run yielded safely and will resume from the last checkpoint.",
      progressLabel: null,
      nextRetryAt: null,
      updatedAt: run.finishedAt ?? run.startedAt,
      requiresAction: false,
    };
  }

  if (run.status === "failed") {
    const requiresAction = isAuthErrorSummary(run.errorSummary);
    return {
      state: "attention",
      label: requiresAction ? "Reconnect" : "Needs attention",
      headline: requiresAction ? "Reconnect to resume sync" : "Sync needs attention",
      detail: requiresAction
        ? "Fresh credentials are required before sync can continue."
        : "This run stopped before the page could catch up.",
      progressLabel: null,
      nextRetryAt: null,
      updatedAt: run.finishedAt ?? run.startedAt,
      requiresAction,
    };
  }

  if (run.status === "skipped") {
    return {
      state: "off",
      label: "Skipped",
      headline: "No work was needed",
      detail: "The requested sync run was skipped.",
      progressLabel: null,
      nextRetryAt: null,
      updatedAt: run.finishedAt ?? run.startedAt,
      requiresAction: false,
    };
  }

  return {
    state: "healthy",
    label: "Completed",
    headline: "Sync completed",
    detail: "This run finished successfully.",
    progressLabel: null,
    nextRetryAt: null,
    updatedAt: run.finishedAt ?? run.startedAt,
    requiresAction: false,
  };
}

function getSyncStatusHelper(
  summary: SyncUxSummary,
  input?: {
    updatedPrefix?: string;
    retryPrefix?: string;
  },
) {
  return summary.detail ??
    summary.progressLabel ??
    formatSyncUxMeta(summary, input) ??
    summary.headline;
}

export function SyncTab() {
  const { data: connections } = useAdminConnections();
  const { data: runsData, isLoading: runsLoading } = useAdminSyncRuns({ limit: 20 });
  const triggerSync = useAdminSyncTrigger();
  const triggerAllSync = useAdminSyncTriggerAll();

  const items = connections ?? [];
  const runs = runsData ?? [];

  async function handleTrigger(pageLabel: string, scope: "light" | "all") {
    try {
      await triggerSync.mutateAsync({ pageLabel, scope });
      toast.success(`Sync triggered for ${pageLabel} (${scope})`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to trigger sync");
    }
  }

  async function handleTriggerAll() {
    try {
      await triggerAllSync.mutateAsync();
      toast.success("Sync triggered for all pages");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to trigger all pages");
    }
  }

  return (
    <div>
      <div className="mb-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-bold text-text-primary">Manual Sync</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleTriggerAll}
              disabled={triggerAllSync.isPending}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-40"
            >
              Sync All Pages
            </button>
            <Link
              to="/sync"
              className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:bg-hover"
            >
              Open Diagnostics
            </Link>
          </div>
        </div>
        <div className="space-y-2">
          {items.map((conn) => {
            const syncMode = getSyncUxDisplayMode(conn.syncUx, "sync_settings");
            const syncHelper = syncMode === "home"
              ? getSyncStatusHelper(conn.syncUx, {
                updatedPrefix: "Updated",
                retryPrefix: "Retrying",
              })
              : null;

            return (
              <div
                key={conn.id}
                className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card px-4 py-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-text-primary">{conn.label}</span>
                    <PlatformBadge platform={conn.platform} />
                  </div>
                  <div className="mt-2">
                    <SyncUxBadge summary={conn.syncUx} />
                  </div>
                  {syncHelper && (
                    <div className="mt-2 text-xs text-text-muted">{syncHelper}</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleTrigger(conn.label, "light")}
                    disabled={triggerSync.isPending}
                    className="rounded-lg bg-accent px-3 py-1 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-40"
                  >
                    Light Sync
                  </button>
                  <button
                    onClick={() => handleTrigger(conn.label, "all")}
                    disabled={triggerSync.isPending}
                    className="rounded-lg border border-border bg-card px-3 py-1 text-xs font-semibold text-text-secondary transition-colors hover:bg-hover disabled:opacity-40"
                  >
                    Full Sync
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <h2 className="text-sm font-bold text-text-primary mb-3">Recent Activity</h2>
        {runsLoading && (
          <p className="text-sm text-text-muted">Loading runs...</p>
        )}
        {!runsLoading && runs.length === 0 && (
          <p className="text-sm text-text-muted">No sync runs found.</p>
        )}
        {runs.length > 0 && (
          <section className="space-y-2">
            {runs.map((run, i) => {
              const runSummary = summaryForRun(run);
              const runMeta = formatSyncUxMeta(runSummary, {
                updatedPrefix: "Finished",
                retryPrefix: "Retrying",
              });
              const runHelper = runSummary.detail ?? runSummary.progressLabel ?? runSummary.headline;

              return (
                <article
                  key={run.runId ?? `${run.pageLabel}-${run.startedAt}-${i}`}
                  className="rounded-xl border border-border bg-card px-4 py-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-text-primary">{run.pageLabel}</span>
                        <PlatformBadge platform={run.platform} />
                        <span className="text-xs text-text-muted">
                          {STREAM_LABELS[run.stream] ?? run.stream}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <SyncUxBadge summary={runSummary} />
                        {runMeta && <span className="text-xs text-text-muted">{runMeta}</span>}
                      </div>
                      <div className="mt-1 text-xs text-text-muted">
                        Started {formatDateTime(run.startedAt)}
                        {run.trigger ? <> &middot; Triggered by {run.trigger}</> : null}
                      </div>
                      {runHelper && (
                        <div className="mt-1 text-xs text-text-muted">{runHelper}</div>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </section>
        )}
      </div>
    </div>
  );
}
