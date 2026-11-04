import { useMemo } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { usePageSubscribers } from "@/api/queries";
import { usePageFilter } from "@/components/layout/usePageFilter";
import { Pagination } from "@/components/shared/Pagination";
import { SearchInput } from "@/components/shared/SearchInput";
import { OfapiOffNotice } from "@/routes/screens/shared";
import { Disclosure } from "@/components/ui/Disclosure";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { daysRemaining, formatCount, formatDate, formatDateTime, formatUsdFromCents } from "@/lib/format";
import { buildFanProfileNavigation } from "@/lib/navigation";
import { listOffset, safeBackTo, subscriberFilter, type SubscriberFilter } from "@/lib/overviewNavigation";
import { ruPlural } from "@/lib/plural";
import { isPlainRowClick } from "@/lib/rowClick";
import { FanCell } from "./FanCell.js";
import { daysLeftWords, fanName, isNewWithinDay } from "./fanWords.js";
import { EmptyRow, ListGate, PastTheEnd, useListParams, useViewerOfapi } from "./listParts.js";

const LIMIT = 50;

const SEGMENTS: ReadonlyArray<{ value: SubscriberFilter; label: string; params: { paid?: boolean; expiringWithinDays?: number; startedWithinHours?: number; autoRenew?: boolean } }> = [
  { value: "all", label: "Все", params: {} },
  { value: "paid", label: "Платные", params: { paid: true } },
  { value: "free", label: "Бесплатные", params: { paid: false } },
  { value: "expiring7d", label: "Кончаются за 7 дней", params: { expiringWithinDays: 7 } },
  { value: "new24h", label: "Новые за 24 ч", params: { startedWithinHours: 24 } },
  { value: "norenew", label: "Без автопродления", params: { autoRenew: false } },
];

function subscribersWord(count: number): string {
  return `${formatCount(count)} ${ruPlural(count, "подписчик", "подписчика", "подписчиков")}`;
}

/** Each segment's count: six reads of one row, the `total` of each (as before). */
function useSegmentCounts(pageLabel: string) {
  const all = usePageSubscribers(pageLabel, { limit: 1 }, { suppressGlobalError: true });
  const paid = usePageSubscribers(pageLabel, { limit: 1, paid: true }, { suppressGlobalError: true });
  const free = usePageSubscribers(pageLabel, { limit: 1, paid: false }, { suppressGlobalError: true });
  const expiring = usePageSubscribers(pageLabel, { limit: 1, expiringWithinDays: 7 }, { suppressGlobalError: true });
  const fresh = usePageSubscribers(pageLabel, { limit: 1, startedWithinHours: 24 }, { suppressGlobalError: true });
  const noRenew = usePageSubscribers(pageLabel, { limit: 1, autoRenew: false }, { suppressGlobalError: true });
  return {
    all: all.data?.total,
    paid: paid.data?.total,
    free: free.data?.total,
    expiring7d: expiring.data?.total,
    new24h: fresh.data?.total,
    norenew: noRenew.data?.total,
  } satisfies Record<SubscriberFilter, number | undefined>;
}

/**
 * «Подписчики» of one page: who is subscribed now, whose subscription ends, who
 * switched renewal off. A list for now: no period (design/screens/fans-page.md §3).
 */
export function SubscribersPage() {
  const filter = usePageFilter();
  const pageLabel = filter.page ?? "";
  const location = useLocation();
  const navigate = useNavigate();
  const { ofapi } = useViewerOfapi();
  const { search, update } = useListParams();
  const segment = subscriberFilter(search.get("filter"));
  const noRenew = segment === "expiring7d" && search.get("norenew") === "1";
  const query = search.get("query") ?? "";
  const offset = listOffset(search.get("offset"));

  const params = useMemo(() => ({
    limit: LIMIT,
    offset,
    query: query || undefined,
    ...SEGMENTS.find((item) => item.value === segment)!.params,
    ...(noRenew ? { autoRenew: false } : {}),
  }), [noRenew, offset, query, segment]);
  const list = usePageSubscribers(pageLabel, params, { suppressGlobalError: true });
  const counts = useSegmentCounts(pageLabel);

  const platform = filter.item?.platform ?? list.data?.page.platform ?? "fansly";
  const frozen = platform === "onlyfans" && ofapi === "off";
  const lastSync = list.data?.page.lastLightSyncAt ?? null;
  const narrowed = segment !== "all" || query !== "";
  const backTo = search.has("backTo") ? safeBackTo(search) : null;
  const here = `${location.pathname}${location.search}`;

  const countLine = (() => {
    if (counts.all === undefined) return "Общее число недоступно";
    if (!list.data) return "";
    if (offset > 0 && list.data.items.length === 0) return `Всего ${subscribersWord(counts.all)}`;
    if (narrowed) return `Найдено ${formatCount(list.data.total)} из ${formatCount(counts.all)}`;
    return `${subscribersWord(counts.all)} · сначала те, у кого подписка кончится раньше`;
  })();

  return (
    <div className="fan-screen">
      <PageHeader fresh={lastSync ? { at: lastSync, onRefresh: () => void list.refetch(), refreshing: list.isFetching && !list.isLoading } : undefined} />
      {frozen && <OfapiOffNotice>Полного обхода подписок нет: список — на 1 ноября плюс те, кого Hub заметил в ленте ChatSpace. Даты окончания могли устареть.</OfapiOffNotice>}
      <div className="table-toolbar fan-toolbar">
        <div className="fan-toolbar-filters">
          <Segmented
            label="Подписчики"
            value={segment}
            onChange={(next) => update({ filter: next === "all" ? null : next, norenew: null })}
            options={SEGMENTS.map((item) => ({ value: item.value, label: item.label, count: counts[item.value] === undefined ? undefined : formatCount(counts[item.value]) }))}
            className="fan-segments"
          />
          {segment === "expiring7d" && (
            <label className="fan-check">
              <input type="checkbox" checked={noRenew} onChange={(event) => update({ norenew: event.target.checked ? "1" : null })} />
              Только без автопродления
            </label>
          )}
        </div>
      </div>
      <ListGate query={list} columns={6}>
        <div className="fan-count-row">
          <p className="fan-count">{countLine}{backTo && <> · <Link className="link" to={backTo}>← Назад</Link></>}</p>
          <SearchInput value={query} onChange={(value) => update({ query: value || null })} placeholder="Найти подписчика" />
        </div>
        <section className="card" aria-label="Подписчики">
          <div className={`table-wrap ${list.isFetching && !list.isLoading ? "is-refreshing" : ""}`}>
            <table className="data-table data-table-sticky fan-table">
              <thead>
                <tr>
                  <th scope="col">Фан</th>
                  <th scope="col">Подписан с</th>
                  <th scope="col">Подписан до</th>
                  <th scope="col">Автопродление</th>
                  <th scope="col" className="num">Потратил за всё время</th>
                  <th scope="col">Последняя покупка</th>
                </tr>
              </thead>
              <tbody>
                {list.data && list.data.items.length === 0 && (offset > 0
                  ? <PastTheEnd colSpan={6} onBack={() => update({ offset: null })} />
                  : narrowed
                    ? <EmptyRow colSpan={6} title={`На ${pageLabel} под этот фильтр подписчиков нет.`} action={<button type="button" className="btn btn-sm" onClick={() => update({ filter: null, norenew: null, query: null })}>Показать всех</button>} />
                    : <EmptyRow colSpan={6} title={`На ${pageLabel} подписчиков пока нет.`} />)}
                {list.data?.items.map((sub) => {
                  const name = fanName(sub);
                  const nav = buildFanProfileNavigation(pageLabel, platform, sub.platformUserId, here, name.label);
                  const ended = sub.endsAt !== null && new Date(sub.endsAt).getTime() < Date.now();
                  return (
                    <tr
                      key={sub.platformSubscriptionId}
                      className="cursor-pointer"
                      onClick={(event) => {
                        if (isPlainRowClick(event)) navigate(nav.to, { state: nav.state });
                      }}
                    >
                      <td>
                        <FanCell
                          name={name.label}
                          to={nav.to}
                          state={nav.state}
                          handle={name.handle}
                          marks={isNewWithinDay(sub.startedAt) ? <span className="badge">Новый</span> : null}
                          note={sub.subscriptionTierName}
                        />
                      </td>
                      <td>{sub.startedAt ? formatDate(sub.startedAt) : "—"}</td>
                      <td>
                        {sub.endsAt === null ? "—" : ended ? (
                          <span>кончилась {formatDate(sub.endsAt)}</span>
                        ) : (
                          <>
                            <div>{formatDate(sub.endsAt)}</div>
                            <div className="fan-cell-sub">{daysLeftWords(daysRemaining(sub.endsAt))}</div>
                          </>
                        )}
                      </td>
                      <td>
                        {sub.autoRenew === null ? "—" : sub.autoRenew ? "Вкл." : (
                          <>
                            <div>Выкл.</div>
                            {sub.autoRenewOffDetectedAt && <div className="fan-cell-sub">с {formatDate(sub.autoRenewOffDetectedAt, { includeYear: true })}</div>}
                          </>
                        )}
                      </td>
                      <td className="num">{formatUsdFromCents(sub.totalSpentCents)}</td>
                      <td>{sub.lastTransactionAt ? formatDateTime(sub.lastTransactionAt, { yearUnlessCurrent: true }) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {list.data && list.data.total > 0 && <Pagination offset={offset} limit={LIMIT} total={list.data.total} onPageChange={(next) => update({ offset: next === 0 ? null : String(next) })} />}
        </section>
      </ListGate>
      <Disclosure>
        <p>Список — текущие подписки, которые сохранил Hub; он не зависит от периода дохода.</p>
        <p>Платные — фан оплатил текущий период подписки. Бесплатные — бесплатная или пробная подписка: покупки в чате такой фан может делать.</p>
        <p>Кончаются за 7 дней — подписки с известной датой окончания в ближайшие 7 дней. Без автопродления — фан явно выключил продление.</p>
        <p>Потратил за всё время — после комиссии, на этой странице.</p>
      </Disclosure>
    </div>
  );
}
