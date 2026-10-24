import type { ChatterNumbers, TeamChatterNumbersResponse } from "@agency_hub_core/contracts";
import { useTeamChatterNumbers } from "@/api/team";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { formatDateTime, formatMills } from "@/lib/format";

/**
 * Chat Memory week 5 (week-5.md §1): the eight numbers of each chatter — a row
 * per shift and the week on top. Only messages with the chatter as their
 * author count; revenue only from confirmed shift reports. A guide, not a
 * basis for pay.
 */

const HEAD = "whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-text-muted xl:px-4";
const CELL = "whitespace-nowrap px-3 py-2 align-top tabular-nums text-text-secondary xl:px-4";

export function hoursOf(minutes: number): string {
  return `${Math.floor(minutes / 60)} ч ${String(minutes % 60).padStart(2, "0")} м`;
}

export function replyOf(numbers: Pick<ChatterNumbers, "replies" | "replyMedianSeconds" | "repliesWithinHour">): string {
  if (numbers.replies === 0 || numbers.replyMedianSeconds === null) return "—";
  const median = numbers.replyMedianSeconds < 60 ? `${numbers.replyMedianSeconds} с` : `${Math.round(numbers.replyMedianSeconds / 60)} мин`;
  return `${median} · ${Math.round((numbers.repliesWithinHour / numbers.replies) * 100)}% за час`;
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "—" : `${Math.round((part / whole) * 100)}%`;
}

function Cells({ numbers, confirmed }: { numbers: ChatterNumbers; confirmed: boolean }) {
  const { composed } = numbers;
  return (
    <>
      <td className={CELL}>{hoursOf(numbers.workedMinutes)}</td>
      <td className={CELL}>
        {numbers.revenueMills === null
          ? <span className="text-text-muted">{confirmed ? "—" : "не подтверждён"}</span>
          : <>{formatMills(numbers.revenueMills)}{numbers.revenuePerHourMills !== null && <span className="text-text-muted"> · {formatMills(numbers.revenuePerHourMills)}/ч</span>}</>}
      </td>
      <td className={CELL}>{numbers.fansWritten} <span className="text-text-muted">· заплатили {numbers.fansPaid}</span></td>
      <td className={CELL}>
        {numbers.ppvSent} / {numbers.ppvBought}
        {numbers.ppvAveragePriceMills !== null && <span className="text-text-muted"> · {formatMills(numbers.ppvAveragePriceMills)}</span>}
      </td>
      <td className={CELL}>{numbers.ppvShare === null ? "—" : `${Math.round(numbers.ppvShare * 100)}%`}</td>
      <td className={CELL}>{replyOf(numbers)}</td>
      <td className={CELL}>{numbers.waitingAtEnd}</td>
      <td className={CELL}>
        {numbers.messages === 0 ? "—" : `${percent(composed.hand, numbers.messages)} / ${percent(composed.reply, numbers.messages)} / ${percent(composed.fix, numbers.messages)}`}
      </td>
    </>
  );
}

function ChatterTable({ chatter }: { chatter: TeamChatterNumbersResponse["chatters"][number] }) {
  const { week } = chatter;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-base font-semibold text-text-primary">
        {chatter.username}
        <span className="ml-2 text-sm font-normal text-text-muted">
          смен: {week.shifts}{week.unconfirmedShifts > 0 ? ` · не подтверждено: ${week.unconfirmedShifts}` : ""}
        </span>
      </h2>
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b border-border">
            <tr>
              <th className={HEAD}>Смена</th>
              <th className={HEAD}>Часы</th>
              <th className={HEAD}>Выручка · в час</th>
              <th className={HEAD}>Фанов написано</th>
              <th className={HEAD}>PPV отпр. / купл. · ср. цена</th>
              <th className={HEAD}>Доля PPV</th>
              <th className={HEAD}>Ответ: медиана · за час</th>
              <th className={HEAD}>Ждут в конце</th>
              <th className={HEAD}>Руками / Reply / Fix</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border bg-accent/5 font-medium text-text-primary">
              <td className={`${CELL} text-text-primary`}>Неделя</td>
              <Cells numbers={week} confirmed={week.unconfirmedShifts === 0} />
            </tr>
            {chatter.shifts.map((shift) => (
              <tr key={shift.startedAt} className="border-b border-border last:border-b-0">
                <td className={CELL}>
                  {formatDateTime(shift.startedAt)}{shift.ongoing ? " · идёт" : ""}
                  <span className="block text-xs text-text-muted">{shift.pages.join(", ")}</span>
                </td>
                <Cells numbers={shift.numbers} confirmed={shift.confirmed} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function TeamNumbersPage() {
  const { data, isLoading, isFetching, refetch } = useTeamChatterNumbers();
  const header = (
    <p className="mb-5 max-w-3xl text-sm text-text-secondary">
      Восемь чисел каждого чаттера за последние 7 дней: по фактическим сменам из расширения и только по сообщениям, где он
      автор. Выручка — из подтверждённых отчётов смены. Это ориентир, а не основание для оплаты.
    </p>
  );
  if (!data) {
    return (
      <div>
        {header}
        {isLoading ? <TableSkeleton rows={4} columns={9} /> : (
          <StatusPanel
            title="Числа не загрузились"
            description="Hub не ответил. Попробуйте ещё раз."
            tone="error"
            action={<button type="button" onClick={() => void refetch()} disabled={isFetching} className="btn btn-sm">Повторить</button>}
          />
        )}
      </div>
    );
  }
  if (data.chatters.length === 0) {
    return <div>{header}<StatusPanel title="Смен нет" description="За неделю никто не работал в расширении под своим входом." /></div>;
  }
  return <div className="flex flex-col gap-6">{header}{data.chatters.map((chatter) => <ChatterTable key={chatter.userId} chatter={chatter} />)}</div>;
}
