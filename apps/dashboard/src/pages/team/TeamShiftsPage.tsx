import { useId } from "react";
import { useSearchParams } from "react-router";
import type { TeamShift } from "@agency_hub_core/contracts";
import { useTeamShifts } from "@/api/team";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { formatDateTime } from "@/lib/format";

/**
 * Chat Memory week 1: the team's actual shifts, from the chat extension's
 * activity (`teamShifts`). Read-only; the owner and team leads.
 */

const RANGES = [
  { key: "1d", label: "Сутки", days: 1 },
  { key: "3d", label: "3 дня", days: 3 },
  { key: "7d", label: "7 дней", days: 7 },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

const HOW_IT_WORKS = [
  "Смена считается по расширению ChatGoose: начало — первое действие сотрудника на странице (клавиша, клик, прокрутка), "
    + "конец — расширение закрыто или час без действий.",
  "Первые 10 минут без действий — работа (читает чат, ждёт ответа фана); дальше — пауза до следующего действия. "
    + "«Отработано» — смена без пауз.",
  "«С автором» — сколько сообщений за смену Hub записал на этого сотрудника. Сообщения с телефона и из браузера без "
    + "расширения сюда не попадают.",
];

const HEAD_CELL = "whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-text-muted xl:px-4";
const CELL = "px-3 py-2 align-top text-text-secondary xl:px-4";
const CELL_MAIN = "px-3 py-2 align-top font-medium text-text-primary xl:px-4";

/** "5 ч 12 мин", "40 мин". */
export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} мин`;
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

function pauseMinutes(shift: TeamShift): number {
  return shift.pauses.reduce((sum, pause) => sum + Math.round((Date.parse(pause.to) - Date.parse(pause.from)) / 60_000), 0);
}

/** The window of a range, its end on the minute: one query key per minute, not per render. */
function windowOf(range: RangeKey, now = Date.now()): { from: string; to: string } {
  const days = RANGES.find((item) => item.key === range)?.days ?? 1;
  const to = Math.floor(now / 60_000) * 60_000;
  return { from: new Date(to - days * 24 * 60 * 60_000).toISOString(), to: new Date(to).toISOString() };
}

export function TeamShiftsPage() {
  const [search, setSearch] = useSearchParams();
  const { pages } = useDashboardShell();
  const pageFilterId = useId();
  const range: RangeKey = RANGES.some((item) => item.key === search.get("range")) ? search.get("range") as RangeKey : "1d";
  const pageLabel = pages.some((page) => page.label === search.get("page")) ? search.get("page")! : null;
  // Read anew each render: the end moves with the minute, so a shift going on keeps up.
  const span = windowOf(range);
  const { data, isLoading, isFetching, refetch } = useTeamShifts({ ...span, ...(pageLabel === null ? {} : { pageLabel }) });

  function show(change: { range?: RangeKey; page?: string | null }) {
    const next = new URLSearchParams(search);
    if (change.range !== undefined) next.set("range", change.range);
    if (change.page !== undefined) {
      if (change.page === null) next.delete("page");
      else next.set("page", change.page);
    }
    setSearch(next);
  }

  const header = (
    <div className="mb-5">
      <p className="max-w-3xl text-sm text-text-secondary">
        Кто когда работал: смены по активности в расширении, без скриншотов и отчётов.
      </p>
      <details className="help mt-1">
        <summary>Как это считается</summary>
        <div className="help-body">
          {HOW_IT_WORKS.map((line) => <p key={line}>{line}</p>)}
        </div>
      </details>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <FilterButtons filters={RANGES.map(({ key, label }) => ({ key, label }))} active={range} onChange={(key) => show({ range: key as RangeKey })} />
        <label htmlFor={pageFilterId} className="flex items-center gap-2 text-sm text-text-secondary">
          Страница
          <select
            id={pageFilterId}
            value={pageLabel ?? ""}
            onChange={(event) => show({ page: event.target.value === "" ? null : event.target.value })}
            className="select w-auto min-h-[34px] py-1.5"
          >
            <option value="">Все страницы</option>
            {pages.map((page) => <option key={page.label} value={page.label}>{page.label}</option>)}
          </select>
        </label>
      </div>
    </div>
  );

  if (!data) {
    return (
      <div>
        {header}
        {isLoading
          ? <TableSkeleton rows={4} columns={6} />
          : (
            <StatusPanel
              title="Смены не загрузились"
              description="Hub не ответил. Попробуйте ещё раз."
              tone="error"
              action={<button type="button" onClick={() => void refetch()} disabled={isFetching} className="btn btn-sm">Повторить</button>}
            />
          )}
      </div>
    );
  }

  if (data.shifts.length === 0) {
    return (
      <div>
        {header}
        <StatusPanel
          title="Смен нет"
          description="За это время никто не работал в расширении ChatGoose на этих страницах — или у сотрудников ещё старая версия расширения."
        />
      </div>
    );
  }

  return (
    <div>
      {header}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b border-border">
            <tr>
              <th className={HEAD_CELL}>Сотрудник</th>
              <th className={HEAD_CELL}>Смена</th>
              <th className={HEAD_CELL}>Отработано</th>
              <th className={HEAD_CELL}>Паузы</th>
              <th className={HEAD_CELL}>Страницы</th>
              <th className={HEAD_CELL}>С автором</th>
            </tr>
          </thead>
          <tbody>
            {data.shifts.map((shift) => {
              const paused = pauseMinutes(shift);
              return (
                <tr key={`${shift.userId}:${shift.startedAt}`} className="border-b border-border last:border-b-0">
                  <td className={CELL_MAIN}>{shift.username}</td>
                  <td className={CELL}>
                    <span className="whitespace-nowrap">{formatDateTime(shift.startedAt)}</span>
                    {" – "}
                    {shift.ongoing
                      ? <span className="whitespace-nowrap font-medium text-accent">идёт</span>
                      : <span className="whitespace-nowrap">{formatDateTime(shift.endedAt)}</span>}
                  </td>
                  <td className={CELL_MAIN}>{formatMinutes(shift.workedMinutes)}</td>
                  <td className={CELL}>
                    {shift.pauses.length === 0 ? "—" : `${shift.pauses.length} · ${formatMinutes(paused)}`}
                  </td>
                  <td className={CELL}>
                    {shift.pages.map((page) => (
                      <div key={page.pageLabel} className="whitespace-nowrap">
                        {page.pageLabel} <span className="text-text-muted">· {formatMinutes(page.activeMinutes)}</span>
                      </div>
                    ))}
                  </td>
                  <td className={CELL}>{shift.authoredMessages}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
