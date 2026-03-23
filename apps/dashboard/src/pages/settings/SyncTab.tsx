import { useAdminConnections, useAdminSyncRuns, useAdminSyncTrigger } from "@/api/queries";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { formatDateTime } from "@/lib/format";
import { toast } from "sonner";

export function SyncTab() {
  const { data: connections } = useAdminConnections();
  const { data: runsData, isLoading: runsLoading } = useAdminSyncRuns({ limit: 20 });
  const triggerSync = useAdminSyncTrigger();

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

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-sm font-bold text-text-primary mb-3">Manual Sync</h2>
        <div className="space-y-2">
          {items.map((conn) => (
            <div
              key={conn.id}
              className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-text-primary">{conn.label}</span>
                <PlatformBadge platform={conn.platform} />
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
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-sm font-bold text-text-primary mb-3">Recent Sync Runs</h2>
        {runsLoading && (
          <p className="text-sm text-text-muted">Loading runs...</p>
        )}
        {!runsLoading && runs.length === 0 && (
          <p className="text-sm text-text-muted">No sync runs found.</p>
        )}
        {runs.length > 0 && (
          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-hover-alt">
                  {["Page", "Scope", "Started", "Status"].map((col) => (
                    <th
                      key={col}
                      className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map((run, i) => {
                  const statusColor =
                    run.status === "completed" || run.status === "success"
                      ? "text-green"
                      : run.status === "failed"
                        ? "text-danger"
                        : run.status === "running"
                          ? "text-warning"
                          : "text-text-muted";

                  return (
                    <tr
                      key={`${run.pageLabel}-${run.startedAt}-${i}`}
                      className="border-t border-border"
                    >
                      <td className="px-4 py-3 text-sm font-medium text-text-primary">
                        {run.pageLabel}
                      </td>
                      <td className="px-4 py-3 text-sm text-text-secondary">{run.stream}</td>
                      <td className="px-4 py-3 text-sm text-text-secondary">
                        {formatDateTime(run.startedAt)}
                      </td>
                      <td className={`px-4 py-3 text-sm font-medium capitalize ${statusColor}`}>
                        {run.status}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </div>
  );
}
