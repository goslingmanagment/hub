import { useQuery } from "@tanstack/react-query";
import { usePageFanTransactions } from "@/api/queries";
import { kernel } from "@/api/sdk";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatAgo, formatDateTime, formatMills, transactionTypeLabel } from "@/lib/format";
import { TRANSACTION_STATUS } from "@/lib/statusWords";

interface Row {
  transactionId: string;
  canonicalType: string;
  transactionState: string;
  amountMills: number;
  netAmountMills: number;
  occurredAt: string;
  pageLabel?: string;
}

/** «Проведена» plain, «Ожидает», «Неизвестно» as their words. */
export function TransactionState({ state }: { state: string }) {
  const word = TRANSACTION_STATUS[state];
  if (word === undefined) return <span>{state}</span>;
  return word === null ? <span>Проведена</span> : <StatusBadge status={word} />;
}

/**
 * The fan's last operations, in a panel. One page: that page's; every page: the
 * platform's, with a page column. Reads only.
 */
export function TransactionsPreviewPanel({ pageLabel, platform, platformUserId, limit = 15 }: {
  /** Null: every page of the platform. */
  pageLabel: string | null;
  platform: string;
  platformUserId: string;
  limit?: number;
}) {
  const one = usePageFanTransactions(pageLabel ?? "", pageLabel ? platformUserId : "", { limit });
  const all = useQuery({
    queryKey: ["crossPageFanTransactions", platform, platformUserId, limit],
    queryFn: () => kernel.crossPageFanTransactions({
      params: { platform, platformUserId } as Parameters<typeof kernel.crossPageFanTransactions>[0]["params"],
      query: { limit },
    }),
    enabled: pageLabel === null,
    meta: { suppressGlobalError: true },
  });
  const query = pageLabel ? one : all;
  const data = query.data as { items: Row[]; total: number } | undefined;

  if (!data) {
    if (query.isError) return <NoAnswerPanel retry={query.refetch} />;
    return <TableSkeleton rows={6} columns={pageLabel ? 5 : 6} />;
  }
  if (data.items.length === 0) {
    return <div className="empty"><p className="empty-title">Операций пока нет.</p></div>;
  }
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Когда</th>
            {!pageLabel && <th scope="col">Страница</th>}
            <th scope="col">Вид дохода</th>
            <th scope="col" className="num">До комиссии</th>
            <th scope="col" className="num">После комиссии</th>
            <th scope="col">Статус</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((row) => (
            <tr key={row.transactionId}>
              <td>
                <div>{formatDateTime(row.occurredAt, { yearUnlessCurrent: true })}</div>
                <div className="fan-cell-sub">{formatAgo(row.occurredAt)}</div>
              </td>
              {!pageLabel && <td>{row.pageLabel ?? "—"}</td>}
              <td>{transactionTypeLabel(row.canonicalType)}</td>
              <td className="num muted">{formatMills(row.amountMills)}</td>
              <td className="num">{formatMills(row.netAmountMills)}</td>
              <td className="status-col"><TransactionState state={row.transactionState} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="card-footer">
        <span className="tabular-nums">Показаны {data.items.length} из {data.total}</span>
      </div>
    </div>
  );
}
