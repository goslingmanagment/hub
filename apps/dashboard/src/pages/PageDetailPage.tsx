import { useLocation, useNavigate, useParams, useSearchParams, Link } from "react-router";
import {
  usePageRevenue,
  usePageSubscribers,
  usePageTransactions,
  usePageSpenderAutoLists,
  usePageFollowersDaily,
  usePageSubscribersDaily,
  usePageRevenueDaily,
} from "@/api/queries";
import { ReadSection } from "./daily/ReadSection.js";
import { Badge } from "@/components/shared/Badge";
import { DeltaIndicator } from "@/components/shared/DeltaIndicator";
import { FanNotVisibleMark } from "@/components/shared/FanNotVisibleMark";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { Pagination } from "@/components/shared/Pagination";
import { RemainingBar } from "@/components/shared/RemainingBar";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { PageActivityChart } from "@/components/page/PageActivityChart";
import {
  buildFanProfileNavigation,
  resolveDashboardPeriod,
  buildPageSectionRoute,
  buildPageSpenderAutoListRoute,
} from "@/lib/navigation";
import { listOffset } from "@/lib/overviewNavigation";
import { usePeriodStore, type PeriodOption } from "@/stores/periodStore";
import { formatUsdFromMills, resolveFanLabelForScope } from "@agency_hub_core/shared";
import {
  formatDate,
  formatDateTime,
  formatUsdFromCents,
  transactionStateLabel,
  transactionTypeLabel,
  daysRemaining,
} from "@/lib/format";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import type {
  PageSpenderAutoListsResponse,
  SpenderListResponse,
  SubscriberListResponse,
  TransactionListResponse,
} from "@agency_hub_core/contracts";

const PAGE_SIZE = 50;
const PERIOD_LABELS = {
  today: "сегодня",
  "7d": "7 дней",
  "30d": "30 дней",
  all: "всё время",
} satisfies Record<PeriodOption, string>;
function isRecent(iso: string | null) {
  if (!iso) return false;
  const age = Date.now() - new Date(iso).getTime();
  return age >= 0 && age < 86_400_000;
}

function getAudienceChartPeriod(period: PeriodOption): PeriodOption {
  return period === "today" ? "7d" : period;
}

export function PageDetailPage() {
  const { pageLabel } = useParams<{ pageLabel: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const { period } = usePeriodStore();
  const selectedPeriod = resolveDashboardPeriod(search.get("period"), period);
  const spenderPeriod = selectedPeriod === "all" ? "lifetime" : selectedPeriod;
  const audienceChartPeriod = getAudienceChartPeriod(selectedPeriod);

  const { findPageByLabel, pageCatalogState, pageCatalogError } = useDashboardShell();
  const resolvedPageLabel = pageLabel ?? "";
  const page = findPageByLabel(pageLabel);
  const canLoadPageData = resolvedPageLabel.length > 0 && pageCatalogState === "ready" && !!page;

  const selectedRevenueQuery = usePageRevenue(resolvedPageLabel, selectedPeriod, {
    enabled: canLoadPageData,
  });

  const isFansly = page?.platform === "fansly";
  const dailyQuery = usePageFollowersDaily(resolvedPageLabel, audienceChartPeriod, {
    enabled: canLoadPageData && isFansly,
  });
  const subsDailyQuery = usePageSubscribersDaily(resolvedPageLabel, audienceChartPeriod, {
    enabled: canLoadPageData,
  });
  const revenueDailyQuery = usePageRevenueDaily(resolvedPageLabel, selectedPeriod, {
    enabled: canLoadPageData,
  });

  const subscribersQuery = usePageSubscribers(resolvedPageLabel, { limit: 6 }, {
    enabled: canLoadPageData,
  });
  const autoListsQuery = usePageSpenderAutoLists(resolvedPageLabel, {
    period: spenderPeriod,
  }, {
    enabled: canLoadPageData,
  });

  const txOffset = listOffset(search.get("txOffset"));
  const txTypeFilter = ["subscription", "tip", "message_purchase"].includes(search.get("type") ?? "") ? search.get("type")! : "";
  function update(key: string, value: string) {
    setSearch((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value); else next.delete(key);
      if (key === "type") next.delete("txOffset");
      return next;
    }, { state: location.state });
  }

  const transactionsQuery = usePageTransactions(resolvedPageLabel, {
    limit: PAGE_SIZE,
    offset: txOffset,
    type: txTypeFilter || undefined,
  }, {
    enabled: canLoadPageData,
  });

  if (pageCatalogState === "loading") {
    return <PageDetailSkeleton />;
  }

  if (pageCatalogState === "error") {
    return (
      <StatusPanel
        title="Не удалось загрузить страницу"
        description={pageCatalogError?.message ?? "Список страниц недоступен."}
        tone="error"
      />
    );
  }

  if (!page) {
    return (
      <StatusPanel
        title="Страница не найдена"
        description="Такой страницы нет среди доступных вам."
        tone="error"
      />
    );
  }

  const selectedRevenue = selectedRevenueQuery.data;
  const activityPoints = isFansly
    ? (dailyQuery.data?.items ?? []).map((item) => ({
      businessDate: item.businessDate,
      value: item.newFollowers ?? 0,
    }))
    : (subsDailyQuery.data?.items ?? []).map((item) => ({
      businessDate: item.businessDate,
      value: item.newSubscribers ?? 0,
    }));
  const chartTitle = isFansly ? "Новые фолловеры" : "Новые подписки";
  const revenuePoints = (revenueDailyQuery.data?.series ?? []).map((item) => ({
    businessDate: item.businessDate,
    value: item.netAmountMills,
  }));
  const revenueReady = Boolean(selectedRevenue);
  const audienceQuery = isFansly ? dailyQuery : subsDailyQuery;
  const selectedPeriodLabel = PERIOD_LABELS[selectedPeriod];

  function breakdownAmount(canonicalType: string): number {
    if (!selectedRevenue?.breakdown) return 0;
    const entry = selectedRevenue.breakdown.find((b) => b.canonicalType === canonicalType);
    return entry?.netAmountMills ?? 0;
  }
  const typed = ["subscription", "tip", "message_purchase"].reduce((sum, type) => sum + breakdownAmount(type), 0);
  const otherMills = (selectedRevenue?.netEarningsMills ?? 0) - typed;

  function openFanProfile(platformUserId: string, fanLabel: string) {
    const fanNavigation = buildFanProfileNavigation(
      pageLabel!,
      page!.platform,
      platformUserId,
      `${location.pathname}?${new URLSearchParams({ ...Object.fromEntries(search), period: selectedPeriod })}`,
      fanLabel,
    );
    navigate(`${fanNavigation.to}?${new URLSearchParams({ period: selectedPeriod })}`, { state: fanNavigation.state });
  }

  return (
    <div className="space-y-6">
      <ReadSection title="Доход страницы" query={selectedRevenueQuery}>
        <div className="stat-grid">
          <div className="stat">
            <div className="stat-label">Доход · {selectedPeriodLabel}</div>
            <div className="stat-value text-accent">
              {revenueReady ? formatUsdFromMills(selectedRevenue?.netEarningsMills ?? 0) : "—"}
            </div>
            {selectedPeriod !== "all" && (
              <div className="stat-meta flex items-center gap-1.5">
                <DeltaIndicator pct={selectedRevenue?.comparison?.deltaPct ?? null} />
                <span>к прошлому периоду</span>
              </div>
            )}
          </div>
          {[
            { label: "Подписки", value: breakdownAmount("subscription") },
            { label: "Чаевые", value: breakdownAmount("tip") },
            { label: "Платные сообщения", value: breakdownAmount("message_purchase") },
            { label: "Прочее", value: otherMills, meta: "посты, эфиры, возвраты" },
          ].map(({ label, value, meta }) => (
            <div key={label} className="stat">
              <div className="stat-label">{label}</div>
              <div className="stat-value">{revenueReady ? formatUsdFromMills(value) : "—"}</div>
              {meta && <div className="stat-meta">{meta}</div>}
            </div>
          ))}
        </div>
        <p className="mt-2 text-[13px] text-text-secondary">После комиссии платформы, по операциям, которые сохранил Hub.</p>
      </ReadSection>

      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <ReadSection title="График дохода" query={revenueDailyQuery}>
          <PageActivityChart
            title="Доход по дням"
            selectedPeriod={selectedPeriod}
            selectedPeriodLabel={selectedPeriodLabel}
            points={revenuePoints}
            valueFormatter={(v) => formatUsdFromMills(v)}
            yAxisWidth={72}
            height={240}
          />
        </ReadSection>
        <ReadSection title={chartTitle} query={audienceQuery}>
          <PageActivityChart
            title={chartTitle}
            selectedPeriod={audienceChartPeriod}
            selectedPeriodLabel={PERIOD_LABELS[audienceChartPeriod]}
            points={activityPoints}
            color="var(--color-fansly)"
            height={240}
          />
        </ReadSection>
      </div>

      <ReadSection title="Подписчики" query={subscribersQuery}>
        <PageSubscribersSection
          pageLabel={pageLabel!}
          subscribers={subscribersQuery.data}
          onOpenFanProfile={openFanProfile}
        />
      </ReadSection>

      <ReadSection title="Списки спендеров" query={autoListsQuery}>
        <PageSpenderAutoListsSection pageLabel={pageLabel!} autoLists={autoListsQuery.data} period={selectedPeriod} />
      </ReadSection>

      <ReadSection title="Операции" query={transactionsQuery}>
        <PageTransactionsSection
          transactions={transactionsQuery.data}
          txOffset={txOffset}
          txTypeFilter={txTypeFilter}
          onTxTypeChange={(value) => update("type", value)}
          onTxPageChange={(value) => update("txOffset", String(value))}
        />
      </ReadSection>
    </div>
  );
}

function PageSubscribersSection({
  pageLabel,
  subscribers,
  onOpenFanProfile,
}: {
  pageLabel: string;
  subscribers: SubscriberListResponse | undefined;
  onOpenFanProfile: (platformUserId: string, fanLabel: string) => void;
}) {
  const allRoute = buildPageSectionRoute(pageLabel, "subscribers");
  return (
    <section className="card" aria-labelledby="page-subscribers-title">
      <div className="card-header">
        <h2 id="page-subscribers-title" className="card-title">
          Подписчики <span className="ml-1 font-normal text-text-secondary tabular-nums">{subscribers?.total ?? 0}</span>
        </h2>
        <Link to={allRoute} className="link text-sm">Все подписчики →</Link>
      </div>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Фан</th>
              <th>С нами с</th>
              <th>Осталось</th>
              <th>Автопродление</th>
              <th className="num">Потратил</th>
              <th>Последняя операция</th>
            </tr>
          </thead>
          <tbody>
            {(subscribers?.items ?? []).map((item) => {
              const days = item.endsAt ? daysRemaining(item.endsAt) : null;
              const fanLabel = resolveFanLabelForScope(item, "page");
              const isNew = isRecent(item.startedAt);

              return (
                <tr key={item.platformSubscriptionId}>
                  <td>
                    <div className="flex items-center gap-2">
                      <div className="min-w-0">
                        <button type="button" onClick={() => onOpenFanProfile(item.platformUserId, fanLabel.label)} className="text-left font-medium text-text-primary hover:text-accent">
                          {fanLabel.label}
                        </button>
                        {fanLabel.secondaryPlatformHandle && (
                          <div className="text-[12px] text-text-secondary">
                            @{fanLabel.secondaryPlatformHandle}
                          </div>
                        )}
                      </div>
                      {isNew && <Badge variant="new">новый</Badge>}
                    </div>
                  </td>
                  <td className="muted">{item.startedAt ? formatDate(item.startedAt) : "\u2014"}</td>
                  <td title={item.endsAt ? `до ${formatDate(item.endsAt, { includeYear: true })}` : undefined}>
                    {days !== null ? <RemainingBar days={days} /> : "\u2014"}
                  </td>
                  <td>
                    {item.autoRenew === true && <span className="font-medium text-green">Вкл.</span>}
                    {item.autoRenew === false && (
                      <span className="inline-flex flex-col">
                        <span className="font-medium text-danger">Выкл.</span>
                        {item.autoRenewOffDetectedAt && (
                          <span className="text-[12px] text-text-secondary">
                            с {formatDate(item.autoRenewOffDetectedAt, { includeYear: true })}
                          </span>
                        )}
                      </span>
                    )}
                    {item.autoRenew == null && <span className="text-text-muted">&mdash;</span>}
                  </td>
                  <td className="num">
                    {item.totalSpentCents != null ? formatUsdFromCents(item.totalSpentCents) : "\u2014"}
                  </td>
                  <td className="muted">
                    {item.lastTransactionAt ? formatDateTime(item.lastTransactionAt) : "\u2014"}
                  </td>
                </tr>
              );
            })}
            {(subscribers?.items ?? []).length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-text-secondary">
                  Подписчиков пока нет
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function PageSpenderAutoListsSection({
  pageLabel,
  autoLists,
  period,
}: {
  pageLabel: string;
  autoLists: PageSpenderAutoListsResponse | undefined;
  period?: PeriodOption;
}) {
  const lists = autoLists?.lists ?? [];

  return (
    <section className="card" aria-labelledby="page-autolists-title">
      <div className="card-header">
        <div>
          <h2 id="page-autolists-title" className="card-title">Списки спендеров</h2>
          <p className="card-description">Фаны по сумме трат — для списков на площадке.</p>
        </div>
        <span className="text-[13px] text-text-secondary tabular-nums">
          {autoLists?.totalEntries ?? 0} фанов
        </span>
      </div>
      <div className="flex flex-wrap gap-2 p-4">
        {lists.map((item) => (
          <Link
            key={item.key}
            to={`${buildPageSpenderAutoListRoute(pageLabel, item.key)}${period ? `?${new URLSearchParams({ period })}` : ""}`}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm transition-colors hover:border-border-strong hover:bg-hover"
          >
            <span className="font-medium text-text-primary">{item.label}</span>
            <span className="badge tabular-nums">{item.entryCount}</span>
          </Link>
        ))}
        {lists.length === 0 && (
          <p className="w-full py-4 text-center text-sm text-text-secondary">Списков пока нет</p>
        )}
      </div>
    </section>
  );
}

function PageTransactionsSection({
  transactions,
  txOffset,
  txTypeFilter,
  onTxTypeChange,
  onTxPageChange,
}: {
  transactions: TransactionListResponse | undefined;
  txOffset: number;
  txTypeFilter: string;
  onTxTypeChange: (value: string) => void;
  onTxPageChange: (offset: number) => void;
}) {
  const pagePlatform = transactions?.page?.platform;

  return (
    <section className="card" aria-labelledby="page-transactions-title">
      <div className="card-header">
        <div>
          <h2 id="page-transactions-title" className="card-title">Операции</h2>
          <p className="card-description">Вся история страницы, не только выбранный период.</p>
        </div>
        <FilterButtons
          filters={[
            { key: "", label: "Все" },
            { key: "subscription", label: "Подписки" },
            { key: "tip", label: "Чаевые" },
            { key: "message_purchase", label: "Сообщения" },
          ]}
          active={txTypeFilter}
          onChange={onTxTypeChange}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Дата</th>
              <th>Фан</th>
              <th>Тип</th>
              <th>Статус</th>
              <th className="num">Сумма</th>
            </tr>
          </thead>
          <tbody>
            {(transactions?.items ?? []).map((item, idx) => {
              const fanLabel = item.fan
                ? resolveFanLabelForScope({ ...item.fan, platform: pagePlatform }, "page")
                : null;
              const fanDisplay = fanLabel?.label ?? null;
              const fanIsMuted = fanLabel?.isDeletedFallback ?? false;

              return (
                <tr key={item.transactionId ?? idx}>
                  <td className="muted">{formatDateTime(item.occurredAt)}</td>
                  <td className={fanIsMuted ? "text-text-muted" : undefined}>{fanDisplay ?? "\u2014"}</td>
                  <td className="muted">{transactionTypeLabel(item.canonicalType)}</td>
                  <td>
                    <span className={stateClass(item.transactionState)}>
                      {transactionStateLabel(item.transactionState)}
                    </span>
                  </td>
                  <td className="num font-medium">{formatUsdFromMills(item.netAmountMills)}</td>
                </tr>
              );
            })}
            {(transactions?.items ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="py-8 text-center text-text-secondary">
                  {txOffset > 0 ? "На этой странице списка записей нет." : "Операций пока нет"}
                  {txOffset > 0 && <button type="button" className="link ml-2" onClick={() => onTxPageChange(0)}>К началу списка</button>}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Pagination
        offset={txOffset}
        limit={PAGE_SIZE}
        total={transactions?.total ?? 0}
        onPageChange={onTxPageChange}
      />
    </section>
  );
}

function stateClass(state: string): string {
  if (state === "posted") return "text-green";
  if (state === "pending") return "text-warning-dark";
  return "text-text-muted";
}

export function PageSpendersSection({
  spenders,
  spenderPeriod,
  spendersOffset,
  onPageChange,
  onOpenFanProfile,
}: {
  spenders: SpenderListResponse | undefined;
  spenderPeriod: "today" | "7d" | "30d" | "lifetime";
  spendersOffset: number;
  onPageChange: (offset: number) => void;
  onOpenFanProfile: (platformUserId: string, fanLabel: string) => void;
}) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Фан</th>
            <th className="num">Потратил</th>
            <th className="num">Операций</th>
          </tr>
        </thead>
        <tbody>
          {(spenders?.items ?? []).length === 0 && (
            <tr>
              <td colSpan={4} className="py-8 text-center text-text-secondary">
                {spendersOffset > 0 ? "На этой странице списка записей нет." : "За этот период трат нет."}
                {spendersOffset > 0 && <button type="button" className="link ml-2" onClick={() => onPageChange(0)}>К началу списка</button>}
              </td>
            </tr>
          )}
          {(spenders?.items ?? []).map((item, index) => {
            const windowMetrics = item.metrics.window;
            const spent = spenderPeriod === "lifetime"
              ? item.metrics.lifetime.scopeCreatorNetAmountMills
              : (windowMetrics?.creatorNetAmountMills ?? null);
            const transactionCount = spenderPeriod === "lifetime"
              ? null
              : (windowMetrics?.transactionCount ?? null);
            const fanLabel = resolveFanLabelForScope(item.fan, "page");

            return (
              <tr key={item.fan.platformUserId}>
                <td className="muted tabular-nums">{spendersOffset + index + 1}</td>
                <td>
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    <button type="button" onClick={() => onOpenFanProfile(item.fan.platformUserId, fanLabel.label)} className="text-left font-medium text-text-primary hover:text-accent">
                      {fanLabel.label}
                    </button>
                    <FanNotVisibleMark missAt={item.accountLookupMissAt} />
                  </div>
                  {fanLabel.secondaryPlatformHandle && (
                    <div className="text-[12px] text-text-secondary">@{fanLabel.secondaryPlatformHandle}</div>
                  )}
                </td>
                <td className="num font-medium">{spent === null ? "—" : formatUsdFromMills(spent)}</td>
                <td className="num muted">{transactionCount ?? "\u2014"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <Pagination
        offset={spendersOffset}
        limit={PAGE_SIZE}
        total={spenders?.total ?? 0}
        onPageChange={onPageChange}
      />
    </div>
  );
}

function PageDetailSkeleton() {
  return (
    <div className="space-y-6" aria-label="Загружаем страницу">
      <div className="stat-grid">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="stat">
            <div className="h-3 w-16 rounded bg-hover animate-pulse" />
            <div className="mt-3 h-7 w-24 rounded bg-hover animate-pulse" style={{ animationDelay: `${i * 100}ms` }} />
          </div>
        ))}
      </div>
      <div className="card card-body">
        <div className="flex h-[240px] items-center justify-center">
          <div className="h-4 w-32 rounded bg-hover animate-pulse" />
        </div>
      </div>
    </div>
  );
}
