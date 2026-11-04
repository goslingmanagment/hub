import { useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { usePageSpenderAutoList } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { usePageFilter } from "@/components/layout/usePageFilter";
import { useScreenPeriod } from "@/components/layout/useScreenPeriod";
import { Pagination } from "@/components/shared/Pagination";
import { SearchInput } from "@/components/shared/SearchInput";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { PageHeader } from "@/components/ui/PageHeader";
import { Spinner } from "@/components/ui/Skeleton";
import { formatCount, formatDate, formatDateTime, formatMills } from "@/lib/format";
import { buildFanProfileNavigation, buildFansRoute } from "@/lib/navigation";
import { listOffset } from "@/lib/overviewNavigation";
import { ruPlural } from "@/lib/plural";
import { isPlainRowClick } from "@/lib/rowClick";
import { bucketAmount, copyFanNames } from "./copyFanNames.js";
import { FanCell, GoneMark } from "./FanCell.js";
import { fanName, periodColumn, spenderPeriodOf } from "./fanWords.js";
import { EmptyRow, PastTheEnd, useListParams } from "./listParts.js";

const LIMIT = 50;

/** One list by the sum spent: its fans, and their names to copy (§7). */
export function BySpendListPage() {
  const filter = usePageFilter();
  const pageLabel = filter.page ?? "";
  const fansly = filter.item?.platform === "fansly";
  const { bucketKey = "" } = useParams<{ bucketKey: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { key } = useScreenPeriod();
  const period = spenderPeriodOf(key);
  const { search, update } = useListParams();
  const query = search.get("query") ?? "";
  const followersOnly = fansly && search.get("followersOnly") === "true";
  const offset = listOffset(search.get("offset"));
  const [copying, setCopying] = useState(false);

  const params = useMemo(() => ({
    limit: LIMIT,
    offset,
    period,
    ...(query ? { query } : {}),
    ...(followersOnly ? { excludeNonFollowers: true } : {}),
  }), [followersOnly, offset, period, query]);
  const list = usePageSpenderAutoList(pageLabel, bucketKey, params, { enabled: pageLabel.length > 0 && bucketKey.length > 0 });
  const bucket = list.data?.bucket;
  const amount = bucket ? bucketAmount(bucket) : null;
  const here = `${location.pathname}${location.search}`;
  const listsRoute = buildFansRoute("by-spend", pageLabel, { period: key === "all" ? null : key });

  const copy = (
    <button
      type="button"
      className="btn"
      disabled={!bucket || copying || list.data?.total === 0}
      onClick={() => {
        if (!bucket || !amount) return;
        setCopying(true);
        void copyFanNames({ pageLabel, bucketKey, bucketLabel: amount, period, query, followersOnly }).finally(() => setCopying(false));
      }}
    >
      {copying ? <><Spinner /> Копируем…</> : "Скопировать имена"}
    </button>
  );
  const header = (
    <PageHeader
      title={amount ? `${amount} · ${pageLabel}` : undefined}
      description={bucket ? `${periodColumn(key)}, до комиссии.${fansly ? ` На Fansly этот список называется ${bucket.label}.` : ""}` : undefined}
      actions={bucket ? copy : undefined}
    />
  );

  if (!list.data) {
    const missing = list.error instanceof KernelApiError && (list.error.status === 400 || list.error.status === 404);
    if (missing) {
      return <StatusPanel title="Такого списка нет" action={<Link to={listsRoute} className="btn btn-sm">К спискам</Link>} />;
    }
    return <div className="fan-screen">{header}{list.isError ? <NoAnswerPanel retry={list.refetch} /> : <TableSkeleton rows={8} columns={6} />}</div>;
  }
  const data = list.data;
  const columns = fansly ? 6 : 5;

  return (
    <div className="fan-screen">
      {header}
      <QueryNotice error={list.isError} stale retry={list.refetch} at={list.dataUpdatedAt} />
      <div className="table-toolbar fan-toolbar">
        <div className="fan-toolbar-filters">
          {fansly && (
            <label className="fan-check">
              <input type="checkbox" checked={followersOnly} onChange={(event) => update({ followersOnly: event.target.checked ? "true" : null })} />
              Только фолловеры
            </label>
          )}
        </div>
        <SearchInput value={query} onChange={(value) => update({ query: value || null })} placeholder="Найти фана" />
      </div>
      <p className="fan-count">{formatCount(data.total)} {ruPlural(data.total, "фан", "фана", "фанов")}</p>
      <section className="card" aria-label="Фаны списка">
        <div className={`table-wrap ${list.isFetching && !list.isLoading ? "is-refreshing" : ""}`}>
          <table className="data-table data-table-sticky fan-table">
            <thead>
              <tr>
                <th scope="col">Фан</th>
                <th scope="col">Подписка</th>
                {fansly && <th scope="col">Фолловит</th>}
                <th scope="col" className="num">После комиссии</th>
                <th scope="col" className="num">До комиссии</th>
                <th scope="col">Последняя покупка</th>
              </tr>
            </thead>
            <tbody>
              {data.items.length === 0 && (offset > 0
                ? <PastTheEnd colSpan={columns} onBack={() => update({ offset: null })} />
                : query
                  ? <EmptyRow colSpan={columns} title={`По запросу «${query}» никого нет.`} action={<button type="button" className="btn btn-sm" onClick={() => update({ query: null })}>Сбросить поиск</button>} />
                  : <EmptyRow colSpan={columns} title="В этом списке фанов нет." />)}
              {data.items.map((item) => {
                const name = fanName(item.fan);
                const nav = buildFanProfileNavigation(pageLabel, data.page.platform, item.fan.platformUserId, here, name.label);
                const to = `${nav.to}?${new URLSearchParams({ period: key })}`;
                return (
                  <tr key={item.fan.platformUserId} className="cursor-pointer" onClick={(event) => { if (isPlainRowClick(event)) navigate(to, { state: nav.state }); }}>
                    <td><FanCell name={name.label} to={to} state={nav.state} handle={name.handle} marks={<GoneMark missAt={item.accountLookupMissAt} />} /></td>
                    <td>
                      {item.subscriptionStatus === "active"
                        ? (item.subscriptionExpiresAt ? `Подписан до ${formatDate(item.subscriptionExpiresAt)}` : "Подписан")
                        : item.subscriptionStatus === "expired"
                          ? (item.lastSubscriptionEndedAt ? `Подписка кончилась ${formatDate(item.lastSubscriptionEndedAt)}` : "Подписка кончилась")
                          : <span className="text-text-muted">Без подписки</span>}
                    </td>
                    {fansly && <td className={item.isFollower ? undefined : "muted"}>{item.isFollower ? "Фолловит" : "—"}</td>}
                    <td className="num">{formatMills(item.creatorNetAmountMills)}</td>
                    <td className="num muted">{formatMills(item.grossAmountMills)}</td>
                    <td>{item.lastTransactionAt ? formatDateTime(item.lastTransactionAt, { yearUnlessCurrent: true }) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {data.total > 0 && <Pagination offset={offset} limit={LIMIT} total={data.total} onPageChange={(next) => update({ offset: next === 0 ? null : String(next) })} />}
      </section>
    </div>
  );
}
