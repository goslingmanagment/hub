import { useMemo, useState } from "react";

import { usdAxisFormatter } from "@/components/charts/format";
import type { ChartSeries } from "@/components/charts/ChartKit";
import {
  ANALYTICS_TABLE_WRAP,
  AnalyticsEmpty,
  AnalyticsPanel,
} from "@/components/analytics/AnalyticsPanel";
import {
  formatBucketDay,
  formatCount,
  formatDurationMs,
  revenueTypeLabel,
} from "@/components/analytics/analytics-words";
import { StackedBarChart } from "@/components/shared/StackedBarChart";
import { formatDelta, formatMills } from "@/lib/format";

import { DayChart } from "./DayChart.js";
import {
  changePercent,
  coveredFrom,
  headline,
  keysByTotal,
  pivotDays,
  sourceColor,
  sourceLabel,
  windowDays,
  type CreatorStats,
  type DayPoint,
  type Kpi,
} from "./creator-stats-model.js";

const SERIES_PALETTE = [
  "var(--color-chart-blue)",
  "var(--color-chart-green)",
  "var(--color-chart-orange)",
  "var(--color-chart-violet)",
  "var(--color-chart-magenta)",
  "var(--color-chart-aqua)",
  "var(--color-chart-lime)",
];

function sourceSeries(sources: readonly number[]): ChartSeries[] {
  return [...sources].sort((a, b) => a - b).map((source) => ({ key: String(source), label: sourceLabel(source), color: sourceColor(source) }));
}

/** Bars want numbers: the days before Hub's first read are left out, not drawn as zero. */
function barRows(rows: readonly DayPoint[]): Array<Record<string, string | number>> {
  const first = rows.findIndex((row) => Object.entries(row).some(([key, value]) => key !== "bucketStart" && value !== null));
  return (first < 0 ? [] : rows.slice(first)).map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value ?? 0])) as Record<string, string | number>);
}

function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" className="segment" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

// ── headline tiles ───────────────────────────────────────────────────────────

function Change({ kpi, money = false }: { kpi: Kpi | null; money?: boolean }) {
  const pct = changePercent(kpi);
  if (kpi === null || kpi.previous === null) return <>Сравнения нет</>;
  const delta = formatDelta(pct);
  const tone = delta.direction === "up" ? "text-green" : delta.direction === "down" ? "text-danger" : "";
  const previous = money ? formatMills(kpi.previous) : formatCount(kpi.previous);
  return (
    <>
      <span className={tone}>{delta.text}</span> · было {previous}
    </>
  );
}

function Tile({ label, value, kpi, money = false, note }: {
  label: string;
  value: string;
  kpi: Kpi | null;
  money?: boolean;
  note?: string | undefined;
}) {
  return (
    <div className="stat">
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      <p className="stat-meta">{note ?? <Change kpi={kpi} money={money} />}</p>
    </div>
  );
}

function shown(value: number | null | undefined, format: (value: number) => string = formatCount): string {
  return value === null || value === undefined ? "—" : format(value);
}

export function CreatorStatsHeadline({ stats }: { stats: CreatorStats }) {
  const h = headline(stats);
  const forYou = h.uniqueViewers(0);
  const timeline = h.uniqueViewers(1);
  return (
    <div className="stat-grid">
      <Tile label="Просмотры" value={shown(h.views.value)} kpi={h.views} />
      <Tile label="Время просмотра" value={shown(h.watchMs.value, formatDurationMs)} kpi={h.watchMs} />
      <Tile
        label="Уникальные зрители"
        value={shown(forYou?.value)}
        kpi={forYou}
        note={forYou === null ? "Нет сводки за этот период" : `For You · лента ${shown(timeline?.value)}`}
      />
      <Tile label="Визиты профиля" value={shown(h.profileVisits.value)} kpi={h.profileVisits} />
      <Tile label="Новые фолловеры" value={shown(h.netFollows.value)} kpi={h.netFollows} />
      <Tile label="Подписчики" value={shown(h.subscribers.value)} kpi={h.subscribers} />
      <Tile label="Доход после комиссии" value={shown(h.netMills.value, formatMills)} kpi={h.netMills} money />
      <Tile
        label="Платящие фаны"
        value={shown(h.payingFans?.value)}
        kpi={h.payingFans}
        note={h.newPayingFans?.value != null ? `из них новых ${formatCount(h.newPayingFans.value)}` : undefined}
      />
    </div>
  );
}

// ── views ────────────────────────────────────────────────────────────────────

type ViewsMeasure = "views" | "watchMs" | "uniqueViewers";

export function ViewsPanel({ stats }: { stats: CreatorStats }) {
  const [measure, setMeasure] = useState<ViewsMeasure>("views");
  const days = windowDays(stats);
  const sources = [...new Set(stats.views.map((row) => row.source))];
  const series = sourceSeries(sources);
  const rows = useMemo(
    () => pivotDays(days, stats.views, (row) => String(row.source), (row) => row[measure], series.map((s) => s.key), coveredFrom(stats, "series:views:day")),
    [days, stats, measure, series],
  );
  return (
    <AnalyticsPanel
      wide
      title="Просмотры по источникам"
      description="Сколько раз смотрели медиа страницы: For You, лента и остальное — как на вкладке Overview в Fansly."
      headerExtra={(
        <Segmented
          label="Мера"
          value={measure}
          onChange={setMeasure}
          options={[{ value: "views", label: "Просмотры" }, { value: "watchMs", label: "Время" }, { value: "uniqueViewers", label: "Уникальные" }]}
        />
      )}
      help={(
        <>
          <p>Дневные ряды Fansly (`/account/stats/series`, семья views). Хаб перечитывает последние 14 дней каждый час.</p>
          <p>Уникальные считаются за день и по каждому источнику: человек, смотревший и в For You, и в ленте, учтён в обоих.</p>
        </>
      )}
    >
      {stats.views.length === 0 ? (
        <AnalyticsEmpty reason="Fansly ещё не прислал просмотры за этот период." />
      ) : (
        <div className="card-body">
          <DayChart rows={rows} series={series} unit={measure === "watchMs" ? "duration" : "count"} height={300} />
        </div>
      )}
    </AnalyticsPanel>
  );
}

// ── audience ─────────────────────────────────────────────────────────────────

type AudienceMeasure = "followers" | "subscribers" | "follows";

export function AudiencePanel({ stats }: { stats: CreatorStats }) {
  const [measure, setMeasure] = useState<AudienceMeasure>("followers");
  const days = windowDays(stats);
  const levelsFrom = stats.levels[0]?.day ?? null;
  const levelRows = pivotDays(days, stats.levels, () => measure === "subscribers" ? "subscribers" : "followers",
    (row) => measure === "subscribers" ? row.subscriberCount : row.followerCount, [measure === "subscribers" ? "subscribers" : "followers"], levelsFrom)
    // A level is a reading, not a count of the day: a day without one is unknown.
    .map((point) => stats.levels.some((row) => row.day === point.bucketStart) ? point : { ...point, followers: null, subscribers: null });
  const followRows = barRows(pivotDays(days, [
    ...stats.follows.map((row) => ({ day: row.day, key: "follows", value: row.follows })),
    ...stats.follows.map((row) => ({ day: row.day, key: "unfollows", value: row.unfollows === null ? null : -row.unfollows })),
  ], (row) => row.key, (row) => row.value, ["follows", "unfollows"], coveredFrom(stats, "series:follows:day")));

  return (
    <AnalyticsPanel
      title="Фолловеры и подписчики"
      description={measure === "follows" ? "Подписались и отписались за день." : "Сколько их было в конце каждого дня (UTC)."}
      headerExtra={(
        <Segmented
          label="Мера"
          value={measure}
          onChange={setMeasure}
          options={[{ value: "followers", label: "Фолловеры" }, { value: "subscribers", label: "Подписчики" }, { value: "follows", label: "За день" }]}
        />
      )}
    >
      {measure === "follows" ? (
        followRows.length === 0 ? <AnalyticsEmpty reason="Подписок и отписок за период нет." /> : (
          <div className="card-body">
            <StackedBarChart
              title=""
              data={followRows}
              xKey="bucketStart"
              series={[
                { key: "follows", label: "Подписались", color: "var(--color-chart-green)" },
                { key: "unfollows", label: "Отписались", color: "var(--color-chart-orange)" },
              ]}
              xTickFormatter={formatBucketDay}
              valueFormatter={(value) => formatCount(Math.abs(value))}
              height={260}
            />
          </div>
        )
      ) : stats.levels.length === 0 ? (
        <AnalyticsEmpty reason="Уровни за этот период ещё не собраны." />
      ) : (
        <div className="card-body">
          <DayChart
            lines
            rows={levelRows}
            series={[measure === "subscribers"
              ? { key: "subscribers", label: "Подписчики", color: "var(--color-chart-violet)" }
              : { key: "followers", label: "Фолловеры", color: "var(--color-chart-blue)" }]}
          />
        </div>
      )}
    </AnalyticsPanel>
  );
}

// ── revenue ──────────────────────────────────────────────────────────────────

export function RevenuePanel({ stats }: { stats: CreatorStats }) {
  const days = windowDays(stats);
  const labels = keysByTotal(stats.revenue, (row) => row.productLabel, (row) => row.netMills);
  const series: ChartSeries[] = labels.map((label, index) => ({
    key: label,
    label: revenueTypeLabel(label),
    color: SERIES_PALETTE[index % SERIES_PALETTE.length]!,
  }));
  const rows = barRows(pivotDays(days, stats.revenue, (row) => row.productLabel, (row) => row.netMills, labels, coveredFrom(stats, "series:revenue:day")));
  const totals = labels.map((label) => {
    const of = stats.revenue.filter((row) => row.productLabel === label);
    return {
      label,
      net: of.reduce((sum, row) => sum + (row.netMills ?? 0), 0),
      gross: of.reduce((sum, row) => sum + (row.grossMills ?? 0), 0),
      transactions: of.reduce((sum, row) => sum + (row.transactions ?? 0), 0),
      refunds: of.reduce((sum, row) => sum + (row.refunds ?? 0), 0),
    };
  });
  return (
    <AnalyticsPanel
      wide
      title="Доход по дням"
      description="После комиссии Fansly, по типам — как считает сам Fansly."
      help={<p>Дневные ряды Fansly (семья revenue). Это не леджер хаба: леджер — то, что хаб записал по транзакциям.</p>}
    >
      {stats.revenue.length === 0 ? (
        <AnalyticsEmpty reason="Дохода за этот период Fansly не прислал." />
      ) : (
        <>
          <div className="card-body">
            <StackedBarChart
              title=""
              data={rows}
              xKey="bucketStart"
              series={series}
              xTickFormatter={formatBucketDay}
              valueFormatter={(value) => formatMills(value)}
              axisFormatter={usdAxisFormatter}
              height={280}
            />
          </div>
          <div className={ANALYTICS_TABLE_WRAP}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Тип</th>
                  <th className="num">Покупок</th>
                  <th className="num">До комиссии</th>
                  <th className="num">После комиссии</th>
                  <th className="num">Возвратов</th>
                </tr>
              </thead>
              <tbody>
                {totals.map((row) => (
                  <tr key={row.label}>
                    <td>{revenueTypeLabel(row.label)}</td>
                    <td className="num">{formatCount(row.transactions)}</td>
                    <td className="num">{formatMills(row.gross)}</td>
                    <td className="num">{formatMills(row.net)}</td>
                    <td className="num">{row.refunds > 0 ? formatCount(row.refunds) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </AnalyticsPanel>
  );
}

// ── profile ──────────────────────────────────────────────────────────────────

export function ProfilePanel({ stats }: { stats: CreatorStats }) {
  const days = windowDays(stats);
  const series = sourceSeries([...new Set(stats.profile.map((row) => row.source))]);
  const rows = pivotDays(days, stats.profile, (row) => String(row.source), (row) => row.profileVisits, series.map((s) => s.key), coveredFrom(stats, "series:profile:day"));
  return (
    <AnalyticsPanel title="Визиты профиля" description="Откуда приходят на страницу.">
      {stats.profile.length === 0 ? <AnalyticsEmpty reason="Визитов за этот период Fansly не прислал." /> : (
        <div className="card-body"><DayChart rows={rows} series={series} /></div>
      )}
    </AnalyticsPanel>
  );
}

// ── engagement ───────────────────────────────────────────────────────────────

export function EngagementPanel({ stats }: { stats: CreatorStats }) {
  const days = windowDays(stats);
  const keys = ["media_likes", "post_likes", "comments"];
  const from = stats.engagement[0]?.day ?? null;
  const rows = pivotDays(days, stats.engagement, (row) => row.metric, (row) => row.value, keys, from);
  return (
    <AnalyticsPanel title="Вовлечённость" description="Лайки медиа и постов, комментарии за день.">
      {stats.engagement.length === 0 ? <AnalyticsEmpty reason="Данных о вовлечённости за этот период нет." /> : (
        <div className="card-body">
          <DayChart
            lines
            rows={rows}
            series={[
              { key: "media_likes", label: "Лайки медиа", color: "var(--color-chart-magenta)" },
              { key: "post_likes", label: "Лайки постов", color: "var(--color-chart-blue)" },
              { key: "comments", label: "Комментарии", color: "var(--color-chart-orange)" },
            ]}
          />
        </div>
      )}
    </AnalyticsPanel>
  );
}

// ── subscriptions by tier ────────────────────────────────────────────────────

export function SubscriptionsPanel({ stats }: { stats: CreatorStats }) {
  const days = windowDays(stats);
  const rows = barRows(pivotDays(days, stats.subscriptions.flatMap((row) => [
    { day: row.day, key: "new", value: row.subscriptionsNew },
    { day: row.day, key: "renewed", value: row.subscriptionsRenewed },
    { day: row.day, key: "expired", value: row.subscriptionsExpired === null ? null : -row.subscriptionsExpired },
    { day: row.day, key: "cancelled", value: row.subscriptionsCancelled === null ? null : -row.subscriptionsCancelled },
  ]), (row) => row.key, (row) => row.value, ["new", "renewed", "expired", "cancelled"], coveredFrom(stats, "series:subscriptions:day")));
  return (
    <AnalyticsPanel
      title="Подписки"
      description="Новые и продлённые — вверх, истёкшие и отменённые — вниз."
      help={<p>Все тиры вместе. «Отменённые» — выключили автопродление, подписка ещё идёт; «истёкшие» — закончилась.</p>}
    >
      {stats.subscriptions.length === 0 ? <AnalyticsEmpty reason="Изменений подписок за этот период нет." /> : (
        <div className="card-body">
          <StackedBarChart
            title=""
            data={rows}
            xKey="bucketStart"
            series={[
              { key: "new", label: "Новые", color: "var(--color-chart-green)" },
              { key: "renewed", label: "Продлённые", color: "var(--color-chart-aqua)" },
              { key: "expired", label: "Истёкшие", color: "var(--color-chart-orange)" },
              { key: "cancelled", label: "Отменённые", color: "var(--color-chart-magenta)" },
            ]}
            xTickFormatter={formatBucketDay}
            valueFormatter={(value) => formatCount(Math.abs(value))}
            height={260}
          />
        </div>
      )}
    </AnalyticsPanel>
  );
}

// ── the last hours ───────────────────────────────────────────────────────────

export function LastHoursPanel({ stats }: { stats: CreatorStats }) {
  const sources = [...new Set(stats.hourlyViews.map((row) => row.source))];
  const series = sourceSeries(sources);
  const rows = useMemo(() => {
    const hours = [...new Set(stats.hourlyViews.map((row) => row.hour))].sort();
    if (hours.length === 0) return [];
    const first = Date.parse(hours[0]!);
    const last = Date.parse(hours.at(-1)!);
    const out: DayPoint[] = [];
    for (let at = first; at <= last; at += 3_600_000) {
      const hour = new Date(at).toISOString();
      const point: DayPoint = { bucketStart: hour };
      for (const entry of series) {
        point[entry.key] = stats.hourlyViews
          .filter((row) => Date.parse(row.hour) === at && String(row.source) === entry.key)
          .reduce((sum, row) => sum + (row.views ?? 0), 0);
      }
      out.push(point);
    }
    return out;
  }, [stats.hourlyViews, series]);
  return (
    <AnalyticsPanel wide title="Последние 72 часа" description="Просмотры по часам (время московское).">
      {rows.length === 0 ? <AnalyticsEmpty reason="Почасовых данных пока нет." /> : (
        <div className="card-body"><DayChart hours rows={rows} series={series} height={240} /></div>
      )}
    </AnalyticsPanel>
  );
}
