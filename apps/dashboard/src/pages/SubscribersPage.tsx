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

import { listOffset, safeBackTo, subscriberFilter } from "@/lib/overviewNavigation";
import { QueryNotice } from "@/components/shared/QueryNotice";

const LIMIT = 50;

function isNewWithin24Hours(iso: string | null) {
  if (!iso) return false;
  const age = Date.now() - new Date(iso).getTime();
  return age >= 0 && age < 86_400_000;
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
      return <TableSkeleton rows={6} columns={7} />;
    }
    if (isError) {
      return (
        <StatusPanel
          title="Subscribers failed to load"
          description="The subscriber list could not be fetched for this page."
          tone="error"
          action={<><button onClick={() => void refetch()}>Повторить</button> · <Link to={safeBackTo(search)}>К дашборду</Link></>}
        />
      );
    }
    return <TableSkeleton rows={6} columns={7} />;
  }

  const platform = data.page.platform;
  const items = data.items;
  const total = data.total;
  const filters = [
    { key: "all", label: "All", count: allCount?.total },
    { key: "expiring7d", label: "Expiring ≤7d", count: expiringCount?.total },
    { key: "new24h", label: "New 24h", count: newCount?.total },
    { key: "norenew", label: "Auto-renew Off", count: noRenewCount?.total },
  ];

  return (
    <div className="p-4 md:p-0">
      {search.has("backTo") && <Link className="text-sm text-accent" to={safeBackTo(search)}>← К дашборду</Link>}
      <QueryNotice error={isError} stale={Boolean(data)} retry={refetch} />
      <div className="mb-5">
        <h1 className="text-xl font-extrabold text-text-primary">
          Subscribers &mdash; {pageLabel}
        </h1>
        <p className="text-sm text-text-muted mt-1">{allCount ? `${allCount.total} total` : "Общее число недоступно"}</p>
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
          placeholder="Search subscriber..."
        />
      </div>

      <p className="text-xs text-text-muted mb-3">Текущие записи Hub, независимо от периода дохода. Истекают ≤7d — известная дата окончания; Auto-renew Off — явно выключенное продление.</p>
      <section className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-hover-alt">
              {["Username", "Since", "Expires", "Remaining", "Renew", "Spent", "Last Txn"].map(
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
                  {offset > 0 ? "На этой странице списка записей нет." : "No subscribers match the current filter."}
                  {offset > 0 && <button type="button" className="ml-2 text-accent" onClick={() => update("offset", "")}>К началу списка</button>}
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
                <tr
                  key={sub.platformSubscriptionId}
                  className="cursor-pointer border-t border-border transition-colors hover:bg-hover"
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
                      {isNew && <Badge variant="new">NEW</Badge>}
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
                      <span className="text-green font-medium">On</span>
                    )}
                    {sub.autoRenew === false && (
                      <span className="inline-flex flex-col">
                        <span className="font-medium text-danger">Off</span>
                        {sub.autoRenewOffDetectedAt && (
                          <span className="text-[11px] text-warning-dark">
                            detected {formatDate(sub.autoRenewOffDetectedAt, { includeYear: true })}
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
          total={total}
          onPageChange={(value) => update("offset", String(value))}
        />
      </section>
    </div>
  );
}
