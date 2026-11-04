import { useMemo } from "react";
import { Link, useParams } from "react-router";
import type { SyncRunDetailResponse } from "@agency_hub_core/contracts";
import { useAdminSyncRunDetail } from "@/api/queries";
import { staleDataText } from "@/components/shared/QueryNotice";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { formatDateTime, formatMomentAgo } from "@/lib/format";
import { buildPageRoute } from "@/lib/navigation";
import { syncStreamLabel } from "@/pages/settings/sync/syncVocabulary";
import { freshOf, platformName, useOfapi } from "../shared.js";
import { getEventDisplaySeverity, SeverityBadge } from "./EventDetailPanel.js";

const RUN_STATES: Record<string, { label: string; badge: string }> = {
  running: { label: "Идёт", badge: "badge badge-bare badge-info" },
  success: { label: "Успешно", badge: "badge badge-bare badge-success" },
  completed: { label: "Завершён", badge: "badge badge-bare badge-success" },
  partial: { label: "Частично", badge: "badge badge-warning" },
  failed: { label: "Ошибка", badge: "badge badge-danger" },
  skipped: { label: "Пропущен", badge: "badge badge-off" },
};

const ATTEMPT_STATES: Record<string, string> = {
  started: "начата",
  success: "успешно",
  succeeded: "успешно",
  retry: "повтор",
  failed: "ошибка",
};

function resolveEventCode(details: Record<string, unknown> | null, fallback: string | null) {
  return typeof details?.code === "string" ? details.code : fallback;
}

const TO_LOG = <Link to="/system/dev/log" className="btn btn-sm">К журналу</Link>;

/** «Запуск сбора №N»: one run of the old collection, its events and its requests by stream (§15). */
export function SyncStatusPage() {
  const { runId: rawRunId } = useParams<{ runId: string }>();
  const runId = Number(rawRunId ?? "0");
  const isValidRunId = Number.isInteger(runId) && runId > 0;
  const query = useAdminSyncRunDetail(isValidRunId ? runId : 0);
  const { data, isLoading } = query;
  const ofapi = useOfapi();
  const off = ofapi.status === "off" && data?.run.platform === "onlyfans";

  const attemptsByStream = useMemo<Map<string, SyncRunDetailResponse["attempts"]>>(() => {
    const grouped = new Map<string, SyncRunDetailResponse["attempts"]>();
    for (const attempt of data?.attempts ?? []) {
      const existing = grouped.get(attempt.stream);
      if (existing) existing.push(attempt);
      else grouped.set(attempt.stream, [attempt]);
    }
    return grouped;
  }, [data]);

  if (!isValidRunId) {
    return (
      <div className="space-y-6 sys-screen">
        <PageHeader title="Запуск сбора" />
        <div className="card"><StatusPanel title="Такого запуска нет" action={TO_LOG} /></div>
      </div>
    );
  }
  if (isLoading && !data) {
    return (
      <div className="space-y-6 sys-screen">
        <PageHeader title={`Запуск сбора №${runId}`} />
        <div className="card"><TableSkeleton rows={5} columns={5} /></div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-6 sys-screen">
        <PageHeader title={`Запуск сбора №${runId}`} />
        <div className="card"><StatusPanel tone="error" title="Hub не ответил" description="Данные этого запуска не пришли. Это не значит, что запуска не было." action={TO_LOG} /></div>
      </div>
    );
  }

  const state = RUN_STATES[data.run.status] ?? { label: data.run.status.replaceAll("_", " "), badge: "badge badge-off" };
  const description = (
    <span className="sys-run-line">
      <Link to={buildPageRoute(data.run.pageLabel)} className="link">{data.run.pageLabel}</Link>
      <span>· {platformName(data.run.platform)} ·</span>
      <span className={off ? "badge badge-off" : state.badge} data-run-state={data.run.status}>{state.label}</span>
      <span>· Начат {formatDateTime(data.run.startedAt, { yearUnlessCurrent: true })}</span>
      {data.run.finishedAt && <span>· Завершён {formatDateTime(data.run.finishedAt, { yearUnlessCurrent: true })}</span>}
    </span>
  );

  return (
    <div className="space-y-6 sys-screen">
      <PageHeader title={`Запуск сбора №${data.run.runId}`} description={description} fresh={freshOf(query)} />
      {query.isError && (
        <Notice tone="warning" role="alert" action={<button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>Повторить</button>}>
          {staleDataText(query.dataUpdatedAt)}
        </Notice>
      )}

      <section className="card" aria-labelledby="run-events-title">
        <div className="card-header"><h2 id="run-events-title" className="card-title">События</h2></div>
        {data.events.length === 0 ? (
          <StatusPanel title="У этого запуска нет событий." />
        ) : (
          <div className="table-wrap">
            <table className="data-table data-table-dense">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Поток</th>
                  <th>Важность</th>
                  <th>Тип</th>
                  <th>Сообщение</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((event) => {
                  const eventCode = resolveEventCode(event.details, event.eventType);
                  const displaySeverity = getEventDisplaySeverity({ eventCode, severity: event.severity, details: event.details });
                  return (
                    <tr key={event.id}>
                      <td className="muted whitespace-nowrap">{formatMomentAgo(event.emittedAt)}</td>
                      <td className="whitespace-nowrap">{syncStreamLabel(event.stream)}</td>
                      <td className="status-col"><SeverityBadge severity={displaySeverity} off={off} /></td>
                      <td><span className="sys-code">{event.eventType}</span></td>
                      <td className="muted">{event.message}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="run-attempts-title">
        <div className="card-header"><h2 id="run-attempts-title" className="card-title">Запросы запуска</h2></div>
        {data.attempts.length === 0 ? (
          <StatusPanel title="У этого запуска нет попыток запросов." />
        ) : (
          <div className="card-body sys-stack">
            {[...attemptsByStream.entries()].map(([stream, attempts]) => (
              <div key={stream}>
                <h3 className="sys-subtitle">{syncStreamLabel(stream)}</h3>
                <div className="table-wrap mt-2">
                  <table className="data-table data-table-dense">
                    <thead>
                      <tr>
                        <th>Попытка</th>
                        <th>Состояние</th>
                        <th className="num">HTTP</th>
                        <th>Начата</th>
                        <th className="num">Длительность</th>
                        <th>Ошибка</th>
                      </tr>
                    </thead>
                    <tbody>
                      {attempts.map((attempt) => (
                        <tr key={attempt.attemptId}>
                          <td className="tabular-nums">№ {attempt.attemptNumber}</td>
                          <td className="muted">{ATTEMPT_STATES[attempt.state] ?? attempt.state}</td>
                          <td className="num muted">{attempt.httpStatus ?? "—"}</td>
                          <td className="muted whitespace-nowrap">{formatDateTime(attempt.startedAt, { yearUnlessCurrent: true })}</td>
                          <td className="num">{attempt.durationMs != null ? `${attempt.durationMs.toLocaleString("ru-RU")} мс` : "—"}</td>
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
  );
}
