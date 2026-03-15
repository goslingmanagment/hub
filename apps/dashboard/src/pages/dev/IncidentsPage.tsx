import { Fragment, useState } from "react";
import { useAdminIncidents } from "@/api/queries";
import { EventDetailPanel, SEVERITY_STYLES } from "@/components/shared/EventDetailPanel";
import { formatRelativeTime } from "@/lib/format";

export function IncidentsPage() {
  const [codeFilter, setCodeFilter] = useState<string | undefined>(undefined);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const params = {
    code: codeFilter,
    limit: 100,
  };

  const { data, isLoading } = useAdminIncidents(params);

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center py-24">
        <span className="text-text-muted text-sm">Loading...</span>
      </div>
    );
  }

  const summary = data.summary ?? [];
  const items = data.items ?? [];

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-extrabold text-text-primary">Incidents</h1>
        <p className="text-sm text-text-muted mt-1">Sync anomalies aggregated from events</p>
      </div>

      {/* Summary cards */}
      {summary.length > 0 && (
        <div className="grid grid-cols-2 gap-3 mb-6 sm:grid-cols-3 lg:grid-cols-4">
          {summary.map((s: any) => {
            const isActive = codeFilter === s.code;
            return (
              <button
                key={s.code}
                type="button"
                onClick={() => setCodeFilter(isActive ? undefined : s.code)}
                className={`rounded-xl border p-4 text-left transition-colors ${
                  isActive
                    ? "border-accent bg-accent/5"
                    : "border-border bg-card hover:bg-hover"
                }`}
              >
                <p className="text-sm font-semibold text-text-primary">{s.code}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-lg font-extrabold text-text-primary tabular-nums">
                    {s.count}
                  </span>
                  {s.severity && (
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[s.severity] ?? SEVERITY_STYLES.info}`}
                    >
                      {s.severity}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Active filter indicator */}
      {codeFilter && (
        <div className="mb-4 flex items-center gap-2">
          <span className="text-sm text-text-muted">
            Filtered by: <span className="font-medium text-text-primary">{codeFilter}</span>
          </span>
          <button
            type="button"
            onClick={() => setCodeFilter(undefined)}
            className="text-sm text-accent hover:underline"
          >
            Clear
          </button>
        </div>
      )}

      {/* Incidents table */}
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-hover-alt">
              {["Time", "Page", "Stream", "Code", "Severity", "Message"].map((col) => (
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
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-text-muted">
                  No incidents found.
                </td>
              </tr>
            )}
            {items.map((item: any, idx: number) => {
              const rowId = item.id ?? `${idx}`;
              const isExpanded = expandedId === rowId;

              return (
                <Fragment key={rowId}>
                  <tr
                    className="cursor-pointer border-t border-border transition-colors hover:bg-hover"
                    onClick={() => setExpandedId(isExpanded ? null : rowId)}
                  >
                    <td className="px-4 py-3 text-sm text-text-secondary whitespace-nowrap">
                      {item.emittedAt ? formatRelativeTime(item.emittedAt) : "\u2014"}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-primary font-medium">
                      {item.pageLabel ?? "\u2014"}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary">
                      {item.stream ?? "\u2014"}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-primary font-mono">
                      {item.details?.code ?? item.eventType ?? "\u2014"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[item.severity] ?? SEVERITY_STYLES.info}`}
                      >
                        {item.severity}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary max-w-xs truncate">
                      {item.message ?? "\u2014"}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={6} className="p-0">
                        <EventDetailPanel
                          message={item.message}
                          syncRunId={item.syncRunId}
                          eventCode={item.details?.code ?? item.eventType}
                          severity={item.severity}
                          details={item.details}
                        />
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
