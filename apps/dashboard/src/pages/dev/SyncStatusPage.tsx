import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { useAdminSyncRunDetail } from "@/api/queries";
import { getEventDisplaySeverity, SeverityBadge } from "@/components/shared/EventDetailPanel";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import type { SyncRunDetailResponse } from "@agency_hub_core/contracts";

const RUN_STATES: Record<string, { label: string; badge: string }> = {
  running: { label: "Идёт", badge: "badge badge-info" },
  success: { label: "Успешно", badge: "badge badge-success" },
  completed: { label: "Завершён", badge: "badge badge-success" },
  partial: { label: "Частично", badge: "badge badge-warning" },
  failed: { label: "Ошибка", badge: "badge badge-danger" },
  skipped: { label: "Пропущен", badge: "badge" },
};

const ATTEMPT_STATES: Record<string, string> = {
  started: "начата",
  success: "успешно",
  succeeded: "успешно",
  retry: "повтор",
  failed: "ошибка",
};

function runState(state: string) {
  return RUN_STATES[state] ?? { label: state.replaceAll("_", " "), badge: "badge" };
}

function resolveEventCode(details: Record<string, unknown> | null, fallback: string | null) {
  return typeof details?.code === "string" ? details.code : fallback;
}

function BackToLog() {
  return (
    <Link to="/dev/log" className="btn btn-ghost btn-sm -ml-2.5 mb-3">
      &larr; Журнал
    </Link>
  );
}

/** System → a sync run, opened from a row of «Журнал»: its events and the
 *  HTTP attempts of each stream. */
export function SyncStatusPage() {
  const [searchParams] = useSearchParams();
  const runId = Number(searchParams.get("runId") ?? "0");
  const isValidRunId = Number.isInteger(runId) && runId > 0;
  const { data, isLoading, isError, error } = useAdminSyncRunDetail(isValidRunId ? runId : 0);

  const attemptsByStream = useMemo<Map<string, SyncRunDetailResponse["attempts"]>>(() => {
    const grouped = new Map<string, SyncRunDetailResponse["attempts"]>();
    if (!data) {
      return grouped;
    }
    for (const attempt of data.attempts) {
      const existing = grouped.get(attempt.stream);
      if (existing) {
        existing.push(attempt);
      } else {
        grouped.set(attempt.stream, [attempt]);
      }
    }
    return grouped;
  }, [data]);

  if (!isValidRunId) {
    return (
      <div>
        <BackToLog />
        <StatusPanel
          title="Запуск не выбран"
          description="Откройте запуск из журнала: строка события → «Открыть запуск синка»."
          tone="error"
        />
      </div>
    );
  }

  if (isLoading && !data) {
    return (
      <div>
        <BackToLog />
        <StatusPanel title="Загружаем запуск" />
      </div>
    );
  }

  if (!data) {
    return (
      <div>
        <BackToLog />
        <StatusPanel title="Запуск не загрузился" description="Hub не вернул данные этого запуска." tone="error" />
      </div>
    );
  }

  const state = runState(data.run.status);

  return (
    <div>
      <BackToLog />
      <div className="mb-5">
        <h2 className="section-title">Запуск синка #{data.run.runId}</h2>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-text-secondary">
          <span className="font-medium text-text-primary">{data.run.pageLabel}</span>
          <PlatformBadge platform={data.run.platform} />
          <span className={state.badge} data-run-state={data.run.status}>{state.label}</span>
          <span>Начат {formatDateTime(data.run.startedAt)}</span>
          {data.run.finishedAt && <span>Завершён {formatDateTime(data.run.finishedAt)}</span>}
        </div>
      </div>

      <div className="space-y-5">
        {isError && <StaleDataNotice error={error} />}

        <section className="card" aria-labelledby="run-events-title">
          <div className="card-header">
            <h3 id="run-events-title" className="card-title">События</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  {["Когда", "Поток", "Важность", "Тип", "Сообщение"].map((label) => <th key={label}>{label}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.events.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-text-muted">У этого запуска нет событий.</td>
                  </tr>
                )}
                {data.events.map((event) => {
                  const eventCode = resolveEventCode(event.details, event.eventType);
                  const displaySeverity = getEventDisplaySeverity({
                    eventCode,
                    severity: event.severity,
                    details: event.details,
                  });
                  return (
                    <tr key={event.id}>
                      <td className="muted whitespace-nowrap">{formatRelativeTime(event.emittedAt)}</td>
                      <td>{event.stream}</td>
                      <td><SeverityBadge severity={displaySeverity} /></td>
                      <td className="muted font-mono text-xs">{event.eventType}</td>
                      <td className="muted">{event.message}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card" aria-labelledby="run-attempts-title">
          <div className="card-header">
            <div>
              <h3 id="run-attempts-title" className="card-title">Попытки запросов</h3>
              <p className="card-description">HTTP-запросы запуска по потокам.</p>
            </div>
          </div>
          {data.attempts.length === 0 ? (
            <p className="card-body text-sm text-text-muted">У этого запуска нет попыток запросов.</p>
          ) : (
            <div className="space-y-4 p-4 sm:p-5">
              {[...attemptsByStream.entries()].map(([stream, attempts]) => (
                <div key={stream} className="overflow-hidden rounded-lg border border-border">
                  <p className="border-b border-border bg-hover-alt px-4 py-2 text-sm font-semibold text-text-primary">{stream}</p>
                  <div className="overflow-x-auto">
                    <table className="data-table">
                      <thead>
                        <tr>
                          {["Попытка", "Состояние", "HTTP", "Начата", "Длительность", "Ошибка"].map((label) => (
                            <th key={label} className={label === "Длительность" ? "num" : undefined}>{label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {attempts.map((attempt) => (
                          <tr key={attempt.attemptId}>
                            <td>#{attempt.attemptNumber}</td>
                            <td className="muted">{ATTEMPT_STATES[attempt.state] ?? attempt.state}</td>
                            <td className="muted tabular-nums">{attempt.httpStatus ?? "—"}</td>
                            <td className="muted whitespace-nowrap">{formatDateTime(attempt.startedAt)}</td>
                            <td className="num">
                              {attempt.durationMs != null ? `${attempt.durationMs.toLocaleString("ru-RU")} мс` : "—"}
                            </td>
                            <td className="muted">{attempt.errorMessage ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
