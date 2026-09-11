import { useMemo } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { usePageFollowers } from "@/api/queries";
import { Badge } from "@/components/shared/Badge";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { Pagination } from "@/components/shared/Pagination";
import { SearchInput } from "@/components/shared/SearchInput";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { audiencePaginationLabels, buildAudienceFanNavigation, followerFilter, updateAudienceSearch } from "@/lib/audienceNavigation";
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

const LIMIT = 50;
const ACTIVE_WINDOW_MINUTES = 120;

function isNew24h(followedAt: string) {
  return Date.now() - new Date(followedAt).getTime() < 86_400_000;
}

export function FollowersPage() {
  const { pageLabel } = useParams();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const filter = followerFilter(search.get("filter"));
  const searchQuery = search.get("query") ?? "";
  const offset = listOffset(search.get("offset"));
  const hasFilters = filter !== "all" || searchQuery.length > 0;
  function update(changes: Record<string, string | null>, resetOffset = true) {
    setSearch((previous) => updateAudienceSearch(previous, changes, resetOffset));
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

  const { data, isError, refetch } = usePageFollowers(pageLabel!, params);

  const platform = data?.page.platform;
  const items = data?.items ?? [];
  const total = data?.total;
  const filters = [
    { key: "all", label: "Все" },
    { key: "new24h", label: "Новые за 24 ч" },
    { key: "unmessaged", label: "Без переписки" },
    { key: "active", label: "Активные" },
    { key: "subscribers", label: "С доступом по подписке" },
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
    <div className="min-w-0 p-4 md:p-0">
      <div className="mb-5">
        <h1 className="text-xl font-extrabold text-text-primary">
          Фолловеры &mdash; {pageLabel}
        </h1>
        <p className="text-sm text-text-muted mt-1">{total === undefined ? "Число записей пока неизвестно" : `${total} записей в выборке`}</p>
      </div>

      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <FilterButtons
          filters={filters}
          active={filter}
          onChange={(next) => update({ filter: next === "all" ? null : next })}
        />
        <SearchInput
          value={searchQuery}
          onChange={(query) => update({ query })}
          placeholder="Поиск фолловера…"
        />
      </div>

      {hasFilters && <button type="button" className="mb-3 text-sm font-medium text-accent" onClick={() => update({ filter: null, query: null })}>Сбросить фильтры</button>}
      <p className="mb-3 text-xs text-text-muted">Текущие записи Hub. Активные — сигнал за последние 2 часа; подписка означает доступ. Доход автора — за всё время, после комиссии платформы.</p>
      <QueryNotice error={isError && Boolean(data)} stale={Boolean(data)} retry={refetch} />
      {!data ? (
        isError ? <StatusPanel title="Не удалось загрузить фолловеров" description="Повторите запрос. Поиск и фильтры сохранены." tone="error" action={<button type="button" className="text-accent font-semibold" onClick={() => void refetch()}>Повторить</button>} />
          : <div role="status" aria-label="Загрузка фолловеров"><TableSkeleton rows={6} columns={6} /></div>
      ) : showEnrichmentUnavailable ? (
        <StatusPanel
          title="Дополнительные сведения пока недоступны"
          description="Для этой выборки нет сведений о подписке, переписке или активности. Сбросьте фильтр или повторите запрос позже."
        />
      ) : (
      <section className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[980px] border-collapse">
          <thead>
            <tr className="bg-hover-alt">
              {["Фолловер", "Начал следить", "Подписка", "Доход автора", "Переписка", "Активность"].map((col) => (
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
                  {offset >= data.total && offset > 0 ? "Эта страница больше не содержит записей." : hasFilters ? "По выбранным условиям фолловеры не найдены." : "В Hub пока нет записей о фолловерах."}
                  {offset > 0 && <button type="button" className="block mx-auto mt-2 text-accent" onClick={() => update({ offset: null }, false)}>К началу списка</button>}
                </td>
              </tr>
            )}
            {items.map((follower) => {
              const recentFollow = isNew24h(follower.followedAt);
              const fanLabel = resolveFanLabelForScope(follower, "page");
              const fanNavigation = buildAudienceFanNavigation(
                pageLabel!,
                platform!,
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
                      {recentFollow && <Badge variant="new">Новый</Badge>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    {recentFollow
                      ? formatDateTime(follower.followedAt)
                      : formatDate(follower.followedAt)}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {!subscriberKnown ? (
                      <span className="text-text-muted">Неизвестно</span>
                    ) : follower.isSubscriber ? (
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Badge variant="subscriber">Подписка</Badge>
                          {follower.autoRenew === false && (
                            <span className="text-xs font-medium text-warning-dark">
                              Продление выключено
                              {follower.autoRenewOffDetectedAt
                                ? ` · ${formatDate(follower.autoRenewOffDetectedAt, { includeYear: true })}`
                                : ""}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-text-muted">
                          {follower.subscriptionExpiresAt
                            ? `${daysRemaining(follower.subscriptionExpiresAt)} дн. осталось`
                            : "Активна"}
                        </div>
                      </div>
                    ) : (
                      <span className="text-text-muted">Без подписки</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {totalSpentCents === null ? (
                      <span className="text-text-muted">Неизвестно</span>
                    ) : (
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
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {!dmKnown ? (
                      <span className="text-text-muted">Ещё не загружено</span>
                    ) : dm.hasConversation ? (
                      <div className="max-w-[260px] space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-text-primary">
                            {dm.unreadCount > 0 ? `${dm.unreadCount} непрочитанных` : "Есть переписка"}
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
                      <span className="font-medium text-green">Переписки пока нет</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {!presenceKnown ? (
                      <span className="text-text-muted">Ещё не загружено</span>
                    ) : presence.status === "active_now" ? (
                      <span className="font-semibold text-green">Сейчас активен</span>
                    ) : presence.status === "recently_active" ? (
                      <span className="font-medium text-text-primary">Недавно активен</span>
                    ) : presence.lastSeenAt ? (
                      <span className="text-text-secondary">
                        {formatRelativeTime(presence.lastSeenAt)}
                      </span>
                    ) : (
                      <span className="text-text-muted">Нет свежего сигнала</span>
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
          total={data.total}
          onPageChange={(value) => update({ offset: value ? String(value) : null }, false)}
          {...audiencePaginationLabels}
        />
      </section>
      )}
    </div>
  );
}
