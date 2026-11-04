import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { CreatorStatsContentResponse, CreatorStatsMediaResponse } from "@agency_hub_core/contracts";
import { useCreatorStatsMedia, type CreatorStatsDays } from "@/api/creator-stats";
import { useMediaSales } from "@/api/insights";
import {
  CHART_ANIMATION,
  CHART_MARGIN,
  ChartLegend,
  ChartTooltipCard,
  activeDot,
  chartGridProps,
  lineCursor,
  xAxisProps,
  yAxisProps,
  type ChartSeries,
  type ChartTooltipRenderProps,
} from "@/components/charts/ChartKit";
import { businessDateRange } from "@/components/charts/scale";
import { StackedBarChart } from "@/components/shared/StackedBarChart";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { Drawer } from "@/components/ui/Drawer";
import { KeyValue } from "@/components/ui/KeyValue";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatCount, formatMills, formatPercent } from "@/lib/format";

import {
  averageWatchPercent,
  barRows,
  formatStatsDay,
  formatStatsHour,
  formatStatsRange,
  pivotDays,
  share,
  sourceColor,
  sourceLabel,
  type DayPoint,
  type StatsWindow,
} from "./creator-stats-model.js";
import { fanslyPostUrl, mediaLine, mediaTitle, type MediaHead } from "./media-words.js";

type MediaRow = CreatorStatsContentResponse["media"][number];
type SoldRow = CreatorStatsContentResponse["topSales"][number];

/** Fewer viewers than this make a retention curve noise. */
const RETENTION_MIN_SAMPLE = 5;
const TAGS_SHOWN = 20;

function count(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : formatCount(value);
}

function percent(value: number | null): string {
  return value === null ? "—" : formatPercent(value);
}

function sourceSeries(sources: Iterable<number>): ChartSeries[] {
  return [...new Set(sources)].sort((a, b) => a - b).map((source) => ({ key: String(source), label: sourceLabel(source), color: sourceColor(source) }));
}

function RetentionChart({ curves }: { curves: CreatorStatsMediaResponse["retention"] }) {
  const legend: ChartSeries[] = curves.map((curve) => ({
    key: String(curve.source),
    label: curve.sampleSize === null ? sourceLabel(curve.source) : `${sourceLabel(curve.source)}, ${formatCount(curve.sampleSize)} зрителей`,
    color: sourceColor(curve.source),
  }));
  const series = curves.map((curve) => ({ key: String(curve.source), label: sourceLabel(curve.source), color: sourceColor(curve.source) }));
  const rows = useMemo(() => {
    const percents = [...new Set(curves.flatMap((curve) => curve.points.map((point) => point.percent)))].sort((a, b) => a - b);
    return percents.map((at) => {
      const row: Record<string, number | null> = { percent: at };
      for (const curve of curves) {
        const point = curve.points.find((entry) => entry.percent === at);
        row[String(curve.source)] = point === undefined ? null : Math.round(point.stillWatching * 100);
      }
      return row;
    });
  }, [curves]);
  return (
    <>
      <ChartLegend series={legend} />
      {legend.length === 1 && <p className="stats-drawer-note">{legend[0]!.label}</p>}
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={rows} margin={CHART_MARGIN}>
          <CartesianGrid {...chartGridProps} />
          <XAxis {...xAxisProps} dataKey="percent" type="number" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(value: number) => `${value} %`} />
          <YAxis {...yAxisProps} domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(value: number) => `${value} %`} />
          <Tooltip
            cursor={lineCursor}
            isAnimationActive={false}
            wrapperStyle={{ zIndex: 20 }}
            content={(props: ChartTooltipRenderProps) => (
              <ChartTooltipCard
                {...props}
                series={series}
                formatLabel={(label) => `${label} % видео`}
                formatValue={(value) => `${value} % ещё смотрят`}
              />
            )}
          />
          {series.map((entry) => (
            <Line key={entry.key} type="linear" dataKey={entry.key} name={entry.label} stroke={entry.color} strokeWidth={2} dot={false} activeDot={activeDot(entry.color)} connectNulls {...CHART_ANIMATION} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </>
  );
}

/**
 * The card of one media, `?media=` in the address: a panel on the right, the list
 * stays behind it. The period's numbers come from the list's row; the days,
 * retention, first hours and tags from `creatorStatsMedia`; the sales, all time,
 * from the catalog's head, asked once when it opens.
 */
export function MediaDrawer({ mediaOfferId, pageLabel, days, window, row, sold, onClose }: {
  mediaOfferId: string;
  pageLabel: string;
  days: CreatorStatsDays;
  window: StatsWindow;
  row: MediaRow | null;
  sold: SoldRow | null;
  onClose: () => void;
}) {
  const detail = useCreatorStatsMedia(pageLabel, mediaOfferId, days);
  const salesWindow = useMemo(() => ({
    from: `${window.fromDay}T00:00:00.000Z`,
    to: new Date(Date.parse(`${window.toDay}T00:00:00Z`) + 86_400_000).toISOString(),
  }), [window.fromDay, window.toDay]);
  const sales = useMediaSales(pageLabel, mediaOfferId, salesWindow);
  const catalog = sales.data?.media[0] ?? null;

  const head: MediaHead | null = row ?? sold ?? (catalog
    ? { mediaType: catalog.mediaType, durationMs: catalog.durationMs, caption: null, postedAt: catalog.createdAtPlatform, deletedAt: catalog.deletedAtPlatform }
    : null);
  const postId = row?.postId ?? sold?.postId ?? null;
  const notFound = head === null && sales.data !== undefined && sales.data.media.length === 0 && (detail.isError || (detail.data !== undefined && detail.data.daily.length === 0));

  const data = detail.data;
  const daily = useMemo(() => {
    if (!data) return { rows: [] as DayPoint[], series: [] as ChartSeries[] };
    const series = sourceSeries(data.daily.map((entry) => entry.source));
    const from = data.daily.map((entry) => entry.day).sort()[0] ?? null;
    const dayList = businessDateRange(data.window.fromDay, data.window.toDay).filter((day) => from === null || day >= from);
    return { rows: pivotDays(dayList, data.daily, (entry) => String(entry.source), (entry) => entry.views, series.map((s) => s.key), from), series };
  }, [data]);
  const hourly = useMemo(() => {
    if (!data || data.hourly.length === 0) return { rows: [] as DayPoint[], series: [] as ChartSeries[] };
    const series = sourceSeries(data.hourly.map((entry) => entry.source));
    const hours = [...new Set(data.hourly.map((entry) => entry.hour))].sort();
    const rows = hours.map((hour) => {
      const point: DayPoint = { bucketStart: hour };
      for (const entry of series) {
        point[entry.key] = data.hourly.filter((item) => item.hour === hour && String(item.source) === entry.key).reduce((sum, item) => sum + (item.views ?? 0), 0);
      }
      return point;
    });
    return { rows, series };
  }, [data]);
  const curves = data?.retention.filter((curve) => curve.points.length > 0 && (curve.sampleSize ?? 0) >= RETENTION_MIN_SAMPLE) ?? [];

  const title = head ? mediaTitle(head) : notFound ? "Медиа не найдено" : "Медиа";
  const watch = row ? averageWatchPercent(row.watchPctSum, row.videoViews) : null;
  const completion = row ? share(row.completedViews, row.videoViews) : null;
  const period = formatStatsRange(window.fromDay, window.toDay);
  const other = row?.otherViews ?? null;

  return (
    <Drawer title={title} onClose={onClose}>
      {notFound ? (
        <p className="stats-drawer-text">Такого медиа на {pageLabel} нет.</p>
      ) : (
        <div className="stats-drawer">
          <div className="stats-drawer-head">
            {head ? <p className="stats-drawer-line">{mediaLine(head, { posted: true })}</p> : <Skeleton width={180} />}
            <p className="stats-drawer-line">
              {postId ? <a className="link" href={fanslyPostUrl(postId)} target="_blank" rel="noreferrer">Открыть пост на Fansly</a> : "пост не найден"}
            </p>
          </div>

          <section aria-labelledby="media-period">
            <h3 className="stats-drawer-title" id="media-period">За период, {period}</h3>
            {row === null && <p className="stats-drawer-note">В списке этого периода его нет.</p>}
            <div className="stats-kv-pair">
              <KeyValue rows={[
                { label: "Просмотры", value: count(row?.views) },
                { label: "For You", value: count(row?.forYouViews) },
                { label: "Лента подписок", value: count(row?.timelineViews) },
                ...(other !== null && other > 0 ? [{ label: "Другое", value: count(other) }] : []),
              ]} />
              <KeyValue rows={[
                { label: "Досмотр", value: percent(watch) },
                { label: "До конца", value: percent(completion) },
                { label: "Лайки", value: count(row?.likes) },
                { label: "За всё время", value: count(row?.allTimeViews) },
              ]} />
            </div>
          </section>

          <section aria-labelledby="media-sales">
            <h3 className="stats-drawer-title" id="media-sales">Продажи, за всё время</h3>
            {sales.data === undefined ? (
              sales.isError ? (
                <p className="stats-drawer-text">— Hub не ответил. <button type="button" className="link" onClick={() => void sales.refetch()}>Повторить</button></p>
              ) : <Skeleton width={260} />
            ) : catalog === null || catalog.sales.count === null || catalog.sales.count === 0 ? (
              <p className="stats-drawer-text">Продаж нет{catalog?.priceMills != null ? `, цена ${formatMills(catalog.priceMills)}` : ""}.</p>
            ) : (
              <div className="stats-kv-pair">
                <KeyValue rows={[
                  { label: "Цена", value: catalog.priceMills === null ? "—" : formatMills(catalog.priceMills) },
                  { label: "Продано", value: formatCount(catalog.sales.count) },
                ]} />
                <KeyValue rows={[
                  { label: "После комиссии", value: catalog.sales.netMills === null ? "—" : formatMills(catalog.sales.netMills) },
                  { label: "До комиссии, расчёт", value: catalog.sales.grossMills === null ? "—" : <span className="muted">{formatMills(catalog.sales.grossMills.value)}</span> },
                ]} />
              </div>
            )}
          </section>

          {data === undefined ? (
            detail.isError ? <NoAnswerPanel retry={() => detail.refetch()} /> : (
              <div className="grid gap-3"><Skeleton width="100%" className="stats-skeleton-chart" /></div>
            )
          ) : (
            <>
              <section aria-labelledby="media-days">
                <h3 className="stats-drawer-title" id="media-days">Просмотры по дням</h3>
                {data.daily.length === 0 ? <p className="stats-drawer-text">Нет дневных данных за период.</p> : (
                  <StackedBarChart
                    title=""
                    data={barRows(daily.rows)}
                    xKey="bucketStart"
                    series={daily.series}
                    xTickFormatter={formatStatsDay}
                    valueFormatter={(value) => formatCount(value)}
                    tickSpacing={{ spacing: 72, max: 6 }}
                    totalLabel="Всего"
                    height={200}
                  />
                )}
              </section>
              <section aria-labelledby="media-retention">
                <h3 className="stats-drawer-title" id="media-retention">Удержание</h3>
                {curves.length === 0
                  ? <p className="stats-drawer-text">Кривой удержания нет: фото или меньше {RETENTION_MIN_SAMPLE} зрителей.</p>
                  : <RetentionChart curves={curves} />}
              </section>
              {hourly.rows.length > 0 && (
                <section aria-labelledby="media-hours">
                  <h3 className="stats-drawer-title" id="media-hours">Первые часы</h3>
                  <StackedBarChart
                    title=""
                    data={barRows(hourly.rows)}
                    xKey="bucketStart"
                    series={hourly.series}
                    xTickFormatter={formatStatsHour}
                    valueFormatter={(value) => formatCount(value)}
                    tickSpacing={{ spacing: 120, max: 4 }}
                    totalLabel="Всего"
                    height={180}
                  />
                </section>
              )}
              {data.tags.length > 0 && (
                <section aria-labelledby="media-tags">
                  <h3 className="stats-drawer-title" id="media-tags">По каким тегам находили</h3>
                  <ul className="stats-tag-list">
                    {data.tags.slice(0, TAGS_SHOWN).map((tag) => (
                      <li key={`${tag.tag}-${tag.source}`}>
                        #{tag.tag} <span className="tabular-nums">{count(tag.views)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}
