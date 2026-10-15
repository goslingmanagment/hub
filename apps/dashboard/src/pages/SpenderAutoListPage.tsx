import { useMemo } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { usePageSpenderAutoList } from "@/api/queries";
import { Pagination } from "@/components/shared/Pagination";
import { SearchInput } from "@/components/shared/SearchInput";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { FanNotVisibleMark } from "@/components/shared/FanNotVisibleMark";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { PageHeader } from "@/components/ui/PageHeader";
import {
  buildFanProfileNavigation,
  resolveSpenderPeriod,
} from "@/lib/navigation";
import { listOffset } from "@/lib/overviewNavigation";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { formatDate, formatDateTime } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { useSpenderPeriodStore } from "@/stores/spenderPeriodStore";
import { formatUsdFromMills, resolveFanLabelForScope } from "@agency_hub_core/shared";
import { isPlainRowClick } from "./daily/rowClick.js";

const LIMIT = 50;

export function SpenderAutoListPage() {
  const { pageLabel, bucketKey } = useParams<{ pageLabel: string; bucketKey: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const storedPeriod = useSpenderPeriodStore((s) => s.period);
  const selectedPeriod = resolveSpenderPeriod(search.get("period"), storedPeriod);
  const spenderPeriod = selectedPeriod === "all" ? "lifetime" : selectedPeriod;
  const searchQuery = search.get("query") ?? "";
  const excludeNonFollowers = search.get("followersOnly") === "true";
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
    ...(excludeNonFollowers ? { excludeNonFollowers: true } : {}),
    period: spenderPeriod,
  }), [excludeNonFollowers, offset, searchQuery, spenderPeriod]);

  const { data, isLoading, isError, refetch } = usePageSpenderAutoList(
    pageLabel ?? "",
    bucketKey ?? "",
    params,
    { enabled: Boolean(pageLabel && bucketKey) },
  );

  if (isLoading || !data) {
    if (isError) {
      return (
        <StatusPanel
          title="Не удалось загрузить список спендеров"
          description="Список этой страницы сейчас недоступен."
          tone="error"
          action={<button type="button" onClick={() => void refetch()}>Повторить</button>}
        />
      );
    }
    return <TableSkeleton rows={6} columns={5} />;
  }

  const pageRoute = `${location.pathname}?${new URLSearchParams({ ...Object.fromEntries(search), period: selectedPeriod })}`;
  const countLine = offset > 0 && data.items.length === 0
    ? "Число записей в фильтре пока недоступно"
    : `${data.total} ${ruPlural(data.total, "фан", "фана", "фанов")}`;

  return (
    <div>
      <QueryNotice error={isError} stale={Boolean(data)} retry={refetch} />
      <PageHeader
        title={data.bucket.label}
        description={`Список спендеров страницы ${pageLabel ?? ""} · ${countLine}`}
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex min-h-[38px] cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm text-text-primary hover:border-border-strong">
          <input
            type="checkbox"
            checked={excludeNonFollowers}
            onChange={(event) => update("followersOnly", event.target.checked ? "true" : "")}
            className="h-4 w-4 accent-accent"
          />
          Только фолловеры
        </label>
        <SearchInput
          value={searchQuery}
          onChange={(value) => update("query", value)}
          placeholder="Поиск фана"
        />
      </div>

      <section className="card overflow-hidden" aria-label="Фаны списка">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Фан</th>
                <th>Статус</th>
                <th className="num">Всего потрачено</th>
                <th className="num">После комиссии</th>
                <th>Последняя операция</th>
              </tr>
            </thead>
            <tbody>
              {data.items.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-text-secondary">
                    {offset > 0 ? "На этой странице списка записей нет." : "В этом списке фанов нет."}
                    {offset > 0 && <button type="button" className="link ml-2" onClick={() => update("offset", "")}>К началу списка</button>}
                  </td>
                </tr>
              )}
              {data.items.map((item) => {
                const fanLabel = resolveFanLabelForScope(item.fan, "page");
                const fanNavigation = buildFanProfileNavigation(
                  pageLabel!,
                  data.page.platform,
                  item.fan.platformUserId,
                  pageRoute,
                  fanLabel.label,
                );
                const fanRoute = `${fanNavigation.to}?${new URLSearchParams({ period: selectedPeriod })}`;

                return (
                  <tr
                    key={item.fan.platformUserId}
                    onClick={(event) => {
                      if (!isPlainRowClick(event)) return;
                      navigate(fanRoute, { state: fanNavigation.state });
                    }}
                    className="cursor-pointer"
                  >
                    <td>
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                        <Link to={fanRoute} state={fanNavigation.state} className="font-medium text-text-primary hover:text-accent hover:underline underline-offset-2">
                          {fanLabel.label}
                        </Link>
                        <FanNotVisibleMark missAt={item.accountLookupMissAt} />
                      </div>
                      {fanLabel.secondaryPlatformHandle && (
                        <div className="text-xs text-text-secondary">@{fanLabel.secondaryPlatformHandle}</div>
                      )}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1.5">
                        {item.isFollower
                          ? <span className="badge badge-success">Фолловер</span>
                          : <span className="badge">Не фолловер</span>}
                        {item.subscriptionStatus === "active" && <span className="badge badge-success">Подписка активна</span>}
                        {item.subscriptionStatus === "expired" && <span className="badge badge-warning">Подписка истекла</span>}
                        {item.subscriptionStatus === "never" && <span className="badge">Без подписки</span>}
                      </div>
                      {item.subscriptionStatus === "expired" && item.lastSubscriptionEndedAt && (
                        <div className="mt-1 text-xs text-text-secondary">
                          Закончилась {formatDate(item.lastSubscriptionEndedAt, { includeYear: true })}
                        </div>
                      )}
                      {item.subscriptionStatus === "active" && item.subscriptionExpiresAt && (
                        <div className="mt-1 text-xs text-text-secondary">
                          До {formatDate(item.subscriptionExpiresAt, { includeYear: true })}
                        </div>
                      )}
                    </td>
                    <td className="num font-medium">
                      {formatUsdFromMills(item.grossAmountMills)}
                    </td>
                    <td className="num muted">
                      {formatUsdFromMills(item.creatorNetAmountMills)}
                    </td>
                    <td className="muted">
                      {item.lastTransactionAt ? formatDateTime(item.lastTransactionAt) : "—"}
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
          total={data.total}
          onPageChange={(value) => update("offset", String(value))}
        />
      </section>
    </div>
  );
}
