import { useEffect, useState } from "react";
import type { SyncRunItem } from "@fansly-connect/contracts";
import {
  useAdminSyncRuns,
  useAdminSyncRunDetail,
  useAdminSyncTrigger,
  useAdminSyncTriggerAll,
  useOverview,
} from "@/api/queries";
import { DataTable, type Column } from "@/components/shared/DataTable";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { RelativeDate } from "@/components/shared/RelativeDate";
import { Button } from "@/components/ui/button";
import { SkeletonTable } from "@/components/shared/SkeletonTable";

export function SyncPage() {
  const { data: overview } = useOverview();
  const [pageFilter, setPageFilter] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [triggerPage, setTriggerPage] = useState("");
  const [triggerScope, setTriggerScope] = useState<"light" | "followers" | "all">("all");

  const query: Record<string, string> = { limit: "30" };
  if (pageFilter) query.pageLabel = pageFilter;

  const [polling, setPolling] = useState(false);
  const { data: runs, isLoading } = useAdminSyncRuns(query, polling ? 5000 : undefined);

  // Start/stop polling based on whether any run is active
  const hasRunning = runs?.some((run) => run.status === "running") ?? false;
  useEffect(() => {
    if (hasRunning !== polling) {
      setPolling(hasRunning);
    }
  }, [hasRunning, polling]);

  const { data: detail } = useAdminSyncRunDetail(selectedRunId ?? 0, {
    enabled: !!selectedRunId,
  });
  const syncTrigger = useAdminSyncTrigger();
  const syncTriggerAll = useAdminSyncTriggerAll();

  const handleTrigger = () => {
    if (triggerPage) {
      syncTrigger.mutate({ pageLabel: triggerPage, scope: triggerScope });
    }
  };

  const columns: Column<SyncRunItem>[] = [
    { key: "runId", header: "ID", className: "w-16", render: (r) => <span className="text-zinc-400">#{r.runId}</span> },
    { key: "pageLabel", header: "Page", render: (r) => <span className="text-zinc-100">{r.pageLabel}</span> },
    { key: "stream", header: "Stream", render: (r) => <span className="text-zinc-300">{r.stream}</span> },
    { key: "trigger", header: "Trigger", render: (r) => <span className="text-zinc-400">{r.trigger}</span> },
    { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "startedAt", header: "Started", render: (r) => <RelativeDate iso={r.startedAt} /> },
    {
      key: "duration",
      header: "Duration",
      render: (r) => {
        if (!r.finishedAt) return <span className="text-zinc-500">—</span>;
        const ms = new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime();
        return <span className="text-zinc-400">{(ms / 1000).toFixed(1)}s</span>;
      },
    },
    { key: "error", header: "Error", render: (r) => r.errorSummary ? <span className="text-xs text-red-400 truncate max-w-48 block">{r.errorSummary}</span> : "—" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-zinc-100">Sync</h1>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => syncTriggerAll.mutate()}
            disabled={syncTriggerAll.isPending}
          >
            Sync All
          </Button>
        </div>
      </div>

      <div className="flex gap-3 items-end">
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Page</label>
          <select
            value={triggerPage}
            onChange={(e) => setTriggerPage(e.target.value)}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100"
          >
            <option value="">Select page</option>
            {(overview?.pages ?? []).map((p) => (
              <option key={p.label} value={p.label}>{p.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Scope</label>
          <select
            value={triggerScope}
            onChange={(e) => setTriggerScope(e.target.value as any)}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100"
          >
            <option value="light">Light</option>
            <option value="followers">Followers</option>
            <option value="all">All</option>
          </select>
        </div>
        <Button size="sm" onClick={handleTrigger} disabled={!triggerPage || syncTrigger.isPending}>
          Sync Page
        </Button>
      </div>

      <div>
        <label className="block text-xs text-zinc-500 mb-1">Filter by page</label>
        <select
          value={pageFilter}
          onChange={(e) => setPageFilter(e.target.value)}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100"
        >
          <option value="">All pages</option>
          {(overview?.pages ?? []).map((p) => (
            <option key={p.label} value={p.label}>{p.label}</option>
          ))}
        </select>
      </div>

      {isLoading ? <SkeletonTable /> : (
        <DataTable
          columns={columns}
          data={runs ?? []}
          onRowClick={(r) => setSelectedRunId(r.runId === selectedRunId ? null : r.runId)}
        />
      )}

      {selectedRunId && detail && (
        <div className="rounded border border-zinc-800 bg-zinc-900 p-4 space-y-4">
          <h2 className="text-sm font-medium text-zinc-100">Run #{selectedRunId} Detail</h2>

          <div>
            <h3 className="text-xs font-medium text-zinc-500 mb-2">Events ({detail.events.length})</h3>
            <div className="max-h-64 overflow-y-auto space-y-1">
              {detail.events.map((e) => (
                <div key={e.id} className="flex gap-2 text-xs">
                  <StatusBadge status={e.severity} />
                  <span className="text-zinc-400">{e.eventType}</span>
                  <span className="text-zinc-500 flex-1 truncate">{e.message}</span>
                  <RelativeDate iso={e.emittedAt} />
                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 className="text-xs font-medium text-zinc-500 mb-2">HTTP Attempts ({detail.attempts.length})</h3>
            <div className="max-h-64 overflow-y-auto space-y-1">
              {detail.attempts.map((a) => (
                <div key={a.attemptId} className="flex gap-2 text-xs">
                  <StatusBadge status={a.state} />
                  <span className="text-zinc-300">{a.operation}</span>
                  {a.httpStatus && <span className="text-zinc-400">HTTP {a.httpStatus}</span>}
                  {a.durationMs != null && <span className="text-zinc-500">{a.durationMs}ms</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
