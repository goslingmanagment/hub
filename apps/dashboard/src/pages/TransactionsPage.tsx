import { useState, useCallback } from "react";
import type { CrossPageTransactionItem } from "@fansly-connect/contracts";
import { useTransactions, useOverview } from "@/api/queries";
import { DataTable, type Column } from "@/components/shared/DataTable";
import { MoneyCell } from "@/components/shared/MoneyCell";
import { PlatformIcon } from "@/components/shared/PlatformIcon";
import { SkeletonTable } from "@/components/shared/SkeletonTable";
import { TRANSACTION_TYPE_LABELS } from "@/lib/constants";
import { Button } from "@/components/ui/button";

export function TransactionsPage() {
  const { data: overview } = useOverview();
  const [pageLabel, setPageLabel] = useState("");
  const [sortBy, setSortBy] = useState("occurredAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const query: Record<string, string> = { limit: String(limit), offset: String(offset), sortBy, sortDir };
  if (pageLabel) query.pageLabel = pageLabel;

  const { data, isLoading } = useTransactions(query);

  const handleSort = useCallback((key: string) => {
    if (key === sortBy) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(key);
      setSortDir("desc");
    }
    setOffset(0);
  }, [sortBy]);

  const columns: Column<CrossPageTransactionItem>[] = [
    { key: "occurredAt", header: "Date", sortable: true, render: (r) => new Date(r.occurredAt).toLocaleDateString() },
    { key: "pageLabel", header: "Page", render: (r) => <span className="text-zinc-300">{r.pageLabel}</span> },
    { key: "platform", header: "Platform", render: (r) => <PlatformIcon platform={r.platform} /> },
    { key: "type", header: "Type", render: (r) => TRANSACTION_TYPE_LABELS[r.canonicalType] ?? r.canonicalType },
    { key: "state", header: "State", render: (r) => <span className="text-zinc-400">{r.transactionState}</span> },
    { key: "fan", header: "Fan", render: (r) => r.fan?.username ?? r.fan?.platformUserId ?? "—" },
    { key: "grossAmountMills", header: "Gross", sortable: true, className: "text-right", render: (r) => <MoneyCell mills={r.amountMills} /> },
    { key: "netAmountMills", header: "Net", sortable: true, className: "text-right", render: (r) => <MoneyCell mills={r.netAmountMills} /> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-zinc-100">Transactions</h1>
        <select
          value={pageLabel}
          onChange={(e) => { setPageLabel(e.target.value); setOffset(0); }}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100"
        >
          <option value="">All pages</option>
          {(overview?.pages ?? []).map((p) => (
            <option key={p.label} value={p.label}>{p.label}</option>
          ))}
        </select>
      </div>
      {isLoading ? <SkeletonTable /> : (
        <>
          <DataTable
            columns={columns}
            data={data?.items ?? []}
            sortBy={sortBy}
            sortDir={sortDir}
            onSort={handleSort}
          />
          <div className="flex justify-between">
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
