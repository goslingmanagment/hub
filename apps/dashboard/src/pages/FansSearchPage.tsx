import { useState } from "react";
import { useNavigate } from "react-router";
import { useFansSearch } from "@/api/queries";
import { DataTable, type Column } from "@/components/shared/DataTable";
import { PlatformIcon } from "@/components/shared/PlatformIcon";
import { MoneyCell } from "@/components/shared/MoneyCell";
import { Input } from "@/components/ui/input";
import { SkeletonTable } from "@/components/shared/SkeletonTable";

export function FansSearchPage() {
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState("");
  const navigate = useNavigate();

  const query: Record<string, string> = { limit: "50" };
  if (search) query.q = search;
  if (platform) query.platform = platform;

  const { data, isLoading } = useFansSearch(query, search.length >= 2);

  const columns: Column<any>[] = [
    { key: "username", header: "Username", render: (r) => <span className="font-medium text-zinc-100">{r.username ?? r.platformUserId}</span> },
    { key: "displayName", header: "Display Name", render: (r) => <span className="text-zinc-300">{r.displayName ?? "—"}</span> },
    { key: "platform", header: "Platform", render: (r) => <PlatformIcon platform={r.platform} /> },
    { key: "pages", header: "Pages", render: (r) => <span className="text-zinc-400">{r.pageCount ?? "—"}</span> },
    { key: "totalSpend", header: "Total Spend", className: "text-right", render: (r) => <MoneyCell mills={r.totalSpendMills} /> },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-zinc-100">Fans</h1>
      <div className="flex gap-3">
        <Input
          placeholder="Search by username..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100"
        >
          <option value="">All platforms</option>
          <option value="fansly">Fansly</option>
          <option value="onlyfans">OnlyFans</option>
        </select>
      </div>
      {search.length < 2 ? (
        <p className="py-8 text-center text-zinc-500">Type at least 2 characters to search</p>
      ) : isLoading ? (
        <SkeletonTable />
      ) : (
        <DataTable
          columns={columns}
          data={data?.fans ?? []}
          onRowClick={(r: any) => navigate(`/fans/${r.platform}/${r.platformUserId}`)}
        />
      )}
    </div>
  );
}
