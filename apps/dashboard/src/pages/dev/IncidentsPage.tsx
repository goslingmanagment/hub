import { Fragment, useState } from "react";
import { useAdminIncidents } from "@/api/queries";
import { EventDetailPanel, getEventDisplaySeverity, SEVERITY_STYLES } from "@/components/shared/EventDetailPanel";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { formatRelativeTime } from "@/lib/format";

export function IncidentsPage() {
  const [codeFilter, setCodeFilter] = useState<string | undefined>(undefined);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const params = {
    code: codeFilter,
    limit: 100,
  };

  const { data, isLoading, isError } = useAdminIncidents(params);

  function resolveEventCode(details: Record<string, unknown> | null, fallback: string | null) {
    return typeof details?.code === "string" ? details.code : fallback;
  }

  if (isLoading || !data) {
    return isLoading ? (
      <StatusPanel title="Loading incidents" description="Fetching recent sync anomaly groups." />
    ) : isError ? (
      <StatusPanel title="Incidents failed to load" description="The incidents feed could not be fetched." tone="error" />
    ) : (
      <StatusPanel title="Incidents unavailable" description="The incidents feed did not return data." tone="error" />
    );
  }

  const summary = data.summary ?? [];
  const items = data.items ?? [];
  const displaySummary = summary.reduce<Array<{ code: string; severity: string; count: number }>>((acc, item) => {
    const displaySeverity = getEventDisplaySeverity({
      eventCode: item.code,
      severity: item.severity ?? "info",
      details: null,
    });
    const existing = acc.find((entry) => entry.code === item.code && entry.severity === displaySeverity);
    if (existing) {
      existing.count += item.count;
    } else {
      acc.push({
        code: item.code,
        severity: displaySeverity,
        count: item.count,
      });
    }
    return acc;
  }, []);

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-extrabold text-text-primary">Incidents</h1>
        <p className="text-sm text-text-muted mt-1">Sync anomalies aggregated from events</p>
      </div>

      {/* Summary cards */}
      {displaySummary.length > 0 && (
        <div className="grid grid-cols-2 gap-3 mb-6 sm:grid-cols-3 lg:grid-cols-4">
          {displaySummary.map((s) => {
            const isActive = codeFilter === s.code;
            return (
              <button
                key={`${s.code}:${s.severity}`}
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
            {items.map((item, idx) => {
              const rowId = item.id != null ? String(item.id) : `${idx}`;
              const isExpanded = expandedId === rowId;
              const eventCode = resolveEventCode(item.details, item.eventType);
              const displaySeverity = getEventDisplaySeverity({
                eventCode,
                severity: item.severity,
                details: item.details,
              });

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
                      {resolveEventCode(item.details, item.eventType) ?? "\u2014"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[displaySeverity] ?? SEVERITY_STYLES.info}`}
                      >
                        {displaySeverity}
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
                          eventCode={eventCode}
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
