import { useNavigate } from "react-router";
import { useOverview } from "@/api/queries";
import { DataTable, type Column } from "@/components/shared/DataTable";
import { MoneyCell } from "@/components/shared/MoneyCell";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { PlatformIcon } from "@/components/shared/PlatformIcon";
import { RelativeDate } from "@/components/shared/RelativeDate";
import { SkeletonTable } from "@/components/shared/SkeletonTable";

export function PagesListPage() {
  const { data, isLoading } = useOverview();
  const navigate = useNavigate();

  if (isLoading) return <SkeletonTable />;

  const columns: Column<any>[] = [
    {
      key: "label",
      header: "Page",
      render: (r) => (
        <div>
          <div className="font-medium text-zinc-100">{r.label}</div>
          <div className="text-xs text-zinc-500">@{r.username}</div>
        </div>
      ),
    },
    { key: "platform", header: "Platform", render: (r) => <PlatformIcon platform={r.platform} /> },
    { key: "model", header: "Model", render: (r) => <span className="text-zinc-300">{r.modelName}</span> },
    { key: "subscribers", header: "Subs", className: "text-right", render: (r) => r.subscriberCount?.toLocaleString() ?? "—" },
    { key: "followers", header: "Followers", className: "text-right", render: (r) => r.followerCount?.toLocaleString() ?? "—" },
    { key: "revenue7d", header: "7D Rev", className: "text-right", render: (r) => <MoneyCell mills={r.revenue7dMills} /> },
    { key: "status", header: "Status", render: (r) => <StatusBadge status={r.connectionStatus} /> },
    { key: "lastSync", header: "Last Sync", render: (r) => <RelativeDate iso={r.lastLightSyncAt} /> },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-zinc-100">Pages</h1>
      <DataTable
        columns={columns}
        data={data?.pages ?? []}
        onRowClick={(r: any) => navigate(`/pages/${r.label}`)}
      />
    </div>
  );
}
