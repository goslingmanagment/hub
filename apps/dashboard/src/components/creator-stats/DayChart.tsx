import type { ReactNode } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  CHART_ANIMATION,
  CHART_MARGIN,
  ChartLegend,
  ChartTooltipCard,
  activeDot,
  chartGridProps,
  isolatedDot,
  lineCursor,
  useTickBudget,
  xAxisProps,
  yAxisProps,
  type ChartSeries,
  type ChartTooltipRenderProps,
  edgeAnchoredTick,
} from "@/components/charts/ChartKit";
import { countAxisLabel, durationAxisLabel } from "@/components/charts/format";
import { durationTicks, evenTickIndices, linearTicks, niceStep, stackedExtent } from "@/components/charts/scale";
import { formatCount } from "@/lib/format";

import { formatStatsDay, formatStatsHour, formatWatchTime, type DayPoint } from "./creator-stats-model.js";

function dayLabel(value: unknown): string {
  return formatStatsDay(String(value));
}

function hourLabel(value: unknown): string {
  return formatStatsHour(String(value));
}

/** A line of levels (followers, subscribers) is read for its movement: the
 *  axis spans the values, not zero to the top. */
function levelTicks(values: readonly number[]): { domain: [number, number]; ticks: number[] } {
  if (values.length === 0) return { domain: [0, 1], ticks: [0, 1] };
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const step = niceStep(Math.max(hi - lo, 1) / 4, true);
  const start = Math.floor(lo / step) * step;
  const end = Math.max(Math.ceil(hi / step) * step, start + step);
  const ticks: number[] = [];
  for (let at = start; at <= end; at += step) ticks.push(at);
  return { domain: [start, end], ticks };
}

/**
 * Days (or hours) on the x axis: one line per series when `lines` (levels and
 * uniques do not add up), otherwise stacked areas (kept for the page card's
 * screens). A null is a day Hub has not read and is drawn as a hole; a zero is a
 * day Fansly counted nothing. Lines are straight segments: no humps that were not.
 */
export function DayChart({
  rows,
  series,
  unit = "count",
  lines = false,
  hours = false,
  height = 260,
  totalLabel = "Всего",
  fromZero = false,
  note,
}: {
  rows: readonly DayPoint[];
  series: readonly ChartSeries[];
  unit?: "count" | "duration";
  lines?: boolean;
  hours?: boolean;
  height?: number;
  totalLabel?: string | undefined;
  /** Lines of counts that are not levels start at zero. */
  fromZero?: boolean;
  /** A line under the tooltip's values, for the hovered row. */
  note?: ((row: Record<string, unknown>) => ReactNode) | undefined;
}) {
  const { budget, onResize } = useTickBudget(hours ? 110 : 72, 7);
  const keys = series.map((entry) => entry.key);
  const values = rows.flatMap((row) => keys.map((key) => row[key]).filter((value): value is number => typeof value === "number"));
  const yScale = lines
    ? fromZero
      ? linearTicks(0, Math.max(0, ...values), { integer: true })
      : levelTicks(values)
    : (() => {
      const extent = stackedExtent(rows, keys);
      return unit === "duration" ? durationTicks(extent.max) : linearTicks(extent.min, extent.max, { integer: true });
    })();
  const xTicks = evenTickIndices(rows.length, budget).map((index) => rows[index]!.bucketStart);
  const formatValue = unit === "duration" ? formatWatchTime : (value: number) => formatCount(value);
  const formatX = hours ? hourLabel : dayLabel;

  const tooltip = (
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
          formatLabel={formatX}
          totalLabel={lines ? undefined : totalLabel}
          note={note}
        />
      )}
    />
  );
  const axes = (
    <>
      <CartesianGrid {...chartGridProps} />
      <XAxis {...xAxisProps} dataKey="bucketStart" ticks={xTicks} tickFormatter={formatX} {...(hours ? { tick: edgeAnchoredTick(formatX, xTicks.at(-1)) } : {})} />
      <YAxis
        {...yAxisProps}
        domain={yScale.domain}
        ticks={yScale.ticks}
        tickFormatter={unit === "duration" ? durationAxisLabel : countAxisLabel}
      />
    </>
  );

  return (
    <>
      <ChartLegend series={series} />
      <ResponsiveContainer width="100%" height={height} onResize={onResize}>
        {lines ? (
          <LineChart data={rows as DayPoint[]} margin={CHART_MARGIN}>
            {axes}
            {tooltip}
            {series.map((entry) => (
              <Line
                key={entry.key}
                type="linear"
                dataKey={entry.key}
                name={entry.label}
                stroke={entry.color}
                strokeWidth={2}
                strokeLinejoin="round"
                dot={isolatedDot(rows, entry.key, entry.color)}
                activeDot={activeDot(entry.color)}
                {...CHART_ANIMATION}
              />
            ))}
          </LineChart>
        ) : (
          <AreaChart data={rows as DayPoint[]} margin={CHART_MARGIN}>
            {axes}
            {tooltip}
            {series.map((entry) => (
              <Area
                key={entry.key}
                type="linear"
                dataKey={entry.key}
                name={entry.label}
                stackId="stack"
                stroke={entry.color}
                strokeWidth={1.5}
                fill={entry.color}
                fillOpacity={0.1}
                dot={isolatedDot(rows, entry.key, entry.color)}
                activeDot={activeDot(entry.color)}
                {...CHART_ANIMATION}
              />
            ))}
          </AreaChart>
        )}
      </ResponsiveContainer>
    </>
  );
}
