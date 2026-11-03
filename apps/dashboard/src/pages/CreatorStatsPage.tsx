import { useMemo } from "react";
import { useSearchParams } from "react-router";

import { useCreatorStats, useCreatorStatsAudience, useCreatorStatsContent } from "@/api/creator-stats";
import { usePages } from "@/api/pages";
import { AnalyticsError, AnalyticsLoading } from "@/components/analytics/AnalyticsPanel";
import {
  AudiencePanel,
  CreatorStatsHeadline,
  EngagementPanel,
  LastHoursPanel,
  ProfilePanel,
  RevenuePanel,
  SubscriptionsPanel,
  ViewsPanel,
} from "@/components/creator-stats/CreatorStatsPanels";
import {
  ActiveHoursPanel,
  BenchmarksPanel,
  CountriesPanel,
  MediaShownPanel,
  TagsPanel,
} from "@/components/creator-stats/AudiencePanels";
import { ContentPanel } from "@/components/creator-stats/ContentPanels";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { PageHeader } from "@/components/ui/PageHeader";
import { useScreenPeriod } from "@/components/layout/useScreenPeriod";
import { formatDayRange } from "@/lib/format";

/**
 * Fansly's statistics pages of 2026-10 (`/creator/stats/*`), as Hub collects
 * them every hour (`creator-stats.account`, 0292): the Overview of every page
 * in one place, with the same periods and the same comparison Fansly shows.
 * FANSLY ONLY: no OnlyFans lane writes these tables.
 */
const PERIODS = [
  { value: 7, label: "7 дней" },
  { value: 30, label: "30 дней" },
  { value: 90, label: "90 дней" },
  { value: 180, label: "Полгода" },
  { value: 365, label: "Год" },
] as const;

type Period = (typeof PERIODS)[number]["value"];

function periodOf(value: string | null): Period {
  return PERIODS.find((option) => String(option.value) === value)?.value ?? 30;
}

type Tab = "overview" | "content" | "audience";

export function CreatorStatsPage({ tab }: { tab: Tab }) {
  const pagesQuery = usePages();
  const [searchParams] = useSearchParams();
  const { days: shownDays } = useScreenPeriod();
  const fanslyPages = useMemo(
    () => (pagesQuery.data ?? []).filter((page) => page.platform === "fansly"),
    [pagesQuery.data],
  );
  const requested = searchParams.get("page") ?? "";
  const activeLabel = fanslyPages.some((page) => page.label === requested) ? requested : fanslyPages[0]?.label ?? "";
  const days = periodOf(String(shownDays));
  const stats = useCreatorStats(activeLabel, days, { enabled: activeLabel.length > 0 && tab === "overview" });
  const content = useCreatorStatsContent(activeLabel, days, { enabled: activeLabel.length > 0 && tab === "content" });
  const audience = useCreatorStatsAudience(activeLabel, days, { enabled: activeLabel.length > 0 && tab === "audience" });

  const data = stats.data;
  const shownWindow = tab === "overview" ? data?.window : tab === "content" ? content.data?.window : audience.data?.window;
  const updatedAt = data?.coverage.reduce<string | null>((newest, row) => (newest === null || row.updatedAt > newest ? row.updatedAt : newest), null) ?? null;

  return (
    <div>
      {shownWindow && (
        <PageHeader
          window={`${formatDayRange(shownWindow.fromDay, shownWindow.toDay)} (сутки Fansly, по UTC).`}
          fresh={tab === "overview" && updatedAt ? { at: updatedAt } : undefined}
        />
      )}
      {pagesQuery.isPending && !pagesQuery.data ? (
        <StatusPanel title="Загружаем страницы…" />
      ) : fanslyPages.length === 0 ? (
        <StatusPanel title="Нет страниц Fansly" description="Статистика собирается только для страниц Fansly." />
      ) : tab === "content" ? (
        <div className="space-y-4">
          {content.isPending ? <AnalyticsLoading what="Загружаем медиа…" /> : content.isError || !content.data ? (
            <AnalyticsError message="Не удалось загрузить медиа." onRetry={() => void content.refetch()} />
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              <ContentPanel data={content.data} pageLabel={activeLabel} days={days} />
            </div>
          )}
        </div>
      ) : tab === "audience" ? (
        <div className="space-y-4">
          {audience.isPending ? <AnalyticsLoading what="Загружаем аудиторию…" /> : audience.isError || !audience.data ? (
            <AnalyticsError message="Не удалось загрузить аудиторию." onRetry={() => void audience.refetch()} />
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              <CountriesPanel data={audience.data} />
              <TagsPanel data={audience.data} />
              <ActiveHoursPanel data={audience.data} />
              <BenchmarksPanel data={audience.data} />
              <MediaShownPanel data={audience.data} />
            </div>
          )}
        </div>
      ) : stats.isPending ? (
        <div className="space-y-4"><AnalyticsLoading what="Загружаем статистику…" /></div>
      ) : stats.isError || data === undefined ? (
        <div className="space-y-4"><AnalyticsError message="Не удалось загрузить статистику." onRetry={() => void stats.refetch()} /></div>
      ) : (
        <div className="space-y-4">
          {data.totalsWindow === null && (
            <p className="text-xs text-text-muted">
              {days > 90
                ? "Fansly не считает итогов за такой период: итоги — сумма по дням, без сравнения."
                : "Сводки Fansly за этот период ещё нет, итоги — сумма по дням."}
            </p>
          )}
          <CreatorStatsHeadline stats={data} />
          <div className="grid gap-4 xl:grid-cols-2">
            <ViewsPanel stats={data} />
            <AudiencePanel stats={data} />
            <ProfilePanel stats={data} />
            <RevenuePanel stats={data} />
            <SubscriptionsPanel stats={data} />
            <EngagementPanel stats={data} />
            <LastHoursPanel stats={data} />
          </div>
        </div>
      )}
    </div>
  );
}
