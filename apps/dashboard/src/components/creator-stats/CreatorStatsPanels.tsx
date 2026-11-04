import { useMemo, useState } from "react";
import { Link, useLocation } from "react-router";
import { sumMills } from "@agency_hub_core/shared";

import type { PageRevenueResponse } from "@agency_hub_core/contracts";
import type { ChartSeries } from "@/components/charts/ChartKit";
import { ChartTable, type ChartTableColumn } from "@/components/charts/ChartTable";
import { durationAxisLabel } from "@/components/charts/format";
import { durationTicks } from "@/components/charts/scale";
import { MoneyDelta } from "@/components/money/Delta";
import { StackedBarChart } from "@/components/shared/StackedBarChart";
import { Segmented } from "@/components/ui/Segmented";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatCount, formatMills, formatPercent } from "@/lib/format";
import { buildRevenueTransactionsRoute } from "@/lib/overviewNavigation";

import { DayChart } from "./DayChart.js";
import { ChartBody, KpiDelta, StatsCard, StatsEmpty, StripHeading, formatSignedCount } from "./StatsCard.js";
import {
  DAY_MS,
  HOUR_IN_PROGRESS_NOTE,
  HOUR_MS,
  IN_PROGRESS_NOTE,
  averageWatch,
  barRows,
  bucketInProgress,
  changePercent,
  coveredFrom,
  formatStatsDay,
  formatStatsHour,
  formatWatchTime,
  forYouShare,
  headline,
  pivotDays,
  seriesTotal,
  sourceColor,
  sourceLabel,
  windowDays,
  type CreatorStats,
  type DayPoint,
} from "./creator-stats-model.js";

type Unit = "count" | "duration";

function formatOf(unit: Unit): (value: number) => string {
  return unit === "duration" ? formatWatchTime : (value) => formatCount(value);
}

function sourceSeries(sources: readonly number[]): ChartSeries[] {
  return [...sources].sort((a, b) => a - b).map((source) => ({ key: String(source), label: sourceLabel(source), color: sourceColor(source) }));
}

function withTotals(series: readonly ChartSeries[], rows: readonly DayPoint[], unit: Unit): ChartSeries[] {
  const format = formatOf(unit);
  return series.map((entry) => {
    const sum = seriesTotal(rows, entry.key);
    return { ...entry, total: sum === null ? undefined : format(sum) };
  });
}

const dayNote = (row: Record<string, unknown>) =>
  typeof row.bucketStart === "string" && bucketInProgress(row.bucketStart, DAY_MS) ? IN_PROGRESS_NOTE : null;
const hourNote = (row: Record<string, unknown>) =>
  typeof row.bucketStart === "string" && bucketInProgress(row.bucketStart, HOUR_MS) ? HOUR_IN_PROGRESS_NOTE : null;

/** The table twin of a chart by day: the date, every series, and the sum where it means something. */
function dayColumns(series: readonly ChartSeries[], unit: Unit, options: { total?: string | null; hours?: boolean; abs?: boolean } = {}): ChartTableColumn<DayPoint>[] {
  const format = formatOf(unit);
  const cell = (value: unknown) => (typeof value === "number" ? format(options.abs ? Math.abs(value) : value) : "—");
  return [
    { key: "day", label: options.hours ? "Час" : "День", value: (row) => (options.hours ? formatStatsHour(row.bucketStart) : formatStatsDay(row.bucketStart)) },
    ...series.map((entry) => ({ key: entry.key, label: entry.label, num: true, value: (row: DayPoint) => cell(row[entry.key]) })),
    ...(options.total ? [{
      key: "total",
      label: options.total,
      num: true,
      value: (row: DayPoint) => {
        const values = series.map((entry) => row[entry.key]).filter((value): value is number => typeof value === "number");
        return values.length === 0 ? "—" : format(values.reduce((sum, value) => sum + value, 0));
      },
    }] : []),
  ];
}

/** Bars of parts of a whole by day (or hour): the tooltip sums them when `totalLabel`. */
function PartsBars({ rows, series, unit = "count", totalLabel = "Всего", hours = false, height = 260, abs = false }: {
  rows: readonly DayPoint[];
  series: ChartSeries[];
  unit?: Unit;
  totalLabel?: string | null;
  hours?: boolean;
  height?: number;
  abs?: boolean;
}) {
  const format = formatOf(unit);
  return (
    <StackedBarChart
      title=""
      data={barRows(rows)}
      xKey="bucketStart"
      series={series}
      xTickFormatter={hours ? formatStatsHour : formatStatsDay}
      valueFormatter={(value) => format(abs ? Math.abs(value) : value)}
      axisFormatter={unit === "duration" ? () => durationAxisLabel : undefined}
      scale={unit === "duration" ? (_min, max) => durationTicks(max) : undefined}
      tickSpacing={hours ? { spacing: 120, max: 7 } : { spacing: 80, max: 7 }}
      totalLabel={totalLabel}
      note={hours ? hourNote : dayNote}
      height={height}
    />
  );
}

// ── the tiles ────────────────────────────────────────────────────────────────

function shown(value: number | null | undefined, format: (value: number) => string = (v) => formatCount(v)): string {
  return value === null || value === undefined ? "—" : format(value);
}

/** «Охват»: what Fansly showed of the page. Not links. */
export function ReachStrip({ stats, compare }: { stats: CreatorStats; compare: string | null }) {
  const h = headline(stats);
  const forYou = h.uniqueViewers(0);
  const timeline = h.uniqueViewers(1);
  const long = stats.window.days > 90;
  return (
    <section aria-label="Охват">
      <StripHeading title="Охват" compare={compare} />
      <div className="stat-grid stats-strip">
        <div className="stat">
          <p className="stat-label">Просмотры</p>
          <p className="stat-value">{shown(h.views.value)}</p>
          <p className="stat-meta"><KpiDelta kpi={h.views} /></p>
        </div>
        <div className="stat">
          <p className="stat-label">Время просмотра</p>
          <p className="stat-value">{shown(h.watchMs.value, formatWatchTime)}</p>
          <p className="stat-meta"><KpiDelta kpi={h.watchMs} unit="duration" /></p>
        </div>
        <div className="stat">
          <p className="stat-label">Уникальные зрители For You</p>
          <p className="stat-value">{long ? "—" : shown(forYou?.value)}</p>
          <p className="stat-meta">
            {long || forYou === null ? "Fansly считает их только за 7, 30 и 90 дней" : `в ленте подписок — ${shown(timeline?.value)}`}
          </p>
        </div>
        <div className="stat">
          <p className="stat-label">Визиты профиля</p>
          <p className="stat-value">{shown(h.profileVisits.value)}</p>
          <p className="stat-meta"><KpiDelta kpi={h.profileVisits} /></p>
        </div>
      </div>
    </section>
  );
}

/** The window of Hub's operations that the money tile is checked against. */
export function hubWindowOf(stats: CreatorStats): { fromDay: string; toDay: string } {
  return stats.totalsWindow ?? stats.window;
}

/** «Сходится с Hub» or «По операциям Hub: $8,012.00», a link to those operations. */
function HubCheckLine({ pageLabel, fanslyNet, hub }: {
  pageLabel: string;
  fanslyNet: number | null;
  hub: { data: PageRevenueResponse | undefined; isPending: boolean; isError: boolean; refetch: () => unknown };
}) {
  const location = useLocation();
  if (hub.data === undefined) {
    if (hub.isError) {
      return (
        <span className="stats-hub-line">
          По операциям Hub: —, Hub не ответил{" "}
          <button type="button" className="link" onClick={() => void hub.refetch()}>Повторить</button>
        </span>
      );
    }
    return <Skeleton width={140} />;
  }
  const window = hub.data.platformWindows[0];
  const to = buildRevenueTransactionsRoute({
    pageLabel,
    from: window?.from ?? null,
    to: window?.to ?? null,
    backTo: `${location.pathname}${location.search}`,
  });
  const same = fanslyNet !== null && sumMills([hub.data.totalNetMills]) === sumMills([fanslyNet]);
  return (
    <Link to={to} className="stats-hub-line stats-quiet-link">
      {same ? "Сходится с Hub" : `По операциям Hub: ${formatMills(hub.data.totalNetMills)}`}
    </Link>
  );
}

/** «Деньги и подписчики». Money is Fansly's number; Hub's books are on Главная. */
export function MoneyStrip({ stats, compare, pageLabel, periodKey, hub }: {
  stats: CreatorStats;
  compare: string | null;
  pageLabel: string;
  periodKey: string;
  hub: { data: PageRevenueResponse | undefined; isPending: boolean; isError: boolean; refetch: () => unknown };
}) {
  const h = headline(stats);
  const long = stats.window.days > 90;
  const net = h.netMills;
  const netDelta = net.value !== null && net.previous !== null ? sumMills([net.value, -net.previous]) : null;
  const subscribers = h.subscribers;
  const home = `/?${new URLSearchParams({ page: pageLabel, period: periodKey })}`;
  return (
    <section aria-label="Деньги и подписчики">
      <StripHeading
        title="Деньги и подписчики"
        compare={compare}
        action={<Link to={home} className="link">Открыть на Главной</Link>}
      />
      <div className="stat-grid stats-strip">
        <div className="stat">
          <p className="stat-label">Доход по данным Fansly</p>
          <p className="stat-value">{net.value === null ? "—" : formatMills(net.value)}</p>
          <p className="stat-meta"><MoneyDelta mills={netDelta} pct={changePercent(net)} /></p>
          <p className="stat-meta"><HubCheckLine pageLabel={pageLabel} fanslyNet={net.value} hub={hub} /></p>
        </div>
        <div className="stat">
          <p className="stat-label">Платящие фаны</p>
          <p className="stat-value">{long ? "—" : shown(h.payingFans?.value)}</p>
          <p className="stat-meta">
            {long || h.payingFans === null
              ? "Fansly считает их только за 7, 30 и 90 дней"
              : h.newPayingFans?.value != null ? `из них новых — ${formatCount(h.newPayingFans.value)}` : null}
          </p>
        </div>
        <div className="stat">
          <p className="stat-label">Подписчиков по данным Fansly</p>
          <p className="stat-value">{shown(subscribers.value)}</p>
          <p className="stat-meta"><KpiDelta kpi={stats.totalsWindow ? subscribers : null} /></p>
        </div>
        <div className="stat">
          <p className="stat-label">Прирост фолловеров</p>
          <p className="stat-value">{shown(h.netFollows.value, formatSignedCount)}</p>
          <p className="stat-meta"><KpiDelta kpi={h.netFollows} /></p>
        </div>
      </div>
    </section>
  );
}

// ── views ────────────────────────────────────────────────────────────────────

type ViewsMeasure = "views" | "watchMs" | "uniqueViewers";

export function ViewsPanel({ stats, pageLabel, periodText }: { stats: CreatorStats; pageLabel: string; periodText: string }) {
  const [measure, setMeasure] = useState<ViewsMeasure>("views");
  const days = windowDays(stats);
  const series = useMemo(() => sourceSeries([...new Set(stats.views.map((row) => row.source))]), [stats.views]);
  const rows = useMemo(
    () => pivotDays(days, stats.views, (row) => String(row.source), (row) => row[measure], series.map((s) => s.key), coveredFrom(stats, "series:views:day")),
    [days, stats, measure, series],
  );
  const share = forYouShare(stats);
  const watch = averageWatch(stats);
  const unit: Unit = measure === "watchMs" ? "duration" : "count";
  const description = `Откуда пришли зрители. Доля For You ${share === null ? "—" : formatPercent(share)}, средний досмотр ${watch === null ? "—" : formatPercent(watch)}.`;
  return (
    <StatsCard
      wide
      id="stats-views"
      title="Просмотры по источникам"
      description={description}
      measure={(
        <Segmented
          label="Показатель"
          value={measure}
          onChange={setMeasure}
          options={[{ value: "views", label: "Просмотры" }, { value: "watchMs", label: "Время" }, { value: "uniqueViewers", label: "Уникальные" }]}
        />
      )}
    >
      {stats.views.length === 0 ? (
        <StatsEmpty>На {pageLabel} за {periodText} Fansly не прислал просмотров.</StatsEmpty>
      ) : measure === "uniqueViewers" ? (
        <ChartBody
          chart={<DayChart lines fromZero rows={rows} series={series} height={300} note={dayNote} />}
          rows={rows}
          columns={dayColumns(series, "count")}
          rowKey={(row) => row.bucketStart}
          caption="Уникальные зрители по дням"
        />
      ) : (
        <ChartBody
          chart={<PartsBars rows={rows} series={withTotals(series, rows, unit)} unit={unit} height={300} />}
          rows={rows}
          columns={dayColumns(series, unit, { total: "Всего" })}
          rowKey={(row) => row.bucketStart}
          caption="Просмотры по дням"
        />
      )}
    </StatsCard>
  );
}

// ── profile ──────────────────────────────────────────────────────────────────

type ProfileMeasure = "profileVisits" | "profileWatchMs" | "uniqueVisitors";

export function ProfilePanel({ stats, pageLabel, periodText }: { stats: CreatorStats; pageLabel: string; periodText: string }) {
  const [measure, setMeasure] = useState<ProfileMeasure>("profileVisits");
  const days = windowDays(stats);
  const series = useMemo(() => sourceSeries([...new Set(stats.profile.map((row) => row.source))]), [stats.profile]);
  const rows = useMemo(
    () => pivotDays(days, stats.profile, (row) => String(row.source), (row) => row[measure], series.map((s) => s.key), coveredFrom(stats, "series:profile:day")),
    [days, stats, measure, series],
  );
  const unit: Unit = measure === "profileWatchMs" ? "duration" : "count";
  return (
    <StatsCard
      id="stats-profile"
      title="Визиты профиля"
      description="Откуда приходят на страницу."
      measure={(
        <Segmented
          label="Показатель"
          value={measure}
          onChange={setMeasure}
          options={[{ value: "profileVisits", label: "Визиты" }, { value: "profileWatchMs", label: "Время на профиле" }, { value: "uniqueVisitors", label: "Уникальные" }]}
        />
      )}
    >
      {stats.profile.length === 0 ? (
        <StatsEmpty>На {pageLabel} за {periodText} Fansly не прислал визитов.</StatsEmpty>
      ) : measure === "uniqueVisitors" ? (
        <ChartBody
          chart={<DayChart lines fromZero rows={rows} series={series} note={dayNote} />}
          rows={rows}
          columns={dayColumns(series, "count")}
          rowKey={(row) => row.bucketStart}
          caption="Уникальные посетители по дням"
        />
      ) : (
        <ChartBody
          chart={<PartsBars rows={rows} series={series} unit={unit} />}
          rows={rows}
          columns={dayColumns(series, unit, { total: "Всего" })}
          rowKey={(row) => row.bucketStart}
          caption="Визиты профиля по дням"
        />
      )}
    </StatsCard>
  );
}

// ── followers and subscribers ───────────────────────────────────────────────

type AudienceMeasure = "followers" | "subscribers" | "follows";

const FOLLOW_SERIES: ChartSeries[] = [
  { key: "follows", label: "Новые фолловеры", color: "var(--color-chart-blue)" },
  { key: "unfollows", label: "Ушли", color: "var(--color-chart-orange)" },
];

export function FollowersPanel({ stats, pageLabel, periodText }: { stats: CreatorStats; pageLabel: string; periodText: string }) {
  const [measure, setMeasure] = useState<AudienceMeasure>("followers");
  const days = windowDays(stats);
  const level = measure === "subscribers" ? "subscribers" : "followers";
  const levelSeries: ChartSeries = measure === "subscribers"
    ? { key: "subscribers", label: "Подписчики", color: "var(--color-chart-violet)" }
    : { key: "followers", label: "Фолловеры", color: "var(--color-chart-blue)" };
  const levelRows = pivotDays(days, stats.levels, () => level,
    (row) => (level === "subscribers" ? row.subscriberCount : row.followerCount), [level], stats.levels[0]?.day ?? null)
    // A level is a reading, not a count of the day: a day without one is unknown.
    .map((point) => (stats.levels.some((row) => row.day === point.bucketStart && (level === "subscribers" ? row.subscriberCount : row.followerCount) !== null)
      ? point
      : { ...point, [level]: null }));
  const lastLevel = [...stats.levels].reverse().find((row) => (level === "subscribers" ? row.subscriberCount : row.followerCount) !== null);
  const lastValue = lastLevel ? (level === "subscribers" ? lastLevel.subscriberCount : lastLevel.followerCount) : null;
  const followRows = pivotDays(days, [
    ...stats.follows.map((row) => ({ day: row.day, key: "follows", value: row.follows })),
    ...stats.follows.map((row) => ({ day: row.day, key: "unfollows", value: row.unfollows === null ? null : -row.unfollows })),
  ], (row) => row.key, (row) => row.value, ["follows", "unfollows"], coveredFrom(stats, "series:follows:day"));
  const followNote = (row: Record<string, unknown>) => {
    const gain = typeof row.follows === "number" && typeof row.unfollows === "number" ? row.follows + row.unfollows : null;
    const inProgress = dayNote(row);
    if (gain === null) return inProgress;
    return <>Прирост {formatSignedCount(gain)}{inProgress ? <><br />{inProgress}</> : null}</>;
  };

  const description = measure === "follows"
    ? "Сколько пришло и сколько ушло за день."
    : lastLevel && lastValue !== null
      ? `На ${formatStatsDay(lastLevel.day)} — ${formatCount(lastValue)}. Сколько их было в конце каждого дня.`
      : "Сколько их было в конце каждого дня.";

  return (
    <StatsCard
      id="stats-followers"
      title="Фолловеры и подписчики"
      description={description}
      measure={(
        <Segmented
          label="Показатель"
          value={measure}
          onChange={setMeasure}
          options={[{ value: "followers", label: "Фолловеры" }, { value: "subscribers", label: "Подписчики" }, { value: "follows", label: "Пришли и ушли" }]}
        />
      )}
    >
      {measure === "follows" ? (
        stats.follows.length === 0 ? <StatsEmpty>На {pageLabel} за {periodText} никто не пришёл и не ушёл.</StatsEmpty> : (
          <div className="card-body">
            <StackedBarChart
              title=""
              data={barRows(followRows)}
              xKey="bucketStart"
              series={FOLLOW_SERIES}
              xTickFormatter={formatStatsDay}
              valueFormatter={(value) => formatCount(Math.abs(value))}
              tickSpacing={{ spacing: 80, max: 7 }}
              totalLabel={null}
              note={followNote}
              height={260}
            />
            <div className="stats-chart-table">
              <ChartBodyTable
                rows={followRows}
                columns={[
                  ...dayColumns(FOLLOW_SERIES, "count", { abs: true }),
                  {
                    key: "gain",
                    label: "Прирост",
                    num: true,
                    value: (row) => (typeof row.follows === "number" && typeof row.unfollows === "number" ? formatSignedCount(row.follows + row.unfollows) : "—"),
                  },
                ]}
                caption="Пришли и ушли по дням"
              />
            </div>
          </div>
        )
      ) : lastValue === null ? (
        <StatsEmpty>На {pageLabel} за {periodText} число {measure === "subscribers" ? "подписчиков" : "фолловеров"} ещё не собрано.</StatsEmpty>
      ) : (
        <ChartBody
          chart={<DayChart lines rows={levelRows} series={[levelSeries]} />}
          rows={levelRows}
          columns={dayColumns([levelSeries], "count")}
          rowKey={(row) => row.bucketStart}
          caption={`${levelSeries.label} по дням`}
        />
      )}
    </StatsCard>
  );
}

function ChartBodyTable({ rows, columns, caption }: { rows: readonly DayPoint[]; columns: readonly ChartTableColumn<DayPoint>[]; caption: string }) {
  return <ChartTable rows={rows} columns={columns} rowKey={(row) => row.bucketStart} caption={caption} />;
}

// ── subscriptions ────────────────────────────────────────────────────────────

const SUBSCRIPTION_SERIES: ChartSeries[] = [
  { key: "new", label: "Новые", color: "var(--color-chart-blue)" },
  { key: "renewed", label: "Продлённые", color: "var(--color-chart-aqua)" },
  { key: "expired", label: "Истёкшие", color: "var(--color-chart-orange)" },
  { key: "cancelled", label: "Отменённые", color: "var(--color-chart-magenta)" },
];

export function SubscriptionsPanel({ stats, pageLabel, periodText }: { stats: CreatorStats; pageLabel: string; periodText: string }) {
  const days = windowDays(stats);
  const rows = pivotDays(days, stats.subscriptions.flatMap((row) => [
    { day: row.day, key: "new", value: row.subscriptionsNew },
    { day: row.day, key: "renewed", value: row.subscriptionsRenewed },
    { day: row.day, key: "expired", value: row.subscriptionsExpired === null ? null : -row.subscriptionsExpired },
    { day: row.day, key: "cancelled", value: row.subscriptionsCancelled === null ? null : -row.subscriptionsCancelled },
  ]), (row) => row.key, (row) => row.value, ["new", "renewed", "expired", "cancelled"], coveredFrom(stats, "series:subscriptions:day"));
  return (
    <StatsCard id="stats-subscriptions" title="Подписки" description="Новые и продлённые вверх, истёкшие и отменённые вниз.">
      {stats.subscriptions.length === 0 ? <StatsEmpty>На {pageLabel} за {periodText} подписки не менялись.</StatsEmpty> : (
        <ChartBody
          chart={<PartsBars rows={rows} series={SUBSCRIPTION_SERIES} totalLabel={null} abs />}
          rows={rows}
          columns={dayColumns(SUBSCRIPTION_SERIES, "count", { abs: true })}
          rowKey={(row) => row.bucketStart}
          caption="Подписки по дням"
        />
      )}
    </StatsCard>
  );
}

// ── engagement ───────────────────────────────────────────────────────────────

const ENGAGEMENT_SERIES: ChartSeries[] = [
  { key: "media_likes", label: "Лайки медиа", color: "var(--color-chart-magenta)" },
  { key: "post_likes", label: "Лайки постов", color: "var(--color-chart-blue)" },
  { key: "comments", label: "Комментарии", color: "var(--color-chart-orange)" },
];

export function EngagementPanel({ stats, pageLabel, periodText }: { stats: CreatorStats; pageLabel: string; periodText: string }) {
  const days = windowDays(stats);
  const rows = pivotDays(days, stats.engagement, (row) => row.metric, (row) => row.value, ENGAGEMENT_SERIES.map((s) => s.key), stats.engagement[0]?.day ?? null);
  return (
    <StatsCard id="stats-engagement" title="Вовлечённость" description="Лайки медиа и постов, комментарии за день.">
      {stats.engagement.length === 0 ? <StatsEmpty>На {pageLabel} за {periodText} данных о вовлечённости нет.</StatsEmpty> : (
        <ChartBody
          chart={<DayChart lines fromZero rows={rows} series={ENGAGEMENT_SERIES} note={dayNote} />}
          rows={rows}
          columns={dayColumns(ENGAGEMENT_SERIES, "count")}
          rowKey={(row) => row.bucketStart}
          caption="Вовлечённость по дням"
        />
      )}
    </StatsCard>
  );
}

// ── the last hours ───────────────────────────────────────────────────────────

/** Hour points from the first hour to the last, one key per series; an hour with no row is a zero. */
export function hourRows<R extends { hour: string; source: number }>(rows: readonly R[], series: readonly ChartSeries[], valueOf: (row: R) => number | null): DayPoint[] {
  const hours = [...new Set(rows.map((row) => row.hour))].sort();
  if (hours.length === 0) return [];
  const sums = new Map<string, number>();
  for (const row of rows) {
    const at = `${Date.parse(row.hour)}|${row.source}`;
    sums.set(at, (sums.get(at) ?? 0) + (valueOf(row) ?? 0));
  }
  const out: DayPoint[] = [];
  for (let at = Date.parse(hours[0]!); at <= Date.parse(hours.at(-1)!); at += HOUR_MS) {
    const point: DayPoint = { bucketStart: new Date(at).toISOString() };
    for (const entry of series) point[entry.key] = sums.get(`${at}|${entry.key}`) ?? 0;
    out.push(point);
  }
  return out;
}

export function LastHoursPanel({ stats, pageLabel }: { stats: CreatorStats; pageLabel: string }) {
  const series = useMemo(() => sourceSeries([...new Set(stats.hourlyViews.map((row) => row.source))]), [stats.hourlyViews]);
  const rows = useMemo(() => hourRows(stats.hourlyViews, series, (row) => row.views), [stats.hourlyViews, series]);
  return (
    <StatsCard wide id="stats-hours" title="Последние 72 часа" description="Просмотры по часам. Период на этот график не влияет.">
      {rows.length === 0 ? <StatsEmpty>Почасовых данных для {pageLabel} пока нет.</StatsEmpty> : (
        <ChartBody
          chart={<PartsBars hours rows={rows} series={series} height={240} />}
          rows={rows}
          columns={dayColumns(series, "count", { total: "Всего", hours: true })}
          rowKey={(row) => row.bucketStart}
          caption="Просмотры по часам"
        />
      )}
    </StatsCard>
  );
}
