import { useNavigate } from "react-router";
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
          <CardContent><span className="text-2xl font-bold">{formatCompactUsd(data.revenue["7d"].netEarningsMills)}</span></CardContent>
        </Card>
        <Card>
          <CardTitle>30D Revenue</CardTitle>
          <CardContent><span className="text-2xl font-bold">{formatCompactUsd(data.revenue["30d"].netEarningsMills)}</span></CardContent>
        </Card>
      </div>

      <DataTable
        columns={columns}
        data={data.pages}
        onRowClick={(r: any) => navigate(`/pages/${r.label}`)}
      />
    </div>
  );
}
