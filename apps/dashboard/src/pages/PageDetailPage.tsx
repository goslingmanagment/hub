import { lazy, Suspense, useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router";
import {
  useOverview,
  usePageRevenue,
  usePageSubscribers,
  usePageTransactions,
  useSpenders,
  usePageFollowersDaily,
  usePageSubscribersDaily,
  usePageRevenueDaily,
} from "@/api/queries";
import { Badge } from "@/components/shared/Badge";
import { DeltaIndicator } from "@/components/shared/DeltaIndicator";
import { Pagination } from "@/components/shared/Pagination";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { RemainingBar } from "@/components/shared/RemainingBar";
import { buildFanProfileNavigation, buildPageRoute } from "@/lib/navigation";
import { usePeriodStore } from "@/stores/periodStore";
import { formatUsdFromMills, resolveFanLabel } from "@agency_hub_core/shared";
import {
  formatDate,
  formatDateTime,
  formatUsdFromCents,
  transactionTypeLabel,
  daysRemaining,
  formatRelativeTime,
} from "@/lib/format";
type TabKey = "transactions" | "spenders" | "followers";

const PAGE_SIZE = 50;
const PageActivityChart = lazy(() =>
  import("@/components/page/PageActivityChart").then((m) => ({ default: m.PageActivityChart })),
);

function isRecent(iso: string | null) {
  return iso ? Date.now() - new Date(iso).getTime() < 86_400_000 : false;
}

export function PageDetailPage() {
  const { pageLabel } = useParams<{ pageLabel: string }>();
  const navigate = useNavigate();
  const { period } = usePeriodStore();
  const selectedPeriod = period === "today" || period === "7d" || period === "30d" || period === "all" ? period : "30d";

  const { data: overview, isLoading: overviewLoading } = useOverview();
  const page = overview?.pages.find((p: { label: string }) => p.label === pageLabel);

  const { data: selectedRevenue } = usePageRevenue(pageLabel!, selectedPeriod);

  const isFansly = page?.platform === "fansly";
  const { data: dailyData } = usePageFollowersDaily(pageLabel!, selectedPeriod, {
    enabled: isFansly,
  });
  const { data: subsDailyData } = usePageSubscribersDaily(pageLabel!, selectedPeriod);
  const { data: revenueDailyData } = usePageRevenueDaily(pageLabel!, selectedPeriod);

  const { data: subscribers } = usePageSubscribers(pageLabel!, { limit: 6 });

  const [activeTab, setActiveTab] = useState<TabKey>("transactions");
  const [txOffset, setTxOffset] = useState(0);
  const [spendersOffset, setSpendersOffset] = useState(0);

  const { data: transactions } = usePageTransactions(pageLabel!, {
    limit: PAGE_SIZE,
    offset: txOffset,
  });
  const spenderPeriod = selectedPeriod === "all" ? "lifetime" : selectedPeriod;
  const { data: spenders } = useSpenders({
    scope: "page",
    pageLabel,
    period: spenderPeriod,
    limit: PAGE_SIZE,
    offset: spendersOffset,
    sortBy: "creatorNetAmountMills",
    sortDir: "desc",
  });

  useEffect(() => {
    setSpendersOffset(0);
  }, [pageLabel, selectedPeriod]);

  useEffect(() => {
    if (!isFansly && activeTab === "followers") {
      setActiveTab("transactions");
    }
  }, [activeTab, isFansly]);

  if (overviewLoading || !overview) {
    return (
      <div className="flex items-center justify-center py-24">
        <span className="text-text-muted text-sm">Loading...</span>
      </div>
    );
  }

  if (!page) {
    return (
      <div className="flex items-center justify-center py-24">
        <span className="text-text-muted text-sm">Page not found</span>
      </div>
    );
  }

  const activityPoints = isFansly
    ? (dailyData?.items ?? []).map((item) => ({
      businessDate: item.businessDate,
      value: item.newFollowers ?? 0,
    }))
    : (subsDailyData?.items ?? []).map((item) => ({
      businessDate: item.businessDate,
      value: item.newSubscribers ?? 0,
    }));
  const chartTitle = isFansly ? "New Followers" : "New Subscribers";
  const revenuePoints = (revenueDailyData?.series ?? []).map((item) => ({
    businessDate: item.businessDate,
    value: item.netAmountMills,
  }));
  const selectedPeriodLabel = selectedPeriod === "today"
    ? "Today"
    : selectedPeriod === "7d"
      ? "7 Days"
      : selectedPeriod === "all"
        ? "All Time"
        : "30 Days";

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
          {page.lastLightSyncAt && (
            <>
              {" "}
              &middot; Synced {formatRelativeTime(page.lastLightSyncAt)}
            </>
          )}
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5 mb-6">
        <div className="rounded-[10px] border border-border bg-card p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Revenue
          </div>
          <div className="text-2xl font-extrabold tabular-nums text-accent mt-1">
            {formatUsdFromMills(selectedRevenue?.netEarningsMills ?? 0)}
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
              {formatUsdFromMills(breakdownAmount(type))}
            </div>
          </div>
        ))}
      </div>

      <Suspense
        fallback={(
          <div className="bg-card border border-border rounded-xl p-5 mb-6">
            <div className="h-[300px] flex items-center justify-center text-sm text-text-muted">
              Loading chart...
            </div>
          </div>
        )}
      >
        <PageActivityChart
          title={chartTitle}
          selectedPeriod={selectedPeriod}
          selectedPeriodLabel={selectedPeriodLabel}
          points={activityPoints}
          color="#5b8def"
        />
        <PageActivityChart
          title="REVENUE"
          selectedPeriod={selectedPeriod}
          selectedPeriodLabel={selectedPeriodLabel}
          points={revenuePoints}
          valueFormatter={(v) => formatUsdFromMills(v)}
          yAxisWidth={72}
        />
      </Suspense>

      <div className="bg-card border border-border rounded-xl overflow-hidden mb-6">
        <div className="flex items-center justify-between p-4 px-[22px] border-b border-border bg-hover-alt">
          <Link
            to={`/pages/${pageLabel}/subscribers`}
            className="font-bold text-[15px] text-text-primary hover:text-accent transition-colors"
          >
            Subscribers
          </Link>
          <div className="flex items-center gap-3">
            <span className="text-[12px] text-text-muted">
              {subscribers?.total ?? 0} total
            </span>
            <Link
              to={`/pages/${pageLabel}/subscribers`}
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
              const fanLabel = resolveFanLabel(item);
              const isNew = isRecent(item.startedAt);
              const fanNavigation = buildFanProfileNavigation(
                pageLabel!,
                page.platform,
                item.platformUserId,
                buildPageRoute(pageLabel!),
              );

              return (
                <tr
                  key={item.platformSubscriptionId}
                  onClick={() => navigate(fanNavigation.to, { state: fanNavigation.state })}
                  className="cursor-pointer hover:bg-hover-alt transition-colors"
                >
                  <td className="p-3.5 px-[22px] text-sm text-text-secondary border-b border-border-light">
                    <div className="flex items-center gap-2">
                      <div className="flex flex-col">
                        <span className="text-text-primary font-medium">
                          {fanLabel.label}
                        </span>
                        {fanLabel.username && fanLabel.displayName && (
                          <span className="text-[12px] text-text-muted">
                            @{fanLabel.username}
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
                      <span className="text-danger font-medium">Off</span>
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

      <div className="flex gap-0 border-b border-border mb-6">
        {tabs.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveTab(key)}
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
        <div className="bg-card border border-border rounded-xl overflow-hidden">
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
                const fanLabel = item.fan ? resolveFanLabel(item.fan) : null;
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
                    No transactions found
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <Pagination
            offset={txOffset}
            limit={PAGE_SIZE}
            total={transactions?.total ?? 0}
            onPageChange={setTxOffset}
          />
        </div>
      )}

      {activeTab === "spenders" && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
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
                    No spenders found for this period.
                  </td>
                </tr>
              )}
              {(spenders?.items ?? []).map((item, index) => {
                const windowMetrics = item.metrics.window;
                const fanLabel = resolveFanLabel(item.fan);
                const fanNavigation = buildFanProfileNavigation(
                  pageLabel!,
                  page.platform,
                  item.fan.platformUserId,
                  buildPageRoute(pageLabel!),
                );

                return (
                  <tr
                    key={item.fan.platformUserId}
                    onClick={() => navigate(fanNavigation.to, { state: fanNavigation.state })}
                    className="cursor-pointer border-t border-border transition-colors hover:bg-hover"
                  >
                    <td className="px-4 py-3 text-sm text-text-secondary tabular-nums">
                      {spendersOffset + index + 1}
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-[15px] font-semibold text-text-primary">
                        {fanLabel.label}
                      </div>
                      {fanLabel.displayName && fanLabel.username && (
                        <div className="text-xs text-text-muted">@{fanLabel.username}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium tabular-nums text-text-primary">
                      {formatUsdFromMills(windowMetrics?.creatorNetAmountMills ?? 0)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-text-secondary tabular-nums">
                      {windowMetrics?.transactionCount ?? 0}
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
            onPageChange={setSpendersOffset}
          />
        </div>
      )}

      {activeTab === "followers" && (
        <div className="bg-card border border-border rounded-xl p-8">
          <Link
            to={`/pages/${pageLabel}/followers`}
            className="text-accent text-sm font-medium hover:underline"
          >
            View all followers &rarr;
          </Link>
        </div>
      )}
    </div>
  );
}
