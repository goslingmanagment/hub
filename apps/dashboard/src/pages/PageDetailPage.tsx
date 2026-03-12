import { useState } from "react";
import type {
  CrossPageTransactionItem,
  FollowerListResponse,
  SubscriberListResponse,
} from "@fansly-connect/contracts";
import { useParams } from "react-router";
import { usePageRevenueDaily, useTransactions, usePageSubscribers, usePageFollowers } from "@/api/queries";
import { Card, CardTitle, CardContent } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/shared/DataTable";
import { MoneyCell } from "@/components/shared/MoneyCell";
import { PeriodSelector } from "@/components/shared/PeriodSelector";
import { SkeletonTable } from "@/components/shared/SkeletonTable";
import { Button } from "@/components/ui/button";
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

type Tab = "revenue" | "transactions" | "subscribers" | "followers";
type SubscriberItem = SubscriberListResponse["items"][number];
type FollowerItem = FollowerListResponse["items"][number];

export function PageDetailPage() {
  const { pageLabel } = useParams<{ pageLabel: string }>();
  const [period, setPeriod] = useState("30d");
  const [tab, setTab] = useState<Tab>("revenue");

  // --- Transaction pagination ---
  const [txnOffset, setTxnOffset] = useState(0);
  const txnLimit = 50;

  // --- Subscriber pagination ---
  const [subOffset, setSubOffset] = useState(0);
  const subLimit = 50;

  // --- Follower pagination ---
  const [folOffset, setFolOffset] = useState(0);
  const folLimit = 50;

  const { data: revenue, isLoading: revLoading } = usePageRevenueDaily(
    pageLabel!,
    { period },
  );

  const { data: txns, isLoading: txnLoading } = useTransactions(
    { pageLabel: pageLabel!, limit: String(txnLimit), offset: String(txnOffset), sortBy: "occurredAt", sortDir: "desc" },
  );

  const { data: subs, isLoading: subLoading } = usePageSubscribers(
    pageLabel!,
    { limit: String(subLimit), offset: String(subOffset) },
  );

  const { data: followers, isLoading: folLoading } = usePageFollowers(
    pageLabel!,
    { limit: String(folLimit), offset: String(folOffset) },
  );

  const chartData = (revenue?.series ?? []).map((s) => ({
    date: formatBusinessDate(s.businessDate),
    net: s.netAmountMills / 1000,
  }));

  const txnColumns: Column<CrossPageTransactionItem>[] = [
    { key: "occurredAt", header: "Date", render: (r) => new Date(r.occurredAt).toLocaleDateString() },
    { key: "type", header: "Type", render: (r) => TRANSACTION_TYPE_LABELS[r.canonicalType] ?? r.canonicalType },
    { key: "fan", header: "Fan", render: (r) => r.fan?.username ?? r.fan?.platformUserId ?? "—" },
    { key: "gross", header: "Gross", className: "text-right", render: (r) => <MoneyCell mills={r.amountMills} /> },
    { key: "net", header: "Net", className: "text-right", render: (r) => <MoneyCell mills={r.netAmountMills} /> },
    { key: "state", header: "State", render: (r) => <span className="text-zinc-400">{r.transactionState}</span> },
  ];

  const subColumns: Column<SubscriberItem>[] = [
    { key: "username", header: "Username", render: (r) => <span className="font-medium text-zinc-100">{r.username ?? r.platformUserId}</span> },
    { key: "displayName", header: "Display Name", render: (r) => <span className="text-zinc-300">{r.displayName ?? "—"}</span> },
    { key: "tier", header: "Tier", render: (r) => <span className="text-zinc-300">{r.subscriptionTierName ?? "—"}</span> },
    { key: "endsAt", header: "Expires", render: (r) => r.endsAt ? new Date(r.endsAt).toLocaleDateString() : "—" },
    { key: "autoRenew", header: "Auto-Renew", render: (r) => r.autoRenew ? "Yes" : r.autoRenew === false ? "No" : "—" },
  ];

  const folColumns: Column<FollowerItem>[] = [
    { key: "username", header: "Username", render: (r) => <span className="font-medium text-zinc-100">{r.username ?? r.platformUserId}</span> },
    { key: "displayName", header: "Display Name", render: (r) => <span className="text-zinc-300">{r.displayName ?? "—"}</span> },
    { key: "followedAt", header: "Followed", render: (r) => new Date(r.followedAt).toLocaleDateString() },
  ];

  const tabs: { key: Tab; label: string }[] = [
    { key: "revenue", label: "Revenue" },
    { key: "transactions", label: "Transactions" },
    { key: "subscribers", label: `Subscribers${subs ? ` (${subs.total})` : ""}` },
    { key: "followers", label: `Followers${followers ? ` (${followers.total})` : ""}` },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-zinc-100">{pageLabel}</h1>
        <div className="flex gap-2">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1 text-sm rounded ${tab === t.key ? "bg-zinc-700 text-white" : "text-zinc-400"}`}
            >
              {t.label}
            </button>
          ))}
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
          <>
            <DataTable columns={txnColumns} data={txns?.items ?? []} />
            <div className="flex justify-between items-center">
              <Button variant="outline" size="sm" disabled={txnOffset === 0} onClick={() => setTxnOffset(Math.max(0, txnOffset - txnLimit))}>
                Previous
              </Button>
              <span className="text-xs text-zinc-500">
                {txnOffset + 1}–{txnOffset + (txns?.items?.length ?? 0)} of {txns?.total ?? "?"}
              </span>
              <Button variant="outline" size="sm" disabled={(txns?.items?.length ?? 0) < txnLimit} onClick={() => setTxnOffset(txnOffset + txnLimit)}>
                Next
              </Button>
            </div>
          </>
        )
      )}

      {tab === "subscribers" && (
        subLoading ? <SkeletonTable /> : (
          <>
            <DataTable columns={subColumns} data={subs?.items ?? []} emptyMessage="No active subscribers" />
            <div className="flex justify-between items-center">
              <Button variant="outline" size="sm" disabled={subOffset === 0} onClick={() => setSubOffset(Math.max(0, subOffset - subLimit))}>
                Previous
              </Button>
              <span className="text-xs text-zinc-500">
                {subOffset + 1}–{subOffset + (subs?.items?.length ?? 0)} of {subs?.total ?? "?"}
              </span>
              <Button variant="outline" size="sm" disabled={(subs?.items?.length ?? 0) < subLimit} onClick={() => setSubOffset(subOffset + subLimit)}>
                Next
              </Button>
            </div>
          </>
        )
      )}

      {tab === "followers" && (
        folLoading ? <SkeletonTable /> : (
          <>
            <DataTable columns={folColumns} data={followers?.items ?? []} emptyMessage="No followers" />
            <div className="flex justify-between items-center">
              <Button variant="outline" size="sm" disabled={folOffset === 0} onClick={() => setFolOffset(Math.max(0, folOffset - folLimit))}>
                Previous
              </Button>
              <span className="text-xs text-zinc-500">
                {folOffset + 1}–{folOffset + (followers?.items?.length ?? 0)} of {followers?.total ?? "?"}
              </span>
              <Button variant="outline" size="sm" disabled={(followers?.items?.length ?? 0) < folLimit} onClick={() => setFolOffset(folOffset + folLimit)}>
                Next
              </Button>
            </div>
          </>
        )
      )}
    </div>
  );
}
