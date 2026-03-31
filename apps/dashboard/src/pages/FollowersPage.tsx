import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { usePageFollowers } from "@/api/queries";
import { Badge } from "@/components/shared/Badge";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { Pagination } from "@/components/shared/Pagination";
import { SearchInput } from "@/components/shared/SearchInput";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { buildFanProfileNavigation, buildPageSectionRoute } from "@/lib/navigation";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { resolveFanLabelForScope } from "@agency_hub_core/shared";
import { formatDate, formatDateTime } from "@/lib/format";

type Filter = "all" | "new24h";

const LIMIT = 50;

function isNew24h(followedAt: string) {
  return Date.now() - new Date(followedAt).getTime() < 86_400_000;
}

export function FollowersPage() {
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
    followedWithinHours: filter === "new24h" ? 24 : undefined,
  }), [filter, offset, searchQuery]);

  const { data, isLoading, isError } = usePageFollowers(pageLabel!, params);

  if (isLoading || !data) {
    if (isLoading) {
      return <TableSkeleton rows={6} columns={5} />;
    }
    if (isError) {
      return (
        <StatusPanel
          title="Followers failed to load"
          description="The follower list could not be fetched for this page."
          tone="error"
        />
      );
    }
    return <TableSkeleton rows={6} columns={5} />;
  }

  const platform = data.page.platform;
  const items = data.items;
  const total = data.total;
  const filters = [
    { key: "all", label: "All" },
    { key: "new24h", label: "New 24h" },
  ];

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-extrabold text-text-primary">
          Followers &mdash; {pageLabel}
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
          placeholder="Search follower..."
        />
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-hover-alt">
              {["Username", "Followed Since", "Subscriber", "Spent", "Notes"].map((col) => (
                <th
                  key={col}
                  className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-text-muted">
                  No followers match the current filter.
                </td>
              </tr>
            )}
            {items.map((follower) => {
              const recentFollow = isNew24h(follower.followedAt);
              const fanLabel = resolveFanLabelForScope(follower, "page");
              const fanNavigation = buildFanProfileNavigation(
                pageLabel!,
                platform,
                follower.platformUserId,
                buildPageSectionRoute(pageLabel!, "followers"),
                fanLabel.label,
              );

              return (
                <tr
                  key={follower.platformUserId}
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
                      {recentFollow && <Badge variant="new">NEW</Badge>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    {recentFollow
                      ? formatDateTime(follower.followedAt)
                      : formatDate(follower.followedAt)}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-muted">&mdash;</td>
                  <td className="px-4 py-3 text-sm text-text-muted">&mdash;</td>
                  <td className="px-4 py-3 text-sm text-text-muted">&mdash;</td>
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
