import { Link } from "react-router";
import type { ChatterNumbers } from "@agency_hub_core/contracts";
import { useAuthMe } from "@/api/queries";
import { useTeamChatterNumbers } from "@/api/team";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { DisclosureCard } from "@/components/ui/DisclosureCard";
import { formatCount, formatDateTime, formatMills, formatPercent } from "@/lib/format";
import { PageLink } from "./teamLinks.js";

/**
 * «Подробно по сменам» on a chatter's screen: the numbers that take long to
 * count, shift by shift (`teamChatterNumbers` for this one person). Read only
 * at the first opening; `from` is the Moscow midnight the window starts at.
 */

function share(part: number, whole: number): string {
  return whole === 0 ? "—" : formatPercent((100 * part) / whole);
}

/** «3 мин, 90 %»: the median reply and the share within an hour. */
export function replyOf(numbers: Pick<ChatterNumbers, "replies" | "replyMedianSeconds" | "repliesWithinHour">): string {
  if (numbers.replies === 0 || numbers.replyMedianSeconds === null) return "—";
  const median = numbers.replyMedianSeconds < 60 ? `${numbers.replyMedianSeconds} с` : `${Math.round(numbers.replyMedianSeconds / 60)} мин`;
  return `${median}, ${share(numbers.repliesWithinHour, numbers.replies)}`;
}

function Cells({ numbers, average }: { numbers: ChatterNumbers; average?: boolean }) {
  const { composed } = numbers;
  return (
    <>
      <td className="num">{formatCount(numbers.ppvSent)} / {formatCount(numbers.ppvBought)}</td>
      <td className="num">{numbers.ppvAveragePriceMills === null ? "—" : formatMills(numbers.ppvAveragePriceMills)}</td>
      <td className="num">{numbers.ppvShare === null ? "—" : formatPercent(numbers.ppvShare * 100)}</td>
      <td className="num">{replyOf(numbers)}</td>
      <td className="num">
        {formatCount(numbers.waitingAtEnd)}
        {average && <span className="team-sub">в среднем</span>}
      </td>
      <td className="num">
        {numbers.messages === 0
          ? "—"
          : `${share(composed.hand, numbers.messages)} / ${share(composed.reply, numbers.messages)} / ${share(composed.fix, numbers.messages)}`}
      </td>
    </>
  );
}

function Numbers({ userId, from }: { userId: number; from: string }) {
  const { data, isLoading, refetch } = useTeamChatterNumbers({ from, userId }, { enabled: true });
  const { data: me } = useAuthMe();
  const owner = me?.user.role === "owner";
  if (!data) {
    return isLoading ? (
      <div className="team-card-inner team-card-top">
        <p className="team-muted" role="status">Считаем по каждой смене, это может занять до минуты.</p>
        <TableSkeleton rows={4} columns={7} />
      </div>
    ) : <NoAnswerPanel retry={refetch} />;
  }
  const chatter = data.chatters.find((one) => one.userId === userId);
  if (!chatter || chatter.shifts.length === 0) {
    return <div className="empty"><p className="empty-title">За этот период смен нет</p></div>;
  }
  return (
    <div className="table-wrap">
      <table className="data-table team-wrap-head">
        <thead>
          <tr>
            <th scope="col">Смена</th>
            <th scope="col" className="num">Платные: отправил / купили</th>
            <th scope="col" className="num">Средняя цена</th>
            <th scope="col" className="num">Доля платных</th>
            <th scope="col" className="num">Ответ: медиана, за час</th>
            <th scope="col" className="num">Ждали ответа в конце смены</th>
            <th scope="col" className="num">Руками / Reply / Fix</th>
          </tr>
        </thead>
        <tbody>
          <tr className="row-total align-top">
            <td>Весь период</td>
            <Cells numbers={chatter.week} average />
          </tr>
          {chatter.shifts.map((shift) => (
            <tr key={shift.startedAt} className="align-top">
              <td className="whitespace-nowrap">
                {formatDateTime(shift.startedAt)}{shift.ongoing && ", сейчас"}
                <span className="team-sub">{shift.pages.map((page, index) => <span key={page}>{index > 0 && ", "}<PageLink label={page} /></span>)}</span>
                {owner && <span className="team-sub"><Link to={`/team/review?${new URLSearchParams({ user: String(userId), at: shift.startedAt }).toString()}`} className="link">Разбор смены</Link></span>}
              </td>
              <Cells numbers={shift.numbers} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChatterShiftNumbers({ userId, firstDay }: { userId: number; firstDay: string }) {
  // The Moscow midnight of the window's first day: one key the whole day long.
  const from = new Date(`${firstDay}T00:00:00+03:00`).toISOString();
  return (
    <DisclosureCard
      lazy
      title="Подробно по сменам"
      description="Цена и доля платных сообщений, ответ, кто ждал в конце смены. Считается дольше: при открытии."
    >
      <Numbers userId={userId} from={from} />
    </DisclosureCard>
  );
}
