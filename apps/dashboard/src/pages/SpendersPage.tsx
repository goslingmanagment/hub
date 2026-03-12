import { useState } from "react";
import type { SpenderListResponse } from "@fansly-connect/contracts";
import { useNavigate } from "react-router";
import { useSpenders, useOverview } from "@/api/queries";
import { DataTable, type Column } from "@/components/shared/DataTable";
import { MoneyCell } from "@/components/shared/MoneyCell";
import { PlatformIcon } from "@/components/shared/PlatformIcon";
import { PeriodSelector } from "@/components/shared/PeriodSelector";
import { SkeletonTable } from "@/components/shared/SkeletonTable";
import { Button } from "@/components/ui/button";

export function SpendersPage() {
  const navigate = useNavigate();
  const { data: overview } = useOverview();
  const [period, setPeriod] = useState("30d");
  const [scope, setScope] = useState("agency");
  const [platform, setPlatform] = useState("fansly");
  const [pageLabel, setPageLabel] = useState("");
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const query: Record<string, string> = { scope, period, limit: String(limit), offset: String(offset) };
  if (scope === "agency") {
    query.platform = platform;
  } else if (scope === "page" && pageLabel) {
    query.pageLabel = pageLabel;
  }

  const { data, isLoading } = useSpenders(query);
  const rows = (data?.items ?? []).map((item, index) => ({
    _rank: offset + index + 1,
    platform: item.fan.platform,
    platformUserId: item.fan.platformUserId,
    username: item.fan.username,
    grossAmountMills: item.metrics.window?.grossAmountMills ?? item.metrics.lifetime.scopeGrossAmountMills,
    transactionCount: item.metrics.window?.transactionCount ?? null,
  }));

  const columns: Column<(typeof rows)[number]>[] = [
    { key: "rank", header: "#", className: "w-10", render: (r) => r._rank },
    { key: "username", header: "Fan", render: (r) => <span className="font-medium text-zinc-100">{r.username ?? r.platformUserId}</span> },
    { key: "platform", header: "Platform", render: (r) => <PlatformIcon platform={r.platform} /> },
    { key: "totalSpend", header: "Total Spend", className: "text-right", render: (r) => <MoneyCell mills={r.grossAmountMills} /> },
    { key: "txnCount", header: "Txns", className: "text-right", render: (r) => r.transactionCount ?? "—" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-zinc-100">Top Spenders</h1>
        <PeriodSelector
          value={period}
          onChange={(v) => { setPeriod(v); setOffset(0); }}
          options={[
            { value: "7d", label: "7D" },
            { value: "30d", label: "30D" },
            { value: "90d", label: "90D" },
            { value: "lifetime", label: "Lifetime" },
          ]}
        />
      </div>
      <div className="flex gap-3">
        <select
          value={scope}
          onChange={(e) => { setScope(e.target.value); setOffset(0); }}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100"
        >
          <option value="agency">Agency</option>
          <option value="page">Page</option>
        </select>
        {scope === "agency" && (
          <select
            value={platform}
            onChange={(e) => { setPlatform(e.target.value); setOffset(0); }}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100"
          >
            <option value="fansly">Fansly</option>
            <option value="onlyfans">OnlyFans</option>
          </select>
        )}
        {scope === "page" && (
          <select
            value={pageLabel}
            onChange={(e) => { setPageLabel(e.target.value); setOffset(0); }}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100"
          >
            <option value="">Select page</option>
            {(overview?.pages ?? []).map((p) => (
              <option key={p.label} value={p.label}>{p.label}</option>
            ))}
          </select>
        )}
      </div>
      {isLoading ? <SkeletonTable /> : (
        <>
          <DataTable
            columns={columns}
            data={rows}
            onRowClick={(r) => navigate(`/spenders/${r.platform}/${r.platformUserId}`)}
          />
          <div className="flex justify-between items-center">
            <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
              Previous
            </Button>
            <span className="text-xs text-zinc-500">
              {offset + 1}–{offset + (data?.items?.length ?? 0)} of {data?.total ?? "?"}
            </span>
            <Button variant="outline" size="sm" disabled={(data?.items?.length ?? 0) < limit} onClick={() => setOffset(offset + limit)}>
              Next
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
