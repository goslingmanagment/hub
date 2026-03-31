import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { usePageSubscribers } from "@/api/queries";
import { Badge } from "@/components/shared/Badge";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { Pagination } from "@/components/shared/Pagination";
import { RemainingBar } from "@/components/shared/RemainingBar";
import { SearchInput } from "@/components/shared/SearchInput";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { buildFanProfileNavigation, buildPageSectionRoute } from "@/lib/navigation";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { resolveFanLabelForScope } from "@agency_hub_core/shared";
import { formatDate, formatDateTime, daysRemaining, formatUsdFromCents } from "@/lib/format";

type Filter = "all" | "expiring7d" | "new24h" | "norenew";

const LIMIT = 50;

function isNewWithin24Hours(iso: string | null) {
  return iso ? Date.now() - new Date(iso).getTime() < 86_400_000 : false;
}

export function SubscribersPage() {
  const { pageLabel } = useParams();
  const [filter, setFilter] = useState<Filter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    setOffset(0);
  }, [filter, searchQuery]);

  const params = useMemo(() => ({
    limit: LIMIT,
    offset,
    query: searchQuery || undefined,
    expiringWithinDays: filter === "expiring7d" ? 7 : undefined,
    startedWithinHours: filter === "new24h" ? 24 : undefined,
    autoRenew: filter === "norenew" ? false : undefined,
  }), [filter, offset, searchQuery]);

  const { data, isLoading, isError } = usePageSubscribers(pageLabel!, params);

  // Filter count queries (lightweight, limit: 1)
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
        />
      );
    }
    return <TableSkeleton rows={6} columns={7} />;
  }

  const platform = data.page.platform;
  const items = data.items;
  const total = data.total;
  const filters = [
    { key: "all", label: "All", count: total },
    { key: "expiring7d", label: "Expiring ≤7d", count: expiringCount?.total },
    { key: "new24h", label: "New 24h", count: newCount?.total },
    { key: "norenew", label: "Auto-renew Off", count: noRenewCount?.total },
  ];

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-extrabold text-text-primary">
          Subscribers &mdash; {pageLabel}
        </h1>
        <p className="text-sm text-text-muted mt-1">{total} total</p>
      </div>

      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <FilterButtons
          filters={filters}
          active={filter}
          onChange={(next) => setFilter(next as Filter)}
        />
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search subscriber..."
        />
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card">
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
                  No subscribers match the current filter.
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
                buildPageSectionRoute(pageLabel!, "subscribers"),
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
                      <span className="text-danger font-medium">Off</span>
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
          onPageChange={setOffset}
        />
      </section>
    </div>
  );
}
