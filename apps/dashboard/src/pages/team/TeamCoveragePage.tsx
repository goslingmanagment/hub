import { useSearchParams } from "react-router";
import type { TeamEmptyHoursResponse } from "@agency_hub_core/contracts";
import { useTeamEmptyHours } from "@/api/team";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { formatDateTime, formatMills } from "@/lib/format";

/**
 * Chat Memory week 6 (week-6.md §В–Г), «Команда → Покрытие»: who the team
 * leaves waiting. Read-only; the owner and team leads. A guide, not a basis
 * for pay.
 */

const RANGES = [
  { key: "7", label: "7 дней" },
  { key: "30", label: "30 дней" },
] as const;

const HOW_EMPTY_HOURS_WORK = [
  "Час пустой, если фаны в нём писали, а расширение ChatGoose ни у кого из команды не было открыто на этой странице ни "
    + "одной минуты. Считается с первой смены страницы в расширении: раньше Hub не отличит пустой час от работы с "
    + "телефона или из старой версии.",
  "«Ждали больше часа» — после сообщения в пустой час личный ответ пришёл позже чем через час или его ещё нет (рассылка "
    + "Fansly ответом не считается). Траты — net фана на этой странице за последние 30 дней: это кто ждал, а не "
    + "потерянные деньги.",
];

const HEAD = "whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-text-muted xl:px-4";
const NUM_HEAD = "whitespace-nowrap px-3 py-2 text-right text-xs font-medium text-text-muted xl:px-4";
const CELL = "px-3 py-2 align-top text-text-secondary xl:px-4";
const NUM = "whitespace-nowrap px-3 py-2 align-top text-right tabular-nums text-text-secondary xl:px-4";

type EmptyHoursPage = TeamEmptyHoursResponse["pages"][number];

function hourCellClass(count: number, max: number): string {
  if (count === 0) return "text-text-muted";
  return count * 2 > max ? "bg-accent/35 font-medium text-text-primary" : "bg-accent/15 text-text-primary";
}

/** Empty hours by Moscow hour of day: one cell per hour, 00–23. */
function HourStrip({ byHour }: { byHour: readonly number[] }) {
  const max = Math.max(...byHour);
  return (
    <div className="grid grid-cols-12 gap-px overflow-hidden rounded border border-border bg-border text-center text-[11px] tabular-nums sm:grid-cols-24">
      {byHour.map((count, hour) => (
        <div
          key={hour}
          title={`${String(hour).padStart(2, "0")}:00 МСК — пустых часов: ${count}`}
          className={`bg-card px-0.5 py-1 ${hourCellClass(count, max)}`}
        >
          <div className="text-[10px] text-text-muted">{String(hour).padStart(2, "0")}</div>
          {count === 0 ? "·" : count}
        </div>
      ))}
    </div>
  );
}

function EmptyHoursTable({ pages }: { pages: readonly EmptyHoursPage[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b border-border">
          <tr>
            <th className={HEAD}>Страница</th>
            <th className={NUM_HEAD}>Часов с фанами</th>
            <th className={NUM_HEAD}>Пустых</th>
            <th className={NUM_HEAD}>Фанов писали · платящих</th>
            <th className={NUM_HEAD}>Ждали больше часа · их траты за 30 дн.</th>
          </tr>
        </thead>
        <tbody>
          {pages.map((page) => (
            <tr key={page.pageLabel} className="border-b border-border last:border-b-0">
              <td className={CELL}>
                <div className="font-medium text-text-primary">{page.pageLabel}</div>
                <div className="text-xs text-text-muted">
                  {page.shiftsSince === null ? "смен в расширении ещё не было" : `смены в расширении с ${formatDateTime(page.shiftsSince)}`}
                </div>
                {page.shiftsSince !== null && page.emptyHours > 0 && (
                  <div className="mt-2 min-w-[18rem]"><HourStrip byHour={page.emptyByHour} /></div>
                )}
              </td>
              {page.shiftsSince === null
                ? <td className={`${CELL} text-text-muted`} colSpan={4}>—</td>
                : (
                  <>
                    <td className={NUM}>{page.hoursWithFans}</td>
                    <td className={`${NUM} font-medium text-text-primary`}>
                      {page.emptyHours}
                      {page.hoursWithFans > 0 && <span className="font-normal text-text-muted"> · {Math.round((100 * page.emptyHours) / page.hoursWithFans)} %</span>}
                    </td>
                    <td className={NUM}>{page.fans} <span className="text-text-muted">· {page.payers}</span></td>
                    <td className={NUM}>
                      {page.waitedOverHour}
                      {page.waitedOverHour > 0 && <span className="text-text-muted"> · {formatMills(page.waitedNetMills)}</span>}
                    </td>
                  </>
                )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyHoursSection({ days }: { days: number }) {
  const { data, isLoading, isFetching, refetch } = useTeamEmptyHours(days);
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Пустые часы</h2>
        <details className="help mt-1">
          <summary>Как это считается</summary>
          <div className="help-body">
            {HOW_EMPTY_HOURS_WORK.map((line) => <p key={line}>{line}</p>)}
          </div>
        </details>
      </div>
      {!data
        ? (isLoading
          ? <TableSkeleton rows={4} columns={5} />
          : (
            <StatusPanel
              title="Пустые часы не загрузились"
              description="Hub не ответил. Попробуйте ещё раз."
              tone="error"
              action={<button type="button" onClick={() => void refetch()} disabled={isFetching} className="btn btn-sm">Повторить</button>}
            />
          ))
        : data.pages.length === 0
          ? <StatusPanel title="Фаны не писали" description="За это время ни на одну страницу не пришло сообщений." />
          : <EmptyHoursTable pages={data.pages} />}
    </section>
  );
}

export function TeamCoveragePage() {
  const [search, setSearch] = useSearchParams();
  const range = RANGES.some((item) => item.key === search.get("days")) ? search.get("days")! : "7";
  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="max-w-3xl text-sm text-text-secondary">
          Кого команда оставляет ждать: часы без чаттера, когда фаны писали. Это ориентир, а не основание для оплаты.
        </p>
        <div className="mt-4">
          <FilterButtons
            filters={RANGES.map(({ key, label }) => ({ key, label }))}
            active={range}
            onChange={(key) => setSearch((current) => {
              const next = new URLSearchParams(current);
              next.set("days", key);
              return next;
            })}
          />
        </div>
      </div>
      <EmptyHoursSection days={Number(range)} />
    </div>
  );
}
