import { useNavigate, useParams } from "react-router";

import { useTeamChatterStats } from "@/api/team";
import { useScreenPeriod } from "@/components/layout/useScreenPeriod";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { PageHeader } from "@/components/ui/PageHeader";
import { formatDayRange } from "@/lib/format";
import { ChatterStatsView } from "@/pages/account/stats/ChatterStatsView";
import { PERIODS } from "@/pages/account/stats/statsView";

/**
 * A chatter's «Статистика» as their cabinet shows it, for the owner and team
 * leads: their shifts, money, sales and records on the pages the viewer reaches.
 * Read-only. The person is in the path; the hub answers an unknown id with the
 * first person it knows, so the screen checks whom it got before showing a number.
 */
export function TeamChatterStatsPage() {
  const { userId: rawUserId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const { days: shownDays } = useScreenPeriod();
  const days = PERIODS.some((period) => period.days === shownDays) ? shownDays : 7;
  const userParam = Number(rawUserId);
  const userId = Number.isInteger(userParam) && userParam > 0 ? userParam : undefined;
  const query = useTeamChatterStats({ userId, days });

  if (query.isLoading) return <p role="status" className="py-16 text-center text-sm text-text-muted">Считаем смены…</p>;
  if (query.isError || !query.data) return <StatusPanel tone="error" title="Hub не ответил" description="Статистика не пришла. Это не ноль." action={<button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>Повторить</button>} />;
  const { people, stats } = query.data;
  if (stats === null) {
    return <StatusPanel title="За последний месяц в расширении никто не работал на ваших страницах" />;
  }
  if (userId === undefined || stats.user.userId !== userId) {
    return <StatusPanel title="Нет такого чаттера" action={<button type="button" className="btn btn-sm" onClick={() => navigate("/team/chatters")}>Ко всем чаттерам</button>} />;
  }

  const picker = (
    <label className="flex items-center gap-2 text-sm text-text-secondary">
      Чаттер
      <select
        className="select"
        value={stats.user.userId}
        onChange={(event) => navigate(`/team/chatters/${Number(event.target.value)}`)}
      >
        {people.map((person) => <option key={person.userId} value={person.userId}>{person.username}</option>)}
      </select>
    </label>
  );

  return (
    <>
      <PageHeader
        title={stats.user.username}
        window={stats.daily.length > 0 ? formatDayRange(stats.daily[0]!.date, stats.daily.at(-1)!.date) : undefined}
      />
      <ChatterStatsView
        stats={stats}
        days={days}
        onDays={undefined}
        self={false}
        reportTo="/team/payouts"
        toolbar={picker}
        refreshing={query.isFetching && query.isPlaceholderData}
      />
    </>
  );
}
