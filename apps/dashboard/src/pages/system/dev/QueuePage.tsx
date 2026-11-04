import { Fragment, useState } from "react";
import { useSearchParams } from "react-router";
import { useAdminQueueJobs } from "@/api/queries";
import { staleDataText } from "@/components/shared/QueryNotice";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";

import { freshOf, MomentCell } from "../shared.js";

const STATE_FILTERS = [
  { value: "all", label: "Все" },
  { value: "created", label: "Созданы" },
  { value: "active", label: "Выполняются" },
  { value: "completed", label: "Завершены" },
  { value: "failed", label: "С ошибкой" },
] as const;
type StateFilter = typeof STATE_FILTERS[number]["value"];

const STATES: Record<string, { label: string; badge: string }> = {
  created: { label: "Создана", badge: "badge badge-bare badge-info" },
  retry: { label: "Повтор", badge: "badge badge-warning" },
  active: { label: "Выполняется", badge: "badge badge-bare badge-info" },
  completed: { label: "Завершена", badge: "badge badge-bare badge-success" },
  failed: { label: "Ошибка", badge: "badge badge-danger" },
  cancelled: { label: "Отменена", badge: "badge badge-off" },
  expired: { label: "Истекла", badge: "badge badge-warning" },
};

const COLUMNS = ["Задача", "Состояние", "Создана", "Запущена", "Завершена", "Повторов"];

function JobState({ state }: { state: string }) {
  const known = STATES[state];
  return <span className={known?.badge ?? "badge badge-off"} data-job-state={state}>{known?.label ?? state}</span>;
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <p className="sys-label">{title}</p>
      <pre className="sys-json">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

/** System → «Очередь задач»: the server's latest background jobs; a row
 *  opens its input and result right under it. */
export function QueuePage() {
  const [search, setSearch] = useSearchParams();
  const raw = search.get("state");
  const stateFilter: StateFilter = STATE_FILTERS.some((entry) => entry.value === raw) ? raw as StateFilter : "all";
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const params = {
    ...(stateFilter === "all" ? {} : { state: stateFilter }),
    limit: 100,
  };

  const query = useAdminQueueJobs(params);
  const { data, isLoading, isError } = query;

  const header = (
    <>
      <PageHeader fresh={freshOf(query)} />
      <div className="sys-seg-scroll"><Segmented
        label="Состояние задачи"
        value={stateFilter}
        options={STATE_FILTERS}
        onChange={(next) => {
          const query = new URLSearchParams(search);
          if (next === "all") query.delete("state");
          else query.set("state", next);
          setSearch(query);
        }}
      /></div>
    </>
  );

  if (isLoading || !data) {
    return (
      <div className="space-y-6 sys-screen">
        {header}
        <div className="card">{isLoading ? <TableSkeleton rows={8} columns={6} /> : <NoAnswerPanel retry={query.refetch} />}</div>
      </div>
    );
  }

  const jobs = data;

  return (
    <div className="space-y-6 sys-screen">
      {header}
      {isError && (
        <Notice tone="warning" role="alert" action={<button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>Повторить</button>}>
          {staleDataText(query.dataUpdatedAt)}
        </Notice>
      )}
      <section className="card" aria-label="Задачи">
        <div className="table-wrap">
        <table className="data-table data-table-dense sys-queue">
          <thead>
            <tr>
              {COLUMNS.map((col) => <th key={col} className={col === "Повторов" ? "num" : undefined}>{col}</th>)}
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="text-center text-text-secondary">
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
                    className="sys-click-row"
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
                    <td><span className="sys-code sys-code-strong">{job.name ?? "—"}</span></td>
                    <td className="status-col"><JobState state={job.state} /></td>
                    <td className="muted"><MomentCell at={job.createdOn} /></td>
                    <td className="muted"><MomentCell at={job.startedOn} /></td>
                    <td className="muted"><MomentCell at={job.completedOn} /></td>
                    <td className="num">{job.retryCount ?? 0}</td>
                  </tr>
                  {isExpanded && (
                    <tr data-job-detail={rowId} className="sys-detail-row">
                      <td colSpan={COLUMNS.length} className="sys-event-cell">
                        <div className="sys-event-detail">
                          {job.data != null && <JsonBlock title="Данные" value={job.data} />}
                          {job.output != null && <JsonBlock title="Результат" value={job.output} />}
                          {job.data == null && job.output == null && (
                            <p className="cell-second">У задачи нет ни данных, ни результата.</p>
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
        </div>
      </section>
    </div>
  );
}
