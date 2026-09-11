import { useId, useState, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  type TooltipProps,
  type TooltipValueType,
  XAxis,
  YAxis,
} from "recharts";
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

  return Array.from(buckets.entries()).map(([businessDate, value]) => ({
    businessDate,
    value,
  }));
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

const gridProps = {
  strokeDasharray: "3 3",
  vertical: false,
  stroke: "var(--color-border, #333)",
} as const;

const xAxisProps = {
  dataKey: "businessDate" as const,
  tick: { fontSize: 11, fill: "var(--color-text-muted, #888)" },
  axisLine: false,
  tickLine: false,
  interval: "preserveStartEnd" as const,
};

const yAxisProps = {
  tick: { fontSize: 11, fill: "var(--color-text-muted, #888)" },
  axisLine: false,
  tickLine: false,
  width: "auto" as const,
  allowDecimals: false,
};

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

function AreaGradientDef(props: { id: string; color: string }) {
  return (
    <defs>
      <linearGradient id={props.id} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={props.color} stopOpacity={0.3} />
        <stop offset="100%" stopColor={props.color} stopOpacity={0.02} />
      </linearGradient>
    </defs>
  );
}

export function PageActivityChart(props: {
  title: string;
  selectedPeriod: "today" | "7d" | "30d" | "all";
  selectedPeriodLabel: string;
  points: Array<{ businessDate: string; value: number }>;
  valueFormatter?: (value: number) => string;
  yAxisWidth?: number;
  height?: number;
  showYAxisLabel?: boolean;
  color?: string;
  allowMonthly?: boolean;
}) {
  const gradientId = useId();
  const color = props.color ?? "#4ead6b";
  const [allTimeGranularity, setAllTimeGranularity] = useState<"monthly" | "daily">("monthly");
  const granularity = props.allowMonthly === false ? "daily" : allTimeGranularity;
  const mode = getChartMode(props.selectedPeriod, granularity);

  const useMonthly = props.selectedPeriod === "all" && granularity === "monthly";
  const chartDisplayItems = useMonthly ? aggregateMonthly(props.points) : props.points;

  const tickFormatter = (value: string) =>
    useMonthly ? formatBusinessDateMonth(value) : formatBusinessDateShort(value);
  const labelFormatter = (label: ReactNode) =>
    typeof label === "string" ? tickFormatter(label) : label;

  const isArea = mode !== "bar";

  const yAxisOverrides = {
    ...(props.yAxisWidth != null ? { width: props.yAxisWidth } : {}),
    ...(props.valueFormatter ? { tickFormatter: props.valueFormatter } : {}),
  };

  const tooltipFormatter: NonNullable<TooltipProps<TooltipValueType, string | number>["formatter"]> | undefined = props.valueFormatter
    ? (value) => {
      const numericValue = typeof value === "number"
        ? value
        : Array.isArray(value)
          ? Number(value[0] ?? 0)
          : Number(value ?? 0);
      const formattedValue = props.valueFormatter!(Number.isFinite(numericValue) ? numericValue : 0);
      const tooltipEntry: [ReactNode, string | number] = [formattedValue, props.title];
      return tooltipEntry;
    }
    : undefined;

  const tooltipOverrides = tooltipFormatter ? { formatter: tooltipFormatter } : {};

  return (
    <div className="bg-card border border-border rounded-xl p-5 mb-6">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-[12px] text-text-muted uppercase tracking-wider font-semibold">
          {props.title}
        </h2>
        {props.selectedPeriod === "all" && props.allowMonthly !== false ? (
          <div className="flex rounded-lg overflow-hidden border border-border">
            {(["daily", "monthly"] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setAllTimeGranularity(g)}
                className={`px-3 py-1 text-[11px] font-semibold cursor-pointer transition-colors ${
                  allTimeGranularity === g
                    ? "bg-accent text-white"
                    : "bg-card text-text-muted hover:text-text-secondary"
                }`}
              >
                {g === "daily" ? "Daily" : "Monthly"}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-[12px] text-text-muted">{props.selectedPeriodLabel}</span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={props.height ?? 300}>
        {isArea ? (
          <AreaChart data={chartDisplayItems} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <AreaGradientDef id={gradientId} color={color} />
            <CartesianGrid {...gridProps} />
            <XAxis {...xAxisProps} tickFormatter={tickFormatter} />
            <YAxis
              {...yAxisProps}
              {...yAxisOverrides}
              label={props.showYAxisLabel === false ? false : {
                value: props.title,
                angle: -90,
                position: "insideLeft",
                style: { fontSize: 11, fill: "var(--color-text-muted, #888)" },
                offset: 0,
              }}
            />
            <Area
              type="monotone"
              dataKey="value"
              name={props.title}
              stroke={color}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              dot={mode === "area-dots" ? { r: 3, fill: color, strokeWidth: 0 } : false}
              activeDot={{ r: 4, fill: color, strokeWidth: 0 }}
            />
            <Tooltip {...tooltipProps} {...tooltipOverrides} labelFormatter={labelFormatter} />
          </AreaChart>
        ) : (
          <BarChart data={chartDisplayItems} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis {...xAxisProps} tickFormatter={tickFormatter} />
            <YAxis
              {...yAxisProps}
              {...yAxisOverrides}
              label={props.showYAxisLabel === false ? false : {
                value: props.title,
                angle: -90,
                position: "insideLeft",
                style: { fontSize: 11, fill: "var(--color-text-muted, #888)" },
                offset: 0,
              }}
            />
            <Bar dataKey="value" name={props.title} fill={color} radius={[3, 3, 0, 0]} />
            <Tooltip {...tooltipProps} {...tooltipOverrides} labelFormatter={labelFormatter} />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
