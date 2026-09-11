import { useMemo } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { usePageSubscribers } from "@/api/queries";
import { Badge } from "@/components/shared/Badge";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { Pagination } from "@/components/shared/Pagination";
import { RemainingBar } from "@/components/shared/RemainingBar";
import { SearchInput } from "@/components/shared/SearchInput";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { audiencePaginationLabels, buildAudienceFanNavigation, updateAudienceSearch } from "@/lib/audienceNavigation";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { resolveFanLabelForScope } from "@agency_hub_core/shared";
import { formatDate, formatDateTime, daysRemaining, formatUsdFromCents } from "@/lib/format";

import { listOffset, safeBackTo, subscriberFilter } from "@/lib/overviewNavigation";
import { QueryNotice } from "@/components/shared/QueryNotice";

const LIMIT = 50;

function isNewWithin24Hours(iso: string | null) {
  return iso ? Date.now() - new Date(iso).getTime() < 86_400_000 : false;
}

export function SubscribersPage() {
  const { pageLabel } = useParams();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const filter = subscriberFilter(search.get("filter"));
  const searchQuery = search.get("query") ?? "";
  const offset = listOffset(search.get("offset"));
  const hasFilters = filter !== "all" || searchQuery.length > 0;
  function update(key: string, value: string) {
    setSearch((previous) => updateAudienceSearch(previous, { [key]: value }, key !== "offset"));
  }
  function resetFilters() {
    setSearch((previous) => updateAudienceSearch(previous, { filter: null, query: null }));
  }

  const params = useMemo(() => ({
    limit: LIMIT,
    offset,
    query: searchQuery || undefined,
    expiringWithinDays: filter === "expiring7d" ? 7 : undefined,
    startedWithinHours: filter === "new24h" ? 24 : undefined,
    autoRenew: filter === "norenew" ? false : undefined,
  }), [filter, offset, searchQuery]);

  const { data, isError, refetch } = usePageSubscribers(pageLabel!, params, {
    suppressGlobalError: true,
  });

  // Filter count queries (lightweight, limit: 1). Like the other chips, the
  // "All" count ignores the active filter AND the search box — chips mean
  // "population per category"; search only narrows the table below.
  const allCountQuery = usePageSubscribers(pageLabel!, { limit: 1 }, { suppressGlobalError: true });
  const expiringCountQuery = usePageSubscribers(pageLabel!, { limit: 1, expiringWithinDays: 7 }, { suppressGlobalError: true });
  const newCountQuery = usePageSubscribers(pageLabel!, { limit: 1, startedWithinHours: 24 }, { suppressGlobalError: true });
  const noRenewCountQuery = usePageSubscribers(pageLabel!, { limit: 1, autoRenew: false }, { suppressGlobalError: true });

  const countQueries = [allCountQuery, expiringCountQuery, newCountQuery, noRenewCountQuery];
  const countError = countQueries.some((query) => query.isError);
  const allCount = allCountQuery.data;
  const platform = data?.page.platform;
  const items = data?.items ?? [];
  const filters = [
    { key: "all", label: "Все", count: allCount?.total },
    { key: "expiring7d", label: "Истекают за 7 дней", count: expiringCountQuery.data?.total },
    { key: "new24h", label: "Новые за 24 ч", count: newCountQuery.data?.total },
    { key: "norenew", label: "Продление выключено", count: noRenewCountQuery.data?.total },
  ];

  return (
    <div className="min-w-0 p-4 md:p-0">
      {search.has("backTo") && <Link className="text-sm text-accent" to={safeBackTo(search)}>← К дашборду</Link>}
      <QueryNotice error={isError && Boolean(data)} stale={Boolean(data)} retry={refetch} />
      <div className="mb-5">
        <h1 className="text-xl font-extrabold text-text-primary">
          Подписчики &mdash; {pageLabel}
        </h1>
        <p className="text-sm text-text-muted mt-1">{allCount ? `${allCount.total} записей о подписке` : allCountQuery.isLoading ? "Загружаем общее число…" : "Общее число недоступно"}</p>
      </div>

      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <FilterButtons
          filters={filters}
          active={filter}
          onChange={(next) => update("filter", next)}
        />
        <SearchInput
          value={searchQuery}
          onChange={(value) => update("query", value)}
          placeholder="Поиск подписчика…"
        />
      </div>

      {hasFilters && <button type="button" className="mb-3 text-sm font-medium text-accent" onClick={resetFilters}>Сбросить фильтры</button>}
      {countError && <p className="mb-3 text-xs text-warning-dark" role="alert">Не удалось обновить часть счётчиков. Доступные числа могут быть устаревшими. <button type="button" className="font-semibold text-accent" onClick={() => countQueries.forEach((query) => { if (query.isError) void query.refetch(); })}>Повторить</button></p>}
      <p className="text-xs text-text-muted mb-3">Текущие записи о доступе в Hub. Числа в фильтрах не зависят от поиска. «Истекают за 7 дней» — известная дата окончания; «Продление выключено» — подтверждённое состояние. Доход автора — за всё время, после комиссии платформы.</p>
      {!data ? (
        isError ? <StatusPanel title="Не удалось загрузить подписчиков" description="Повторите запрос. Поиск и фильтры сохранены." tone="error" action={<button type="button" className="text-accent font-semibold" onClick={() => void refetch()}>Повторить</button>} />
          : <div role="status" aria-label="Загрузка подписчиков"><TableSkeleton rows={6} columns={7} /></div>
      ) : (
      <section className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[800px] border-collapse">
          <thead>
            <tr className="bg-hover-alt">
              {["Подписчик", "Начало", "Окончание", "Осталось", "Продление", "Доход автора", "Последняя операция"].map(
                (col) => (
                  <th
                    key={col}
                    className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted"
                  >
                    {col}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-text-muted">
                  {offset >= data.total && offset > 0 ? "Эта страница больше не содержит записей." : hasFilters ? "По выбранным условиям подписчики не найдены." : "В Hub пока нет записей о подписчиках."}
                  {offset > 0 && <button type="button" className="block mx-auto mt-2 text-accent" onClick={() => update("offset", "")}>К началу списка</button>}
                </td>
              </tr>
            )}
            {items.map((sub) => {
              const days = sub.endsAt ? daysRemaining(sub.endsAt) : null;
              const isNew = isNewWithin24Hours(sub.startedAt);
              const fanLabel = resolveFanLabelForScope(sub, "page");
              const fanNavigation = buildAudienceFanNavigation(
                pageLabel!,
                platform!,
                sub.platformUserId,
                location.pathname + location.search,
                fanLabel.label,
              );

              return (
                <tr
                  key={sub.platformSubscriptionId}
                  className="border-t border-border transition-colors hover:bg-hover"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Link
                        to={fanNavigation.to}
                        state={fanNavigation.state}
                        className="text-[15px] font-semibold text-text-primary hover:text-accent"
                      >
                        {fanLabel.label}
                      </Link>
                      {fanLabel.secondaryPlatformHandle && (
                        <span className="text-xs text-text-muted">@{fanLabel.secondaryPlatformHandle}</span>
                      )}
                      {isNew && <Badge variant="new">Новая</Badge>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    {sub.startedAt ? formatDate(sub.startedAt) : "\u2014"}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    {sub.endsAt ? formatDate(sub.endsAt) : "\u2014"}
                  </td>
                  <td className="px-4 py-3">
                    {days !== null ? (
                      <RemainingBar days={days} />
                    ) : (
                      <span className="text-text-muted">&mdash;</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    {sub.autoRenew === true && (
                      <span className="text-green font-medium">Включено</span>
                    )}
                    {sub.autoRenew === false && (
                      <span className="inline-flex flex-col">
                        <span className="font-medium text-danger">Выключено</span>
                        {sub.autoRenewOffDetectedAt && (
                          <span className="text-[11px] text-warning-dark">
                            замечено {formatDate(sub.autoRenewOffDetectedAt, { includeYear: true })}
                          </span>
                        )}
                      </span>
                    )}
                    {sub.autoRenew == null && (
                      <span className="text-text-muted">&mdash;</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary tabular-nums">
                    {sub.totalSpentCents != null ? formatUsdFromCents(sub.totalSpentCents) : "\u2014"}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    {sub.lastTransactionAt ? formatDateTime(sub.lastTransactionAt) : "\u2014"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <Pagination
          offset={offset}
          limit={LIMIT}
          total={data.total}
          onPageChange={(value) => update("offset", value ? String(value) : "")}
          {...audiencePaginationLabels}
        />
      </section>
      )}
    </div>
  );
}
