import {
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

export function PageActivityChart(props: {
  title: string;
  selectedPeriod: "today" | "7d" | "30d" | "all";
  selectedPeriodLabel: string;
  items: ChartItem[];
  dataKey: "newFollowers" | "newSubscribers";
}) {
  const chartItems: ChartPoint[] = props.items.map((item) => ({
    businessDate: item.businessDate,
    value: item[props.dataKey] ?? 0,
  }));
  const chartDisplayItems = props.selectedPeriod === "all"
    ? aggregateMonthly(chartItems)
    : chartItems;

  return (
    <div className="bg-card border border-border rounded-xl p-5 mb-6">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-[12px] text-text-muted uppercase tracking-wider font-semibold">
          {props.title}
        </h2>
        <span className="text-[12px] text-text-muted">{props.selectedPeriodLabel}</span>
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={chartDisplayItems} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border, #333)" />
          <XAxis
            dataKey="businessDate"
            tickFormatter={(value: string) =>
              props.selectedPeriod === "all"
                ? formatBusinessDateMonth(value)
                : formatBusinessDateShort(value)
            }
            tick={{ fontSize: 11, fill: "var(--color-text-muted, #888)" }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--color-text-muted, #888)" }}
            axisLine={false}
            tickLine={false}
            width={40}
            allowDecimals={false}
            label={{
              value: props.title,
              angle: -90,
              position: "insideLeft",
              style: { fontSize: 11, fill: "var(--color-text-muted, #888)" },
              offset: 0,
            }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--color-card, #1a1a2e)",
              border: "1px solid var(--color-border, #333)",
              borderRadius: 8,
              fontSize: 13,
            }}
            labelFormatter={(value: string) =>
              props.selectedPeriod === "all"
                ? formatBusinessDateMonth(value)
                : formatBusinessDateShort(value)
            }
          />
          <Bar dataKey="value" name={props.title} fill="#4ead6b" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
