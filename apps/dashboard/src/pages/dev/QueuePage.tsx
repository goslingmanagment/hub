import { Fragment, useState } from "react";
import { useAdminQueueJobs } from "@/api/queries";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { formatRelativeTime } from "@/lib/format";
import { DevHeader } from "./DevHeader.js";

const STATE_FILTERS = [
  { key: "all", label: "Все" },
  { key: "created", label: "Созданы" },
  { key: "active", label: "Выполняются" },
  { key: "completed", label: "Завершены" },
  { key: "failed", label: "С ошибкой" },
];

const STATES: Record<string, { label: string; badge: string }> = {
  created: { label: "Создана", badge: "badge" },
  retry: { label: "Повтор", badge: "badge badge-warning" },
  active: { label: "Выполняется", badge: "badge badge-info" },
  completed: { label: "Завершена", badge: "badge badge-success" },
  failed: { label: "Ошибка", badge: "badge badge-danger" },
  cancelled: { label: "Отменена", badge: "badge" },
  expired: { label: "Истекла", badge: "badge badge-warning" },
};

const COLUMNS = ["Задача", "Состояние", "Создана", "Запущена", "Завершена", "Повторов"];

function JobState({ state }: { state: string }) {
  const known = STATES[state];
  return <span className={known?.badge ?? "badge"} data-job-state={state}>{known?.label ?? state}</span>;
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-text-secondary">{title}</p>
      <pre className="overflow-x-auto rounded-lg border border-border-light bg-card p-3 font-mono text-xs text-text-secondary">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

/** System → «Очередь задач»: the server's latest background jobs; a row
 *  opens its input and result right under it. */
export function QueuePage() {
  const [stateFilter, setStateFilter] = useState("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const params = {
    ...(stateFilter === "all" ? {} : { state: stateFilter }),
    limit: 100,
  };

  const { data, isLoading, isError, error } = useAdminQueueJobs(params);

  const header = (
    <>
      <DevHeader title="Очередь задач" description="Фоновые задачи сервера: последние 100 записей, не вся история." />
      <div className="mb-4">
        <FilterButtons filters={STATE_FILTERS} active={stateFilter} onChange={setStateFilter} />
      </div>
    </>
  );

  if (isLoading || !data) {
    return (
      <div>
        {header}
        {isLoading ? (
          <StatusPanel title="Загружаем очередь" />
        ) : isError ? (
          <StatusPanel title="Очередь не загрузилась" description="Hub не ответил. Попробуйте обновить страницу." tone="error" />
        ) : (
          <StatusPanel title="Очередь недоступна" description="Hub не вернул задач." tone="error" />
        )}
      </div>
    );
  }

  const jobs = data;

  return (
    <div>
      {header}
      {isError && <StaleDataNotice error={error} className="mb-4" />}
      <section className="card overflow-x-auto" aria-label="Задачи">
        <table className="data-table">
          <thead>
            <tr>
              {COLUMNS.map((col) => <th key={col} className={col === "Повторов" ? "num" : undefined}>{col}</th>)}
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="py-8 text-center text-text-muted">
                  Задач нет.
                </td>
              </tr>
            )}
            {jobs.map((job, idx) => {
              const rowId = job.id != null ? String(job.id) : `${idx}`;
              const isExpanded = expandedId === rowId;
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
                    <td className="font-mono text-xs font-medium">{job.name ?? "—"}</td>
                    <td><JobState state={job.state} /></td>
                    <td className="muted whitespace-nowrap">{job.createdOn ? formatRelativeTime(job.createdOn) : "—"}</td>
                    <td className="muted whitespace-nowrap">{job.startedOn ? formatRelativeTime(job.startedOn) : "—"}</td>
                    <td className="muted whitespace-nowrap">{job.completedOn ? formatRelativeTime(job.completedOn) : "—"}</td>
                    <td className="num">{job.retryCount ?? 0}</td>
                  </tr>
                  {isExpanded && (
                    <tr data-job-detail={rowId}>
                      <td colSpan={COLUMNS.length} className="bg-hover-alt">
                        <div className="sticky left-0 max-w-[calc(100vw-66px)] space-y-3 lg:max-w-none">
                          {job.data != null && <JsonBlock title="Данные" value={job.data} />}
                          {job.output != null && <JsonBlock title="Результат" value={job.output} />}
                          {job.data == null && job.output == null && (
                            <p className="text-sm text-text-muted">У задачи нет ни данных, ни результата.</p>
                          )}
                        </div>
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
