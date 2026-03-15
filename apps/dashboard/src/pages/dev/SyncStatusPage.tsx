import { Fragment } from "react";
import { useSearchParams } from "react-router";
import { useAdminSyncRuns, useAdminSyncRunDetail } from "@/api/queries";
import { formatRelativeTime } from "@/lib/format";

const STATUS_STYLES: Record<string, string> = {
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

function parseRunIdParam(value: string | null) {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
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
      {data.error && (
        <pre className="text-xs text-text-muted bg-bg rounded-lg p-3 overflow-x-auto">
          {typeof data.error === "string" ? data.error : JSON.stringify(data.error, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function SyncStatusPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const expandedRunId = parseRunIdParam(searchParams.get("runId"));

  const toggleRun = (id: number) => {
    const next = expandedRunId === id ? null : id;
    setSearchParams(next != null ? { runId: String(next) } : {}, { replace: true });
  };

  const { data, isLoading } = useAdminSyncRuns({ limit: 100 });

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center py-24">
        <span className="text-text-muted text-sm">Loading...</span>
      </div>
    );
  }

  const runs = data;

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-extrabold text-text-primary">Sync Status</h1>
        <p className="text-sm text-text-muted mt-1">Recent sync runs across all pages</p>
      </div>

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
            {runs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-text-muted">
                  No sync runs found.
                </td>
              </tr>
            )}
            {runs.map((run: any) => {
              const isExpanded = expandedRunId === run.id;

              return (
                <Fragment key={run.id}>
                  <tr
                    className="cursor-pointer border-t border-border transition-colors hover:bg-hover"
                    onClick={() => toggleRun(run.id)}
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
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[run.status] ?? STATUS_STYLES.skipped}`}
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
                      {run.error ?? ""}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={7} className="p-0">
                        <RunDetail runId={run.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
