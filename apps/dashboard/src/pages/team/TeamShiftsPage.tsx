import { CHATTER_SHIFT_MIN_MESSAGES, CHATTER_SHIFT_MIN_WORKED_MINUTES, CHATTER_SHIFT_PAGE_MIN_MESSAGES, type TeamShift } from "@agency_hub_core/contracts";
import { useTeamShifts } from "@/api/team";
import { usePageFilter } from "@/components/layout/usePageFilter";
import { useScreenPeriod } from "@/components/layout/useScreenPeriod";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { PageHeader } from "@/components/ui/PageHeader";
import { formatDateTime } from "@/lib/format";
import { plural } from "@/pages/account/stats/statsView";

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
    + "конец — час без действий. Закрытое расширение и перезапуск браузера смену не прерывают.",
  `Сменой считается работа от ${formatMinutes(CHATTER_SHIFT_MIN_WORKED_MINUTES)} и ${CHATTER_SHIFT_MIN_MESSAGES} сообщений. Меньше — заход, в этом списке его нет. `
    + "Пара сообщений до начала смены или после её конца — тоже заход, а не часть смены.",
  "Первые 10 минут без действий — работа (читает чат, ждёт ответа фана); дальше — пауза до следующего действия. "
    + "«Отработано» — смена без пауз.",
  "«Сообщения» — сколько сообщений за смену Hub записал на сотрудника, всего и по страницам; сообщения с телефона и из "
    + "браузера без расширения сюда не попадают. Страницы, где сотрудник ничего не написал, а только заглядывал, не показаны. "
    + `Серым — страница, где меньше ${CHATTER_SHIFT_PAGE_MIN_MESSAGES} сообщений: её продажи в смену не идут.`,
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

/** The end of a shift: its time alone when it ends the day it began. */
function endOf(shift: TeamShift): string {
  const [start, end] = [new Date(shift.startedAt), new Date(shift.endedAt)];
  if (start.toDateString() !== end.toDateString()) return formatDateTime(shift.endedAt);
  return end.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", hour12: false });
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
  const { key: period } = useScreenPeriod();
  const { page: pageLabel } = usePageFilter();
  const range: RangeKey = period === "3d" ? "3d" : period === "7d" ? "7d" : "1d";
  // Read anew each render: the end moves with the minute, so a shift going on keeps up.
  const span = windowOf(range);
  const { data, isLoading, isFetching, refetch } = useTeamShifts({ ...span, ...(pageLabel === null ? {} : { pageLabel }) });

  const header = (
    <div className="mb-5">
      <PageHeader window={`${formatDateTime(span.from)} – ${formatDateTime(span.to)}`} />
      <p className="max-w-3xl text-sm text-text-secondary">
        Кто когда работал: смены по активности в расширении, без скриншотов и отчётов.
      </p>
      <details className="help mt-1">
        <summary>Как это считается</summary>
        <div className="help-body">
          {HOW_IT_WORKS.map((line) => <p key={line}>{line}</p>)}
        </div>
      </details>
    </div>
  );

  if (!data) {
    return (
      <div>
        {header}
        {isLoading
          ? <TableSkeleton rows={4} columns={5} />
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
              <th className={HEAD_CELL}>Сообщения</th>
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
                      : <span className="whitespace-nowrap">{endOf(shift)}</span>}
                  </td>
                  <td className={CELL_MAIN}>{formatMinutes(shift.workedMinutes)}</td>
                  <td className={CELL}>
                    {shift.pauses.length === 0
                      ? "—"
                      : <span className="whitespace-nowrap">{formatMinutes(paused)} · {shift.pauses.length} {plural(shift.pauses.length, ["пауза", "паузы", "пауз"])}</span>}
                  </td>
                  <td className={CELL}>
                    <div className="font-medium text-text-primary">{shift.authoredMessages}</div>
                    {shift.pages.filter((page) => page.messages > 0).map((page) => {
                      const counts = page.messages >= CHATTER_SHIFT_PAGE_MIN_MESSAGES;
                      return (
                        <div
                          key={page.pageLabel}
                          className={counts ? "whitespace-nowrap text-xs" : "whitespace-nowrap text-xs text-text-muted"}
                          title={counts ? undefined : `Меньше ${CHATTER_SHIFT_PAGE_MIN_MESSAGES} сообщений: продажи этой страницы в смену не идут`}
                        >
                          {page.pageLabel} · {page.messages}
                        </div>
                      );
                    })}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
