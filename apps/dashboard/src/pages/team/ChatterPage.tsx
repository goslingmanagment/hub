import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useAuthMe } from "@/api/queries";
import { useTeamChatterPeople, useTeamChatterStats } from "@/api/team";
import { useScreenPeriod } from "@/components/layout/useScreenPeriod";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatDayRange } from "@/lib/format";
import { ChatterStatsView } from "@/pages/account/stats/ChatterStatsView";
import { moscowOf } from "@/pages/account/stats/statsView";
import { ChatterShiftNumbers } from "./ChatterShiftNumbers.js";

/**
 * Команда → Чаттеры → one chatter: their shifts, money, sales and records on the
 * pages the viewer reaches, with the cabinet's blocks. Read-only. The person is
 * in the path; the hub answers an unknown id with the first person it knows,
 * so the screen checks whom it got before showing a number.
 */
export function ChatterPage() {
  const { userId: rawUserId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const { days } = useScreenPeriod();
  const { data: me } = useAuthMe();
  const owner = me?.user.role === "owner";
  const userParam = Number(rawUserId);
  const userId = Number.isInteger(userParam) && userParam > 0 ? userParam : undefined;
  const query = useTeamChatterStats({ userId, days });
  const people = useTeamChatterPeople();
  const stats = query.data?.stats ?? null;
  const ours = stats !== null && userId !== undefined && stats.user.userId === userId ? stats : null;

  const others = (people.data?.people ?? query.data?.people ?? []).filter((person) => person.userId !== userId);
  const actions = (
    <>
      {others.length > 0 && (
        <select
          aria-label="Другой чаттер"
          className="select team-picker"
          value=""
          onChange={(event) => {
            if (event.target.value === "") return;
            const keep = search.toString();
            navigate(`/team/chatters/${Number(event.target.value)}${keep ? `?${keep}` : ""}`);
          }}
        >
          <option value="">Другой чаттер</option>
          {others.map((person) => <option key={person.userId} value={person.userId}>{person.username}</option>)}
        </select>
      )}
      {owner && userId !== undefined && <Link to={`/team/people/${userId}`} className="btn">Доступ и устройства</Link>}
    </>
  );
  const showMonth = () => {
    const next = new URLSearchParams(search);
    next.set("period", "30d");
    setSearch(next);
  };

  if (query.isLoading) {
    return (
      <div className="team-screen" aria-busy="true">
        <PageHeader actions={actions} />
        <section className="card cs-hero" aria-hidden="true">
          <Skeleton width={180} />
          <div className="mt-4"><Skeleton width={220} className="!h-10" /></div>
          <div className="mt-4"><Skeleton width="50%" /></div>
          <div className="mt-8 grid gap-3">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} width="100%" />)}</div>
        </section>
      </div>
    );
  }
  if (query.isError || !query.data) {
    return <div className="team-screen"><PageHeader actions={actions} /><NoAnswerPanel retry={query.refetch} /></div>;
  }
  if (stats === null) {
    return (
      <div className="team-screen">
        <StatusPanel title="Никто не работал" description="За последний месяц в расширении никто не работал на ваших страницах." />
      </div>
    );
  }
  if (ours === null) {
    return (
      <div className="team-screen">
        <PageHeader title="Нет такого чаттера" />
        <StatusPanel
          title="Нет такого чаттера"
          description="За последние 31 день этот человек не работал в расширении на ваших страницах."
          action={<Link to="/team/chatters" className="btn btn-sm">К чаттерам</Link>}
        />
      </div>
    );
  }

  const today = moscowOf(Date.parse(ours.serverNow)).day;
  const firstDay = ours.daily[0]?.date ?? today;
  return (
    <div className="team-screen">
      <PageHeader
        title={ours.user.username}
        description="Продажи и работа за период. Это ориентир, а не основание для оплаты."
        actions={actions}
        window={formatDayRange(firstDay, today)}
        fresh={{ at: query.dataUpdatedAt, onRefresh: () => void query.refetch(), refreshing: query.isFetching }}
      />
      <ChatterStatsView
        stats={ours}
        self={false}
        linkPages
        reportTo={(from, to) => `/team/payouts?${new URLSearchParams({ from, to, chatter: ours.user.username }).toString()}#unconfirmed`}
        onShowMonth={showMonth}
        refreshing={query.isFetching && query.isPlaceholderData}
        extra={<ChatterShiftNumbers key={`${ours.user.userId}:${firstDay}`} userId={ours.user.userId} firstDay={firstDay} />}
      />
    </div>
  );
}
