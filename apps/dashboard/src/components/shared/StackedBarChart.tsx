import type { ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface StackedBarChartSeries {
  // Key into each data row holding this series' numeric value.
  key: string;
  label: string;
  color: string;
}

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
  wrapperStyle: {
    zIndex: 20,
  },
};

/** Legend text wears the text colour; the swatch beside it carries identity. */
function legendText(value: unknown) {
  return <span style={{ color: "var(--color-text-secondary)" }}>{String(value)}</span>;
}

/**
 * Generic stacked-bars time chart: rows keyed by `xKey`, one stacked Bar per
 * series. Domain-agnostic by design — callers own labels, colors, and formats.
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
  // Optional richer formatter for tooltip values only (e.g. add a USD estimate);
  // falls back to valueFormatter. Y-axis ticks always use valueFormatter.
  tooltipValueFormatter?: (value: number) => string;
  yAxisWidth?: number;
  height?: number;
  headerExtra?: ReactNode;
}) {
  const height = props.height ?? 300;
  const tooltipFormatter = props.tooltipValueFormatter ?? props.valueFormatter;

  // Legend and tooltip keep the series' own order (recharts sorts by name).
  const seriesOrder = (item: { dataKey?: unknown }) =>
    props.series.findIndex((series) => series.key === String(item.dataKey));

  const labelFormatter = (label: ReactNode) =>
    typeof label === "string" && props.xTickFormatter ? props.xTickFormatter(label) : label;

  const chart = (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={props.data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid {...gridProps} />
        <XAxis
          dataKey={props.xKey}
          tick={axisTick}
          axisLine={false}
          tickLine={false}
          interval="preserveStartEnd"
          minTickGap={16}
          {...(props.xTickFormatter ? { tickFormatter: props.xTickFormatter } : {})}
        />
        <YAxis
          tick={axisTick}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
          {...(props.yAxisWidth != null ? { width: props.yAxisWidth } : { width: "auto" as const })}
          {...(props.valueFormatter ? { tickFormatter: props.valueFormatter } : {})}
        />
        {props.series.map((series) => (
          <Bar
            key={series.key}
            dataKey={series.key}
            name={series.label}
            stackId="stack"
            fill={series.color}
          />
        ))}
        <Tooltip
          {...tooltipProps}
          labelFormatter={labelFormatter}
          itemSorter={seriesOrder}
          {...(tooltipFormatter
            ? {
              formatter: (value: unknown, name: unknown) => [
                tooltipFormatter(Number(value ?? 0)),
                String(name ?? ""),
              ] as [ReactNode, string],
            }
            : {})}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} formatter={legendText} itemSorter={seriesOrder} />
      </BarChart>
    </ResponsiveContainer>
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
