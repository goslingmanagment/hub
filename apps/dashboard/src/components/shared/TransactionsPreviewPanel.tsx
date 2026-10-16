import { Link } from "react-router";
import { usePageFanTransactions } from "@/api/queries";
import { formatDateTime, formatRelativeTime, transactionStateLabel, transactionTypeLabel } from "@/lib/format";
import { formatUsdFromMills } from "@agency_hub_core/shared";

interface TransactionsPreviewPanelProps {
  pageLabel: string;
  platformUserId: string;
  profileHref: string;
  limit?: number;
}

const STATE_BADGE: Record<string, string> = {
  posted: "badge badge-success",
  pending: "badge badge-warning",
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
      <div className="bg-hover-alt px-5 py-4 sm:px-6">
        <span className="text-sm text-text-secondary">Загружаем операции…</span>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="bg-hover-alt px-5 py-4 sm:px-6">
        <span className="text-sm text-danger">Не удалось загрузить операции.</span>
      </div>
    );
  }

  if (data.items.length === 0) {
    return (
      <div className="bg-hover-alt px-5 py-4 sm:px-6">
        <span className="text-sm text-text-secondary">Операций пока нет.</span>
      </div>
    );
  }

  return (
    <div className="border-t border-border">
      <div className="max-h-[420px] overflow-auto">
        <table className="data-table">
          <thead className="sticky top-0">
            <tr>
              <th>Когда</th>
              <th>Тип</th>
              <th className="num">Всего</th>
              <th className="num">После комиссии</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((txn) => (
              <tr key={txn.transactionId}>
                <td>
                  <div className="font-medium">{formatRelativeTime(txn.occurredAt)}</div>
                  <div className="text-xs text-text-secondary">{formatDateTime(txn.occurredAt)}</div>
                </td>
                <td className="muted">{transactionTypeLabel(txn.canonicalType)}</td>
                <td className="num muted">{formatUsdFromMills(txn.amountMills)}</td>
                <td className="num font-medium">{formatUsdFromMills(txn.netAmountMills)}</td>
                <td>
                  <span className={STATE_BADGE[txn.transactionState] ?? "badge"}>
                    {transactionStateLabel(txn.transactionState)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border-light px-5 py-3 sm:px-6">
        <span className="text-xs text-text-secondary tabular-nums">
          Показаны {data.items.length} из {data.total}
        </span>
        <Link
          to={profileHref}
          onClick={(e) => e.stopPropagation()}
          className="link text-sm"
        >
          Открыть профиль
        </Link>
      </div>
    </div>
  );
}
