import { Link, useSearchParams } from "react-router";
import { reportableTransactionTypes } from "@agency_hub_core/shared";
import { useRevenueTransactions } from "@/api/transactions";
import { Pagination } from "@/components/shared/Pagination";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { safeBackTo } from "@/lib/overviewNavigation";
import {
  matchesTransactionScope,
  parseTransactionSearch,
} from "@/lib/transactionNavigation";
import { money, SOURCE_LABELS } from "@/lib/revenueDisplay";
import { QueryNotice } from "@/components/shared/QueryNotice";

const STATE_LABELS: Record<string, string> = { pending: "Ожидает подтверждения", posted: "Проведена", unknown: "Неизвестен" };

const timestamp = (value: string) =>
  new Date(value).toLocaleString("ru-RU", { timeZone: "UTC" });

export function TransactionsPage() {
  const [search, setSearch] = useSearchParams();
  const parsed = parseTransactionSearch(search);
  const params = parsed.success ? parsed.data : undefined;
  const query = useRevenueTransactions(params);
  const data = query.data;
  const compatible = data && params && matchesTransactionScope(data, params);
  function update(key: string, value: string) {
    setSearch((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value);
      else next.delete(key);
      if (key !== "offset") next.delete("offset");
      return next;
    });
  }

  return (
    <div className="p-4 md:p-0">
      <Link className="text-accent text-sm" to={safeBackTo(search)}>
        ← К дашборду
      </Link>
      <h1 className="text-xl font-bold mt-3 mb-1">
        Операции · {params?.pageLabel ?? "Доступные страницы"}
      </h1>
      {params && (
        <p className="text-sm text-text-muted mb-4">
          {params.from && params.to
            ? `${timestamp(params.from)} ≤ время операции < ${timestamp(params.to)} UTC`
            : "Вся сохранённая история"}
          .{" "}
          {params.reportableOnly
            ? "Операции, входящие в доход; отмены выплат исключены."
            : "Все типы операций."}
        </p>
      )}
      {!params ? (
        <StatusPanel
          tone="error"
          title="Некорректная ссылка на операции"
          description="Нужны обе границы времени с часовым поясом; конец окна должен быть позже начала."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-4 mb-4">
            <label className="text-sm text-text-secondary">
              Источник{" "}
              <select
                className="border border-border rounded-lg p-2 bg-card"
                aria-label="Источник операций"
                value={params.type ?? ""}
                onChange={(event) => update("type", event.target.value)}
              >
                <option value="">Все источники</option>
                {[
                  ...reportableTransactionTypes,
                  ...(!params.reportableOnly ? ["payout_reversal"] : []),
                ].map((type) => (
                  <option key={type} value={type}>
                    {SOURCE_LABELS[type] ?? type}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-text-secondary">
              Статус{" "}
              <select
                className="border border-border rounded-lg p-2 bg-card"
                aria-label="Статус операций"
                value={params.state ?? ""}
                onChange={(event) => update("state", event.target.value)}
              >
                <option value="">Все статусы</option>
                {["pending", "posted", "unknown"].map((state) => (
                  <option key={state} value={state}>
                    {STATE_LABELS[state] ?? state}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <QueryNotice
            error={query.isError}
            stale={Boolean(data)}
            retry={query.refetch}
          />
          {query.isLoading ? (
            <TableSkeleton rows={6} columns={5} />
          ) : data && !compatible ? (
            <StatusPanel
              tone="error"
              title="Сервер не подтвердил выбранные фильтры"
              description="Этот ответ нельзя использовать для сверки суммы. Обновите сервер до версии с точной детализацией операций."
            />
          ) : (
            compatible &&
            data && (
              <>
                <div className="rounded-xl border border-border bg-card p-4 mb-4">
                  <strong className="text-xl tabular-nums">
                    {money(data.summary!.netAmountMills)}
                  </strong>
                  <span className="ml-3 text-text-secondary">
                    {data.total.toLocaleString("ru-RU")} операций во всём
                    фильтре
                  </span>
                  <p className="text-xs text-text-muted mt-1">
                    После комиссии платформы. Итог и список прочитаны вместе:{" "}
                    {timestamp(data.summary!.readAt)} UTC. При новом чтении
                    сумма может измениться из-за поступивших записей.
                  </p>
                </div>
                <div className="overflow-x-auto rounded-xl border border-border bg-card">
                  <table className="w-full text-sm">
                    <thead className="text-text-muted bg-hover-alt">
                      <tr>
                        {[
                          "Время UTC",
                          "Источник",
                          "Статус",
                          "После комиссии",
                          "Операция",
                        ].map((label) => (
                          <th key={label} className="p-3 text-left font-medium">
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((item) => (
                        <tr
                          key={`${item.pageLabel}:${item.transactionId}`}
                          className="border-t border-border"
                        >
                          <td className="p-3 whitespace-nowrap">
                            {timestamp(item.occurredAt)}
                          </td>
                          <td className="p-3">
                            {SOURCE_LABELS[item.canonicalType] ??
                              item.canonicalType}
                          </td>
                          <td className="p-3">{STATE_LABELS[item.transactionState] ?? item.transactionState}</td>
                          <td className="p-3 tabular-nums whitespace-nowrap">
                            {money(item.netAmountMills)}
                          </td>
                          <td className="p-3 text-xs text-text-muted">
                            <span>
                              {item.pageLabel} · {item.transactionId}
                            </span>
                          </td>
                        </tr>
                      ))}
                      {data.items.length === 0 && (
                        <tr>
                          <td
                            colSpan={5}
                            className="p-8 text-center text-text-muted"
                          >
                            {data.total
                              ? "На этой странице списка записей нет. Вернитесь к первой странице."
                              : "В этом фильтре операций не записано."}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <Pagination
                  offset={params.offset}
                  limit={params.limit}
                  total={data.total}
                  onPageChange={(offset) => update("offset", String(offset))}
                />
              </>
            )
          )}
        </>
      )}
    </div>
  );
}
