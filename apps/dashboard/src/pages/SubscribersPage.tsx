import { useMemo } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { usePageSubscribers } from "@/api/queries";
import { Badge } from "@/components/shared/Badge";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { Pagination } from "@/components/shared/Pagination";
import { RemainingBar } from "@/components/shared/RemainingBar";
import { SearchInput } from "@/components/shared/SearchInput";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { buildFanProfileNavigation } from "@/lib/navigation";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { resolveFanLabelForScope } from "@agency_hub_core/shared";
import { formatDate, formatDateTime, daysRemaining, formatUsdFromCents } from "@/lib/format";
import { ruPlural } from "@/lib/plural";

import { listOffset, safeBackTo, subscriberFilter } from "@/lib/overviewNavigation";
import { QueryNotice } from "@/components/shared/QueryNotice";

const LIMIT = 50;

function isNewWithin24Hours(iso: string | null) {
  if (!iso) return false;
  const age = Date.now() - new Date(iso).getTime();
  return age >= 0 && age < 86_400_000;
}

function subscribersCount(count: number) {
  return `${count} ${ruPlural(count, "подписчик", "подписчика", "подписчиков")}`;
}

export function SubscribersPage() {
  const { pageLabel } = useParams();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const filter = subscriberFilter(search.get("filter"));
  const searchQuery = search.get("query") ?? "";
  const offset = listOffset(search.get("offset"));
  function update(key: string, value: string) {
    setSearch((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value); else next.delete(key);
      if (key !== "offset") next.delete("offset");
      return next;
    });
  }

  const params = useMemo(() => ({
    limit: LIMIT,
    offset,
    query: searchQuery || undefined,
    expiringWithinDays: filter === "expiring7d" ? 7 : undefined,
    startedWithinHours: filter === "new24h" ? 24 : undefined,
    autoRenew: filter === "norenew" ? false : undefined,
  }), [filter, offset, searchQuery]);

  const { data, isLoading, isError, refetch } = usePageSubscribers(pageLabel!, params, {
    suppressGlobalError: true,
  });

  // Filter count queries (lightweight, limit: 1). Like the other chips, the
  // "All" count ignores the active filter AND the search box — chips mean
  // "population per category"; search only narrows the table below.
  const { data: allCount } = usePageSubscribers(pageLabel!, { limit: 1 });
  const { data: expiringCount } = usePageSubscribers(pageLabel!, { limit: 1, expiringWithinDays: 7 });
  const { data: newCount } = usePageSubscribers(pageLabel!, { limit: 1, startedWithinHours: 24 });
  const { data: noRenewCount } = usePageSubscribers(pageLabel!, { limit: 1, autoRenew: false });

  if (isLoading || !data) {
    if (isLoading) {
      return <TableSkeleton rows={6} columns={6} />;
    }
    if (isError) {
      return (
        <StatusPanel
          title="Не удалось загрузить подписчиков"
          description="Список подписчиков этой страницы сейчас недоступен."
          tone="error"
          action={<><button type="button" onClick={() => void refetch()}>Повторить</button><Link to={safeBackTo(search)}>К обзору</Link></>}
        />
      );
    }
    return <TableSkeleton rows={6} columns={6} />;
  }

  const platform = data.page.platform;
  const items = data.items;
  const total = data.total;
  const filters = [
    { key: "all", label: "Все", count: allCount?.total },
    { key: "expiring7d", label: "Истекают ≤7 дн", count: expiringCount?.total },
    { key: "new24h", label: "Новые за 24 ч", count: newCount?.total },
    { key: "norenew", label: "Без автопродления", count: noRenewCount?.total },
  ];
  const narrowed = filter !== "all" || searchQuery !== "";
  // The population comes from its own unfiltered count; the main query's
  // total is the match count of the active filter and search.
  const countLine = !allCount
    ? "Общее число недоступно"
    : narrowed
      ? (offset > 0 && items.length === 0 ? `Всего ${subscribersCount(allCount.total)}` : `Найдено ${total} из ${allCount.total}`)
      : subscribersCount(allCount.total);

  return (
    <div>
      <QueryNotice error={isError} stale={Boolean(data)} retry={refetch} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <FilterButtons
          filters={filters}
          active={filter}
          onChange={(next) => update("filter", next)}
        />
        <SearchInput
          value={searchQuery}
          onChange={(value) => update("query", value)}
          placeholder="Поиск подписчика"
        />
      </div>

      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[13px] text-text-secondary">
        <span className="tabular-nums">{countLine}</span>
        {search.has("backTo") && <Link className="link" to={safeBackTo(search)}>← К обзору</Link>}
      </div>

      <section className="card overflow-hidden" aria-label="Подписчики">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Фан</th>
                <th>С нами с</th>
                <th>Осталось</th>
                <th>Автопродление</th>
                <th className="num">Потратил</th>
                <th>Последняя операция</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-text-secondary">
                    {offset > 0 ? "На этой странице списка записей нет." : (narrowed ? "Под этот фильтр подписчиков нет." : "Подписчиков пока нет.")}
                    {offset > 0 && <button type="button" className="link ml-2" onClick={() => update("offset", "")}>К началу списка</button>}
                  </td>
                </tr>
              )}
              {items.map((sub) => {
                const days = sub.endsAt ? daysRemaining(sub.endsAt) : null;
                const isNew = isNewWithin24Hours(sub.startedAt);
                const fanLabel = resolveFanLabelForScope(sub, "page");
                const fanNavigation = buildFanProfileNavigation(
                  pageLabel!,
                  platform,
                  sub.platformUserId,
                  location.pathname + location.search,
                  fanLabel.label,
                );

                return (
                  <tr key={sub.platformSubscriptionId}>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="min-w-0">
                          <Link
                            to={fanNavigation.to}
                            state={fanNavigation.state}
                            className="font-medium text-text-primary hover:text-accent hover:underline underline-offset-2"
                          >
                            {fanLabel.label}
                          </Link>
                          {fanLabel.secondaryPlatformHandle && (
                            <div className="text-xs text-text-secondary">@{fanLabel.secondaryPlatformHandle}</div>
                          )}
                        </div>
                        {isNew && <Badge variant="new">Новый</Badge>}
                      </div>
                    </td>
                    <td className="muted">
                      {sub.startedAt ? formatDate(sub.startedAt) : "—"}
                    </td>
                    <td title={sub.endsAt ? `до ${formatDate(sub.endsAt, { includeYear: true })}` : undefined}>
                      {days !== null ? <RemainingBar days={days} /> : <span className="text-text-muted">&mdash;</span>}
                    </td>
                    <td>
                      {sub.autoRenew === true && <span className="font-medium text-green">Вкл.</span>}
                      {sub.autoRenew === false && (
                        <span className="inline-flex flex-col">
                          <span className="font-medium text-danger">Выкл.</span>
                          {sub.autoRenewOffDetectedAt && (
                            <span className="text-xs text-text-secondary">
                              с {formatDate(sub.autoRenewOffDetectedAt, { includeYear: true })}
                            </span>
                          )}
                        </span>
                      )}
                      {sub.autoRenew == null && <span className="text-text-muted">&mdash;</span>}
                    </td>
                    <td className="num">
                      {sub.totalSpentCents != null ? formatUsdFromCents(sub.totalSpentCents) : "—"}
                    </td>
                    <td className="muted">
                      {sub.lastTransactionAt ? formatDateTime(sub.lastTransactionAt) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <Pagination
          offset={offset}
          limit={LIMIT}
          total={total}
          onPageChange={(value) => update("offset", String(value))}
        />
      </section>

      <details className="help mt-4">
        <summary>Как это работает</summary>
        <div className="help-body">
          <p>Список — текущие подписки, которые сохранил Hub; он не зависит от периода дохода.</p>
          <p>«Истекают ≤7 дн» — подписки с известной датой окончания в ближайшие 7 дней. «Без автопродления» — фан явно выключил продление.</p>
        </div>
      </details>
    </div>
  );
}
