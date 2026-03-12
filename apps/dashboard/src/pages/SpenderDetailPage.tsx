import { useState } from "react";
import { useParams } from "react-router";
import { useSpenderSeries } from "@/api/queries";
import { Card, CardTitle, CardContent } from "@/components/ui/card";
import { PlatformIcon } from "@/components/shared/PlatformIcon";
import { PeriodSelector } from "@/components/shared/PeriodSelector";
import { SkeletonTable } from "@/components/shared/SkeletonTable";
import { formatBusinessDate } from "@/lib/date";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

export function SpenderDetailPage() {
  const { platform, platformUserId } = useParams<{ platform: string; platformUserId: string }>();
  const [period, setPeriod] = useState("30d");
  const { data, isLoading } = useSpenderSeries(platform!, platformUserId!, { period });

  const chartData = (data?.series ?? []).map((s: any) => ({
    date: formatBusinessDate(s.businessDate),
    spend: s.totalSpendMills / 1000,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <PlatformIcon platform={platform!} />
        <h1 className="text-lg font-semibold text-zinc-100">{platformUserId}</h1>
      </div>
      <PeriodSelector value={period} onChange={setPeriod} />
      {isLoading ? <SkeletonTable rows={4} cols={2} /> : (
        <Card>
          <CardTitle>Spending Trend</CardTitle>
          <CardContent>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#71717a" }} />
                  <YAxis tick={{ fontSize: 11, fill: "#71717a" }} tickFormatter={(v) => `$${v}`} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#18181b", border: "1px solid #3f3f46", borderRadius: 8 }}
                  />
                  <Bar dataKey="spend" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
