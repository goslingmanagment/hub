import { type ReactNode } from "react";
import {
  useNavigate,
  useParams,
  useLocation,
  useSearchParams,
  Link,
} from "react-router";
import {
  useAuthMe,
  usePageRevenue,
  usePageSubscribers,
  useSpenders,
  usePageSpenderAutoLists,
  usePageFollowersDaily,
  usePageSubscribersDaily,
  usePageRevenueDaily,
} from "@/api/queries";
import { useRevenueTransactions } from "@/api/transactions";
import { Badge } from "@/components/shared/Badge";
import { DeltaIndicator } from "@/components/shared/DeltaIndicator";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { Pagination } from "@/components/shared/Pagination";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { RemainingBar } from "@/components/shared/RemainingBar";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { QuerySection } from "@/components/shared/QuerySection";
import { getSyncUxTone } from "@/components/shared/SyncUxBadge";
import {
  getSyncUxDisplayMode,
  getSyncUxExceptionKind,
} from "@/components/shared/syncUxDisplay";
import { PageActivityChart } from "@/components/page/PageActivityChart";
import {
  buildPageSectionRoute,
  buildPageSpenderAutoListRoute,
  buildSettingsRoute,
} from "@/lib/navigation";
import {
  buildAudienceFanNavigation,
  audiencePaginationLabels,
} from "@/lib/audienceNavigation";
import {
  buildRevenueTransactionsRoute,
  listOffset,
  parseOverviewState,
  PERIOD_LABELS,
} from "@/lib/overviewNavigation";
import { pageTransactionQuery } from "@/lib/pageDetailNavigation";
import { matchesTransactionScope } from "@/lib/transactionNavigation";
import { usePeriodStore, type PeriodOption } from "@/stores/periodStore";
import {
  formatUsdFromMills,
  resolveFanLabelForScope,
} from "@agency_hub_core/shared";
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
  CrossPageTransactionListResponse,
} from "@agency_hub_core/contracts";

type TabKey = "transactions" | "spenders" | "followers";
const PAGE_SIZE = 50;
function isRecent(iso: string | null) {
  return iso ? Date.now() - new Date(iso).getTime() < 86_400_000 : false;
}

export function PageDetailPage() {
  const { pageLabel } = useParams<{ pageLabel: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const { data: auth } = useAuthMe();
  const { period } = usePeriodStore();
  const selectedPeriod = parseOverviewState(search, period).period;
  const spenderPeriod = selectedPeriod === "all" ? "lifetime" : selectedPeriod;
  const audienceChartPeriod =
    selectedPeriod === "today" ? "7d" : selectedPeriod;
  const { findPageByLabel, pageCatalogState, pageCatalogError } =
    useDashboardShell();
  const resolvedPageLabel = pageLabel ?? "";
  const page = findPageByLabel(pageLabel);
  const canLoadPageData =
    resolvedPageLabel.length > 0 && pageCatalogState === "ready" && !!page;
  const isFansly = page?.platform === "fansly";
  const revenue = usePageRevenue(resolvedPageLabel, selectedPeriod, {
    enabled: canLoadPageData,
  });
  const selectedRevenue = revenue.data;
  const followersDaily = usePageFollowersDaily(
    resolvedPageLabel,
    audienceChartPeriod,
    { enabled: canLoadPageData && isFansly },
  );
  const subscribersDaily = usePageSubscribersDaily(
    resolvedPageLabel,
    audienceChartPeriod,
    { enabled: canLoadPageData },
  );
  const revenueDaily = usePageRevenueDaily(resolvedPageLabel, selectedPeriod, {
    enabled: canLoadPageData,
  });
  const subscribers = usePageSubscribers(
    resolvedPageLabel,
    { limit: 6 },
    { enabled: canLoadPageData },
  );
  const autoLists = usePageSpenderAutoLists(
    resolvedPageLabel,
    { period: spenderPeriod },
    { enabled: canLoadPageData },
  );
  const activeTab: TabKey =
    search.get("tab") === "spenders"
      ? "spenders"
      : search.get("tab") === "followers" && isFansly
        ? "followers"
        : "transactions";
  const txOffset = listOffset(search.get("txOffset"));
  const txTypeFilter = ["subscription", "tip", "message_purchase"].includes(
    search.get("type") ?? "",
  )
    ? search.get("type")!
    : "";
  const spendersOffset = listOffset(search.get("spendersOffset"));
  const transactionParams = canLoadPageData
    ? pageTransactionQuery(
        resolvedPageLabel,
        selectedPeriod,
        selectedRevenue,
        txTypeFilter,
        txOffset,
      )
    : undefined;
  const transactions = useRevenueTransactions(
    activeTab === "transactions" ? transactionParams : undefined,
  );
  const compatibleTransactions =
    transactions.data &&
    transactionParams &&
    matchesTransactionScope(transactions.data, transactionParams);
  const spenders = useSpenders(
    {
      scope: "page",
      pageLabel: resolvedPageLabel,
      period: spenderPeriod,
      limit: PAGE_SIZE,
      offset: spendersOffset,
      sortBy: "creatorNetAmountMills",
      sortDir: "desc",
    },
    { enabled: canLoadPageData },
  );

  function update(changes: Record<string, string | null>) {
    setSearch((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    });
  }
  const backTo = `${location.pathname}?${new URLSearchParams({ ...Object.fromEntries(search), period: selectedPeriod })}`;
  function fanNavigation(platformUserId: string, fanLabel: string) {
    return buildAudienceFanNavigation(
      resolvedPageLabel,
      page!.platform,
      platformUserId,
      backTo,
      fanLabel,
      selectedPeriod,
    );
  }
  function openFanProfile(platformUserId: string, fanLabel: string) {
    const target = fanNavigation(platformUserId, fanLabel);
    navigate(target.to, { state: target.state });
  }
  const renderFan = (id: string, label: string) => {
    const target = fanNavigation(id, label);
    return (
      <Link
        to={target.to}
        state={target.state}
        className="font-semibold text-text-primary hover:text-accent hover:underline"
      >
        {label}
      </Link>
    );
  };

  if (pageCatalogState === "loading") return <PageDetailSkeleton />;
  if (pageCatalogState === "error")
    return (
      <StatusPanel
        title="Не удалось загрузить аккаунт"
        description={
          pageCatalogError?.message ?? "Каталог аккаунтов недоступен."
        }
        tone="error"
      />
    );
  if (!page)
    return (
      <StatusPanel
        title="Аккаунт не найден"
        description="Этого аккаунта нет среди доступных вам страниц."
        tone="error"
      />
    );

  const activityQuery = isFansly ? followersDaily : subscribersDaily;
  const activityPoints = isFansly
    ? (followersDaily.data?.items ?? []).map((item) => ({
        businessDate: item.businessDate,
        value: item.newFollowers ?? 0,
      }))
    : (subscribersDaily.data?.items ?? []).map((item) => ({
        businessDate: item.businessDate,
        value: item.newSubscribers ?? 0,
      }));
  const chartTitle = isFansly ? "Новые фолловеры" : "Новые подписчики";
  const exceptionKind = getSyncUxExceptionKind(page.syncUx);
  const syncTone = getSyncUxTone(page.syncUx.state);
  const showSyncException =
    getSyncUxDisplayMode(page.syncUx, "page_detail") === "exception" &&
    exceptionKind &&
    exceptionKind !== "credentials";
  const revenueRoute = (type?: "subscription" | "tip" | "message_purchase") =>
    buildRevenueTransactionsRoute({
      pageLabel: page.label,
      from: transactionParams?.from ?? null,
      to: transactionParams?.to ?? null,
      ...(type ? { type } : {}),
      backTo,
    });
  const tabs: { key: TabKey; label: string }[] = [
    { key: "transactions", label: "Транзакции" },
    { key: "spenders", label: "Платящие фаны" },
    ...(isFansly ? [{ key: "followers" as const, label: "Фолловеры" }] : []),
  ];

  return (
    <div className="p-4 md:p-0 space-y-6">
      <header>
        <div className="flex flex-wrap items-center gap-3 mb-1">
          <h1 className="text-2xl font-extrabold text-text-primary break-words">
            {page.label}
          </h1>
          <PlatformBadge platform={page.platform} />
        </div>
        <p className="text-sm text-text-muted">
          {page.username ? `@${page.username}` : "Имя аккаунта не получено"} ·
          Модель: {page.modelName}
        </p>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm text-accent">
          <Link
            className="hover:underline"
            to={buildPageSectionRoute(page.label, "subscribers")}
          >
            Подписчики →
          </Link>
          {isFansly && (
            <Link
              className="hover:underline"
              to={buildPageSectionRoute(page.label, "followers")}
            >
              Фолловеры →
            </Link>
          )}
          <Link
            className="hover:underline"
            to={`${buildPageSectionRoute(page.label, "top-supporters")}?period=${selectedPeriod}`}
          >
            Топ фанов →
          </Link>
        </div>
        {showSyncException && (
          <div
            className={`mt-3 flex flex-wrap items-center gap-2 rounded-xl border px-4 py-3 text-sm ${syncTone.panel}`}
          >
            <span className={`font-medium ${syncTone.text}`}>
              {exceptionKind === "off"
                ? `${page.syncUx.headline} — проверьте синхронизацию`
                : "Данные могут быть неполными"}
            </span>
            {auth?.user.role === "owner" && (
              <Link
                to={buildSettingsRoute("sync", page.label)}
                className="font-semibold text-accent hover:underline"
              >
                Проверить синхронизацию →
              </Link>
            )}
          </div>
        )}
      </header>

      <QuerySection
        title="Доход"
        hasData={Boolean(selectedRevenue)}
        isError={revenue.isError}
        retry={revenue.refetch}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
          <h2 className="font-bold text-text-primary">
            Доход · {PERIOD_LABELS[selectedPeriod]}
          </h2>
          <span className="text-xs text-text-muted">
            После комиссии платформы · по сохранённым операциям
          </span>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
          {[
            {
              label: "Всего",
              type: undefined,
              amount: selectedRevenue?.netEarningsMills,
            },
            ...(
              [
                { label: "Подписки", type: "subscription" },
                { label: "Чаевые", type: "tip" },
                { label: "Сообщения", type: "message_purchase" },
              ] as const
            ).map((entry) => ({
              ...entry,
              amount:
                selectedRevenue?.breakdown.find(
                  (row) => row.canonicalType === entry.type,
                )?.netAmountMills ?? 0,
            })),
          ].map((entry) => {
            const body = (
              <>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                  {entry.label}
                </div>
                <div className="text-xl sm:text-2xl font-extrabold tabular-nums mt-1 text-text-primary">
                  {entry.amount == null
                    ? "—"
                    : formatUsdFromMills(entry.amount)}
                </div>
                {!entry.type && selectedPeriod !== "all" && (
                  <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                    <DeltaIndicator
                      pct={selectedRevenue?.comparison?.deltaPct ?? null}
                    />
                    <span className="text-[11px] text-text-muted">
                      к прошлому периоду
                    </span>
                  </div>
                )}
              </>
            );
            return transactionParams ? (
              <Link
                key={entry.label}
                to={revenueRoute(entry.type)}
                className="rounded-[10px] border border-border bg-card p-4 hover:border-accent focus-visible:outline-accent"
                aria-label={`${entry.label}: открыть операции`}
              >
                {body}
              </Link>
            ) : (
              <div
                key={entry.label}
                className="rounded-[10px] border border-border bg-card p-4"
              >
                {body}
              </div>
            );
          })}
        </div>
      </QuerySection>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <QuerySection
          title={chartTitle}
          hasData={Boolean(activityQuery.data)}
          isError={activityQuery.isError}
          retry={activityQuery.refetch}
        >
          <PageActivityChart
            title={chartTitle}
            selectedPeriod={audienceChartPeriod}
            selectedPeriodLabel={PERIOD_LABELS[audienceChartPeriod]}
            points={activityPoints}
            color="#5b8def"
          />
        </QuerySection>
        <QuerySection
          title="Динамика дохода"
          hasData={Boolean(revenueDaily.data)}
          isError={revenueDaily.isError}
          retry={revenueDaily.refetch}
        >
          <PageActivityChart
            title="Динамика дохода"
            selectedPeriod={selectedPeriod}
            selectedPeriodLabel={PERIOD_LABELS[selectedPeriod]}
            points={(revenueDaily.data?.series ?? []).map((item) => ({
              businessDate: item.businessDate,
              value: item.netAmountMills,
            }))}
            valueFormatter={formatUsdFromMills}
            yAxisWidth={72}
          />
        </QuerySection>
      </div>
      <QuerySection
        title="Подписчики"
        hasData={Boolean(subscribers.data)}
        isError={subscribers.isError}
        retry={subscribers.refetch}
      >
        <PageSubscribersSection
          pageLabel={page.label}
          subscribers={subscribers.data}
          renderFan={renderFan}
        />
      </QuerySection>
      <QuerySection
        title="Автосписки по тратам"
        hasData={Boolean(autoLists.data)}
        isError={autoLists.isError}
        retry={autoLists.refetch}
      >
        <PageSpenderAutoListsSection
          pageLabel={page.label}
          autoLists={autoLists.data}
          period={selectedPeriod}
        />
      </QuerySection>
      <div>
        <div
          className="flex flex-wrap border-b border-border mb-4"
          role="group"
          aria-label="Детализация аккаунта"
        >
          {tabs.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              aria-pressed={activeTab === key}
              onClick={() => update({ tab: key })}
              className={`px-4 py-3 text-sm border-b-2 transition-colors ${activeTab === key ? "text-text-primary border-accent font-semibold" : "text-text-muted border-transparent hover:text-text-secondary"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {activeTab === "transactions" && (
          <>
            <p className="text-sm text-text-muted mb-3">
              {PERIOD_LABELS[selectedPeriod]} · операции, входящие в доход,
              после комиссии платформы.
            </p>
            <FilterButtons
              filters={[
                { key: "", label: "Все источники" },
                { key: "subscription", label: "Подписки" },
                { key: "tip", label: "Чаевые" },
                { key: "message_purchase", label: "Сообщения" },
              ]}
              active={txTypeFilter}
              onChange={(type) => update({ type, txOffset: null })}
            />
            <div className="mt-3">
              {!transactionParams ? (
                <StatusPanel
                  title="Период операций ещё не определён"
                  description={
                    revenue.isError
                      ? "Обновите блок дохода, чтобы получить границы выбранного периода."
                      : "Ожидаем данные выбранного периода."
                  }
                />
              ) : transactions.data && !compatibleTransactions ? (
                <StatusPanel
                  title="Сервер не подтвердил выбранный период"
                  description="Этот ответ нельзя использовать для сверки дохода. Нужна версия сервера с точной детализацией операций."
                  tone="error"
                />
              ) : (
                <QuerySection
                  title="Транзакции"
                  hasData={Boolean(transactions.data)}
                  isError={transactions.isError}
                  retry={transactions.refetch}
                >
                  <PageTransactionsSection
                    transactions={transactions.data}
                    txOffset={txOffset}
                    onTxPageChange={(offset) =>
                      update({ txOffset: String(offset) })
                    }
                    renderFan={renderFan}
                  />
                </QuerySection>
              )}
            </div>
          </>
        )}
        {activeTab === "spenders" && (
          <QuerySection
            title="Платящие фаны"
            hasData={Boolean(spenders.data)}
            isError={spenders.isError}
            retry={spenders.refetch}
          >
            <p className="text-sm text-text-muted mb-3">
              {PERIOD_LABELS[selectedPeriod]} · доход от фана после комиссии
              платформы.
            </p>
            <PageSpendersSection
              spenders={spenders.data}
              spenderPeriod={spenderPeriod}
              spendersOffset={spendersOffset}
              onPageChange={(offset) =>
                update({ spendersOffset: String(offset) })
              }
              onOpenFanProfile={openFanProfile}
              renderFan={renderFan}
            />
          </QuerySection>
        )}
        {activeTab === "followers" && (
          <PageFollowersSection pageLabel={page.label} />
        )}
      </div>
    </div>
  );
}

function PageSubscribersSection({
  pageLabel,
  subscribers,
  renderFan,
}: {
  pageLabel: string;
  subscribers: SubscriberListResponse | undefined;
  renderFan: (platformUserId: string, fanLabel: string) => ReactNode;
}) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden mb-6">
      <div className="flex flex-wrap items-center justify-between gap-2 p-4 px-[22px] border-b border-border bg-hover-alt">
        <Link
          to={buildPageSectionRoute(pageLabel, "subscribers")}
          className="font-bold text-[15px] text-text-primary hover:text-accent transition-colors"
        >
          Подписчики
        </Link>
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-text-muted">
            {subscribers?.total ?? "—"} всего
          </span>
          <Link
            to={buildPageSectionRoute(pageLabel, "subscribers")}
            className="text-accent text-[12px] font-medium hover:underline"
          >
            Все подписчики &rarr;
          </Link>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse">
          <thead>
            <tr>
              {[
                "Фан",
                "Начало",
                "Окончание",
                "Осталось",
                "Автопродление",
                "Доход автора",
                "Последняя оплата",
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
                  className="hover:bg-hover-alt transition-colors"
                >
                  <td className="p-3.5 px-[22px] text-sm text-text-secondary border-b border-border-light">
                    <div className="flex items-center gap-2">
                      <div className="flex flex-col">
                        <span className="text-text-primary font-medium">
                          {renderFan(item.platformUserId, fanLabel.label)}
                        </span>
                        {fanLabel.secondaryPlatformHandle && (
                          <span className="text-[12px] text-text-muted">
                            @{fanLabel.secondaryPlatformHandle}
                          </span>
                        )}
                      </div>
                      {isNew && <Badge variant="new">Новый</Badge>}
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
                      <span className="text-green font-medium">Вкл</span>
                    )}
                    {item.autoRenew === false && (
                      <span className="inline-flex flex-col">
                        <span className="font-medium text-danger">Выкл</span>
                        {item.autoRenewOffDetectedAt && (
                          <span className="text-[11px] text-warning-dark">
                            обнаружено{" "}
                            {formatDate(item.autoRenewOffDetectedAt, {
                              includeYear: true,
                            })}
                          </span>
                        )}
                      </span>
                    )}
                    {item.autoRenew == null && (
                      <span className="text-text-muted">&mdash;</span>
                    )}
                  </td>
                  <td className="p-3.5 px-[22px] text-sm text-text-secondary border-b border-border-light">
                    {item.totalSpentCents != null
                      ? formatUsdFromCents(item.totalSpentCents)
                      : "\u2014"}
                  </td>
                  <td className="p-3.5 px-[22px] text-sm text-text-secondary border-b border-border-light">
                    {item.lastTransactionAt
                      ? formatDateTime(item.lastTransactionAt)
                      : "\u2014"}
                  </td>
                </tr>
              );
            })}
            {subscribers && subscribers.items.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="p-8 text-center text-sm text-text-muted"
                >
                  Подписчики не найдены
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
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
    <div className="bg-card border border-border rounded-xl overflow-hidden mb-6">
      <div className="flex flex-wrap items-center justify-between gap-2 p-4 px-[22px] border-b border-border bg-hover-alt">
        <div className="font-bold text-[15px] text-text-primary">
          Автосписки по тратам
        </div>
        <span className="text-[12px] text-text-muted">
          {autoLists?.totalEntries ?? "—"} записей
        </span>
      </div>
      <div className="divide-y divide-border-light">
        {lists.map((item) => (
          <Link
            key={item.key}
            to={`${buildPageSpenderAutoListRoute(pageLabel, item.key)}${period ? `?period=${period}` : ""}`}
            className="block px-[22px] py-4 transition-colors hover:bg-hover"
          >
            <div className="text-[15px] font-extrabold text-text-primary">
              {item.label}
            </div>
            <div className="mt-1 text-sm text-text-muted tabular-nums">
              {item.entryCount} фанов
            </div>
          </Link>
        ))}
        {autoLists && lists.length === 0 && (
          <div className="px-[22px] py-8 text-center text-sm text-text-muted">
            Автосписки не найдены
          </div>
        )}
      </div>
    </div>
  );
}

function PageTransactionsSection({
  transactions,
  txOffset,
  onTxPageChange,
  renderFan,
}: {
  transactions: CrossPageTransactionListResponse | undefined;
  txOffset: number;
  onTxPageChange: (offset: number) => void;
  renderFan: (id: string, label: string) => ReactNode;
}) {
  if (!transactions) return null;
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr>
              {["Дата", "Фан", "Источник", "Статус", "После комиссии"].map(
                (label) => (
                  <th
                    key={label}
                    className="text-left p-3 font-semibold text-text-muted border-b border-border"
                  >
                    {label}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {transactions.items.map((item) => {
              const fanLabel = item.fan
                ? resolveFanLabelForScope(
                    { ...item.fan, platform: item.platform },
                    "page",
                  )
                : null;
              return (
                <tr
                  key={`${item.pageLabel}:${item.transactionId}`}
                  className="border-b border-border-light hover:bg-hover-alt"
                >
                  <td className="p-3 whitespace-nowrap text-text-secondary">
                    {formatDateTime(item.occurredAt)}
                  </td>
                  <td className="p-3">
                    {item.fan && fanLabel
                      ? renderFan(item.fan.platformUserId, fanLabel.label)
                      : "—"}
                  </td>
                  <td className="p-3">
                    {transactionTypeLabel(item.canonicalType)}
                  </td>
                  <td className="p-3 text-text-secondary">
                    {(
                      {
                        posted: "Проведена",
                        pending: "Ожидает",
                        unknown: "Неизвестен",
                      } as Record<string, string>
                    )[item.transactionState] ?? item.transactionState}
                  </td>
                  <td className="p-3 tabular-nums font-medium whitespace-nowrap">
                    {formatUsdFromMills(item.netAmountMills)}
                  </td>
                </tr>
              );
            })}
            {transactions.items.length === 0 && (
              <tr>
                <td colSpan={5} className="p-8 text-center text-text-muted">
                  {transactions.total
                    ? "На этой странице записей нет. Вернитесь к первой странице."
                    : "За выбранный период операции не записаны."}
                  {txOffset > 0 && (
                    <button
                      type="button"
                      className="block mx-auto mt-2 text-accent underline"
                      onClick={() => onTxPageChange(0)}
                    >
                      К первой странице
                    </button>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination
        offset={txOffset}
        limit={PAGE_SIZE}
        total={transactions.total}
        onPageChange={onTxPageChange}
        {...audiencePaginationLabels}
      />
    </div>
  );
}

export function PageSpendersSection({
  spenders,
  spenderPeriod,
  spendersOffset,
  onPageChange,
  onOpenFanProfile,
  renderFan,
}: {
  spenders: SpenderListResponse | undefined;
  spenderPeriod: "today" | "7d" | "30d" | "lifetime";
  spendersOffset: number;
  onPageChange: (offset: number) => void;
  onOpenFanProfile: (platformUserId: string, fanLabel: string) => void;
  renderFan?: (id: string, label: string) => ReactNode;
}) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse">
          <thead>
            <tr className="bg-hover-alt">
              {["Место", "Фан", "Доход от фана", "Операции"].map((col) => (
                <th
                  key={col}
                  className={`px-4 py-3 text-[12px] font-semibold uppercase tracking-wider text-text-muted ${
                    col === "Доход от фана" || col === "Операции"
                      ? "text-right"
                      : "text-left"
                  }`}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {spenders && spenders.items.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-8 text-center text-sm text-text-muted"
                >
                  {spenders.total
                    ? "На этой странице списка записей нет."
                    : "За выбранный период платящие фаны не найдены."}
                  {spendersOffset > 0 && (
                    <button
                      type="button"
                      className="block mx-auto mt-2 text-accent underline"
                      onClick={() => onPageChange(0)}
                    >
                      К первой странице
                    </button>
                  )}
                </td>
              </tr>
            )}
            {(spenders?.items ?? []).map((item, index) => {
              const windowMetrics = item.metrics.window;
              const spent =
                spenderPeriod === "lifetime"
                  ? item.metrics.lifetime.scopeCreatorNetAmountMills
                  : (windowMetrics?.creatorNetAmountMills ?? null);
              const transactionCount =
                spenderPeriod === "lifetime"
                  ? null
                  : (windowMetrics?.transactionCount ?? null);
              const fanLabel = resolveFanLabelForScope(item.fan, "page");

              return (
                <tr
                  key={item.fan.platformUserId}
                  className="border-t border-border transition-colors hover:bg-hover"
                >
                  <td className="px-4 py-3 text-sm text-text-secondary tabular-nums">
                    {spendersOffset + index + 1}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-[15px] font-semibold text-text-primary">
                      {renderFan ? (
                        renderFan(item.fan.platformUserId, fanLabel.label)
                      ) : (
                        <button
                          type="button"
                          className="text-left hover:text-accent hover:underline"
                          onClick={() =>
                            onOpenFanProfile(
                              item.fan.platformUserId,
                              fanLabel.label,
                            )
                          }
                        >
                          {fanLabel.label}
                        </button>
                      )}
                    </div>
                    {fanLabel.secondaryPlatformHandle && (
                      <div className="text-xs text-text-muted">
                        @{fanLabel.secondaryPlatformHandle}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-medium tabular-nums text-text-primary">
                    {spent == null ? "—" : formatUsdFromMills(spent)}
                  </td>
                  <td className="px-4 py-3 text-right text-sm text-text-secondary tabular-nums">
                    {transactionCount ?? "\u2014"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Pagination
        offset={spendersOffset}
        limit={PAGE_SIZE}
        total={spenders?.total ?? 0}
        onPageChange={onPageChange}
        {...audiencePaginationLabels}
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
        Открыть всех фолловеров &rarr;
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
          <div
            key={i}
            className="rounded-[10px] border border-border bg-card p-4"
          >
            <div className="h-3 w-16 rounded bg-hover-alt animate-pulse" />
            <div
              className="mt-3 h-7 w-24 rounded bg-hover-alt animate-pulse"
              style={{ animationDelay: `${i * 100}ms` }}
            />
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
