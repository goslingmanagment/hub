import { useId } from "react";
import { Link } from "react-router";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useSpenderSeries } from "@/api/queries";
import { formatBusinessDateShort } from "@/lib/format";
import { formatUsdFromMills } from "@agency_hub_core/shared";

interface SpenderTrendPanelProps {
  pageLabel: string;
  platform: string;
  platformUserId: string;
  profileHref: string;
  period?: string;
}

export function SpenderTrendPanel({
  pageLabel,
  platform,
  platformUserId,
  profileHref,
  period = "90d",
}: SpenderTrendPanelProps) {
  const gradientId = useId();
  const { data, isLoading, isError } = useSpenderSeries(platform, platformUserId, {
    scope: "page",
    pageLabel,
    period,
    granularity: "auto",
  });

  if (isLoading) {
    return (
      <div className="bg-hover/50 px-6 py-8 text-center text-sm text-text-muted">
        Loading trend…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="bg-hover/50 px-6 py-8 text-center text-sm text-text-muted">
        Trend failed to load.
      </div>
    );
  }

  const points = data.items.map((bucket) => ({
    date: bucket.fromBusinessDate,
    value: bucket.metrics.creatorNetAmountMills,
    txnCount: bucket.metrics.transactionCount,
  }));

  const totalSpent = points.reduce((acc, p) => acc + p.value, 0);
  const totalTxns = points.reduce((acc, p) => acc + p.txnCount, 0);
  const nonZeroPoints = points.filter((p) => p.value > 0);
  const avgPerSpendDay = nonZeroPoints.length > 0 ? totalSpent / nonZeroPoints.length : 0;
  const largest = points.reduce<{ date: string; value: number } | null>(
    (best, p) => (best === null || p.value > best.value ? { date: p.date, value: p.value } : best),
    null,
  );

  return (
    <div className="bg-hover/50">
      <div className="grid grid-cols-2 gap-3 px-6 py-4 sm:grid-cols-4">
        <Stat label={`Spent · ${period}`} value={formatUsdFromMills(totalSpent)} />
        <Stat label="Transactions" value={String(totalTxns)} />
        <Stat
          label="Avg / spend-day"
          value={nonZeroPoints.length > 0 ? formatUsdFromMills(avgPerSpendDay) : "—"}
        />
        <Stat
          label="Biggest day"
          value={largest && largest.value > 0
            ? `${formatUsdFromMills(largest.value)} · ${formatBusinessDateShort(largest.date)}`
            : "—"}
        />
      </div>

      <div className="px-3 pb-3" style={{ height: 220 }}>
        {points.length === 0 || totalSpent === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-text-muted">
            No spending in this window.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={formatBusinessDateShort}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
                axisLine={false}
                tickLine={false}
                width={50}
                tickFormatter={(v: number) => (v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`)}
              />
              <ChartTooltip
                contentStyle={{
                  backgroundColor: "#1a1a1a",
                  border: "none",
                  borderRadius: 8,
                  fontSize: 12,
                  color: "white",
                }}
                labelFormatter={(label) => formatBusinessDateShort(String(label))}
                formatter={(value) => [formatUsdFromMills(Number(value)), "Spent"]}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke="var(--color-accent)"
                strokeWidth={2}
                fill={`url(#${gradientId})`}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="flex items-center justify-end border-t border-border px-6 py-2">
        <Link
          to={profileHref}
          onClick={(e) => e.stopPropagation()}
          className="text-[12px] font-medium text-accent hover:underline"
        >
          View Full Profile
        </Link>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wider text-text-muted">
        {label}
      </div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums text-text-primary">
        {value}
      </div>
    </div>
  );
}
