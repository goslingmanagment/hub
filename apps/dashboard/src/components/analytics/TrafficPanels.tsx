import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { StatsTrafficResponse } from "@agency_hub_core/contracts";
import { ANALYTICS_COVERAGE_PLANES } from "@agency_hub_core/shared";

import {
  CHART_ANIMATION,
  CHART_MARGIN,
  ChartLegend,
  ChartTooltipCard,
  activeDot,
  chartGridProps,
  gapSpans,
  isolatedDot,
  lineCursor,
  useTickBudget,
  xAxisProps,
  yAxisProps,
  type ChartSeries,
  type ChartTooltipRenderProps,
} from "@/components/charts/ChartKit";
import { countAxisLabel, durationAxisLabel } from "@/components/charts/format";
import {
  durationTicks,
  evenTickIndices,
  linearTicks,
  stackedExtent,
} from "@/components/charts/scale";
import {
  panelData,
  type AnalyticsPanelState,
} from "@/pages/analytics-query-state";

import {
  AnalyticsEmpty,
  AnalyticsError,
  AnalyticsLoading,
  AnalyticsPanel,
} from "./AnalyticsPanel.js";
import {
  formatBucketDay,
  formatCount,
  formatDurationMs,
  formatPercent,
} from "./analytics-words.js";
import {
  SUGGESTIONS_DENOMINATOR_NOTE,
  coverageBadgeVerdict,
  emptyPanelReason,
  type AnalyticsCoverageWindow,
  type CoverageRow,
} from "./coverage.js";
import {
  UNKNOWN_SOURCE_KEY,
  bucketInProgress,
  buildFypMediaViewSummary,
  buildTrafficSourceRows,
  onTimeline,
  type TimelinePoint,
  type TrafficMeasure,
} from "./traffic-metrics.js";

type TrafficRow = StatsTrafficResponse["rows"][number];

/**
 * The four profile families, in the order the §2.1 census lists them, plus a
 * fifth series for codes this build cannot name.
 *
 * THE FIFTH SERIES IS NOT DECORATION. A1: an unknown or new type code is
 * journaled and SURFACED, never dropped. Folding it silently into a known
 * family — or omitting it from the chart — would make a platform change look
 * like a dip in traffic. It is drawn whenever some bucket carries one.
 */
/* Colours: the validated traffic order (blue · green · violet · orange) —
 * chart hues, never the status colours; the unnamed source is neutral grey. */
const FAMILY_SERIES: readonly ChartSeries[] = [
  { key: "10000", label: "Прямые и лента", color: "var(--color-chart-blue)" },
  { key: "44000", label: "Продвижение FYP", color: "var(--color-chart-green)" },
  { key: "44010", label: "Рекомендации", color: "var(--color-chart-violet)" },
  { key: "44030", label: "Поиск", color: "var(--color-chart-orange)" },
  { key: UNKNOWN_SOURCE_KEY, label: "Неизвестный источник", color: "var(--color-text-muted)" },
];

const FYP_SERIES: readonly ChartSeries[] = [
  { key: "fyp", label: "FYP", color: "var(--color-chart-green)" },
  { key: "direct", label: "Прямые", color: "var(--color-chart-blue)" },
];

const MEASURE_OPTIONS: readonly { value: TrafficMeasure; label: string }[] = [
  { value: "visits", label: "Визиты" },
  { value: "dwell", label: "Время" },
];

const MEASURE_DESCRIPTION: Readonly<Record<TrafficMeasure, string>> = {
  visits: "Визиты профиля по источникам — тот же счётчик, что в виджете Fansly.",
  dwell: "Время на профиле по источникам.",
};

function bucketLabel(value: unknown): string {
  return formatBucketDay(String(value));
}

/** The response came back cut even after following its pages. */
function TruncatedNote() {
  return (
    <p className="card-footer text-text-muted">
      Показана только часть периода: данных больше, чем Hub отдаёт за один запрос.
    </p>
  );
}

/**
 * A stacked area chart of daily buckets over the whole window, with the
 * console's axes, legend and tooltip. Shared by both traffic panels.
 */
function StackedTimeChart({
  rows,
  series,
  periodMs,
  unit,
  fill = false,
  height = 280,
}: {
  rows: readonly TimelinePoint[];
  series: readonly ChartSeries[];
  periodMs: number;
  unit: "count" | "duration";
  /** Grow into the card's height (never below `height`). */
  fill?: boolean;
  height?: number;
}) {
  const { budget, onResize } = useTickBudget();
  const keys = series.map((entry) => entry.key);
  const extent = stackedExtent(rows, keys);
  const yScale = unit === "duration"
    ? durationTicks(extent.max)
    : linearTicks(0, extent.max, { integer: true });
  const xTicks = evenTickIndices(rows.length, budget).map((index) => rows[index]!.bucketStart);
  const formatValue = unit === "duration" ? formatDurationMs : formatCount;
  const gaps = gapSpans(rows, "bucketStart", keys);

  const chart = (
    <ResponsiveContainer width="100%" height={fill ? "100%" : height} onResize={onResize}>
      <AreaChart data={rows as TimelinePoint[]} margin={CHART_MARGIN}>
        <CartesianGrid {...chartGridProps} />
        {gaps.map((gap) => (
          <ReferenceArea
            key={String(gap.x1)}
            x1={gap.x1 as string}
            x2={gap.x2 as string}
            fill="var(--color-text-muted)"
            fillOpacity={0.07}
            stroke="none"
            ifOverflow="hidden"
          />
        ))}
        <XAxis {...xAxisProps} dataKey="bucketStart" ticks={xTicks} tickFormatter={bucketLabel} />
        <YAxis
          {...yAxisProps}
          domain={yScale.domain}
          ticks={yScale.ticks}
          tickFormatter={unit === "duration" ? durationAxisLabel : countAxisLabel}
        />
        <Tooltip
          cursor={lineCursor}
          filterNull={false}
          isAnimationActive={false}
          wrapperStyle={{ zIndex: 20 }}
          content={(props: ChartTooltipRenderProps) => (
            <ChartTooltipCard
              {...props}
              series={series}
              formatValue={formatValue}
              formatLabel={bucketLabel}
              totalLabel="Всего"
              note={(row) => bucketInProgress(String(row.bucketStart), periodMs)
                ? "День ещё идёт — число вырастет."
                : null}
            />
          )}
        />
        {series.map((entry) => (
          <Area
            key={entry.key}
            type="monotone"
            dataKey={entry.key}
            name={entry.label}
            stackId="stack"
            stroke={entry.color}
            strokeWidth={1.5}
            fill={entry.color}
            fillOpacity={0.16}
            dot={isolatedDot(rows, entry.key, entry.color)}
            activeDot={activeDot(entry.color)}
            {...CHART_ANIMATION}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );

  return (
    <>
      <ChartLegend series={series} />
      {fill ? (
        <div className="chart-fill" style={{ ["--chart-min-height" as string]: `${height}px` }}>
          <div className="chart-fill-box">{chart}</div>
        </div>
      ) : chart}
    </>
  );
}

/**
 * Panel 1 — traffic by source.
 *
 * The 8-code structure served as four stacked families and one measure at a
 * time. The two members are NOT summed: member 1 is a visit count and member 0
 * carries dwell with its OWN, differing view count, and the precise meaning of
 * member 0's counts is unproven. Adding them would invent a number.
 *
 * The axis is the WHOLE window: a day Hub holds nothing about is a hole at its
 * date, not a day squeezed out of the timeline (see `buildTrafficSourceRows`).
 */
export function TrafficBySourcePanel({
  state,
  coverage,
  selectedWindow,
  showDenominatorNote,
  onRetry,
}: {
  state: AnalyticsPanelState<StatsTrafficResponse>;
  coverage: AnalyticsPanelState<readonly CoverageRow[]>;
  selectedWindow: AnalyticsCoverageWindow;
  /** A8: the footnote belongs to the 30-DAY view and to no other. */
  showDenominatorNote: boolean;
  onRetry: () => void;
}) {
  const [measure, setMeasure] = useState<TrafficMeasure>("visits");
  const verdict = coverageBadgeVerdict(
    coverage,
    ANALYTICS_COVERAGE_PLANES.traffic,
    selectedWindow,
  );
  const data = panelData(state);

  const chart = useMemo(() => buildTrafficSourceRows(data, measure), [data, measure]);
  const series = useMemo(
    () => FAMILY_SERIES.filter((entry) => chart.keys.includes(entry.key)),
    [chart.keys],
  );

  return (
    <AnalyticsPanel
      title="Трафик по источникам"
      description={MEASURE_DESCRIPTION[measure]}
      verdict={verdict}
      cached={state.status === "ready" && state.refreshFailed}
      wide
      help={(
        <>
          <p>
            Визиты и время — два разных ряда Fansly. Они не складываются: у времени
            свой счётчик просмотров, и сумма дала бы число, которого нет.
          </p>
          <p>
            День, за который Hub ничего не собрал, — разрыв на графике, а не ноль.
            Источник, которого нет в собранном дне, — ноль: Fansly присылает только
            источники, у которых в этот день был трафик.
          </p>
          <p>
            «Неизвестный источник» — новый код Fansly, который Hub пока не умеет
            называть. Он показан отдельно, а не спрятан, чтобы изменение на стороне
            Fansly не выглядело как падение трафика.
          </p>
          {showDenominatorNote ? <p>{SUGGESTIONS_DENOMINATOR_NOTE}</p> : null}
        </>
      )}
      headerExtra={(
        <div className="segmented" role="group" aria-label="Показатель">
          {MEASURE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="segment"
              aria-pressed={measure === option.value}
              onClick={() => setMeasure(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    >
      {state.status === "loading" ? (
        <AnalyticsLoading />
      ) : state.status === "error" ? (
        <AnalyticsError message={state.message} onRetry={onRetry} />
      ) : chart.servedBuckets === 0 ? (
        <AnalyticsEmpty
          reason={emptyPanelReason(
            verdict,
            "За этот период статистики нет.",
          )}
        />
      ) : (
        <>
          <div className="card-body">
            <StackedTimeChart
              rows={chart.rows}
              series={series}
              periodMs={data?.window.periodMs ?? 86_400_000}
              unit={measure === "dwell" ? "duration" : "count"}
            />
          </div>
          {data?.nextCursor ? <TruncatedNote /> : null}
        </>
      )}
    </AnalyticsPanel>
  );
}

/** One figure of the FYP panel's summary strip. */
function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-text-secondary">{label}</div>
      <div className="mt-0.5 text-[15px] font-semibold text-text-primary">{value}</div>
    </div>
  );
}

/**
 * Panel 2 — FYP against direct, on MEDIA views, plus the FYP share.
 *
 * The share is ours, computed at read time from each source's full + preview
 * views, and it says so. A13: the platform serves no averages and no shares;
 * anything of that shape in this system was computed here.
 */
export function FypSharePanel({
  state,
  coverage,
  selectedWindow,
  onRetry,
}: {
  state: AnalyticsPanelState<StatsTrafficResponse>;
  coverage: AnalyticsPanelState<readonly CoverageRow[]>;
  selectedWindow: AnalyticsCoverageWindow;
  onRetry: () => void;
}) {
  const verdict = coverageBadgeVerdict(coverage, ANALYTICS_COVERAGE_PLANES.fyp, selectedWindow);
  const data = panelData(state);

  const summary = useMemo(() => {
    const built = buildFypMediaViewSummary(data?.rows ?? []);
    return {
      ...built,
      rows: data === undefined ? [] : onTimeline(data.window, built.series) as TimelinePoint[],
    };
  }, [data]);
  const share = summary.sharePercent;

  return (
    <AnalyticsPanel
      title="Просмотры: FYP и прямые"
      verdict={verdict}
      cached={state.status === "ready" && state.refreshFailed}
      headerExtra={share === null ? null : (
        <span className="text-[13px] text-text-secondary">
          Доля FYP{" "}
          <span className="font-semibold tabular-nums text-text-primary">{formatPercent(share)}</span>
          <span className="ml-1 text-text-muted">· рассчитано Hub</span>
        </span>
      )}
      help={(
        <>
          <p>
            Просмотры медиа — полные плюс просмотры превью, как в виджете Fansly. Доля FYP
            рассчитана в Hub из этих чисел: готовой доли или среднего Fansly не присылает.
          </p>
          <p>День, за который Hub ничего не собрал, — разрыв на графике, а не ноль.</p>
        </>
      )}
    >
      {state.status === "loading" ? (
        <AnalyticsLoading />
      ) : state.status === "error" ? (
        <AnalyticsError message={state.message} onRetry={onRetry} />
      ) : summary.series.length === 0 ? (
        <AnalyticsEmpty
          reason={emptyPanelReason(
            verdict,
            "За этот период нет данных о просмотрах медиа.",
          )}
        />
      ) : (
        <>
          <div className="card-body flex flex-1 flex-col">
            <div className="mb-4 grid grid-cols-3 gap-4 border-b border-border-light pb-4">
              <Figure label="Из FYP" value={summary.fypTotal === null ? "—" : formatCount(summary.fypTotal)} />
              <Figure label="Прямые" value={summary.directTotal === null ? "—" : formatCount(summary.directTotal)} />
              <Figure
                label="Всего"
                value={summary.fypTotal === null || summary.directTotal === null
                  ? "—"
                  : formatCount(summary.fypTotal + summary.directTotal)}
              />
            </div>
            <StackedTimeChart
              rows={summary.rows}
              series={FYP_SERIES}
              periodMs={data?.window.periodMs ?? 86_400_000}
              unit="count"
              fill
              height={240}
            />
          </div>
          {data?.nextCursor ? <TruncatedNote /> : null}
        </>
      )}
    </AnalyticsPanel>
  );
}

/**
 * The account-level watch figure, and the ONLY place this page shows one.
 *
 * `totalVideoPercentWatched` is a SUM over views on the wire, so the average is
 * `sum / videoViews` — computed here, from components, labelled Hub-derived,
 * and shown only where BOTH components were actually served. It is never shown
 * per media offer: [E5] found the per-media route serves no video fields at
 * all, so a per-media watch figure would be an invention.
 */
export function accountWatchAverage(rows: readonly TrafficRow[] | undefined): number | null {
  let sum = 0;
  let views = 0;
  for (const row of rows ?? []) {
    if (row.videoPercentWatchedSum === null || row.videoViews === null) {
      continue;
    }
    sum += Number(row.videoPercentWatchedSum);
    views += row.videoViews;
  }
  return views > 0 ? sum / views : null;
}
