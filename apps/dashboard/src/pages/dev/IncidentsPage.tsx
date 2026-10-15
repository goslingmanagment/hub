import { Fragment, useState } from "react";
import { useAdminIncidents } from "@/api/queries";
import { EventDetailPanel, getEventDisplaySeverity, SeverityBadge } from "@/components/shared/EventDetailPanel";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { formatRelativeTime } from "@/lib/format";
import { DevHeader } from "./DevHeader.js";

const COLUMNS = ["Время", "Страница", "Поток", "Код", "Важность", "Сообщение"];

function resolveEventCode(details: Record<string, unknown> | null, fallback: string | null) {
  return typeof details?.code === "string" ? details.code : fallback;
}

/** System → «Аномалии синка»: unusual sync events grouped by their code (not
 *  the owner's «Инциденты» under «Требует внимания»). A code's tile filters
 *  the table; a row opens its detail. */
export function IncidentsPage() {
  const [codeFilter, setCodeFilter] = useState<string | undefined>(undefined);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const params = {
    ...(codeFilter === undefined ? {} : { code: codeFilter }),
    limit: 100,
  };

  const { data, isLoading, isError, error } = useAdminIncidents(params);

  const header = (
    <DevHeader
      title="Аномалии синка"
      description="Необычные события сбора данных по кодам: последние 100 записей, не вся история."
    />
  );

  if (isLoading || !data) {
    return (
      <div>
        {header}
        {isLoading ? (
          <StatusPanel title="Загружаем аномалии" />
        ) : isError ? (
          <StatusPanel title="Аномалии не загрузились" description="Hub не ответил. Попробуйте обновить страницу." tone="error" />
        ) : (
          <StatusPanel title="Аномалии недоступны" description="Hub не вернул записей." tone="error" />
        )}
      </div>
    );
  }

  const summary = data.summary ?? [];
  const items = data.items ?? [];
  const displaySummary = summary.reduce<Array<{ code: string | null; severity: string; count: number }>>((acc, item) => {
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
      {header}
      {isError && <StaleDataNotice error={error} className="mb-4" />}

      {displaySummary.length > 0 && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" role="group" aria-label="Коды аномалий">
          {displaySummary.map((s) => {
            const isActive = s.code !== null && codeFilter === s.code;
            const card = (
              <>
                <p
                  className={`truncate text-sm font-medium ${s.code === null ? "text-text-secondary" : "font-mono text-text-primary"}`}
                  title={s.code ?? undefined}
                >
                  {s.code ?? "Без кода"}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <span className="text-xl font-semibold tabular-nums text-text-primary">{s.count}</span>
                  {s.severity && <SeverityBadge severity={s.severity} />}
                </div>
              </>
            );
            // The tile of events with no code has nothing to filter by.
            return s.code === null ? (
              <div key={`null:${s.severity}`} className="stat">{card}</div>
            ) : (
              <button
                key={`${s.code}:${s.severity}`}
                type="button"
                aria-pressed={isActive}
                onClick={() => setCodeFilter(isActive ? undefined : s.code ?? undefined)}
                className={`stat text-left transition-colors hover:bg-hover ${isActive ? "border-accent bg-accent-soft" : ""}`}
              >
                {card}
              </button>
            );
          })}
        </div>
      )}

      {codeFilter && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-text-secondary">
            Показан код: <span className="font-mono font-medium text-text-primary">{codeFilter}</span>
          </span>
          <button type="button" onClick={() => setCodeFilter(undefined)} className="btn btn-ghost btn-sm">
            Показать все
          </button>
        </div>
      )}

      <section className="card overflow-x-auto" aria-label="Аномалии">
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
                  Аномалий нет.
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
                      {item.emittedAt ? formatRelativeTime(item.emittedAt) : "—"}
                    </td>
                    <td className="font-medium">{item.pageLabel ?? "—"}</td>
                    <td className="muted">{item.stream ?? "—"}</td>
                    <td className="font-mono text-xs">{eventCode ?? "—"}</td>
                    <td><SeverityBadge severity={displaySeverity} /></td>
                    <td className="muted">
                      <span className="block max-w-[18rem] truncate" title={item.message ?? undefined}>{item.message ?? "—"}</span>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={COLUMNS.length} className="p-0">
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
