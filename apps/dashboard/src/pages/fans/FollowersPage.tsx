import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router";
import { usePageFollowers } from "@/api/queries";
import { usePageFilter } from "@/components/layout/usePageFilter";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { Pagination } from "@/components/shared/Pagination";
import { SearchInput } from "@/components/shared/SearchInput";
import { Disclosure } from "@/components/ui/Disclosure";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { formatAgo, formatCount, formatDate, formatDateTime, formatUsdFromCents } from "@/lib/format";
import { buildFanProfileNavigation } from "@/lib/navigation";
import { listOffset } from "@/lib/overviewNavigation";
import { ruPlural } from "@/lib/plural";
import { isPlainRowClick } from "@/lib/rowClick";
import { FanCell } from "./FanCell.js";
import { fanName, isNewWithinDay, subscriptionWords } from "./fanWords.js";
import { EmptyRow, ListGate, PastTheEnd, useListParams } from "./listParts.js";

const LIMIT = 50;
const ACTIVE_WINDOW_MINUTES = 120;

type Segment = "all" | "new24h" | "unmessaged" | "active" | "subscribers";
const SEGMENTS: ReadonlyArray<{ value: Segment; label: string }> = [
  { value: "all", label: "Все" },
  { value: "new24h", label: "Новые за 24 ч" },
  { value: "unmessaged", label: "Без переписки" },
  { value: "active", label: "Онлайн за 2 ч" },
  { value: "subscribers", label: "Подписчики" },
];

function unread(count: number): string {
  return `${count} ${ruPlural(count, "непрочитанное", "непрочитанных", "непрочитанных")}`;
}

/** «Фолловеры» of one Fansly page: who follows it, who is new, whom nobody wrote yet (§4). */
export function FollowersPage() {
  const filter = usePageFilter();
  const pageLabel = filter.page ?? "";
  const { findPageByLabel } = useDashboardShell();
  const location = useLocation();
  const navigate = useNavigate();
  const { search, update } = useListParams();
  const raw = search.get("filter");
  const segment: Segment = SEGMENTS.some((item) => item.value === raw) ? raw as Segment : "all";
  const query = search.get("query") ?? "";
  const offset = listOffset(search.get("offset"));

  const params = useMemo(() => ({
    limit: LIMIT,
    offset,
    ...(query ? { query } : {}),
    ...(segment === "new24h" ? { followedWithinHours: 24 } : {}),
    ...(segment === "unmessaged" ? { dmStatus: "none" as const } : {}),
    ...(segment === "active" ? { activeWithinMinutes: ACTIVE_WINDOW_MINUTES } : {}),
    ...(segment === "subscribers" ? { subscriber: true } : {}),
  }), [offset, query, segment]);
  const list = usePageFollowers(pageLabel, params);
  const narrowed = segment !== "all" || query !== "";
  const here = `${location.pathname}${location.search}`;
  const lastFollowerSync = list.data?.page.lastFollowerSyncAt ?? findPageByLabel(pageLabel)?.lastLightSyncAt ?? null;
  const total = list.data?.total ?? 0;
  const countLine = !list.data ? "" : narrowed ? `Найдено: ${formatCount(total)}` : `${formatCount(total)} ${ruPlural(total, "фолловер", "фолловера", "фолловеров")}`;

  return (
    <div className="fan-screen">
      <PageHeader fresh={lastFollowerSync ? { at: lastFollowerSync, onRefresh: () => void list.refetch(), refreshing: list.isFetching && !list.isLoading } : undefined} />
      <div className="table-toolbar fan-toolbar">
        <Segmented label="Фолловеры" value={segment} onChange={(next) => update({ filter: next === "all" ? null : next })} options={SEGMENTS} className="fan-segments" />
        <SearchInput value={query} onChange={(value) => update({ query: value || null })} placeholder="Найти фолловера" />
      </div>
      <ListGate query={list} columns={6}>
        <p className="fan-count">{countLine}</p>
        <section className="card" aria-label="Фолловеры">
          <div className={`table-wrap ${list.isFetching && !list.isLoading ? "is-refreshing" : ""}`}>
            <table className="data-table data-table-sticky fan-table">
              <thead>
                <tr>
                  <th scope="col">Фан</th>
                  <th scope="col">Фолловит с</th>
                  <th scope="col">Подписка</th>
                  <th scope="col" className="num">Потратил за всё время</th>
                  <th scope="col">Переписка</th>
                  <th scope="col">Активность</th>
                </tr>
              </thead>
              <tbody>
                {list.data && list.data.items.length === 0 && (offset > 0
                  ? <PastTheEnd colSpan={6} onBack={() => update({ offset: null })} />
                  : narrowed
                    ? <EmptyRow colSpan={6} title={`На ${pageLabel} под этот фильтр фолловеров нет.`} action={<button type="button" className="btn btn-sm" onClick={() => update({ filter: null, query: null })}>Показать всех</button>} />
                    : <EmptyRow colSpan={6} title={`На ${pageLabel} фолловеров пока нет.`} />)}
                {list.data?.items.map((follower) => {
                  const name = fanName(follower);
                  const nav = buildFanProfileNavigation(pageLabel, list.data!.page.platform, follower.platformUserId, here, name.label);
                  const fresh = isNewWithinDay(follower.followedAt);
                  const sub = subscriptionWords({
                    status: follower.isSubscriber ? "active" : "never",
                    expiresAt: follower.subscriptionExpiresAt,
                    autoRenew: follower.autoRenew,
                  });
                  const dm = follower.dm;
                  return (
                    <tr key={follower.platformUserId} className="cursor-pointer" onClick={(event) => { if (isPlainRowClick(event)) navigate(nav.to, { state: nav.state }); }}>
                      <td>
                        <FanCell name={name.label} to={nav.to} state={nav.state} handle={name.handle} marks={fresh ? <span className="badge">Новый</span> : null} />
                      </td>
                      <td>{fresh ? formatDateTime(follower.followedAt) : formatDate(follower.followedAt)}</td>
                      <td>
                        {follower.isSubscriber ? (
                          <>
                            <div>{sub.first}</div>
                            {follower.autoRenew === false && follower.autoRenewOffDetectedAt
                              ? <div className="fan-cell-sub">без автопродления с {formatDate(follower.autoRenewOffDetectedAt)}</div>
                              : sub.second && <div className="fan-cell-sub">{sub.second}</div>}
                          </>
                        ) : <span className="text-text-muted">Не подписан</span>}
                      </td>
                      <td className="num">
                        <div className={follower.totalSpentCents === 0 ? "text-text-muted" : undefined}>{formatUsdFromCents(follower.totalSpentCents)}</div>
                        {follower.totalSpentCents > 0 && follower.lastTransactionAt && <div className="fan-cell-sub">{formatAgo(follower.lastTransactionAt)}</div>}
                      </td>
                      <td className="fan-dm">
                        {dm.hasConversation ? (
                          <>
                            <div>
                              {dm.unreadCount > 0 ? unread(dm.unreadCount) : "Есть переписка"}
                              {dm.lastMessageAt && `, ${formatAgo(dm.lastMessageAt)}`}
                            </div>
                            {dm.lastMessagePreview && <div className="fan-cell-sub fan-preview" title={dm.lastMessagePreview}>{dm.lastMessagePreview}</div>}
                          </>
                        ) : <span className="text-text-muted">Нет переписки</span>}
                      </td>
                      <td>
                        {follower.presence.status === "active_now"
                          ? <span className="fan-online"><span className="status-dot status-dot-ok" aria-hidden="true" />Онлайн</span>
                          : follower.presence.status === "recently_active"
                            ? "Недавно"
                            : follower.presence.lastSeenAt ? formatAgo(follower.presence.lastSeenAt) : <span className="text-text-muted">Нет данных</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {total > 0 && <Pagination offset={offset} limit={LIMIT} total={total} onPageChange={(next) => update({ offset: next === 0 ? null : String(next) })} />}
        </section>
      </ListGate>
      <Disclosure>
        <p>Список — фолловеры, которых сохранил Hub.</p>
        <p>Без переписки — в Hub нет записанного диалога с фаном. Онлайн за 2 ч — у фана был сигнал активности в последние 120 минут.</p>
        <p>Писать отсюда нельзя: это делает чаттер в расширении.</p>
      </Disclosure>
    </div>
  );
}
