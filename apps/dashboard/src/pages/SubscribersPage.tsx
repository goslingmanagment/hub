import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { usePageSubscribers } from "@/api/queries";
import { Badge } from "@/components/shared/Badge";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { Pagination } from "@/components/shared/Pagination";
import { RemainingBar } from "@/components/shared/RemainingBar";
import { SearchInput } from "@/components/shared/SearchInput";
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

  const { data, isLoading } = usePageSubscribers(pageLabel!, params);

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center py-24">
        <span className="text-text-muted text-sm">Loading...</span>
      </div>
    );
  }

  const platform = data.page.platform;
  const items = [...data.items].sort((a, b) => {
    if (!a.endsAt) return 1;
    if (!b.endsAt) return -1;
    return new Date(a.endsAt).getTime() - new Date(b.endsAt).getTime();
  });
  const total = data.total;
  const filters = [
    { key: "all", label: "All" },
    { key: "expiring7d", label: "Expiring ≤7d" },
    { key: "new24h", label: "New 24h" },
    { key: "norenew", label: "Auto-renew Off" },
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
              const displayName = sub.displayName ?? sub.username ?? "Unknown";

              return (
                <tr
                  key={sub.platformSubscriptionId}
                  className="cursor-pointer border-t border-border transition-colors hover:bg-hover"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Link
                        to={`/pages/${pageLabel}/fans/${platform}/${sub.platformUserId}`}
                        className="text-[15px] font-semibold text-text-primary hover:text-accent"
                      >
                        {displayName}
                      </Link>
                      {sub.displayName && sub.username && (
                        <span className="text-xs text-text-muted">@{sub.username}</span>
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
