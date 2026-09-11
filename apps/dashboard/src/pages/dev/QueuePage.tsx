import { Fragment, useId, useState } from "react";
import { useAdminQueueJobs } from "@/api/queries";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { QuerySection } from "@/components/shared/QuerySection";
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
  const detailPrefix = useId();

  const params = {
    ...(stateFilter === "all" ? {} : { state: stateFilter }),
    limit: 100,
  };

  const { data, isError, refetch } = useAdminQueueJobs(params);
  const jobs = data ?? [];

  return (
    <div className="p-4 md:p-0">
      <div className="mb-5">
        <h1 className="text-xl font-extrabold text-text-primary">Queue</h1>
        <p className="text-sm text-text-muted mt-1">До 100 последних задач в выбранном состоянии. Обновление каждые 10 секунд.</p>
      </div>

      <div className="mb-4">
        <FilterButtons
          filters={STATE_FILTERS}
          active={stateFilter}
          onChange={(next) => { setStateFilter(next); setExpandedId(null); }}
        />
      </div>

      <QuerySection title="Очередь задач" hasData={data !== undefined} isError={isError} retry={refetch}>
      <section role="region" aria-label="Очередь задач" tabIndex={0} className="overflow-x-auto rounded-xl border border-border bg-card">
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
                <Fragment key={rowId}>
                <tr
                  className="cursor-pointer border-t border-border transition-colors hover:bg-hover"
                  onClick={() => setExpandedId(isExpanded ? null : rowId)}
                >
                  <td className="px-4 py-3 text-sm text-text-primary font-medium">
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      aria-controls={isExpanded ? `${detailPrefix}-${rowId}` : undefined}
                      aria-label={`Details for ${job.name ?? "job"}`}
                      className="text-left hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
                      onClick={(event) => { event.stopPropagation(); setExpandedId(isExpanded ? null : rowId); }}
                    >
                      <span aria-hidden="true">{isExpanded ? "▾ " : "▸ "}</span>
                      {job.name ?? "\u2014"}
                    </button>
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
                {isExpanded && <tr id={`${detailPrefix}-${rowId}`}><td colSpan={6} className="border-t border-border p-4"><div className="space-y-3">
              {job.data != null && (
                <div>
                  <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-1">
                    Данные задачи
                  </h4>
                      <pre className="text-xs text-text-muted bg-bg rounded-lg p-3 mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all">
                        {JSON.stringify(job.data, null, 2)}
                      </pre>
                </div>
              )}
              {job.output != null && (
                <div>
                  <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-1">
                    Результат
                  </h4>
                      <pre className="text-xs text-text-muted bg-bg rounded-lg p-3 mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all">
                        {JSON.stringify(job.output, null, 2)}
                      </pre>
                </div>
              )}
              {job.data == null && job.output == null && (
                <p className="text-sm text-text-muted">У этой задачи нет сохранённых данных или результата.</p>
              )}
                </div></td></tr>}
                </Fragment>
              );
            })}
          </tbody>
        </table>


      </section>
      </QuerySection>
    </div>
  );
}
