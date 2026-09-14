import { Fragment, useState } from "react";
import { useAdminLogs } from "@/api/queries";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { EventDetailPanel, getEventDisplaySeverity, SEVERITY_STYLES } from "@/components/shared/EventDetailPanel";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { formatRelativeTime } from "@/lib/format";

const SEVERITY_FILTERS = [
  { key: "all", label: "All" },
  { key: "info", label: "Info" },
  { key: "warn", label: "Warn" },
  { key: "error", label: "Error" },
];

export function LogPage() {
  const [severity, setSeverity] = useState("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const params = {
    ...(severity === "all" ? {} : { severity }),
    limit: 100,
  };

  const { data, isLoading, isError, error } = useAdminLogs(params);

  function resolveEventCode(details: Record<string, unknown> | null, fallback: string | null) {
    return typeof details?.code === "string" ? details.code : fallback;
  }

  if (isLoading || !data) {
    return isLoading ? (
      <StatusPanel title="Loading logs" description="Fetching recent sync run events." />
    ) : isError ? (
      <StatusPanel title="Logs failed to load" description="The log stream could not be fetched." tone="error" />
    ) : (
      <StatusPanel title="Logs unavailable" description="The log stream did not return data." tone="error" />
    );
  }

  const items = data;

  return (
    <div>
      {isError && <StaleDataNotice error={error} className="mb-4" />}
      <div className="mb-5">
        <h1 className="text-xl font-extrabold text-text-primary">Logs</h1>
        <p className="text-sm text-text-muted mt-1">Recent sync run events</p>
      </div>

      <div className="mb-4">
        <FilterButtons
          filters={SEVERITY_FILTERS}
          active={severity}
          onChange={setSeverity}
        />
      </div>

      <p className="mb-2 text-xs text-text-muted">Up to 100 recent matching records. This is a bounded view, not the full history.</p>
      <section className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-hover-alt">
              {["Time", "Page", "Stream", "Severity", "Type", "Message"].map((col) => (
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
                  No log entries found.
                </td>
              </tr>
            )}
            {items.map((log, idx) => {
              const rowId = log.id != null ? String(log.id) : `${idx}`;
              const isExpanded = expandedId === rowId;
              const eventCode = resolveEventCode(log.details, log.eventType);
              const displaySeverity = getEventDisplaySeverity({
                eventCode,
                severity: log.severity,
                details: log.details,
              });

              return (
                <Fragment key={rowId}>
                  <tr
                    className="cursor-pointer border-t border-border transition-colors hover:bg-hover"
                    onClick={() => setExpandedId(isExpanded ? null : rowId)}
                    tabIndex={0}
                    aria-expanded={isExpanded}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setExpandedId(isExpanded ? null : rowId);
                      }
                    }}
                  >
                    <td className="px-4 py-3 text-sm text-text-secondary whitespace-nowrap">
                      {log.emittedAt ? formatRelativeTime(log.emittedAt) : "\u2014"}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-primary font-medium">
                      {log.pageLabel ?? "\u2014"}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary">
                      {log.stream ?? "\u2014"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[displaySeverity] ?? SEVERITY_STYLES.info}`}
                      >
                        {displaySeverity}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary">
                      {log.eventType ?? "\u2014"}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary max-w-xs truncate">
                      {log.message ?? "\u2014"}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={6} className="p-0">
                        <EventDetailPanel
                          message={log.message}
                          syncRunId={log.syncRunId}
                          eventCode={eventCode}
                          severity={log.severity}
                          details={log.details}
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
