import { useLocation, useNavigate, useParams, useSearchParams, Link } from "react-router";
import {
  useAuthMe,
  useOverview,
  usePageRevenue,
  usePageSubscribers,
  usePageTransactions,
  useSpenders,
  usePageSpenderAutoLists,
  usePageFollowersDaily,
  usePageSubscribersDaily,
  usePageRevenueDaily,
} from "@/api/queries";
import { ReadSection } from "./daily/ReadSection.js";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { Badge } from "@/components/shared/Badge";
import { DeltaIndicator } from "@/components/shared/DeltaIndicator";
import { FanNotVisibleMark } from "@/components/shared/FanNotVisibleMark";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { Pagination } from "@/components/shared/Pagination";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { RemainingBar } from "@/components/shared/RemainingBar";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { getSyncUxTone } from "@/components/shared/SyncUxBadge";
import { getSyncUxDisplayMode, getSyncUxExceptionKind } from "@/components/shared/syncUxDisplay";
import { PageActivityChart } from "@/components/page/PageActivityChart";
import {
  buildFanProfileNavigation,
  resolveDashboardPeriod,
  buildPageSectionRoute,
  buildPageSpenderAutoListRoute,
  buildPageSyncRoute,
} from "@/lib/navigation";
import { listOffset } from "@/lib/overviewNavigation";
import { usePeriodStore, type PeriodOption } from "@/stores/periodStore";
import { formatUsdFromMills, resolveFanLabelForScope } from "@agency_hub_core/shared";
import {
  formatDate,
  formatDateTime,
  formatUsdFromCents,
  transactionTypeLabel,
  daysRemaining,
} from "@/lib/format";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import type {
  PageSpenderAutoListsResponse,
  SpenderListResponse,
  SubscriberListResponse,
  SyncUxSummary,
  TransactionListResponse,
} from "@agency_hub_core/contracts";
type TabKey = "transactions" | "spenders" | "followers";

const PAGE_SIZE = 50;
const PERIOD_LABELS = {
  today: "Today",
  "7d": "7 Days",
  "30d": "30 Days",
  all: "All Time",
} satisfies Record<PeriodOption, string>;
function isRecent(iso: string | null) {
  if (!iso) return false;
  const age = Date.now() - new Date(iso).getTime();
  return age >= 0 && age < 86_400_000;
}

function getAudienceChartPeriod(period: PeriodOption): PeriodOption {
  return period === "today" ? "7d" : period;
}

function getPageExceptionMessage(
  summary: SyncUxSummary,
  kind: NonNullable<ReturnType<typeof getSyncUxExceptionKind>>,
) {
  switch (kind) {
    case "off":
      return `${summary.headline} \u2014 check sync settings`;
    case "attention":
      return "Data may be incomplete \u2014 check sync settings";
    default:
      return null;
  }
}

export function PageDetailPage() {
  const { pageLabel } = useParams<{ pageLabel: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const { data: auth } = useAuthMe();
  const syncQuery = useOverview();
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

  const rawTab = search.get("tab");
  const activeTab: TabKey = rawTab === "spenders" || (rawTab === "followers" && isFansly) ? rawTab : "transactions";
  const txOffset = listOffset(search.get("txOffset"));
  const txTypeFilter = ["subscription", "tip", "message_purchase"].includes(search.get("type") ?? "") ? search.get("type")! : "";
  const spendersOffset = listOffset(search.get("spendersOffset"));
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
  const spendersQuery = useSpenders({
    scope: "page",
    pageLabel: resolvedPageLabel,
    period: spenderPeriod,
    limit: PAGE_SIZE,
    offset: spendersOffset,
    sortBy: "creatorNetAmountMills",
    sortDir: "desc",
  }, {
    enabled: canLoadPageData,
  });

  if (pageCatalogState === "loading") {
    return <PageDetailSkeleton />;
  }

  if (pageCatalogState === "error") {
    return (
      <StatusPanel
        title="Page details failed to load"
        description={pageCatalogError?.message ?? "The page catalog could not be loaded."}
        tone="error"
      />
    );
  }

  if (!page) {
    return (
      <StatusPanel
        title="Page not found"
        description="The requested page does not exist in the dashboard catalog."
        tone="error"
      />
    );
  }

  const selectedRevenue = selectedRevenueQuery.data;
  const dailyData = dailyQuery.data;
  const subsDailyData = subsDailyQuery.data;
  const revenueDailyData = revenueDailyQuery.data;
  const activityPoints = isFansly
    ? (dailyData?.items ?? []).map((item) => ({
      businessDate: item.businessDate,
      value: item.newFollowers ?? 0,
    }))
    : (subsDailyData?.items ?? []).map((item) => ({
      businessDate: item.businessDate,
      value: item.newSubscribers ?? 0,
    }));
  const chartTitle = isFansly ? "Новые записи о фолловерах" : "Записи о начале подписки";
  const revenuePoints = (revenueDailyData?.series ?? []).map((item) => ({
    businessDate: item.businessDate,
    value: item.netAmountMills,
  }));
  const revenueReady = Boolean(selectedRevenue);
  const audienceQuery = isFansly ? dailyQuery : subsDailyQuery;
  const selectedPeriodLabel = PERIOD_LABELS[selectedPeriod];
  const audienceChartPeriodLabel = PERIOD_LABELS[audienceChartPeriod];
  const syncUx = syncQuery.data?.pages.find((item) => item.id === page.id)?.syncUx;
  const syncMode = syncUx ? getSyncUxDisplayMode(syncUx, "page_detail") : null;
  const exceptionKind = syncUx ? getSyncUxExceptionKind(syncUx) : null;
  const syncTone = syncUx ? getSyncUxTone(syncUx.state) : null;
  const isOwner = auth?.user.role === "owner";
  const pageExceptionMessage = exceptionKind && syncUx ? getPageExceptionMessage(syncUx, exceptionKind) : null;

  function breakdownAmount(canonicalType: string): number {
    if (!selectedRevenue?.breakdown) return 0;
    const entry = selectedRevenue.breakdown.find((b) => b.canonicalType === canonicalType);
    return entry?.netAmountMills ?? 0;
  }

  function stateColorClass(state: string): string {
    if (state === "posted") return "text-green";
    if (state === "pending") return "text-warning-dark";
    return "text-text-muted";
  }

  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: "transactions", label: "Transactions" },
    { key: "spenders", label: "Spenders" },
  ];
  if (isFansly) {
    tabs.push({ key: "followers", label: "Followers" });
  }

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
    <div>
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-2xl font-extrabold text-text-primary">
            {page.label}
          </h1>
          <PlatformBadge platform={page.platform} />
        </div>
        <p className="text-sm text-text-muted">
          @{page.username ?? "unknown"} &middot; Model: {page.modelName}
        </p>
        <QueryNotice error={syncQuery.isError} stale={Boolean(syncUx)} retry={syncQuery.refetch} />
        {!syncUx && <p className="mt-2 text-xs text-text-muted">{syncQuery.isLoading ? "Загружаем состояние сбора…" : "Состояние сбора недоступно. Данные разделов загружаются отдельно."}</p>}
        {syncMode === "exception" && exceptionKind && exceptionKind !== "credentials" && pageExceptionMessage && syncTone && (
          <div className={`mt-3 flex flex-wrap items-center gap-2 rounded-xl border px-4 py-3 text-sm ${syncTone.panel}`}>
            <span className={`font-medium ${syncTone.text}`}>
              {pageExceptionMessage}
            </span>
            {isOwner && (
              <Link
                to={buildPageSyncRoute(page.platform, page.label)}
                className="font-semibold text-accent hover:underline"
              >
                Open Sync Settings
              </Link>
            )}
          </div>
        )}
      </div>

      <ReadSection title="Доход страницы" query={selectedRevenueQuery}>
      <p className="mb-3 text-xs text-text-muted">Доход после комиссии платформы за {selectedPeriodLabel}. По сохранённым операциям Hub; полнота захвата не подтверждена.</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5 mb-6">
        <div className="rounded-[10px] border border-border bg-card p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Revenue
          </div>
          <div className="text-2xl font-extrabold tabular-nums text-accent mt-1">
            {revenueReady ? formatUsdFromMills(selectedRevenue?.netEarningsMills ?? 0) : "—"}
          </div>
          {selectedPeriod !== "all" && (
            <div className="flex items-center gap-1.5 mt-1.5">
              <DeltaIndicator pct={selectedRevenue?.comparison?.deltaPct ?? null} />
              <span className="text-[11px] text-text-muted">vs prev</span>
            </div>
          )}
        </div>
        {[
          { label: "Subscriptions", type: "subscription" },
          { label: "Tips", type: "tip" },
          { label: "Messages", type: "message_purchase" },
        ].map(({ label, type }) => (
          <div key={type} className="rounded-[10px] border border-border bg-card p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              {label}
            </div>
            <div className="text-2xl font-extrabold tabular-nums text-text-primary mt-1">
              {revenueReady ? formatUsdFromMills(breakdownAmount(type)) : "—"}
            </div>
          </div>
        ))}
      </div>

      </ReadSection>
      <ReadSection title={chartTitle} query={audienceQuery}>
        <p className="mb-2 text-xs text-text-muted">Даты в текущих записях Hub. Повторные подписки и изменения источника не означают привлечение новых людей.</p>
        <PageActivityChart
          title={chartTitle}
          selectedPeriod={audienceChartPeriod}
          selectedPeriodLabel={audienceChartPeriodLabel}
          points={activityPoints}
          color="#5b8def"
        />
      </ReadSection>
      <ReadSection title="График дохода" query={revenueDailyQuery}>
        <PageActivityChart
          title="REVENUE"
          selectedPeriod={selectedPeriod}
          selectedPeriodLabel={selectedPeriodLabel}
          points={revenuePoints}
          valueFormatter={(v) => formatUsdFromMills(v)}
          yAxisWidth={72}
        />
      </ReadSection>

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

      <div className="flex gap-0 border-b border-border mb-6">
        {tabs.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => update("tab", key)}
            className={`px-[22px] py-3 text-sm font-medium cursor-pointer border-b-2 transition-colors ${
              activeTab === key
                ? "text-text-primary border-accent font-semibold"
                : "text-text-muted border-transparent hover:text-text-secondary"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === "transactions" && (
        <ReadSection title="Операции" query={transactionsQuery}>
        <p className="mb-3 text-xs text-text-muted">Вся сохранённая история операций; период дохода сверху этот список не ограничивает.</p>
        <PageTransactionsSection
          transactions={transactionsQuery.data}
          txOffset={txOffset}
          txTypeFilter={txTypeFilter}
          onTxTypeChange={(value) => update("type", value)}
          onTxPageChange={(value) => update("txOffset", String(value))}
          stateColorClass={stateColorClass}
        />
        </ReadSection>
      )}

      {activeTab === "spenders" && (
        <ReadSection title="Спендеры" query={spendersQuery}>
        <PageSpendersSection
          spenders={spendersQuery.data}
          spenderPeriod={spenderPeriod}
          spendersOffset={spendersOffset}
          onPageChange={(value) => update("spendersOffset", String(value))}
          onOpenFanProfile={openFanProfile}
        />
        </ReadSection>
      )}

      {activeTab === "followers" && (
        <PageFollowersSection pageLabel={pageLabel!} />
      )}
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
  return (
    <div className="bg-card border border-border rounded-xl overflow-x-auto mb-6">
      <div className="flex items-center justify-between p-4 px-[22px] border-b border-border bg-hover-alt">
        <Link
          to={buildPageSectionRoute(pageLabel, "subscribers")}
          className="font-bold text-[15px] text-text-primary hover:text-accent transition-colors"
        >
          Subscribers
        </Link>
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-text-muted">
            {subscribers?.total ?? 0} total
          </span>
          <Link
            to={buildPageSectionRoute(pageLabel, "subscribers")}
            className="text-accent text-[12px] font-medium hover:underline"
          >
            View all &rarr;
          </Link>
        </div>
      </div>

      <table className="w-full border-collapse">
        <thead>
          <tr>
            {[
              "Username",
              "Since",
              "Expires",
              "Remaining",
              "Renew",
              "Spent",
              "Last Txn",
            ].map((col) => (
              <th
                key={col}
                className="text-left p-3 px-[22px] text-[11px] font-semibold text-text-muted uppercase tracking-wider border-b border-border"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(subscribers?.items ?? []).map((item) => {
            const days = item.endsAt ? daysRemaining(item.endsAt) : null;
            const fanLabel = resolveFanLabelForScope(item, "page");
            const isNew = isRecent(item.startedAt);

            return (
              <tr
                key={item.platformSubscriptionId}
                onClick={() => onOpenFanProfile(item.platformUserId, fanLabel.label)}
                className="cursor-pointer hover:bg-hover-alt transition-colors"
              >
                <td className="p-3.5 px-[22px] text-sm text-text-secondary border-b border-border-light">
                  <div className="flex items-center gap-2">
                    <div className="flex flex-col">
                      <button type="button" onClick={(event) => { event.stopPropagation(); onOpenFanProfile(item.platformUserId, fanLabel.label); }} className="text-left text-text-primary font-medium hover:text-accent">
                        {fanLabel.label}
                      </button>
                      {fanLabel.secondaryPlatformHandle && (
                        <span className="text-[12px] text-text-muted">
                          @{fanLabel.secondaryPlatformHandle}
                        </span>
                      )}
                    </div>
                    {isNew && <Badge variant="new">NEW</Badge>}
                  </div>
                </td>
                <td className="p-3.5 px-[22px] text-sm text-text-secondary border-b border-border-light">
                  {item.startedAt ? formatDate(item.startedAt) : "\u2014"}
                </td>
                <td className="p-3.5 px-[22px] text-sm text-text-secondary border-b border-border-light">
                  {item.endsAt ? formatDate(item.endsAt) : "\u2014"}
                </td>
                <td className="p-3.5 px-[22px] text-sm border-b border-border-light">
                  {days !== null ? <RemainingBar days={days} /> : "\u2014"}
                </td>
                <td className="p-3.5 px-[22px] text-sm border-b border-border-light">
                  {item.autoRenew === true && (
                    <span className="text-green font-medium">On</span>
                  )}
                  {item.autoRenew === false && (
                    <span className="inline-flex flex-col">
                      <span className="font-medium text-danger">Off</span>
                      {item.autoRenewOffDetectedAt && (
                        <span className="text-[11px] text-warning-dark">
                          detected {formatDate(item.autoRenewOffDetectedAt, { includeYear: true })}
                        </span>
                      )}
                    </span>
                  )}
                  {item.autoRenew == null && (
                    <span className="text-text-muted">&mdash;</span>
                  )}
                </td>
                <td className="p-3.5 px-[22px] text-sm text-text-secondary border-b border-border-light">
                  {item.totalSpentCents != null ? formatUsdFromCents(item.totalSpentCents) : "\u2014"}
                </td>
                <td className="p-3.5 px-[22px] text-sm text-text-secondary border-b border-border-light">
                  {item.lastTransactionAt ? formatDateTime(item.lastTransactionAt) : "\u2014"}
                </td>
              </tr>
            );
          })}
          {(subscribers?.items ?? []).length === 0 && (
            <tr>
              <td
                colSpan={7}
                className="p-8 text-center text-sm text-text-muted"
              >
                No subscribers found
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
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
    <div className="bg-card border border-border rounded-xl overflow-x-auto mb-6">
      <div className="flex items-center justify-between p-4 px-[22px] border-b border-border bg-hover-alt">
        <div className="font-bold text-[15px] text-text-primary">
          Spender Auto Lists
        </div>
        <span className="text-[12px] text-text-muted">
          {autoLists?.totalEntries ?? 0} total
        </span>
      </div>
      <div className="divide-y divide-border-light">
        {lists.map((item) => (
          <Link
            key={item.key}
            to={`${buildPageSpenderAutoListRoute(pageLabel, item.key)}${period ? `?${new URLSearchParams({ period })}` : ""}`}
            className="block px-[22px] py-4 transition-colors hover:bg-hover"
          >
            <div className="text-[15px] font-extrabold text-text-primary">
              {item.label}
            </div>
            <div className="mt-1 text-sm text-text-muted tabular-nums">
              {item.entryCount} Entries
            </div>
          </Link>
        ))}
        {lists.length === 0 && (
          <div className="px-[22px] py-8 text-center text-sm text-text-muted">
            No auto lists found
          </div>
        )}
      </div>
    </div>
  );
}

function PageTransactionsSection({
  transactions,
  txOffset,
  txTypeFilter,
  onTxTypeChange,
  onTxPageChange,
  stateColorClass,
}: {
  transactions: TransactionListResponse | undefined;
  txOffset: number;
  txTypeFilter: string;
  onTxTypeChange: (value: string) => void;
  onTxPageChange: (offset: number) => void;
  stateColorClass: (state: string) => string;
}) {
  const pagePlatform = transactions?.page?.platform;

  return (
    <div>
      <div className="mb-3">
        <FilterButtons
          filters={[
            { key: "", label: "All" },
            { key: "subscription", label: "Subscriptions" },
            { key: "tip", label: "Tips" },
            { key: "message_purchase", label: "Messages" },
          ]}
          active={txTypeFilter}
          onChange={onTxTypeChange}
        />
      </div>
      <div className="bg-card border border-border rounded-xl overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="text-left p-3 px-[22px] text-[11px] font-semibold text-text-muted uppercase tracking-wider border-b border-border">
                Date
              </th>
              <th className="text-left p-3 px-[22px] text-[11px] font-semibold text-text-muted uppercase tracking-wider border-b border-border">
                Fan
              </th>
              <th className="text-left p-3 px-[22px] text-[11px] font-semibold text-text-muted uppercase tracking-wider border-b border-border">
                Type
              </th>
              <th className="text-left p-3 px-[22px] text-[11px] font-semibold text-text-muted uppercase tracking-wider border-b border-border">
                Status
              </th>
              <th className="text-right p-3 px-[22px] text-[11px] font-semibold text-text-muted uppercase tracking-wider border-b border-border">
                Amount
              </th>
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
                <tr
                  key={item.transactionId ?? idx}
                  className="cursor-pointer hover:bg-hover-alt transition-colors"
                >
                  <td className="p-3.5 px-[22px] text-sm text-text-secondary border-b border-border-light">
                    {formatDateTime(item.occurredAt)}
                  </td>
                  <td
                    className={`p-3.5 px-[22px] text-sm border-b border-border-light ${fanIsMuted ? "text-text-muted" : "text-text-primary"}`}
                  >
                    {fanDisplay ?? "\u2014"}
                  </td>
                  <td className="p-3.5 px-[22px] text-sm text-text-secondary border-b border-border-light">
                    {transactionTypeLabel(item.canonicalType)}
                  </td>
                  <td className="p-3.5 px-[22px] text-sm border-b border-border-light">
                    <span className={stateColorClass(item.transactionState)}>
                      {item.transactionState.charAt(0).toUpperCase() +
                        item.transactionState.slice(1)}
                    </span>
                  </td>
                  <td className="p-3.5 px-[22px] text-sm text-text-primary font-medium text-right border-b border-border-light">
                    {formatUsdFromMills(item.netAmountMills)}
                  </td>
                </tr>
              );
            })}
            {(transactions?.items ?? []).length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="p-8 text-center text-sm text-text-muted"
                >
                  {txOffset > 0 ? "На этой странице списка записей нет." : "No transactions found"}
                  {txOffset > 0 && <button type="button" className="ml-2 text-accent" onClick={() => onTxPageChange(0)}>К началу списка</button>}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <Pagination
          offset={txOffset}
          limit={PAGE_SIZE}
          total={transactions?.total ?? 0}
          onPageChange={onTxPageChange}
        />
      </div>
    </div>
  );
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
    <div className="bg-card border border-border rounded-xl overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-hover-alt">
            {["Rank", "Username", "Total Spent", "Transactions"].map((col) => (
              <th
                key={col}
                className={`px-4 py-3 text-[12px] font-semibold uppercase tracking-wider text-text-muted ${
                  col === "Total Spent" || col === "Transactions" ? "text-right" : "text-left"
                }`}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(spenders?.items ?? []).length === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-8 text-center text-sm text-text-muted">
                {spendersOffset > 0 ? "На этой странице списка записей нет." : "No spenders found for this period."}
                {spendersOffset > 0 && <button type="button" className="ml-2 text-accent" onClick={() => onPageChange(0)}>К началу списка</button>}
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
              <tr
                key={item.fan.platformUserId}
                onClick={() => onOpenFanProfile(item.fan.platformUserId, fanLabel.label)}
                className="cursor-pointer border-t border-border transition-colors hover:bg-hover"
              >
                <td className="px-4 py-3 text-sm text-text-secondary tabular-nums">
                  {spendersOffset + index + 1}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    <button type="button" onClick={(event) => { event.stopPropagation(); onOpenFanProfile(item.fan.platformUserId, fanLabel.label); }} className="text-left text-[15px] font-semibold text-text-primary hover:text-accent">
                      {fanLabel.label}
                    </button>
                    <FanNotVisibleMark missAt={item.accountLookupMissAt} />
                  </div>
                  {fanLabel.secondaryPlatformHandle && (
                    <div className="text-xs text-text-muted">@{fanLabel.secondaryPlatformHandle}</div>
                  )}
                </td>
                <td className="px-4 py-3 text-right text-sm font-medium tabular-nums text-text-primary">
                  {spent === null ? "—" : formatUsdFromMills(spent)}
                </td>
                <td className="px-4 py-3 text-right text-sm text-text-secondary tabular-nums">
                  {transactionCount ?? "\u2014"}
                </td>
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

function PageFollowersSection({ pageLabel }: { pageLabel: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-8">
      <Link
        to={buildPageSectionRoute(pageLabel, "followers")}
        className="text-accent text-sm font-medium hover:underline"
      >
        View all followers &rarr;
      </Link>
    </div>
  );
}

function PageDetailSkeleton() {
  return (
    <div>
      <div className="mb-6">
        <div className="h-7 w-48 rounded bg-hover-alt animate-pulse" />
        <div className="mt-2 h-4 w-64 rounded bg-hover-alt animate-pulse" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5 mb-6">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="rounded-[10px] border border-border bg-card p-4">
            <div className="h-3 w-16 rounded bg-hover-alt animate-pulse" />
            <div className="mt-3 h-7 w-24 rounded bg-hover-alt animate-pulse" style={{ animationDelay: `${i * 100}ms` }} />
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-border bg-card p-5 mb-6">
        <div className="h-[300px] flex items-center justify-center">
          <div className="h-4 w-32 rounded bg-hover-alt animate-pulse" />
        </div>
      </div>
    </div>
  );
}
