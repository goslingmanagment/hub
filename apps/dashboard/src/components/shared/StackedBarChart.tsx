import type { ReactNode } from "react";
import {
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
  ChartLegend,
  ChartTooltipCard,
  bandCursor,
  chartGridProps,
  useTickBudget,
  xAxisProps,
  yAxisProps,
  type ChartSeries,
  type ChartTooltipRenderProps,
} from "@/components/charts/ChartKit";
import { evenTickIndices, linearTicks, stackedExtent } from "@/components/charts/scale";

export type StackedBarChartSeries = ChartSeries;

/**
 * Generic stacked-bars time chart: rows keyed by `xKey`, one stacked Bar per
 * series. Domain-agnostic by design — callers own labels, colors, and formats.
 *
 * Rows are expected one per date, gaps included (a date with no keys is drawn
 * as no bar and says "no data" on hover), so the bars stay evenly spaced in
 * time. Negative values (refunds, corrections) stack DOWN from zero rather
 * than overlapping the positive stack.
 *
 * With a `title` it is its own card; with an empty title and no `headerExtra`
 * it is the bare chart, for a caller that already draws the card around it.
 */
export function StackedBarChart(props: {
  title: string;
  data: Array<Record<string, string | number>>;
  xKey: string;
  series: StackedBarChartSeries[];
  xTickFormatter?: (value: string) => string;
  valueFormatter?: (value: number) => string;
  /** Axis labels, given the axis step (e.g. whole dollars vs cents); falls
   *  back to `valueFormatter`. */
  axisFormatter?: ((step: number) => (value: number) => string) | undefined;
  // Optional richer formatter for tooltip values only (e.g. add a USD estimate);
  // falls back to valueFormatter.
  tooltipValueFormatter?: (value: number) => string;
  yAxisWidth?: number;
  height?: number;
  headerExtra?: ReactNode;
}) {
  const height = props.height ?? 300;
  const { budget, onResize } = useTickBudget();
  const format = props.valueFormatter ?? ((value: number) => String(value));
  const tooltipFormat = props.tooltipValueFormatter ?? format;
  const xFormat = props.xTickFormatter ?? ((value: string) => value);

  const extent = stackedExtent(props.data, props.series.map((series) => series.key));
  const yScale = linearTicks(extent.min, extent.max, { integer: true });
  const step = (yScale.ticks[1] ?? 1) - (yScale.ticks[0] ?? 0);
  const axisFormat = props.axisFormatter?.(step) ?? format;
  const xTicks = evenTickIndices(props.data.length, budget)
    .map((index) => props.data[index]?.[props.xKey])
    .filter((value): value is string | number => value !== undefined);

  const chart = (
    <>
      <ChartLegend series={props.series} />
      <ResponsiveContainer width="100%" height={height} onResize={onResize}>
        <BarChart data={props.data} margin={CHART_MARGIN} stackOffset="sign" barCategoryGap="20%">
          <CartesianGrid {...chartGridProps} />
          <XAxis
            {...xAxisProps}
            dataKey={props.xKey}
            ticks={xTicks}
            tickFormatter={(value: unknown) => xFormat(String(value))}
          />
          <YAxis
            {...yAxisProps}
            domain={yScale.domain}
            ticks={yScale.ticks}
            tickFormatter={axisFormat}
            {...(props.yAxisWidth != null ? { width: props.yAxisWidth } : {})}
          />
          {extent.min < 0 ? <ReferenceLine y={0} stroke="var(--color-border-strong)" /> : null}
          {props.series.map((series) => (
            <Bar
              key={series.key}
              dataKey={series.key}
              name={series.label}
              stackId="stack"
              fill={series.color}
              fillOpacity={series.fillOpacity ?? 1}
              // The card-coloured hairline is the gap between segments.
              stroke="var(--color-card)"
              strokeWidth={1}
              maxBarSize={24}
              {...CHART_ANIMATION}
            />
          ))}
          <Tooltip
            cursor={bandCursor}
            filterNull={false}
            isAnimationActive={false}
            wrapperStyle={{ zIndex: 20 }}
            content={(tooltip: ChartTooltipRenderProps) => (
              <ChartTooltipCard
                {...tooltip}
                series={props.series}
                formatValue={tooltipFormat}
                formatLabel={(label) => xFormat(String(label))}
                totalLabel="Итого"
              />
            )}
          />
        </BarChart>
      </ResponsiveContainer>
    </>
  );

  if (!props.title && !props.headerExtra) {
    return chart;
  }

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">{props.title}</h2>
        {props.headerExtra}
      </div>
      <div className="card-body">{chart}</div>
    </div>
  );
}
