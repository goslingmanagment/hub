import { useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  formatBusinessDateMonth,
  formatBusinessDateShort,
} from "@/lib/format";

type ChartItem = {
  businessDate: string;
  newFollowers?: number;
  newSubscribers?: number;
};

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
  width: 40,
  allowDecimals: false,
};

const tooltipProps = {
  contentStyle: {
    backgroundColor: "var(--color-card, #1a1a2e)",
    border: "1px solid var(--color-border, #333)",
    borderRadius: 8,
    fontSize: 13,
  },
};

const GRADIENT_ID = "pageActivityGradient";

function AreaGradientDef() {
  return (
    <defs>
      <linearGradient id={GRADIENT_ID} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#4ead6b" stopOpacity={0.3} />
        <stop offset="100%" stopColor="#4ead6b" stopOpacity={0.02} />
      </linearGradient>
    </defs>
  );
}

export function PageActivityChart(props: {
  title: string;
  selectedPeriod: "today" | "7d" | "30d" | "all";
  selectedPeriodLabel: string;
  items: ChartItem[];
  dataKey: "newFollowers" | "newSubscribers";
}) {
  const [allTimeGranularity, setAllTimeGranularity] = useState<"monthly" | "daily">("monthly");
  const mode = getChartMode(props.selectedPeriod, allTimeGranularity);

  const chartItems: ChartPoint[] = props.items.map((item) => ({
    businessDate: item.businessDate,
    value: item[props.dataKey] ?? 0,
  }));

  const useMonthly = props.selectedPeriod === "all" && allTimeGranularity === "monthly";
  const chartDisplayItems = useMonthly ? aggregateMonthly(chartItems) : chartItems;

  const tickFormatter = (value: string) =>
    useMonthly ? formatBusinessDateMonth(value) : formatBusinessDateShort(value);
  const labelFormatter = tickFormatter;

  const isArea = mode !== "bar";

  return (
    <div className="bg-card border border-border rounded-xl p-5 mb-6">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-[12px] text-text-muted uppercase tracking-wider font-semibold">
          {props.title}
        </h2>
        {props.selectedPeriod === "all" ? (
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
      <ResponsiveContainer width="100%" height={300}>
        {isArea ? (
          <AreaChart data={chartDisplayItems} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <AreaGradientDef />
            <CartesianGrid {...gridProps} />
            <XAxis {...xAxisProps} tickFormatter={tickFormatter} />
            <YAxis
              {...yAxisProps}
              label={{
                value: props.title,
                angle: -90,
                position: "insideLeft",
                style: { fontSize: 11, fill: "var(--color-text-muted, #888)" },
                offset: 0,
              }}
            />
            <Tooltip {...tooltipProps} labelFormatter={labelFormatter} />
            <Area
              type="monotone"
              dataKey="value"
              name={props.title}
              stroke="#4ead6b"
              strokeWidth={2}
              fill={`url(#${GRADIENT_ID})`}
              dot={mode === "area-dots" ? { r: 3, fill: "#4ead6b", strokeWidth: 0 } : false}
              activeDot={{ r: 4, fill: "#4ead6b", strokeWidth: 0 }}
            />
          </AreaChart>
        ) : (
          <BarChart data={chartDisplayItems} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis {...xAxisProps} tickFormatter={tickFormatter} />
            <YAxis
              {...yAxisProps}
              label={{
                value: props.title,
                angle: -90,
                position: "insideLeft",
                style: { fontSize: 11, fill: "var(--color-text-muted, #888)" },
                offset: 0,
              }}
            />
            <Tooltip {...tooltipProps} labelFormatter={labelFormatter} />
            <Bar dataKey="value" name={props.title} fill="#4ead6b" radius={[3, 3, 0, 0]} />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
