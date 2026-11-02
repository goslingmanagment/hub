import { useSearchParams } from "react-router";

import { useTeamChatterStats } from "@/api/team";
import { ChatterStatsView } from "@/pages/account/stats/ChatterStatsView";
import { PERIODS } from "@/pages/account/stats/statsView";

/**
 * A chatter's «Статистика» as their cabinet shows it, for the owner and team
 * leads: pick a chatter, see their shifts, money, sales and records on the
 * pages the viewer reaches. Read-only.
 */
export function TeamChatterStatsPage() {
  const [params, setParams] = useSearchParams();
  const asked = Number(params.get("days"));
  const days = PERIODS.some((period) => period.days === asked) ? asked : 7;
  const userParam = Number(params.get("user"));
  const userId = Number.isInteger(userParam) && userParam > 0 ? userParam : undefined;
  const query = useTeamChatterStats({ userId, days });

  const set = (next: { user?: number; days?: number }) => {
    const merged = new URLSearchParams(params);
    if (next.user !== undefined) merged.set("user", String(next.user));
    if (next.days !== undefined) merged.set("days", String(next.days));
    setParams(merged, { replace: true });
  };

  if (query.isLoading) return <p role="status" className="py-16 text-center text-sm text-text-muted">Считаем смены…</p>;
  if (query.isError || !query.data) return <p role="alert" className="py-16 text-center text-sm text-danger">Не удалось посчитать статистику. Обнови страницу.</p>;
  const { people, stats } = query.data;
  if (stats === null) {
    return <p className="py-16 text-center text-sm text-text-muted">За последний месяц в расширении никто не работал на твоих страницах.</p>;
  }

  const picker = (
    <label className="flex items-center gap-2 text-sm text-text-secondary">
      Чаттер
      <select
        className="select"
        value={stats.user.userId}
        onChange={(event) => set({ user: Number(event.target.value) })}
      >
        {people.map((person) => <option key={person.userId} value={person.userId}>{person.username}</option>)}
      </select>
    </label>
  );

  return (
    <ChatterStatsView
      stats={stats}
      days={days}
      onDays={(next) => set({ days: next })}
      self={false}
      reportTo="/team/shift-reports"
      toolbar={picker}
      refreshing={query.isFetching && query.isPlaceholderData}
    />
  );
}
