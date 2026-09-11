import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { useAdminSyncRunDetail } from "@/api/queries";
import { getEventDisplaySeverity } from "@/components/shared/EventDetailPanel";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { buildSettingsRoute } from "@/lib/navigation";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import type { SyncRunDetailResponse } from "@agency_hub_core/contracts";

function formatRunState(state: string) {
  return state
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function resolveEventCode(details: Record<string, unknown> | null, fallback: string | null) {
  return typeof details?.code === "string" ? details.code : fallback;
}

export function SyncStatusPage() {
  const [searchParams] = useSearchParams();
  const runId = Number(searchParams.get("runId") ?? "0");
  const isValidRunId = Number.isSafeInteger(runId) && runId > 0;
  const { data, isLoading, isError, isFetching, refetch } = useAdminSyncRunDetail(isValidRunId ? runId : 0);

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

  const header = <header className="flex flex-wrap items-start justify-between gap-3">
    <div>
      <h1 className="text-xl font-extrabold text-text-primary">Запуск синхронизации{isValidRunId ? ` #${runId}` : ""}</h1>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-sm text-accent">
        <Link className="hover:underline" to={buildSettingsRoute("sync", data?.run.pageLabel)}>Синхронизация{data?.run.pageLabel ? ` · ${data.run.pageLabel}` : ""} →</Link>
        <Link className="hover:underline" to="/dev/log">Журнал событий →</Link>
      </div>
    </div>
    {isValidRunId && <button type="button" disabled={isFetching} onClick={() => void refetch()} className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary hover:bg-hover disabled:opacity-50">{isFetching ? "Обновляем…" : "Обновить"}</button>}
  </header>;

  if (!isValidRunId) {
    return (
      <div className="space-y-5 p-4 md:p-0">{header}
      <StatusPanel
        title="Запуск не выбран"
        description="Откройте конкретный запуск из журнала событий или раздела синхронизации."
        tone="error"
      />
      </div>
    );
  }

  if (isLoading && !data) {
    return (
      <div className="space-y-5 p-4 md:p-0">{header}
      <StatusPanel
        title="Загружаем запуск"
        description="Получаем сведения, события и историю запросов."
      />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-5 p-4 md:p-0">{header}
      <StatusPanel
        title="Не удалось загрузить запуск"
        description="Повторите запрос или вернитесь к списку запусков."
        tone="error"
        action={<button type="button" className="text-accent underline" onClick={() => void refetch()}>Повторить</button>}
      />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-0">
      {header}
      <QueryNotice error={isError} stale retry={refetch} />
      <div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-text-muted">
          <span>{data.run.pageLabel}</span>
          <span>{data.run.platform}</span>
          <span>{formatRunState(data.run.status)}</span>
          <span>Начат {formatDateTime(data.run.startedAt)}</span>
          {data.run.finishedAt && <span>Завершён {formatDateTime(data.run.finishedAt)}</span>}
        </div>
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text-primary">События · {data.events.length}</h2>
        </div>
        {data.events.length === 0 ? (
          <div className="px-4 py-6">
            <StatusPanel
              title="Нет сохранённых событий"
              description="В ответе нет событий этого запуска."
            />
          </div>
        ) : (
          <div role="region" aria-label="События запуска" tabIndex={0} className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-accent">
          <table className="w-full min-w-[720px] border-collapse">
            <thead>
              <tr className="bg-hover-alt">
                {["Когда", "Поток", "Уровень", "Тип", "Сообщение"].map((label) => (
                  <th
                    key={label}
                    className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted"
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.events.map((event) => (
                (() => {
                  const eventCode = resolveEventCode(event.details, event.eventType);
                  const displaySeverity = getEventDisplaySeverity({
                    eventCode,
                    severity: event.severity,
                    details: event.details,
                  });

                  return (
                    <tr key={event.id} className="border-t border-border">
                      <td className="px-4 py-3 text-sm text-text-muted">{formatRelativeTime(event.emittedAt)}</td>
                      <td className="px-4 py-3 text-sm text-text-primary">{event.stream}</td>
                      <td className="px-4 py-3 text-sm text-text-secondary">{displaySeverity}</td>
                      <td className="px-4 py-3 text-sm text-text-secondary">{event.eventType}</td>
                      <td className="px-4 py-3 text-sm text-text-secondary">{event.message}</td>
                    </tr>
                  );
                })()
              ))}
            </tbody>
          </table></div>
        )}
      </section>

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text-primary">Попытки запросов · {data.attempts.length}</h2>
        </div>
        {data.attempts.length === 0 ? (
          <div className="px-4 py-6">
            <StatusPanel
              title="Нет сведений о попытках"
              description="В ответе нет подробностей о запросах этого запуска."
            />
          </div>
        ) : (
          <div className="space-y-4 px-4 py-4">
            {[...attemptsByStream.entries()].map(([stream, attempts]) => (
              <div key={stream} className="rounded-xl border border-border">
                <div className="break-words border-b border-border bg-hover-alt px-4 py-2 text-sm font-semibold text-text-primary">
                  {stream}
                </div>
                <div role="region" aria-label={`Попытки потока ${stream}`} tabIndex={0} className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-accent">
                <table className="w-full min-w-[680px] border-collapse">
                  <thead>
                    <tr className="bg-hover-alt/50">
                      {["Попытка", "Состояние", "HTTP", "Начало", "Длительность", "Ошибка"].map((label) => (
                        <th
                          key={label}
                          className="px-4 py-2 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted"
                        >
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {attempts.map((attempt) => (
                      <tr key={attempt.attemptId} className="border-t border-border">
                        <td className="px-4 py-2 text-sm text-text-primary">#{attempt.attemptNumber}</td>
                        <td className="px-4 py-2 text-sm text-text-secondary">{attempt.state}</td>
                        <td className="px-4 py-2 text-sm text-text-secondary">{attempt.httpStatus ?? "—"}</td>
                        <td className="px-4 py-2 text-sm text-text-muted">{formatDateTime(attempt.startedAt)}</td>
                        <td className="px-4 py-2 text-sm text-text-muted">{attempt.durationMs != null ? `${attempt.durationMs} мс` : "—"}</td>
                        <td className="px-4 py-2 text-sm text-text-secondary">{attempt.errorMessage ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
