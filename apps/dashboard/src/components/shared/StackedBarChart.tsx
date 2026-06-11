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
  stroke: "var(--color-border, #333)",
} as const;

const tooltipProps = {
  contentStyle: {
    backgroundColor: "var(--color-card, #1a1a2e)",
    border: "1px solid var(--color-border, #333)",
    borderRadius: 8,
    fontSize: 13,
  },
  wrapperStyle: {
    zIndex: 20,
  },
};

/**
 * Generic stacked-bars time chart: rows keyed by `xKey`, one stacked Bar per
 * series. Domain-agnostic by design — callers own labels, colors, and formats.
 */
export function StackedBarChart(props: {
  title: string;
  data: Array<Record<string, string | number>>;
  xKey: string;
  series: StackedBarChartSeries[];
  xTickFormatter?: (value: string) => string;
  valueFormatter?: (value: number) => string;
  yAxisWidth?: number;
  height?: number;
  headerExtra?: ReactNode;
}) {
  const height = props.height ?? 300;

  const labelFormatter = (label: ReactNode) =>
    typeof label === "string" && props.xTickFormatter ? props.xTickFormatter(label) : label;

  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-[12px] text-text-muted uppercase tracking-wider font-semibold">
          {props.title}
        </h2>
        {props.headerExtra}
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={props.data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid {...gridProps} />
          <XAxis
            dataKey={props.xKey}
            tick={{ fontSize: 11, fill: "var(--color-text-muted, #888)" }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
            {...(props.xTickFormatter ? { tickFormatter: props.xTickFormatter } : {})}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--color-text-muted, #888)" }}
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
            {...(props.valueFormatter
              ? {
                formatter: (value: unknown, name: unknown) => [
                  props.valueFormatter!(Number(value ?? 0)),
                  String(name ?? ""),
                ] as [ReactNode, string],
              }
              : {})}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
