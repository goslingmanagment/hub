import { Link } from "react-router";

import { useCreatorStats, useHubRevenueWindow } from "@/api/creator-stats";
import {
  EngagementPanel,
  FollowersPanel,
  LastHoursPanel,
  MoneyStrip,
  ProfilePanel,
  ReachStrip,
  SubscriptionsPanel,
  ViewsPanel,
  hubWindowOf,
} from "@/components/creator-stats/CreatorStatsPanels";
import {
  coveredFrom,
  expectedWindow,
  formatStatsRange,
  newestUpdate,
  previousWindow,
  type CreatorStats,
} from "@/components/creator-stats/creator-stats-model";
import { PERIOD_LABELS } from "@/lib/period";
import { buildPageCollectionRoute } from "@/lib/navigation";

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

/** «к 5 сент. – 4 окт.» once a strip, when Fansly compares this exact window. */
function compareText(stats: CreatorStats): string | null {
  const { totalsWindow, window } = stats;
  if (window.days > 90 || totalsWindow === null || totalsWindow.fromDay !== window.fromDay || totalsWindow.toDay !== window.toDay) return null;
  const previous = previousWindow(window);
  return formatStatsRange(previous.fromDay, previous.toDay);
}

/** Nothing was ever read: no coverage and no rows at all. */
function neverCollected(stats: CreatorStats): boolean {
  return stats.coverage.length === 0 && stats.views.length === 0 && stats.revenue.length === 0 && stats.levels.length === 0;
}

/** «Главное»: how Fansly itself sees the page — reach, money, subscribers. */
export function StatsMainPage() {
  const { pageLabel, days, periodKey, substituted } = useStatsPage();
  const stats = useCreatorStats(pageLabel, days);
  const data = stats.data;
  const fresh = data && !stats.isPlaceholderData ? data : undefined;
  const hub = useHubRevenueWindow(pageLabel, fresh ? hubWindowOf(fresh) : null);
  const window = data?.window ?? expectedWindow(days);
  const updatedAt = data ? newestUpdate(data.coverage) : null;
  const periodText = PERIOD_LABELS[periodKey].toLowerCase();
  const incomplete = data ? incompleteText(pageLabel, coveredFrom(data, "series:views:day"), window, "статистику") : null;
  const notices = { pageLabel, updatedAt, incomplete, substituted };

  return (
    <div className="stats-screen">
      <StatsHeader
        window={window}
        compare
        totalsWindow={data ? data.totalsWindow : undefined}
        updatedAt={updatedAt}
        refreshing={stats.isFetching || hub.isFetching}
        onRefresh={() => {
          void stats.refetch();
          if (hub.data || hub.isError) void hub.refetch();
        }}
        extraNote={incompleteGoesQuiet(notices) ? incomplete : null}
      />
      <StatsNotices {...notices} />
      <QueryGate
        query={stats}
        pageLabel={pageLabel}
        neverCollected={neverCollected}
        skeleton={(
          <div className="stats-stack">
            <TilesSkeleton />
            <TilesSkeleton />
            <div className="stats-grid"><CardSkeleton wide height={300} /><CardSkeleton /><CardSkeleton /></div>
          </div>
        )}
      >
        {(data) => {
          const compare = compareText(data);
          return (
            <div className="stats-stack">
              <ReachStrip stats={data} compare={compare} />
              <MoneyStrip stats={data} compare={compare} pageLabel={pageLabel} periodKey={periodKey} hub={hub} />
              <div className="stats-grid">
                <ViewsPanel stats={data} pageLabel={pageLabel} periodText={periodText} />
                <ProfilePanel stats={data} pageLabel={pageLabel} periodText={periodText} />
                <FollowersPanel stats={data} pageLabel={pageLabel} periodText={periodText} />
                <SubscriptionsPanel stats={data} pageLabel={pageLabel} periodText={periodText} />
                <EngagementPanel stats={data} pageLabel={pageLabel} periodText={periodText} />
                <LastHoursPanel stats={data} pageLabel={pageLabel} />
              </div>
            </div>
          );
        }}
      </QueryGate>
      <HowCounted>
        <p>Все числа на этой вкладке — данные самого Fansly. Hub читает их каждый час и каждый раз перечитывает последние 14 дней.</p>
        <p>Итоги за 7, 30 и 90 дней и сравнение с прошлым периодом считает Fansly. За 180 дней и год таких итогов нет: итог — сумма по дням, сравнения нет, уникальных зрителей и платящих фанов нет.</p>
        <p>Сутки Fansly считает по UTC, с 03:00 по Москве. Сегодняшний день ещё идёт: его столбец бледный, число вырастет. Так же бледным рисуется идущий час. Графики по часам — по Москве.</p>
        <p>Разрыв на графике — день, о котором у Hub нет данных. Ноль — день, когда Fansly ничего не насчитал.</p>
        <p>Уникальные считаются за день и по каждому источнику: человек, который смотрел и в For You, и в ленте подписок, учтён в обоих. Поэтому они не складываются.</p>
        <p>Прирост фолловеров — пришли минус ушли, бывает меньше нуля. Отменённые подписки — выключили автопродление, подписка ещё идёт. Истёкшие — закончилась.</p>
        <p>«Подписчиков по данным Fansly» — счётчик самого Fansly. Платные и бесплатные подписки по данным Hub — на Главной.</p>
        <p>Доход здесь — число Fansly. Главный учёт денег — на Главной, по операциям Hub. Лайки здесь — числа; кто именно лайкнул, Fansly не отдаёт.</p>
        <p>
          Как собрана эта страница, читает ли её Hub и насколько глубоко —{" "}
          <Link className="link" to={buildPageCollectionRoute(pageLabel)}>Сбор данных {pageLabel}</Link>.
        </p>
      </HowCounted>
    </div>
  );
}
