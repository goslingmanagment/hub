import { useState } from "react";
import { useAdminQueueJobs } from "@/api/queries";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { formatRelativeTime } from "@/lib/format";

const STATE_FILTERS = [
  { key: "all", label: "All" },
  { key: "created", label: "Created" },
  { key: "active", label: "Active" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
];

const STATE_STYLES: Record<string, string> = {
  created: "bg-[#e5e7eb] text-[#374151]",
  active: "bg-[#dbeafe] text-[#1e40af]",
  completed: "bg-[#d1fae5] text-[#065f46]",
  failed: "bg-[#fee2e2] text-[#991b1b]",
};

export function QueuePage() {
  const [stateFilter, setStateFilter] = useState("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const params = {
    state: stateFilter === "all" ? undefined : stateFilter,
    limit: 100,
  };

  const { data, isLoading, isError } = useAdminQueueJobs(params);

  if (isLoading || !data) {
    return isLoading ? (
      <StatusPanel title="Loading queue jobs" description="Fetching recent pg-boss jobs." />
    ) : isError ? (
      <StatusPanel title="Queue failed to load" description="The job queue view could not be fetched." tone="error" />
    ) : (
      <StatusPanel title="Queue unavailable" description="The job queue did not return data." tone="error" />
    );
  }

  const jobs = data;

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-extrabold text-text-primary">Queue</h1>
        <p className="text-sm text-text-muted mt-1">pg-boss job queue</p>
      </div>

      <div className="mb-4">
        <FilterButtons
          filters={STATE_FILTERS}
          active={stateFilter}
          onChange={setStateFilter}
        />
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-hover-alt">
              {["Name", "State", "Created", "Started", "Completed", "Retries"].map((col) => (
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
            {jobs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-text-muted">
                  No jobs found.
                </td>
              </tr>
            )}
            {jobs.map((job, idx) => {
              const rowId = job.id != null ? String(job.id) : `${idx}`;
              const isExpanded = expandedId === rowId;

              return (
                <tr
                  key={rowId}
                  className="cursor-pointer border-t border-border transition-colors hover:bg-hover"
                  onClick={() => setExpandedId(isExpanded ? null : rowId)}
                >
                  <td className="px-4 py-3 text-sm text-text-primary font-medium">
                    {job.name ?? "\u2014"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATE_STYLES[job.state] ?? STATE_STYLES.created}`}
                    >
                      {job.state}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary whitespace-nowrap">
                    {job.createdOn ? formatRelativeTime(job.createdOn) : "\u2014"}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary whitespace-nowrap">
                    {job.startedOn ? formatRelativeTime(job.startedOn) : "\u2014"}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary whitespace-nowrap">
                    {job.completedOn ? formatRelativeTime(job.completedOn) : "\u2014"}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    {job.retryCount ?? 0}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {expandedId != null && (() => {
          const job = jobs.find((entry, index) => (entry.id ?? `${index}`) === expandedId);
          if (!job) return null;
          return (
            <div className="border-t border-border px-4 py-3 space-y-2">
              {job.data != null && (
                <div>
                  <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-1">
                    Data
                  </h4>
                      <pre className="text-xs text-text-muted bg-bg rounded-lg p-3 mt-2 overflow-x-auto">
                        {JSON.stringify(job.data, null, 2)}
                      </pre>
                </div>
              )}
              {job.output != null && (
                <div>
                  <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-1">
                    Output
                  </h4>
                      <pre className="text-xs text-text-muted bg-bg rounded-lg p-3 mt-2 overflow-x-auto">
                        {JSON.stringify(job.output, null, 2)}
                      </pre>
                </div>
              )}
              {job.data == null && job.output == null && (
                <p className="text-sm text-text-muted">No data or output available.</p>
              )}
            </div>
          );
        })()}
      </section>
    </div>
  );
}
