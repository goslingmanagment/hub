import { useMemo } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { usePageFollowers } from "@/api/queries";
import { Badge } from "@/components/shared/Badge";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { Pagination } from "@/components/shared/Pagination";
import { SearchInput } from "@/components/shared/SearchInput";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { buildFanProfileNavigation } from "@/lib/navigation";
import { listOffset } from "@/lib/overviewNavigation";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { resolveFanLabelForScope } from "@agency_hub_core/shared";
import {
  daysRemaining,
  formatDate,
  formatDateTime,
  formatRelativeTime,
  formatUsdFromCents,
} from "@/lib/format";

type Filter = "all" | "new24h" | "unmessaged" | "active" | "subscribers";

const LIMIT = 50;
const ACTIVE_WINDOW_MINUTES = 120;

function isNew24h(followedAt: string) {
  const age = Date.now() - new Date(followedAt).getTime();
  return age >= 0 && age < 86_400_000;
}

export function FollowersPage() {
  const { pageLabel } = useParams();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const rawFilter = search.get("filter");
  const filter: Filter = rawFilter === "new24h" || rawFilter === "unmessaged" || rawFilter === "active" || rawFilter === "subscribers" ? rawFilter : "all";
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
    ...(searchQuery ? { query: searchQuery } : {}),
    ...(filter === "new24h" ? { followedWithinHours: 24 } : {}),
    ...(filter === "unmessaged" ? { dmStatus: "none" as const } : {}),
    ...(filter === "active" ? { activeWithinMinutes: ACTIVE_WINDOW_MINUTES } : {}),
    ...(filter === "subscribers" ? { subscriber: true } : {}),
  }), [filter, offset, searchQuery]);

  const { data, isLoading, isError, refetch } = usePageFollowers(pageLabel!, params);

  if (isLoading || !data) {
    if (isLoading) {
      return <TableSkeleton rows={6} columns={6} />;
    }
    if (isError) {
      return (
        <StatusPanel
          title="Followers failed to load"
          description="The follower list could not be fetched for this page."
          tone="error"
          action={<button type="button" onClick={() => void refetch()}>Повторить</button>}
        />
      );
    }
    return <TableSkeleton rows={6} columns={6} />;
  }

  const platform = data.page.platform;
  const items = data.items;
  const total = data.total;
  const filters = [
    { key: "all", label: "All" },
    { key: "new24h", label: "New 24h" },
    { key: "unmessaged", label: "Unmessaged" },
    { key: "active", label: "Active" },
    { key: "subscribers", label: "Subscribers" },
  ];
  const enrichmentFilterActive = filter === "unmessaged" || filter === "active" || filter === "subscribers";
  const hasFollowerEnrichment = items.length === 0 || items.every((follower) => (
    typeof follower.isSubscriber === "boolean" &&
    typeof follower.totalSpentCents === "number" &&
    follower.dm != null &&
    follower.presence != null
  ));
  const showEnrichmentUnavailable = enrichmentFilterActive && !hasFollowerEnrichment;

  return (
    <div>
      <QueryNotice error={isError} stale={Boolean(data)} retry={refetch} />
      <div className="mb-5">
        <h1 className="text-xl font-extrabold text-text-primary">
          Followers &mdash; {pageLabel}
        </h1>
        <p className="text-sm text-text-muted mt-1">{offset > 0 && items.length === 0 ? "Число записей в фильтре пока недоступно" : `${total} в текущем фильтре`}</p>
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
          placeholder="Search follower..."
        />
      </div>

      <p className="mb-3 text-xs text-text-muted">Сохранённые записи Hub. Unmessaged означает, что диалог не записан; Active — сигнал активности за последние 120 минут.</p>
      {showEnrichmentUnavailable ? (
        <StatusPanel
          title="Follower details are not available yet"
          description="The API returned the older follower list shape, so subscriber, DM, and activity filters cannot be applied safely."
        />
      ) : (
      <section className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[980px] border-collapse">
          <thead>
            <tr className="bg-hover-alt">
              {["Follower", "Followed", "Subscriber", "Spent", "DM", "Activity"].map((col) => (
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
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-text-muted">
                  {offset > 0 ? "На этой странице списка записей нет." : "No followers match the current filter."}
                  {offset > 0 && <button type="button" className="ml-2 text-accent" onClick={() => update("offset", "")}>К началу списка</button>}
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
                location.pathname + location.search,
                fanLabel.label,
              );
              const subscriberKnown = typeof follower.isSubscriber === "boolean";
              const totalSpentCents = typeof follower.totalSpentCents === "number"
                ? follower.totalSpentCents
                : null;
              const dmKnown = follower.dm != null;
              const dm = follower.dm ?? {
                hasConversation: false,
                platformConversationId: null,
                unreadCount: 0,
                lastMessageAt: null,
                lastFanMessageAt: null,
                lastModelMessageAt: null,
                lastMessagePreview: null,
              };
              const presenceKnown = follower.presence != null;
              const presence = follower.presence ?? {
                status: "offline" as const,
                lastSeenAt: null,
                observedAt: null,
              };

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
                  <td className="px-4 py-3 text-sm">
                    {!subscriberKnown ? (
                      <span className="text-text-muted">Unknown</span>
                    ) : follower.isSubscriber ? (
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Badge variant="subscriber">Subscriber</Badge>
                          {follower.autoRenew === false && (
                            <span className="text-xs font-medium text-warning-dark">
                              No renew
                              {follower.autoRenewOffDetectedAt
                                ? ` · ${formatDate(follower.autoRenewOffDetectedAt, { includeYear: true })}`
                                : ""}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-text-muted">
                          {follower.subscriptionExpiresAt
                            ? `${daysRemaining(follower.subscriptionExpiresAt)}d left`
                            : "Active"}
                        </div>
                      </div>
                    ) : (
                      <span className="text-text-muted">Follower only</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {totalSpentCents === null ? (
                      <span className="text-text-muted">Unknown</span>
                    ) : totalSpentCents > 0 ? (
                      <div className="space-y-1">
                        <div className="font-semibold text-text-primary">
                          {formatUsdFromCents(totalSpentCents)}
                        </div>
                        {follower.lastTransactionAt && (
                          <div className="text-xs text-text-muted">
                            {formatRelativeTime(follower.lastTransactionAt)}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-text-muted">$0.00</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {!dmKnown ? (
                      <span className="text-text-muted">Not synced</span>
                    ) : dm.hasConversation ? (
                      <div className="max-w-[260px] space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-text-primary">
                            {dm.unreadCount > 0 ? `${dm.unreadCount} unread` : "DM open"}
                          </span>
                          {dm.lastMessageAt && (
                            <span className="text-xs text-text-muted">
                              {formatRelativeTime(dm.lastMessageAt)}
                            </span>
                          )}
                        </div>
                        {dm.lastMessagePreview && (
                          <div className="truncate text-xs text-text-muted">
                            {dm.lastMessagePreview}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-text-muted">Нет записанного диалога</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {!presenceKnown ? (
                      <span className="text-text-muted">Not synced</span>
                    ) : presence.status === "active_now" ? (
                      <span className="font-semibold text-green">Active now</span>
                    ) : presence.status === "recently_active" ? (
                      <span className="font-medium text-text-primary">Recently active</span>
                    ) : presence.lastSeenAt ? (
                      <span className="text-text-secondary">
                        {formatRelativeTime(presence.lastSeenAt)}
                      </span>
                    ) : (
                      <span className="text-text-muted">No recent signal</span>
                    )}
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
      )}
    </div>
  );
}
