import { useNavigate } from "react-router";
import { AlertTriangle } from "lucide-react";
import { useOverview } from "@/api/queries";
import { Card, CardTitle, CardContent } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/shared/DataTable";
import { MoneyCell } from "@/components/shared/MoneyCell";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { RelativeDate } from "@/components/shared/RelativeDate";
import { PlatformIcon } from "@/components/shared/PlatformIcon";
import { EmptyState } from "@/components/shared/EmptyState";
import { SkeletonTable } from "@/components/shared/SkeletonTable";
import { formatCompactUsd } from "@/lib/format";
import { CONNECTION_STATUS_LABELS } from "@/lib/constants";

export function OverviewPage() {
  const { data, isLoading } = useOverview();
  const navigate = useNavigate();

  if (isLoading) return <SkeletonTable rows={6} cols={6} />;

  if (!data?.setup?.hasPages) {
    return (
      <EmptyState
        message="No pages connected yet."
        actionLabel="Add credentials to get started"
        actionTo="/settings/credentials"
      />
    );
  }

  const columns: Column<any>[] = [
    {
      key: "label",
      header: "Page",
      render: (r) => (
        <div>
          <div className="font-medium text-zinc-100">{r.label}</div>
          <div className="text-xs text-zinc-500">{r.modelName}</div>
        </div>
      ),
    },
    { key: "platform", header: "Platform", render: (r) => <PlatformIcon platform={r.platform} /> },
    { key: "subscribers", header: "Subs", className: "text-right", render: (r) => <span className="text-zinc-300">{r.subscriberCount?.toLocaleString() ?? "—"}</span> },
    { key: "followers", header: "Followers", className: "text-right", render: (r) => <span className="text-zinc-300">{r.followerCount?.toLocaleString() ?? "—"}</span> },
    { key: "revenue7d", header: "7D Rev", className: "text-right", render: (r) => <MoneyCell mills={r.revenue7dMills} /> },
    { key: "status", header: "Status", render: (r) => <StatusBadge status={r.connectionStatus} /> },
    { key: "lastSync", header: "Last Sync", render: (r) => <RelativeDate iso={r.lastLightSyncAt} /> },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-zinc-100">Overview</h1>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Card>
          <CardTitle>Models</CardTitle>
          <CardContent><span className="text-2xl font-bold">{data.counts.models}</span></CardContent>
        </Card>
        <Card>
          <CardTitle>Pages</CardTitle>
          <CardContent><span className="text-2xl font-bold">{data.counts.pages}</span></CardContent>
        </Card>
        <Card>
          <CardTitle>Fans</CardTitle>
          <CardContent><span className="text-2xl font-bold">{data.counts.fans.toLocaleString()}</span></CardContent>
        </Card>
        <Card>
          <CardTitle>7D Revenue</CardTitle>
          <CardContent>
            <span className="text-2xl font-bold">{formatCompactUsd(data.revenue["7d"].netEarningsMills)}</span>
            {data.revenue["7d"].deltaPct != null && (
              <span className={`ml-2 text-sm font-medium ${data.revenue["7d"].deltaPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {data.revenue["7d"].deltaPct >= 0 ? "+" : ""}{data.revenue["7d"].deltaPct.toFixed(1)}%
              </span>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardTitle>30D Revenue</CardTitle>
          <CardContent>
            <span className="text-2xl font-bold">{formatCompactUsd(data.revenue["30d"].netEarningsMills)}</span>
            {data.revenue["30d"].deltaPct != null && (
              <span className={`ml-2 text-sm font-medium ${data.revenue["30d"].deltaPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {data.revenue["30d"].deltaPct >= 0 ? "+" : ""}{data.revenue["30d"].deltaPct.toFixed(1)}%
              </span>
            )}
          </CardContent>
        </Card>
      </div>

      {(() => {
        const problemPages = data.pages.filter(
          (p) => p.connectionStatus === "error" || p.connectionStatus === "expired" || p.connectionStatus === "stale",
        );
        if (problemPages.length === 0) return null;
        return (
          <div className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
            <span className="text-sm text-amber-300">
              {problemPages.length} page{problemPages.length > 1 ? "s" : ""} with issues:
            </span>
            <div className="flex flex-wrap gap-2">
              {problemPages.map((p) => (
                <button
                  key={p.label}
                  onClick={() => navigate("/sync")}
                  className="rounded bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-300 hover:bg-amber-500/30"
                >
                  {p.label} — {CONNECTION_STATUS_LABELS[p.connectionStatus] ?? p.connectionStatus}
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      <DataTable
        columns={columns}
        data={data.pages}
        onRowClick={(r: any) => navigate(`/pages/${r.label}`)}
      />
    </div>
  );
}
