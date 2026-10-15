import { Fragment, useState } from "react";
import { useAdminLogs } from "@/api/queries";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { EventDetailPanel, getEventDisplaySeverity, SeverityBadge } from "@/components/shared/EventDetailPanel";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { formatRelativeTime } from "@/lib/format";
import { DevHeader } from "./DevHeader.js";

const SEVERITY_FILTERS = [
  { key: "all", label: "Все" },
  { key: "info", label: "Инфо" },
  { key: "warn", label: "Предупреждения" },
  { key: "error", label: "Ошибки" },
];

const COLUMNS = ["Время", "Страница", "Поток", "Важность", "Тип", "Сообщение"];

function resolveEventCode(details: Record<string, unknown> | null, fallback: string | null) {
  return typeof details?.code === "string" ? details.code : fallback;
}

/** System → «Журнал»: the latest events of sync runs; a row opens its detail
 *  and the run it belongs to. */
export function LogPage() {
  const [severity, setSeverity] = useState("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const params = {
    ...(severity === "all" ? {} : { severity }),
    limit: 100,
  };

  const { data, isLoading, isError, error } = useAdminLogs(params);

  const header = (
    <>
      <DevHeader title="Журнал" description="События запусков сбора данных: последние 100 записей, не вся история." />
      <div className="mb-4">
        <FilterButtons filters={SEVERITY_FILTERS} active={severity} onChange={setSeverity} />
      </div>
    </>
  );

  if (isLoading || !data) {
    return (
      <div>
        {header}
        {isLoading ? (
          <StatusPanel title="Загружаем журнал" />
        ) : isError ? (
          <StatusPanel title="Журнал не загрузился" description="Hub не ответил. Попробуйте обновить страницу." tone="error" />
        ) : (
          <StatusPanel title="Журнал недоступен" description="Hub не вернул записей." tone="error" />
        )}
      </div>
    );
  }

  const items = data;

  return (
    <div>
      {header}
      {isError && <StaleDataNotice error={error} className="mb-4" />}
      <section className="card overflow-x-auto" aria-label="События">
        <table className="data-table">
          <thead>
            <tr>
              {COLUMNS.map((col) => <th key={col}>{col}</th>)}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="py-8 text-center text-text-muted">
                  Записей нет.
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
              const toggle = () => setExpandedId(isExpanded ? null : rowId);

              return (
                <Fragment key={rowId}>
                  <tr
                    className="cursor-pointer"
                    onClick={toggle}
                    tabIndex={0}
                    aria-expanded={isExpanded}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        toggle();
                      }
                    }}
                  >
                    <td className="muted whitespace-nowrap">
                      {log.emittedAt ? formatRelativeTime(log.emittedAt) : "—"}
                    </td>
                    <td className="font-medium">{log.pageLabel ?? "—"}</td>
                    <td className="muted">{log.stream ?? "—"}</td>
                    <td><SeverityBadge severity={displaySeverity} /></td>
                    <td className="muted font-mono text-xs">{log.eventType ?? "—"}</td>
                    <td className="muted">
                      <span className="block max-w-[18rem] truncate" title={log.message ?? undefined}>{log.message ?? "—"}</span>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={COLUMNS.length} className="p-0">
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
