import { Link, useLocation, useSearchParams } from "react-router";
import type { CrossPageTransactionItem } from "@agency_hub_core/contracts";
import { reportableTransactionTypes } from "@agency_hub_core/shared";
import { useRevenueTransactions } from "@/api/transactions";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/shared/Pagination";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { transactionStateLabel, transactionTypeLabel } from "@/lib/format";
import { buildFanProfileNavigation } from "@/lib/navigation";
import { safeBackTo } from "@/lib/overviewNavigation";
import {
  matchesTransactionScope,
  parseTransactionSearch,
} from "@/lib/transactionNavigation";
import { money, SOURCE_LABELS } from "@/lib/revenueDisplay";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { windowLabel } from "./overview/presentation.js";

const STATES = ["pending", "posted", "unknown"] as const;

// The drill-down reconciles a window of whole UTC days, so its times are UTC
// too: an operation late in the evening must land on the day it is counted in.
const utcFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const utcFormatWithYear = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
function utcTime(iso: string) {
  const date = new Date(iso);
  return date.getUTCFullYear() === new Date().getUTCFullYear()
    ? utcFormat.format(date)
    : utcFormatWithYear.format(date);
}

const isUtcMidnight = (iso: string) =>
  new Date(iso).toISOString().endsWith("T00:00:00.000Z");

/** The window in words: whole days as a date range, anything else as the
 *  exact instants it starts and ends at. */
function describeRange(from: string | undefined, to: string | undefined) {
  if (!from || !to) return "вся сохранённая история";
  if (isUtcMidnight(from) && isUtcMidnight(to))
    return `${windowLabel(from, to)} (UTC)`;
  return `с ${utcTime(from)} до ${utcTime(to)} (UTC)`;
}

function TransactionState({ state }: { state: string }) {
  const label = transactionStateLabel(state);
  if (state === "pending")
    return <span className="badge badge-warning">{label}</span>;
  if (state === "posted") return <span className="muted">{label}</span>;
  return <span className="badge">{label}</span>;
}

function FanCell({
  item,
  backTo,
}: {
  item: CrossPageTransactionItem;
  backTo: string;
}) {
  const fan = item.fan;
  if (!fan) return <span className="text-text-muted">—</span>;
  const handle = fan.username ? `@${fan.username}` : null;
  const name = fan.displayName || handle || "Фан без имени";
  const navigation = buildFanProfileNavigation(
    item.pageLabel,
    item.platform,
    fan.platformUserId,
    backTo,
    name,
  );
  return (
    <div className="min-w-0">
      <Link className="link" to={navigation.to} state={navigation.state}>
        {name}
      </Link>
      {fan.displayName && handle && (
        <div className="text-xs text-text-muted">{handle}</div>
      )}
    </div>
  );
}

export function TransactionsPage() {
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const parsed = parseTransactionSearch(search);
  const params = parsed.success ? parsed.data : undefined;
  const query = useRevenueTransactions(params);
  const data = query.data;
  const compatible = data && params && matchesTransactionScope(data, params);
  const back = search.has("backTo") ? safeBackTo(search) : null;
  const here = `${location.pathname}${location.search}`;
  const showPage = !params?.pageLabel;
  const columns = showPage ? 6 : 5;
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
    <div className="space-y-5">
      <PageHeader
        title="Операции"
        description={
          params
            ? `${params.pageLabel ?? "Все страницы"} · ${describeRange(params.from, params.to)}`
            : undefined
        }
        actions={
          back && (
            <Link className="btn btn-ghost btn-sm" to={back}>
              ← {back === "/" || back.startsWith("/?") ? "Назад к обзору" : "Назад"}
            </Link>
          )
        }
      />
      {!params ? (
        <StatusPanel
          tone="error"
          title="Некорректная ссылка на операции"
          description="В ссылке нет периода или он задан неверно. Откройте операции из обзора ещё раз."
          action={<Link to="/">К обзору</Link>}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="field-label">Источник</span>
              <select
                className="select w-auto min-w-48"
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
            <label className="block">
              <span className="field-label">Статус</span>
              <select
                className="select w-auto min-w-40"
                value={params.state ?? ""}
                onChange={(event) => update("state", event.target.value)}
              >
                <option value="">Все статусы</option>
                {STATES.map((state) => (
                  <option key={state} value={state}>
                    {transactionStateLabel(state)}
                  </option>
                ))}
              </select>
            </label>
            {params.reportableOnly && (
              <p className="pb-2 text-[13px] text-text-secondary">
                Только операции, входящие в доход
              </p>
            )}
          </div>
          <QueryNotice
            error={query.isError}
            stale={Boolean(data)}
            retry={query.refetch}
          />
          {query.isLoading ? (
            <TableSkeleton rows={6} columns={columns} />
          ) : data && !compatible ? (
            <StatusPanel
              tone="error"
              title="Сервер не подтвердил выбранные фильтры"
              description="По такому ответу сумму не сверить. Обновите Hub до версии с точной детализацией операций."
            />
          ) : (
            compatible &&
            data && (
              <>
                <div className="stat-grid max-sm:grid-cols-2 sm:max-w-2xl">
                  <div className="stat">
                    <p className="stat-label">Сумма после комиссии</p>
                    <p className="stat-value">
                      {money(data.summary!.netAmountMills)}
                    </p>
                    <p className="stat-meta">
                      Данные на {utcTime(data.summary!.readAt)} (UTC)
                    </p>
                  </div>
                  <div className="stat">
                    <p className="stat-label">Операций</p>
                    <p className="stat-value">
                      {data.total.toLocaleString("ru-RU")}
                    </p>
                    <p className="stat-meta">С учётом выбранных фильтров</p>
                  </div>
                </div>
                <div className="card overflow-hidden">
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th scope="col">Время (UTC)</th>
                          <th scope="col">Фан</th>
                          {showPage && <th scope="col">Страница</th>}
                          <th scope="col">Источник</th>
                          <th scope="col">Статус</th>
                          <th scope="col" className="num">
                            Сумма
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.items.map((item) => (
                          <tr key={`${item.pageLabel}:${item.transactionId}`}>
                            <td
                              className="whitespace-nowrap"
                              title={`ID операции: ${item.transactionId}`}
                            >
                              {utcTime(item.occurredAt)}
                            </td>
                            <td>
                              <FanCell item={item} backTo={here} />
                            </td>
                            {showPage && <td className="muted">{item.pageLabel}</td>}
                            <td>{transactionTypeLabel(item.canonicalType)}</td>
                            <td>
                              <TransactionState state={item.transactionState} />
                            </td>
                            <td
                              className={`num ${item.netAmountMills < 0 ? "text-danger" : ""}`}
                            >
                              {money(item.netAmountMills)}
                            </td>
                          </tr>
                        ))}
                        {data.items.length === 0 && (
                          <tr>
                            <td colSpan={columns} className="py-10 text-center text-text-secondary">
                              {data.total
                                ? "На этой странице списка записей нет. Вернитесь к первой странице."
                                : "С этими фильтрами операций нет."}
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
                </div>
              </>
            )
          )}
        </>
      )}
    </div>
  );
}
