import { useId, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  CHART_ANIMATION,
  CHART_MARGIN,
  ChartTooltipCard,
  activeDot,
  bandCursor,
  chartGridProps,
  lineCursor,
  useTickBudget,
  xAxisProps,
  yAxisProps,
  type ChartTooltipRenderProps,
} from "@/components/charts/ChartKit";
import { countAxisLabel, usdAxisFormatter } from "@/components/charts/format";
import { businessDateRange, evenTickIndices, linearTicks } from "@/components/charts/scale";
import {
  formatBusinessDateMonth,
  formatBusinessDateShort,
} from "@/lib/format";

type ChartPoint = {
  businessDate: string;
  value: number;
};

function aggregateMonthly(items: ChartPoint[]): ChartPoint[] {
  const buckets = new Map<string, number>();
  for (const item of items) {
    const monthKey = item.businessDate.slice(0, 7) + "-01";
    buckets.set(monthKey, (buckets.get(monthKey) ?? 0) + item.value);
  }

  return Array.from(buckets.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([businessDate, value]) => ({ businessDate, value }));
}

/**
 * The days between the first and the last point, each once, in order. The
 * daily series these charts get list only days that HAD something (a ledger
 * day without a sale is not a row), and a category axis built from them
 * squeezed a quiet week out of the timeline and drew a slope across it.
 * Inside the range a missing day is a zero; outside it nothing is claimed.
 */
export function everyDay(items: readonly ChartPoint[]): ChartPoint[] {
  if (items.length === 0) {
    return [];
  }
  const byDate = new Map<string, number>();
  for (const item of items) {
    byDate.set(item.businessDate, (byDate.get(item.businessDate) ?? 0) + item.value);
  }
  const dates = [...byDate.keys()].sort();
  const range = businessDateRange(dates[0]!, dates.at(-1)!);
  // A malformed date cannot be placed; keep the series as given.
  if (range.length === 0) {
    return dates.map((businessDate) => ({ businessDate, value: byDate.get(businessDate)! }));
  }
  return range.map((businessDate) => ({ businessDate, value: byDate.get(businessDate) ?? 0 }));
}

type ChartMode = "area-dots" | "area-nodots" | "area-daily" | "bar";

function getChartMode(
  period: "today" | "7d" | "30d" | "all",
  allTimeGranularity: "monthly" | "daily",
): ChartMode {
  if (period === "today" || period === "7d") return "area-dots";
  if (period === "30d") return "area-nodots";
  if (period === "all") return allTimeGranularity === "daily" ? "area-daily" : "bar";
  return "bar";
}

export function PageActivityChart(props: {
  title: string;
  selectedPeriod: "today" | "7d" | "30d" | "all";
  selectedPeriodLabel: string;
  points: Array<{ businessDate: string; value: number }>;
  /** Exact values, in the tooltip. */
  valueFormatter?: (value: number) => string;
  /** Money (mills) gets dollar ticks; anything else is a count. */
  valueKind?: "money" | "count";
  yAxisWidth?: number;
  height?: number;
  /** The axis repeats the card title, so it is off unless asked for. */
  showYAxisLabel?: boolean;
  color?: string;
  allowMonthly?: boolean;
}) {
  const gradientId = useId();
  const color = props.color ?? "var(--color-green)";
  const { budget, onResize } = useTickBudget();
  const [allTimeGranularity, setAllTimeGranularity] = useState<"monthly" | "daily">("monthly");
  const granularity = props.allowMonthly === false ? "daily" : allTimeGranularity;
  const mode = getChartMode(props.selectedPeriod, granularity);

  const useMonthly = props.selectedPeriod === "all" && granularity === "monthly";
  const items = useMemo(
    () => (useMonthly ? aggregateMonthly(props.points) : everyDay(props.points)),
    [props.points, useMonthly],
  );

  const tickFormatter = (value: unknown) =>
    useMonthly ? formatBusinessDateMonth(String(value)) : formatBusinessDateShort(String(value));

  const values = items.map((item) => item.value);
  const yScale = linearTicks(Math.min(0, ...values), Math.max(0, ...values), { integer: true });
  const step = (yScale.ticks[1] ?? 1) - (yScale.ticks[0] ?? 0);
  const axisLabel = props.valueKind === "money" ? usdAxisFormatter(step) : countAxisLabel;
  const xTicks = evenTickIndices(items.length, budget).map((index) => items[index]!.businessDate);
  const hasNegative = values.some((value) => value < 0);
  const series = [{ key: "value", label: props.title, color }];
  const formatValue = props.valueFormatter ?? countAxisLabel;

  const yAxis = (
    <YAxis
      {...yAxisProps}
      domain={yScale.domain}
      ticks={yScale.ticks}
      tickFormatter={axisLabel}
      {...(props.yAxisWidth != null ? { width: props.yAxisWidth } : {})}
      label={props.showYAxisLabel !== true ? false : {
        value: props.title,
        angle: -90,
        position: "insideLeft",
        style: { fontSize: 11, fill: "var(--color-text-muted)" },
        offset: 0,
      }}
    />
  );
  const tooltip = (cursor: typeof lineCursor | typeof bandCursor) => (
    <Tooltip
      cursor={cursor}
      isAnimationActive={false}
      wrapperStyle={{ zIndex: 20 }}
      content={(tooltipProps: ChartTooltipRenderProps) => (
        <ChartTooltipCard
          {...tooltipProps}
          series={series}
          formatValue={formatValue}
          formatLabel={tickFormatter}
        />
      )}
    />
  );
  const zeroLine = hasNegative ? <ReferenceLine y={0} stroke="var(--color-border-strong)" /> : null;

  return (
    <div className="card card-body">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="card-title">
          {props.title}
        </h2>
        {props.selectedPeriod === "all" && props.allowMonthly !== false ? (
          <div className="segmented" role="group" aria-label="Шаг графика">
            {(["daily", "monthly"] as const).map((g) => (
              <button
                key={g}
                type="button"
                aria-pressed={allTimeGranularity === g}
                onClick={() => setAllTimeGranularity(g)}
                className="segment"
              >
                {g === "daily" ? "По дням" : "По месяцам"}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-[13px] text-text-secondary">{props.selectedPeriodLabel}</span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={props.height ?? 300} onResize={onResize}>
        {mode !== "bar" ? (
          <AreaChart data={items} margin={CHART_MARGIN}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.24} />
                <stop offset="100%" stopColor={color} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid {...chartGridProps} />
            <XAxis {...xAxisProps} dataKey="businessDate" ticks={xTicks} tickFormatter={tickFormatter} />
            {yAxis}
            {zeroLine}
            <Area
              type="monotone"
              dataKey="value"
              name={props.title}
              stroke={color}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              dot={mode === "area-dots"
                ? { r: 3, fill: color, stroke: "var(--color-card)", strokeWidth: 1.5 }
                : false}
              activeDot={activeDot(color)}
              {...CHART_ANIMATION}
            />
            {tooltip(lineCursor)}
          </AreaChart>
        ) : (
          <BarChart data={items} margin={CHART_MARGIN}>
            <CartesianGrid {...chartGridProps} />
            <XAxis {...xAxisProps} dataKey="businessDate" ticks={xTicks} tickFormatter={tickFormatter} />
            {yAxis}
            {zeroLine}
            <Bar
              dataKey="value"
              name={props.title}
              fill={color}
              radius={[4, 4, 0, 0]}
              maxBarSize={24}
              {...CHART_ANIMATION}
            />
            {tooltip(bandCursor)}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
