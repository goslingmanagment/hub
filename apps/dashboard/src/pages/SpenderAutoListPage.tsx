import { useMemo } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { usePageSpenderAutoList } from "@/api/queries";
import { Pagination } from "@/components/shared/Pagination";
import { SearchInput } from "@/components/shared/SearchInput";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { audiencePaginationLabels, audiencePeriod, buildAudienceFanNavigation, updateAudienceSearch } from "@/lib/audienceNavigation";
import { listOffset } from "@/lib/overviewNavigation";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { formatDate, formatDateTime } from "@/lib/format";
import { useSpenderPeriodStore } from "@/stores/spenderPeriodStore";
import { formatUsdFromMills, resolveFanLabelForScope } from "@agency_hub_core/shared";

const LIMIT = 50;

function statusBadgeClass(tone: "green" | "danger" | "warning" | "muted") {
  if (tone === "green") return "bg-green/15 text-green";
  if (tone === "danger") return "bg-danger/15 text-danger";
  if (tone === "warning") return "bg-warning/15 text-warning-dark";
  return "bg-hover-alt text-text-muted";
}

function StatusBadge({ tone, children }: { tone: "green" | "danger" | "warning" | "muted"; children: string }) {
  return (
    <span className={`inline-flex rounded-md px-2 py-0.5 text-[10px] font-bold uppercase ${statusBadgeClass(tone)}`}>
      {children}
    </span>
  );
}

export function SpenderAutoListPage() {
  const { pageLabel, bucketKey } = useParams<{ pageLabel: string; bucketKey: string }>();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const storedPeriod = useSpenderPeriodStore((s) => s.period);
  const selectedPeriod = audiencePeriod(search.get("period"), storedPeriod);
  const spenderPeriod = selectedPeriod === "all" ? "lifetime" : selectedPeriod;
  const searchQuery = search.get("query") ?? "";
  const excludeNonFollowers = search.get("followersOnly") === "true";
  const offset = listOffset(search.get("offset"));
  const hasFilters = searchQuery.length > 0 || excludeNonFollowers;
  function update(changes: Record<string, string | null>, resetOffset = true) {
    setSearch((previous) => updateAudienceSearch(previous, changes, resetOffset));
  }

  const params = useMemo(() => ({
    limit: LIMIT,
    offset,
    ...(searchQuery ? { query: searchQuery } : {}),
    ...(excludeNonFollowers ? { excludeNonFollowers: true } : {}),
    period: spenderPeriod,
  }), [excludeNonFollowers, offset, searchQuery, spenderPeriod]);

  const { data, isError, refetch } = usePageSpenderAutoList(
    pageLabel ?? "",
    bucketKey ?? "",
    params,
    { enabled: Boolean(pageLabel && bucketKey) },
  );

  return (
    <div className="min-w-0 p-4 md:p-0">
      <div className="mb-5">
        <h1 className="text-xl font-extrabold text-text-primary">
          {data?.bucket.label ?? "Список спендеров"}
        </h1>
        <p className="text-sm text-text-muted mt-1">
          {data ? `${data.total} записей · ${pageLabel}` : pageLabel}
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-[13px] font-semibold text-text-secondary">
          <input
            type="checkbox"
            checked={excludeNonFollowers}
            onChange={(event) => update({ followersOnly: event.target.checked ? "true" : null })}
            className="h-4 w-4 accent-accent"
          />
          Только фолловеры
        </label>
        <SearchInput
          value={searchQuery}
          onChange={(query) => update({ query })}
          placeholder="Поиск фана…"
        />
      </div>

      {hasFilters && <button type="button" className="mb-3 text-sm font-medium text-accent" onClick={() => update({ query: null, followersOnly: null })}>Сбросить фильтры</button>}
      <p className="mb-3 text-xs text-text-muted">Суммы за выбранный период: расходы фана и доход автора после комиссии показаны отдельно.</p>
      <QueryNotice error={isError && Boolean(data)} stale={Boolean(data)} retry={refetch} />
      {!data ? (
        isError ? <StatusPanel title="Не удалось загрузить список" description="Повторите запрос. Поиск и фильтры сохранены." tone="error" action={<button type="button" className="text-accent font-semibold" onClick={() => void refetch()}>Повторить</button>} />
          : <div role="status" aria-label="Загрузка списка"><TableSkeleton rows={6} columns={5} /></div>
      ) : (
      <section className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[700px] border-collapse">
          <thead>
            <tr className="bg-hover-alt">
              {[
                { label: "Фан", align: "text-left" },
                { label: "Статус", align: "text-left" },
                { label: "Расходы фана", align: "text-right" },
                { label: "Доход автора", align: "text-right" },
                { label: "Последняя операция", align: "text-left" },
              ].map((col) => (
                <th
                  key={col.label}
                  className={`px-4 py-3 text-[12px] font-semibold uppercase tracking-wider text-text-muted ${col.align}`}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-text-muted">
                  {offset >= data.total && offset > 0 ? "Эта страница больше не содержит записей." : hasFilters ? "По выбранным условиям фаны не найдены." : "В этом списке пока нет фанов."}
                  {offset > 0 && <button type="button" className="block mx-auto mt-2 text-accent" onClick={() => update({ offset: null }, false)}>К началу списка</button>}
                </td>
              </tr>
            )}
            {data.items.map((item) => {
              const fanLabel = resolveFanLabelForScope(item.fan, "page");
              const fanNavigation = buildAudienceFanNavigation(
                pageLabel!,
                data.page.platform,
                item.fan.platformUserId,
                location.pathname + location.search,
                fanLabel.label,
                selectedPeriod,
              );

              return (
                <tr
                  key={item.fan.platformUserId}
                  className="border-t border-border transition-colors hover:bg-hover"
                >
                  <td className="px-4 py-3">
                    <Link to={fanNavigation.to} state={fanNavigation.state} className="text-[15px] font-semibold text-text-primary hover:text-accent">
                      {fanLabel.label}
                    </Link>
                    {fanLabel.secondaryPlatformHandle && (
                      <div className="text-xs text-text-muted">@{fanLabel.secondaryPlatformHandle}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {item.isFollower ? (
                        <StatusBadge tone="green">Фолловер</StatusBadge>
                      ) : (
                        <StatusBadge tone="danger">Не следит</StatusBadge>
                      )}
                      {item.subscriptionStatus === "active" && (
                        <StatusBadge tone="green">Подписка активна</StatusBadge>
                      )}
                      {item.subscriptionStatus === "expired" && (
                        <StatusBadge tone="warning">Подписка истекла</StatusBadge>
                      )}
                      {item.subscriptionStatus === "never" && (
                        <StatusBadge tone="muted">Без подписки</StatusBadge>
                      )}
                    </div>
                    {item.subscriptionStatus === "expired" && item.lastSubscriptionEndedAt && (
                      <div className="mt-1 text-xs text-text-muted">
                        Окончилась {formatDate(item.lastSubscriptionEndedAt, { includeYear: true })}
                      </div>
                    )}
                    {item.subscriptionStatus === "active" && item.subscriptionExpiresAt && (
                      <div className="mt-1 text-xs text-text-muted">
                        До {formatDate(item.subscriptionExpiresAt, { includeYear: true })}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-medium tabular-nums text-text-primary">
                    {formatUsdFromMills(item.grossAmountMills)}
                  </td>
                  <td className="px-4 py-3 text-right text-sm tabular-nums text-text-secondary">
                    {formatUsdFromMills(item.creatorNetAmountMills)}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    {item.lastTransactionAt ? formatDateTime(item.lastTransactionAt) : "\u2014"}
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
