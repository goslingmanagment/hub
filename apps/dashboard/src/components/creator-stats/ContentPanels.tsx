import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { CreatorStatsContentResponse, CreatorStatsMediaResponse } from "@agency_hub_core/contracts";

import { useCreatorStatsMedia } from "@/api/creator-stats";
import {
  CHART_ANIMATION,
  CHART_MARGIN,
  ChartLegend,
  chartGridProps,
  lineCursor,
  xAxisProps,
  yAxisProps,
  type ChartSeries,
} from "@/components/charts/ChartKit";
import {
  ANALYTICS_TABLE_WRAP,
  AnalyticsEmpty,
  AnalyticsError,
  AnalyticsLoading,
  AnalyticsPanel,
} from "@/components/analytics/AnalyticsPanel";
import { formatBucketDay, formatCount, formatDurationMs, formatPercent } from "@/components/analytics/analytics-words";
import { ModalShell } from "@/components/shared/ModalShell";
import { businessDateRange } from "@/components/charts/scale";

import { DayChart } from "./DayChart.js";
import { pivotDays, sourceColor, sourceLabel, type DayPoint } from "./creator-stats-model.js";

type MediaRow = CreatorStatsContentResponse["media"][number];

/** Average share of the video watched, 0–100: the sum of watched shares in
 *  hundredths of a percent over the video views (map §4). */
export function averageWatchPercent(watchPctSum: number | null, videoViews: number | null): number | null {
  if (watchPctSum === null || videoViews === null || videoViews === 0) return null;
  return watchPctSum / videoViews / 100;
}

function share(part: number | null, whole: number | null): number | null {
  return part === null || whole === null || whole === 0 ? null : (part / whole) * 100;
}

function mediaTitle(row: MediaRow): string {
  const caption = row.caption?.replace(/\s+/g, " ").trim();
  if (caption) return caption.length > 70 ? `${caption.slice(0, 70)}…` : caption;
  return row.mediaType === 2 ? "Видео без подписи" : row.mediaType === 1 ? "Фото без подписи" : `Медиа ${row.mediaOfferId}`;
}

function mediaKind(row: MediaRow): string {
  if (row.mediaType === 2) return row.durationMs ? `видео · ${formatDurationMs(row.durationMs)}` : "видео";
  if (row.mediaType === 1) return "фото";
  return "медиа";
}

type SortKey = "views" | "forYouViews" | "timelineViews" | "watch" | "completion" | "likes" | "postedAt";

const SORTS: readonly { key: SortKey; label: string }[] = [
  { key: "views", label: "Просмотры" },
  { key: "forYouViews", label: "For You" },
  { key: "watch", label: "Досмотр" },
  { key: "likes", label: "Лайки" },
  { key: "postedAt", label: "Новые" },
];

function sortValue(row: MediaRow, key: SortKey): number {
  switch (key) {
    case "watch": return averageWatchPercent(row.watchPctSum, row.videoViews) ?? -1;
    case "completion": return share(row.completedViews, row.videoViews) ?? -1;
    case "postedAt": return row.postedAt ? Date.parse(row.postedAt) : 0;
    default: return row[key] ?? -1;
  }
}

/** The page's media of the window, most viewed first; a row opens its card. */
export function ContentPanel({ data, pageLabel, days }: { data: CreatorStatsContentResponse; pageLabel: string; days: 7 | 30 | 90 }) {
  const [sort, setSort] = useState<SortKey>("views");
  const [open, setOpen] = useState<MediaRow | null>(null);
  const [kind, setKind] = useState<"all" | "video" | "image">("all");
  const rows = useMemo(
    () => data.media
      .filter((row) => kind === "all" || (kind === "video" ? row.mediaType === 2 : row.mediaType === 1))
      .sort((a, b) => sortValue(b, sort) - sortValue(a, sort)),
    [data.media, sort, kind],
  );
  return (
    <AnalyticsPanel
      wide
      title="Медиа за период"
      description="Что смотрели: просмотры по источникам, досмотр и лайки. Нажмите на строку — откроется карточка медиа."
      headerExtra={(
        <>
          <div className="segmented" role="group" aria-label="Тип">
            {([["all", "Все"], ["video", "Видео"], ["image", "Фото"]] as const).map(([value, label]) => (
              <button key={value} type="button" className="segment" aria-pressed={kind === value} onClick={() => setKind(value)}>{label}</button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[13px] text-text-secondary">
            Сортировка
            <select className="select w-auto" value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
              {SORTS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
            </select>
          </label>
        </>
      )}
      help={(
        <>
          <p>Строки — дневные ряды Fansly по каждому медиа (`/account/stats/media`), сложенные за период. Хаб обходит медиа само: новые — каждые 6 часов, до 30 дней — ежедневно, старше — реже.</p>
          <p>Досмотр — средняя доля видео, которую посмотрели. «Всего за всё время» — итог Fansly по прочитанным источникам.</p>
        </>
      )}
    >
      {rows.length === 0 ? (
        <AnalyticsEmpty reason="Просмотров медиа за этот период ещё нет: обход только начался или медиа не смотрели." />
      ) : (
        <div className={ANALYTICS_TABLE_WRAP}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Медиа</th>
                <th className="num">For You</th>
                <th className="num">Лента</th>
                <th className="num">Другое</th>
                <th className="num">Всего</th>
                <th className="num">Досмотр</th>
                <th className="num">До конца</th>
                <th className="num">Лайки</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 100).map((row) => {
                const watch = averageWatchPercent(row.watchPctSum, row.videoViews);
                const completion = share(row.completedViews, row.videoViews);
                return (
                  <tr key={row.mediaOfferId} className="cursor-pointer" onClick={() => setOpen(row)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") setOpen(row); }}>
                    <td>
                      <div className="font-medium text-text-primary">{mediaTitle(row)}</div>
                      <div className="text-xs text-text-muted">
                        {mediaKind(row)}{row.postedAt ? ` · ${formatBucketDay(row.postedAt)}` : ""}
                      </div>
                    </td>
                    <td className="num">{row.forYouViews === null ? "—" : formatCount(row.forYouViews)}</td>
                    <td className="num">{row.timelineViews === null ? "—" : formatCount(row.timelineViews)}</td>
                    <td className="num">{row.otherViews === null ? "—" : formatCount(row.otherViews)}</td>
                    <td className="num font-medium">{row.views === null ? "—" : formatCount(row.views)}</td>
                    <td className="num">{watch === null ? "—" : formatPercent(watch)}</td>
                    <td className="num">{completion === null ? "—" : formatPercent(completion)}</td>
                    <td className="num">{row.likes === null ? "—" : formatCount(row.likes)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {open ? <MediaCard pageLabel={pageLabel} days={days} media={open} onClose={() => setOpen(null)} /> : null}
    </AnalyticsPanel>
  );
}

function RetentionChart({ curves }: { curves: CreatorStatsMediaResponse["retention"] }) {
  const series: ChartSeries[] = curves.map((curve) => ({ key: String(curve.source), label: sourceLabel(curve.source), color: sourceColor(curve.source) }));
  const rows = useMemo(() => {
    const percents = [...new Set(curves.flatMap((curve) => curve.points.map((point) => point.percent)))].sort((a, b) => a - b);
    return percents.map((percent) => {
      const row: Record<string, number | null> = { percent };
      for (const curve of curves) {
        const point = curve.points.find((entry) => entry.percent === percent);
        row[String(curve.source)] = point === undefined ? null : Math.round(point.stillWatching * 1000) / 10;
      }
      return row;
    });
  }, [curves]);
  return (
    <>
      <ChartLegend series={series} />
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={rows} margin={CHART_MARGIN}>
          <CartesianGrid {...chartGridProps} />
          <XAxis {...xAxisProps} dataKey="percent" type="number" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(value) => `${value}%`} />
          <YAxis {...yAxisProps} domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(value) => `${value}%`} />
          <Tooltip
            cursor={lineCursor}
            isAnimationActive={false}
            formatter={(value, name) => [`${String(value)}% ещё смотрят`, String(name)]}
            labelFormatter={(label) => `${label}% видео`}
          />
          {series.map((entry) => (
            <Line key={entry.key} type="monotone" dataKey={entry.key} name={entry.label} stroke={entry.color} strokeWidth={2} dot={false} connectNulls {...CHART_ANIMATION} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </>
  );
}

function MediaCard({ pageLabel, days, media, onClose }: { pageLabel: string; days: 7 | 30 | 90; media: MediaRow; onClose: () => void }) {
  const detail = useCreatorStatsMedia(pageLabel, media.mediaOfferId, days);
  const data = detail.data;
  const daily = useMemo(() => {
    if (!data) return { rows: [] as DayPoint[], series: [] as ChartSeries[] };
    const sources = [...new Set(data.daily.map((row) => row.source))].sort((a, b) => a - b);
    const keys = sources.map(String);
    const from = data.daily[0]?.day ?? null;
    const daysOf = businessDateRange(data.window.fromDay, data.window.toDay).filter((day) => from === null || day >= from);
    return {
      rows: pivotDays(daysOf, data.daily, (row) => String(row.source), (row) => row.views, keys, from),
      series: sources.map((source) => ({ key: String(source), label: sourceLabel(source), color: sourceColor(source) })),
    };
  }, [data]);
  const hourly = useMemo(() => {
    if (!data || data.hourly.length === 0) return { rows: [] as DayPoint[], series: [] as ChartSeries[] };
    const sources = [...new Set(data.hourly.map((row) => row.source))].sort((a, b) => a - b);
    const hours = [...new Set(data.hourly.map((row) => row.hour))].sort();
    const rows = hours.map((hour) => {
      const point: DayPoint = { bucketStart: hour };
      for (const source of sources) {
        point[String(source)] = data.hourly.filter((row) => row.hour === hour && row.source === source).reduce((sum, row) => sum + (row.views ?? 0), 0);
      }
      return point;
    });
    return { rows, series: sources.map((source) => ({ key: String(source), label: sourceLabel(source), color: sourceColor(source) })) };
  }, [data]);
  const watch = averageWatchPercent(media.watchPctSum, media.videoViews);
  const postUrl = media.postId ? `https://fansly.com/post/${media.postId}` : null;

  return (
    <ModalShell title={mediaTitle(media)} onClose={onClose} wide>
      <div className="space-y-5">
        <div className="stat-grid">
          <div className="stat"><p className="stat-label">Просмотры за период</p><p className="stat-value">{media.views === null ? "—" : formatCount(media.views)}</p><p className="stat-meta">{mediaKind(media)}{media.postedAt ? ` · опубликовано ${formatBucketDay(media.postedAt)}` : ""}</p></div>
          <div className="stat"><p className="stat-label">For You</p><p className="stat-value">{media.forYouViews === null ? "—" : formatCount(media.forYouViews)}</p><p className="stat-meta">лента — {media.timelineViews === null ? "—" : formatCount(media.timelineViews)}</p></div>
          <div className="stat"><p className="stat-label">Досмотр</p><p className="stat-value">{watch === null ? "—" : formatPercent(watch)}</p><p className="stat-meta">до конца — {formatPercent(share(media.completedViews, media.videoViews) ?? 0)}</p></div>
          <div className="stat"><p className="stat-label">За всё время</p><p className="stat-value">{media.allTimeViews === null ? "—" : formatCount(media.allTimeViews)}</p><p className="stat-meta">{postUrl ? <a className="link" href={postUrl} target="_blank" rel="noreferrer">открыть пост на Fansly</a> : "пост не найден"}</p></div>
        </div>
        {detail.isPending ? <AnalyticsLoading /> : detail.isError || !data ? (
          <AnalyticsError message="Не удалось загрузить карточку медиа." onRetry={() => void detail.refetch()} />
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            <section>
              <h3 className="mb-2 text-[14px] font-semibold text-text-primary">Просмотры по дням</h3>
              {daily.rows.length === 0 ? <p className="text-text-muted">Нет дневных данных за период.</p> : <DayChart rows={daily.rows} series={daily.series} height={220} />}
            </section>
            <section>
              <h3 className="mb-2 text-[14px] font-semibold text-text-primary">Удержание</h3>
              {data.retention.every((curve) => curve.points.length === 0)
                ? <p className="text-text-muted">Кривой удержания нет (фото или мало просмотров).</p>
                : <RetentionChart curves={data.retention.filter((curve) => curve.points.length > 0)} />}
            </section>
            {hourly.rows.length > 0 ? (
              <section>
                <h3 className="mb-2 text-[14px] font-semibold text-text-primary">Первые часы</h3>
                <DayChart hours rows={hourly.rows} series={hourly.series} height={200} />
              </section>
            ) : null}
            {data.tags.length > 0 ? (
              <section>
                <h3 className="mb-2 text-[14px] font-semibold text-text-primary">По каким тегам находили</h3>
                <ul className="flex flex-wrap gap-2">
                  {data.tags.slice(0, 20).map((tag) => (
                    <li key={`${tag.tag}-${tag.source}`} className="rounded-full border border-border px-2.5 py-1 text-[13px]">
                      #{tag.tag} <span className="text-text-muted">{tag.views === null ? "" : formatCount(tag.views)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        )}
      </div>
    </ModalShell>
  );
}
