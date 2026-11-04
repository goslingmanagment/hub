import { sumMills } from "@agency_hub_core/shared";

import { useCreatorStats, useHubRevenueDays, useHubRevenueWindow } from "@/api/creator-stats";
import { useFanslyMonths } from "@/api/insights";
import { IncomeTiles, MismatchPanel, MonthsPanel, RevenueByDayPanel, checkState, fanslyNet } from "@/components/creator-stats/IncomePanels";
import { coveredFrom, expectedWindow, headline, newestUpdate, type CreatorStats } from "@/components/creator-stats/creator-stats-model";
import { PERIOD_LABELS } from "@/lib/period";

import {
  CardSkeleton,
  HowCounted,
  QueryGate,
  StatsHeader,
  StatsNotices,
  TilesSkeleton,
  incompleteGoesQuiet,
  incompleteText,
} from "./StatsScreen.js";
import { useStatsPage } from "./useStatsPage.js";

function neverCollected(stats: CreatorStats): boolean {
  return stats.coverage.length === 0 && stats.revenue.length === 0 && stats.views.length === 0;
}

/** «Доход Fansly»: what the page earned by Fansly's numbers, by day and month, and whether Hub agrees. */
export function StatsIncomePage() {
  const { pageLabel, days, periodKey, substituted } = useStatsPage();
  const stats = useCreatorStats(pageLabel, days);
  const data = stats.data;
  const fresh = data && !stats.isPlaceholderData ? data : undefined;
  const hubWindow = fresh ? { fromDay: fresh.window.fromDay, toDay: fresh.window.toDay } : null;
  const hub = useHubRevenueWindow(pageLabel, hubWindow);
  // The days are asked only when the two sums disagree.
  const differs = fresh !== undefined && hub.data !== undefined && (fanslyNet(fresh) ?? sumMills([])) !== sumMills([hub.data.totalNetMills]);
  const hubDays = useHubRevenueDays(pageLabel, hubWindow, differs);
  const months = useFanslyMonths(pageLabel);
  const window = data?.window ?? expectedWindow(days);
  const updatedAt = data ? newestUpdate(data.coverage) : null;
  const periodText = PERIOD_LABELS[periodKey].toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  const incomplete = data ? incompleteText(pageLabel, coveredFrom(data, "series:revenue:day"), window, "доход") : null;
  const notices = { pageLabel, updatedAt, incomplete, substituted };

  return (
    <div className="stats-screen">
      <StatsHeader
        window={window}
        compare
        totalsWindow={data ? data.totalsWindow : undefined}
        updatedAt={updatedAt}
        refreshing={stats.isFetching || hub.isFetching || months.isFetching}
        onRefresh={() => {
          void stats.refetch();
          if (hub.data || hub.isError) void hub.refetch();
          if (differs) void hubDays.refetch();
          void months.refetch();
        }}
        extraNote={incompleteGoesQuiet(notices) ? incomplete : null}
      />
      <StatsNotices {...notices} />
      <div className="stats-stack">
        <QueryGate
          query={stats}
          pageLabel={pageLabel}
          neverCollected={neverCollected}
          skeleton={<div className="stats-stack"><TilesSkeleton /><CardSkeleton wide height={300} /></div>}
        >
          {(data) => {
            const check = checkState(data, hub, hubDays, today);
            return (
              <div className="stats-stack">
                <IncomeTiles stats={data} kpi={headline(data).netMills} hub={hub} check={check} pageLabel={pageLabel} />
                <RevenueByDayPanel stats={data} pageLabel={pageLabel} periodText={periodText} />
                {check.kind === "differs" && <MismatchPanel check={check} pageLabel={pageLabel} today={today} hubDays={hubDays} />}
              </div>
            );
          }}
        </QueryGate>
        <MonthsPanel months={months} pageLabel={pageLabel} />
      </div>
      <HowCounted>
        <p>Здесь данные самого Fansly: его дневные ряды и выписки. Виды дохода тоже его: платные медиа, наборы, чаевые, подписки. В Hub виды другие, поэтому разбивки не совпадают, а итог должен сходиться.</p>
        <p>Главный учёт денег — на Главной, по операциям Hub.</p>
        <p>Сверка: сумма дневных данных Fansly за даты периода против операций Hub за те же даты. Сутки — по UTC, с 03:00 по Москве. Сегодняшний день ещё идёт, а Hub читает Fansly раз в час, поэтому сегодня числа могут ненадолго разойтись.</p>
        <p>«До комиссии» и «после комиссии» — две разные базы, они никогда не складываются.</p>
        <p>«Сводный итог Fansly» — шапка раздела выписок Fansly, а не отдельный месяц. Он включает те же месяцы: если сложить, доход посчитается дважды.</p>
      </HowCounted>
    </div>
  );
}
