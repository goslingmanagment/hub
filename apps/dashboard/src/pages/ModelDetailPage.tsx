import { useState } from "react";
import { useParams } from "react-router";
import { useModelRevenueDaily } from "@/api/queries";
import { Card, CardTitle, CardContent } from "@/components/ui/card";
import { PeriodSelector } from "@/components/shared/PeriodSelector";
import { SkeletonTable } from "@/components/shared/SkeletonTable";
import { formatBusinessDate } from "@/lib/date";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

export function ModelDetailPage() {
  const { modelSlug } = useParams<{ modelSlug: string }>();
  const [period, setPeriod] = useState("30d");
  const { data, isLoading } = useModelRevenueDaily(modelSlug!, { period });

  const chartData = (data?.series ?? []).map((s: any) => ({
    date: formatBusinessDate(s.businessDate),
    net: s.netAmountMills / 1000,
  }));

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-zinc-100">{modelSlug}</h1>
      <PeriodSelector value={period} onChange={setPeriod} />
      {isLoading ? (
        <SkeletonTable rows={4} cols={3} />
      ) : (
        <Card>
          <CardTitle>Net Earnings</CardTitle>
          <CardContent>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#71717a" }} />
                  <YAxis tick={{ fontSize: 11, fill: "#71717a" }} tickFormatter={(v) => `$${v}`} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#18181b", border: "1px solid #3f3f46", borderRadius: 8 }}
                    labelStyle={{ color: "#a1a1aa" }}
                  />
                  <Line type="monotone" dataKey="net" stroke="#3b82f6" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
