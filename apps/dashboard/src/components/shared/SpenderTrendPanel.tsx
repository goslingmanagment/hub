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

const PERIOD_WORDS: Record<string, string> = {
  today: "сегодня",
  "7d": "за 7 дней",
  "30d": "за 30 дней",
  "90d": "за 90 дней",
  "180d": "за 180 дней",
  lifetime: "за всё время",
  all: "за всё время",
};

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
      <div className="bg-hover-alt px-6 py-8 text-center text-sm text-text-secondary">
        Загружаем динамику трат…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="bg-hover-alt px-6 py-8 text-center text-sm text-danger">
        Не удалось загрузить динамику трат.
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
    <div className="border-t border-border bg-hover-alt">
      <div className="grid grid-cols-2 gap-3 px-5 py-4 sm:grid-cols-4 sm:px-6">
        <Stat label={`Потратил ${PERIOD_WORDS[period] ?? period}`} value={formatUsdFromMills(totalSpent)} />
        <Stat label="Операций" value={String(totalTxns)} />
        <Stat
          label="В среднем за день с тратами"
          value={nonZeroPoints.length > 0 ? formatUsdFromMills(avgPerSpendDay) : "—"}
        />
        <Stat
          label="Самый крупный день"
          value={largest && largest.value > 0
            ? `${formatUsdFromMills(largest.value)} · ${formatBusinessDateShort(largest.date)}`
            : "—"}
        />
      </div>

      <div className="px-3 pb-3" style={{ height: 220 }}>
        {points.length === 0 || totalSpent === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-text-secondary">
            За этот период трат нет.
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
                tick={{ fontSize: 12, fill: "var(--color-text-muted)" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={formatBusinessDateShort}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 12, fill: "var(--color-text-muted)" }}
                axisLine={false}
                tickLine={false}
                width={56}
                tickFormatter={(v: number) => formatUsdFromMills(v)}
              />
              <ChartTooltip
                contentStyle={{
                  backgroundColor: "var(--color-card)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 8,
                  fontSize: 12,
                  color: "var(--color-text-primary)",
                }}
                labelFormatter={(label) => formatBusinessDateShort(String(label))}
                formatter={(value) => [formatUsdFromMills(Number(value)), "Потратил"]}
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

      <div className="flex items-center justify-end border-t border-border-light px-5 py-3 sm:px-6">
        <Link
          to={profileHref}
          onClick={(e) => e.stopPropagation()}
          className="link text-sm"
        >
          Открыть профиль
        </Link>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-xs text-text-secondary">
        {label}
      </div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums text-text-primary">
        {value}
      </div>
    </div>
  );
}
