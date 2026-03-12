import { useState } from "react";
import { useParams } from "react-router";
import { usePageRevenueDaily, useTransactions } from "@/api/queries";
import { Card, CardTitle, CardContent } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/shared/DataTable";
import { MoneyCell } from "@/components/shared/MoneyCell";
import { PeriodSelector } from "@/components/shared/PeriodSelector";
import { SkeletonTable } from "@/components/shared/SkeletonTable";
import { formatBusinessDate } from "@/lib/date";
import { TRANSACTION_TYPE_LABELS } from "@/lib/constants";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

export function PageDetailPage() {
  const { pageLabel } = useParams<{ pageLabel: string }>();
  const [period, setPeriod] = useState("30d");
  const [tab, setTab] = useState<"revenue" | "transactions">("revenue");

  const { data: revenue, isLoading: revLoading } = usePageRevenueDaily(
    pageLabel!,
    { period },
  );

  const { data: txns, isLoading: txnLoading } = useTransactions(
    { pageLabel: pageLabel!, limit: "50", sortBy: "occurredAt", sortDir: "desc" },
  );

  const chartData = (revenue?.series ?? []).map((s: any) => ({
    date: formatBusinessDate(s.businessDate),
    net: s.netAmountMills / 1000,
  }));

  const txnColumns: Column<any>[] = [
    { key: "occurredAt", header: "Date", render: (r) => new Date(r.occurredAt).toLocaleDateString() },
    { key: "type", header: "Type", render: (r) => TRANSACTION_TYPE_LABELS[r.canonicalType] ?? r.canonicalType },
    { key: "fan", header: "Fan", render: (r) => r.fanUsername ?? r.fanPlatformUserId ?? "—" },
    { key: "gross", header: "Gross", className: "text-right", render: (r) => <MoneyCell mills={r.grossAmountMills} /> },
    { key: "net", header: "Net", className: "text-right", render: (r) => <MoneyCell mills={r.netAmountMills} /> },
    { key: "state", header: "State", render: (r) => <span className="text-zinc-400">{r.transactionState}</span> },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-zinc-100">{pageLabel}</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setTab("revenue")}
            className={`px-3 py-1 text-sm rounded ${tab === "revenue" ? "bg-zinc-700 text-white" : "text-zinc-400"}`}
          >
            Revenue
          </button>
          <button
            onClick={() => setTab("transactions")}
            className={`px-3 py-1 text-sm rounded ${tab === "transactions" ? "bg-zinc-700 text-white" : "text-zinc-400"}`}
          >
            Transactions
          </button>
        </div>
      </div>

      {tab === "revenue" && (
        <>
          <PeriodSelector value={period} onChange={setPeriod} />
          {revLoading ? (
            <SkeletonTable rows={4} cols={3} />
          ) : (
            <>
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
            </>
          )}
        </>
      )}

      {tab === "transactions" && (
        txnLoading ? <SkeletonTable /> : (
          <DataTable columns={txnColumns} data={txns?.items ?? []} />
        )
      )}
    </div>
  );
}
