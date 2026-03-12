import { useState } from "react";
import { useParams } from "react-router";
import { useFanDetail, useFanTransactions, useCreateFanNote, useSetFanFlags } from "@/api/queries";
import { Card, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, type Column } from "@/components/shared/DataTable";
import { MoneyCell } from "@/components/shared/MoneyCell";
import { PlatformIcon } from "@/components/shared/PlatformIcon";
import { SkeletonTable } from "@/components/shared/SkeletonTable";
import { TRANSACTION_TYPE_LABELS } from "@/lib/constants";
import { useAuthStore } from "@/stores/auth";

const FLAG_OPTIONS = ["whale", "vip", "risky"] as const;

export function FanDetailPage() {
  const { platform, platformUserId } = useParams<{ platform: string; platformUserId: string }>();
  const { data: fan, isLoading } = useFanDetail(platform!, platformUserId!);
  const { data: txns, isLoading: txnLoading } = useFanTransactions(platform!, platformUserId!, { limit: "50" });
  const createNote = useCreateFanNote();
  const setFlags = useSetFanFlags();
  const isOwner = useAuthStore((s) => s.isOwner);

  const [noteBody, setNoteBody] = useState("");
  const [notePageLabel, setNotePageLabel] = useState("");

  if (isLoading) return <SkeletonTable />;
  if (!fan) return <p className="text-zinc-400">Fan not found</p>;

  const activeFlags: string[] = (fan.flags ?? []).map((f: any) => f.flag);

  const toggleFlag = (flag: string) => {
    const next = activeFlags.includes(flag)
      ? activeFlags.filter((f) => f !== flag)
      : [...activeFlags, flag];
    setFlags.mutate({ platform: platform!, platformUserId: platformUserId!, flags: next });
  };

  const submitNote = (e: React.FormEvent) => {
    e.preventDefault();
    if (!noteBody.trim() || !notePageLabel) return;
    createNote.mutate(
      { pageLabel: notePageLabel, platformUserId: platformUserId!, body: noteBody },
      { onSuccess: () => setNoteBody("") },
    );
  };

  const txnColumns: Column<any>[] = [
    { key: "occurredAt", header: "Date", render: (r) => new Date(r.occurredAt).toLocaleDateString() },
    { key: "pageLabel", header: "Page", render: (r) => <span className="text-zinc-300">{r.pageLabel}</span> },
    { key: "type", header: "Type", render: (r) => TRANSACTION_TYPE_LABELS[r.canonicalType] ?? r.canonicalType },
    { key: "gross", header: "Gross", className: "text-right", render: (r) => <MoneyCell mills={r.grossAmountMills} /> },
    { key: "net", header: "Net", className: "text-right", render: (r) => <MoneyCell mills={r.netAmountMills} /> },
  ];

  const pages: Array<{ pageLabel: string }> = fan.pages ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <PlatformIcon platform={platform!} />
        <h1 className="text-lg font-semibold text-zinc-100">
          {fan.username ?? fan.platformUserId}
        </h1>
        {fan.displayName && <span className="text-zinc-400">({fan.displayName})</span>}
      </div>

      {/* Flags */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-500">Flags:</span>
        {FLAG_OPTIONS.map((flag) => (
          <Badge
            key={flag}
            variant={activeFlags.includes(flag) ? "success" : "outline"}
            className={isOwner ? "cursor-pointer" : ""}
            onClick={() => isOwner && toggleFlag(flag)}
          >
            {flag}
          </Badge>
        ))}
      </div>

      {/* Spend by page */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {(fan.spendByPage ?? []).map((s: any) => (
          <Card key={s.pageLabel}>
            <CardTitle>{s.pageLabel}</CardTitle>
            <CardContent>
              <MoneyCell mills={s.totalSpendMills} />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Transaction history */}
      <div>
        <h2 className="mb-2 text-sm font-medium text-zinc-400">Transactions</h2>
        {txnLoading ? <SkeletonTable rows={5} cols={5} /> : (
          <DataTable columns={txnColumns} data={txns?.items ?? []} />
        )}
      </div>

      {/* Notes */}
      <div>
        <h2 className="mb-2 text-sm font-medium text-zinc-400">Notes</h2>
        <div className="space-y-2 mb-4">
          {(fan.notes ?? []).map((note: any) => (
            <div key={note.id} className="rounded border border-zinc-800 bg-zinc-900 p-3">
              <p className="text-sm text-zinc-200">{note.body}</p>
              <p className="mt-1 text-xs text-zinc-500">
                {note.authorUsername} — {new Date(note.createdAt).toLocaleDateString()}
                {note.pageLabel && ` on ${note.pageLabel}`}
              </p>
            </div>
          ))}
        </div>
        <form onSubmit={submitNote} className="flex gap-2">
          <select
            value={notePageLabel}
            onChange={(e) => setNotePageLabel(e.target.value)}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100"
          >
            <option value="">Select page</option>
            {pages.map((p) => (
              <option key={p.pageLabel} value={p.pageLabel}>{p.pageLabel}</option>
            ))}
          </select>
          <Input
            placeholder="Add a note..."
            value={noteBody}
            onChange={(e) => setNoteBody(e.target.value)}
            className="flex-1"
          />
          <Button type="submit" size="sm" disabled={!noteBody.trim() || !notePageLabel || createNote.isPending}>
            Add
          </Button>
        </form>
      </div>
    </div>
  );
}
