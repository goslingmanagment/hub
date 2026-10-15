import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { StatsTrafficResponse } from "@agency_hub_core/contracts";
import { ANALYTICS_COVERAGE_PLANES } from "@agency_hub_core/shared";

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
import { buildFypMediaViewSummary } from "./traffic-metrics.js";

type TrafficRow = StatsTrafficResponse["rows"][number];

/** The chart chrome: recessive grid and axes in the theme's own colours. */
const gridProps = {
  strokeDasharray: "3 3",
  vertical: false,
  stroke: "var(--color-border)",
} as const;

const axisTick = { fontSize: 12, fill: "var(--color-text-muted)" };

const tooltipProps = {
  contentStyle: {
    backgroundColor: "var(--color-card)",
    border: "1px solid var(--color-border)",
    borderRadius: 8,
    fontSize: 13,
    color: "var(--color-text-primary)",
  },
  wrapperStyle: { zIndex: 20 },
};

/** Legend text wears the text colour; the swatch beside it carries identity. */
function legendText(value: unknown) {
  return <span style={{ color: "var(--color-text-secondary)" }}>{String(value)}</span>;
}

/** Legend and tooltip keep the series' own order (recharts sorts by name). */
function inOrder(keys: readonly string[]) {
  return (item: { dataKey?: unknown }) => keys.indexOf(String(item.dataKey));
}

/**
 * The four profile families, in the order the §2.1 census lists them, plus a
 * fifth series for codes this build cannot name.
 *
 * THE FIFTH SERIES IS NOT DECORATION. A1: an unknown or new type code is
 * journaled and SURFACED, never dropped. Folding it silently into a known
 * family — or omitting it from the chart — would make a platform change look
 * like a dip in traffic.
 */
/* Colours: the theme's Fansly blue and green, then two hues that pass the
 * colour-blind separation check against them; the unnamed source is grey. */
const FAMILY_SERIES = [
  { key: "10000", label: "Прямые и лента", color: "var(--color-fansly)" },
  { key: "44000", label: "Продвижение FYP", color: "var(--color-green)" },
  { key: "44010", label: "Рекомендации", color: "#6250d6" },
  { key: "44030", label: "Поиск", color: "var(--color-warning)" },
  { key: "unknown", label: "Неизвестный источник", color: "var(--color-text-muted)" },
] as const;

const FAMILY_ORDER = inOrder(FAMILY_SERIES.map((entry) => entry.key));
const FYP_ORDER = inOrder(["fyp", "direct"]);

type Measure = "visits" | "dwell";

const MEASURE_OPTIONS: readonly { value: Measure; label: string }[] = [
  { value: "visits", label: "Визиты" },
  { value: "dwell", label: "Время" },
];

const MEASURE_DESCRIPTION: Readonly<Record<Measure, string>> = {
  visits: "Визиты профиля по источникам — тот же счётчик, что в виджете Fansly.",
  dwell: "Время на профиле по источникам.",
};

function bucketLabel(value: unknown): string {
  return formatBucketDay(String(value));
}

/**
 * Panel 1 — traffic by source.
 *
 * The 8-code structure served as four stacked families and one measure at a
 * time. The two members are NOT summed: member 1 is a visit count and member 0
 * carries dwell with its OWN, differing view count, and the precise meaning of
 * member 0's counts is unproven. Adding them would invent a number.
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
  const [measure, setMeasure] = useState<Measure>("visits");
  const verdict = coverageBadgeVerdict(
    coverage,
    ANALYTICS_COVERAGE_PLANES.traffic,
    selectedWindow,
  );
  const data = panelData(state);

  const series = useMemo(() => {
    const buckets = new Map<string, Record<string, number | string>>();
    for (const row of data?.rows ?? []) {
      const known = row.measure !== null && row.family !== null;
      if (known && row.measure !== measure) {
        continue;
      }
      const value = measure === "visits" ? row.views : row.interactionTimeMs;
      // NULL IS NOT ZERO: a metric the platform never served contributes
      // nothing to the stack rather than a floor of zero.
      if (value === null) {
        continue;
      }
      const key = known ? row.family! : "unknown";
      const bucket = buckets.get(row.bucketStart) ?? { bucketStart: row.bucketStart };
      bucket[key] = Number(bucket[key] ?? 0) + value;
      buckets.set(row.bucketStart, bucket);
    }
    return [...buckets.values()].sort((left, right) =>
      String(left.bucketStart).localeCompare(String(right.bucketStart)));
  }, [data, measure]);

  const formatValue = measure === "visits" ? formatCount : formatDurationMs;

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
      ) : series.length === 0 ? (
        <AnalyticsEmpty
          reason={emptyPanelReason(
            verdict,
            "За этот период статистики нет.",
          )}
        />
      ) : (
        <div className="card-body">
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={series} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid {...gridProps} />
              <XAxis
                dataKey="bucketStart"
                tickFormatter={bucketLabel}
                tick={axisTick}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis
                tick={axisTick}
                tickFormatter={(value: number) => formatValue(value)}
                axisLine={false}
                tickLine={false}
                width="auto"
              />
              <Tooltip
                {...tooltipProps}
                labelFormatter={bucketLabel}
                itemSorter={FAMILY_ORDER}
                formatter={(value: unknown, name: unknown) => [formatValue(Number(value ?? 0)), String(name ?? "")]}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} formatter={legendText} itemSorter={FAMILY_ORDER} />
              {FAMILY_SERIES.map((entry) => (
                <Area
                  key={entry.key}
                  type="monotone"
                  dataKey={entry.key}
                  name={entry.label}
                  stackId="traffic"
                  stroke={entry.color}
                  strokeWidth={1.5}
                  fill={entry.color}
                  fillOpacity={0.2}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </AnalyticsPanel>
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

  const { series, sharePercent: share } = useMemo(
    () => buildFypMediaViewSummary(data?.rows ?? []),
    [data],
  );

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
        <p>
          Просмотры медиа — полные плюс просмотры превью, как в виджете Fansly. Доля FYP
          рассчитана в Hub из этих чисел: готовой доли или среднего Fansly не присылает.
        </p>
      )}
    >
      {state.status === "loading" ? (
        <AnalyticsLoading />
      ) : state.status === "error" ? (
        <AnalyticsError message={state.message} onRetry={onRetry} />
      ) : series.length === 0 ? (
        <AnalyticsEmpty
          reason={emptyPanelReason(
            verdict,
            "За этот период нет данных о просмотрах медиа.",
          )}
        />
      ) : (
        <div className="card-body">
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={series} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid {...gridProps} />
              <XAxis
                dataKey="bucketStart"
                tickFormatter={bucketLabel}
                tick={axisTick}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis
                tick={axisTick}
                tickFormatter={(value: number) => formatCount(value)}
                axisLine={false}
                tickLine={false}
                width="auto"
              />
              <Tooltip
                {...tooltipProps}
                labelFormatter={bucketLabel}
                itemSorter={FYP_ORDER}
                formatter={(value: unknown, name: unknown) => [formatCount(Number(value ?? 0)), String(name ?? "")]}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} formatter={legendText} itemSorter={FYP_ORDER} />
              <Area
                type="monotone"
                dataKey="fyp"
                name="FYP"
                stackId="media"
                stroke="var(--color-green)"
                strokeWidth={1.5}
                fill="var(--color-green)"
                fillOpacity={0.2}
              />
              <Area
                type="monotone"
                dataKey="direct"
                name="Прямые"
                stackId="media"
                stroke="var(--color-fansly)"
                strokeWidth={1.5}
                fill="var(--color-fansly)"
                fillOpacity={0.2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
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
