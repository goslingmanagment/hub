import { useState } from "react";
import type { FansSearchResponse } from "@fansly-connect/contracts";
import { useNavigate } from "react-router";
import { useFansSearch } from "@/api/queries";
import { DataTable, type Column } from "@/components/shared/DataTable";
import { PlatformIcon } from "@/components/shared/PlatformIcon";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SkeletonTable } from "@/components/shared/SkeletonTable";

export function FansSearchPage() {
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState("");
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const navigate = useNavigate();

  const query: Record<string, string> = { scope: "agency", limit: String(limit), offset: String(offset) };
  if (search) query.query = search;
  if (platform) query.platform = platform;

  const { data, isLoading } = useFansSearch(query, search.length >= 2);
  const rows = (data?.items ?? []).map((item) => ({
    ...item.fan,
    pageCount: item.pages.length,
  }));

  const columns: Column<(typeof rows)[number]>[] = [
    { key: "username", header: "Username", render: (r) => <span className="font-medium text-zinc-100">{r.username ?? r.platformUserId}</span> },
    { key: "displayName", header: "Display Name", render: (r) => <span className="text-zinc-300">{r.displayName ?? "—"}</span> },
    { key: "platform", header: "Platform", render: (r) => <PlatformIcon platform={r.platform} /> },
    { key: "pages", header: "Pages", render: (r) => <span className="text-zinc-400">{r.pageCount}</span> },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-zinc-100">Fans</h1>
      <div className="flex gap-3">
        <Input
          placeholder="Search by username..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setOffset(0); }}
          className="max-w-sm"
        />
        <select
          value={platform}
          onChange={(e) => { setPlatform(e.target.value); setOffset(0); }}
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
        <>
          <DataTable
            columns={columns}
            data={rows}
            onRowClick={(r) => navigate(`/fans/${r.platform}/${r.platformUserId}`)}
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
