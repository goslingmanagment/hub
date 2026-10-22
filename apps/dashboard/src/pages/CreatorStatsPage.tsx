import { useMemo } from "react";
import { useSearchParams } from "react-router";

import { useCreatorStats } from "@/api/creator-stats";
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
import { StatusPanel } from "@/components/shared/StatusPanel";
import { PageHeader } from "@/components/ui/PageHeader";
import { formatBusinessDateShort, formatRelativeTime } from "@/lib/format";

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
] as const;

type Period = (typeof PERIODS)[number]["value"];

function periodOf(value: string | null): Period {
  return value === "7" ? 7 : value === "90" ? 90 : 30;
}

export function CreatorStatsPage() {
  const pagesQuery = usePages();
  const [searchParams, setSearchParams] = useSearchParams();
  const fanslyPages = useMemo(
    () => (pagesQuery.data ?? []).filter((page) => page.platform === "fansly"),
    [pagesQuery.data],
  );
  const requested = searchParams.get("page") ?? "";
  const activeLabel = fanslyPages.some((page) => page.label === requested) ? requested : fanslyPages[0]?.label ?? "";
  const days = periodOf(searchParams.get("days"));
  const stats = useCreatorStats(activeLabel, days, { enabled: activeLabel.length > 0 });

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    next.set(key, value);
    setSearchParams(next);
  }

  const actions = fanslyPages.length > 0 ? (
    <>
      <label className="flex items-center">
        <span className="sr-only">Страница</span>
        <select value={activeLabel} onChange={(event) => setParam("page", event.target.value)} className="select w-auto min-w-[160px] max-w-[240px]">
          {fanslyPages.map((page) => <option key={page.id} value={page.label}>{page.label}</option>)}
        </select>
      </label>
      <div className="segmented" role="group" aria-label="Период">
        {PERIODS.map((option) => (
          <button key={option.value} type="button" className="segment" aria-pressed={days === option.value} onClick={() => setParam("days", String(option.value))}>
            {option.label}
          </button>
        ))}
      </div>
    </>
  ) : null;

  const data = stats.data;
  const updatedAt = data?.coverage.reduce<string | null>((newest, row) => (newest === null || row.updatedAt > newest ? row.updatedAt : newest), null) ?? null;

  return (
    <div>
      <PageHeader
        title="Статистика"
        description="Новая статистика Fansly: просмотры, аудитория, доход — как на вкладке Overview, по каждой странице."
        actions={actions}
      />
      {pagesQuery.isPending && !pagesQuery.data ? (
        <StatusPanel title="Загружаем страницы…" />
      ) : fanslyPages.length === 0 ? (
        <StatusPanel title="Нет страниц Fansly" description="Статистика собирается только для страниц Fansly." />
      ) : stats.isPending ? (
        <AnalyticsLoading what="Загружаем статистику…" />
      ) : stats.isError || data === undefined ? (
        <AnalyticsError message="Не удалось загрузить статистику." onRetry={() => void stats.refetch()} />
      ) : (
        <div className="space-y-4">
          <p className="text-[13px] text-text-muted">
            {formatBusinessDateShort(data.window.fromDay)} — {formatBusinessDateShort(data.window.toDay)} (UTC)
            {data.totalsWindow === null ? " · сводки Fansly за этот период ещё нет, итоги — сумма по дням" : ""}
            {updatedAt ? ` · обновлено ${formatRelativeTime(updatedAt)}` : ""}
          </p>
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
