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
import { ruPlural } from "@/lib/plural";

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
    }, { state: location.state });
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
          title="Не удалось загрузить фолловеров"
          description="Список фолловеров этой страницы сейчас недоступен."
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
    { key: "all", label: "Все" },
    { key: "new24h", label: "Новые за 24 ч" },
    { key: "unmessaged", label: "Без переписки" },
    { key: "active", label: "Онлайн за 2 ч" },
    { key: "subscribers", label: "Подписчики" },
  ];
  const enrichmentFilterActive = filter === "unmessaged" || filter === "active" || filter === "subscribers";
  const hasFollowerEnrichment = items.length === 0 || items.every((follower) => (
    typeof follower.isSubscriber === "boolean" &&
    typeof follower.totalSpentCents === "number" &&
    follower.dm != null &&
    follower.presence != null
  ));
  const showEnrichmentUnavailable = enrichmentFilterActive && !hasFollowerEnrichment;
  const narrowed = filter !== "all" || searchQuery !== "";
  const countLine = offset > 0 && items.length === 0
    ? "Число записей в фильтре пока недоступно"
    : narrowed
      ? `Найдено: ${total}`
      : `${total} ${ruPlural(total, "фолловер", "фолловера", "фолловеров")}`;

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
          placeholder="Поиск фолловера"
        />
      </div>

      <p className="mb-3 text-[13px] text-text-secondary tabular-nums">{countLine}</p>

      {showEnrichmentUnavailable ? (
        <StatusPanel
          title="Этот фильтр пока недоступен"
          description="Сервер ещё не присылает подписку, переписку и активность фолловеров, поэтому отобрать их нельзя. Выберите «Все» или «Новые за 24 ч»."
        />
      ) : (
      <section className="card overflow-hidden" aria-label="Фолловеры">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Фолловер</th>
                <th>Подписан с</th>
                <th>Подписка</th>
                <th className="num">Потратил</th>
                <th>Переписка</th>
                <th>Активность</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-text-secondary">
                    {offset > 0 ? "На этой странице списка записей нет." : (narrowed ? "Под этот фильтр фолловеров нет." : "Фолловеров пока нет.")}
                    {offset > 0 && <button type="button" className="link ml-2" onClick={() => update("offset", "")}>К началу списка</button>}
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
                  <tr key={follower.platformUserId}>
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
                        {recentFollow && <Badge variant="new">Новый</Badge>}
                      </div>
                    </td>
                    <td className="muted">
                      {recentFollow
                        ? formatDateTime(follower.followedAt)
                        : formatDate(follower.followedAt)}
                    </td>
                    <td>
                      {!subscriberKnown ? (
                        <span className="text-text-muted">Неизвестно</span>
                      ) : follower.isSubscriber ? (
                        <div className="space-y-0.5">
                          <Badge variant="subscriber">Подписчик</Badge>
                          <div className="text-xs text-text-secondary">
                            {follower.subscriptionExpiresAt
                              ? `осталось ${daysRemaining(follower.subscriptionExpiresAt)} дн`
                              : "без даты окончания"}
                            {follower.autoRenew === false && (
                              <span
                                className="text-warning-dark"
                                title={follower.autoRenewOffDetectedAt
                                  ? `Замечено ${formatDate(follower.autoRenewOffDetectedAt, { includeYear: true })}`
                                  : undefined}
                              >
                                {" · без автопродления"}
                              </span>
                            )}
                          </div>
                        </div>
                      ) : (
                        <span className="text-text-muted">Не подписан</span>
                      )}
                    </td>
                    <td className="num">
                      {totalSpentCents === null ? (
                        <span className="text-text-muted">Неизвестно</span>
                      ) : totalSpentCents > 0 ? (
                        <div>
                          <div className="font-medium">{formatUsdFromCents(totalSpentCents)}</div>
                          {follower.lastTransactionAt && (
                            <div className="text-xs text-text-secondary">
                              {formatRelativeTime(follower.lastTransactionAt)}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-text-muted">$0.00</span>
                      )}
                    </td>
                    <td>
                      {!dmKnown ? (
                        <span className="text-text-muted">Неизвестно</span>
                      ) : dm.hasConversation ? (
                        <div className="max-w-[260px]">
                          <div className="flex items-center gap-2">
                            {dm.unreadCount > 0
                              ? <span className="badge badge-accent">{dm.unreadCount} непрочит.</span>
                              : <span>Есть переписка</span>}
                            {dm.lastMessageAt && (
                              <span className="text-xs text-text-secondary">
                                {formatRelativeTime(dm.lastMessageAt)}
                              </span>
                            )}
                          </div>
                          {dm.lastMessagePreview && (
                            <div className="truncate text-xs text-text-secondary" title={dm.lastMessagePreview}>
                              {dm.lastMessagePreview}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-text-muted">Нет переписки</span>
                      )}
                    </td>
                    <td>
                      {!presenceKnown ? (
                        <span className="text-text-muted">Неизвестно</span>
                      ) : presence.status === "active_now" ? (
                        <span className="inline-flex items-center gap-1.5 font-medium text-green">
                          <span className="status-dot status-dot-ok" aria-hidden="true" />
                          Онлайн
                        </span>
                      ) : presence.status === "recently_active" ? (
                        <span>Недавно</span>
                      ) : presence.lastSeenAt ? (
                        <span className="text-text-secondary">
                          {formatRelativeTime(presence.lastSeenAt)}
                        </span>
                      ) : (
                        <span className="text-text-muted">Нет данных</span>
                      )}
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
      )}

      <details className="help mt-4">
        <summary>Как это работает</summary>
        <div className="help-body">
          <p>Список — фолловеры, которых сохранил Hub.</p>
          <p>«Без переписки» — в Hub нет записанного диалога с фаном. «Онлайн за 2 ч» — у фана был сигнал активности в последние 120 минут.</p>
        </div>
      </details>
    </div>
  );
}
