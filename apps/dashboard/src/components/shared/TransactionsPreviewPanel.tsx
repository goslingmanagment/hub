import { Link } from "react-router";
import { usePageFanTransactions } from "@/api/queries";
import { formatDateTime, formatRelativeTime, transactionTypeLabel } from "@/lib/format";
import { formatUsdFromMills } from "@agency_hub_core/shared";

interface TransactionsPreviewPanelProps {
  pageLabel: string;
  platformUserId: string;
  profileHref: string;
  limit?: number;
}

const STATE_STYLES: Record<string, string> = {
  posted: "bg-green/15 text-green",
  pending: "bg-warning/15 text-warning-dark",
  unknown: "bg-text-muted/15 text-text-muted",
};

export function TransactionsPreviewPanel({
  pageLabel,
  platformUserId,
  profileHref,
  limit = 15,
}: TransactionsPreviewPanelProps) {
  const { data, isLoading, isError } = usePageFanTransactions(pageLabel, platformUserId, { limit });

  if (isLoading) {
    return (
      <div className="bg-hover/50 px-6 py-4">
        <span className="text-sm text-text-muted">Loading transactions...</span>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="bg-hover/50 px-6 py-4">
        <span className="text-sm text-text-muted">Transactions failed to load.</span>
      </div>
    );
  }

  if (data.items.length === 0) {
    return (
      <div className="bg-hover/50 px-6 py-4">
        <span className="text-sm text-text-secondary">No transactions yet.</span>
      </div>
    );
  }

  return (
    <div className="bg-hover/50">
      <div className="max-h-[420px] overflow-y-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-hover-alt">
            <tr>
              <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                When
              </th>
              <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                Type
              </th>
              <th className="px-4 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                Gross
              </th>
              <th className="px-4 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                Net
              </th>
              <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                State
              </th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((txn) => {
              const stateClass = STATE_STYLES[txn.transactionState] ?? STATE_STYLES.unknown;
              return (
                <tr key={txn.transactionId} className="border-t border-border">
                  <td className="px-4 py-2 align-middle">
                    <div className="text-sm font-medium text-text-primary">
                      {formatRelativeTime(txn.occurredAt)}
                    </div>
                    <div className="text-[11px] text-text-muted">
                      {formatDateTime(txn.occurredAt)}
                    </div>
                  </td>
                  <td className="px-4 py-2 align-middle text-sm text-text-secondary">
                    {transactionTypeLabel(txn.canonicalType)}
                  </td>
                  <td className="px-4 py-2 align-middle text-right text-sm tabular-nums text-text-secondary">
                    {formatUsdFromMills(txn.amountMills)}
                  </td>
                  <td className="px-4 py-2 align-middle text-right text-sm font-medium tabular-nums text-text-primary">
                    {formatUsdFromMills(txn.netAmountMills)}
                  </td>
                  <td className="px-4 py-2 align-middle">
                    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${stateClass}`}>
                      {txn.transactionState}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between border-t border-border px-6 py-2">
        <span className="text-[11px] text-text-muted">
          Showing {data.items.length} of {data.total}
        </span>
        <Link
          to={profileHref}
          onClick={(e) => e.stopPropagation()}
          className="text-[12px] font-medium text-accent hover:underline"
        >
          View Full Profile
        </Link>
      </div>
    </div>
  );
}
