import { lazy, Suspense, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import {
  useAuthMe,
  useOverview,
  useOverviewRevenue,
  useOverviewGrowth,
  useOverviewRevenueDaily,
  useOverviewRevenueByModel,
} from "@/api/queries";
import { TrendSparkline } from "@/components/shared/TrendSparkline";
import { DeltaIndicator } from "@/components/shared/DeltaIndicator";
import { PeriodSelector } from "@/components/shared/PeriodSelector";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { getSyncUxTone } from "@/components/shared/SyncUxBadge";
import {
  getSyncUxDisplayMode,
  getSyncUxExceptionKind,
} from "@/components/shared/syncUxDisplay";
import { buildPageRoute, buildSettingsRoute } from "@/lib/navigation";
import { PLATFORM_DISPLAY_NAME } from "@/lib/platformUrls";
import { formatUsdFromMills } from "@agency_hub_core/shared";
import { usePeriodStore } from "@/stores/periodStore";
import type {
  OverviewResponse,
  PlatformRevenueWindow,
} from "@agency_hub_core/contracts";

const PageActivityChart = lazy(() =>
  import("@/components/page/PageActivityChart").then((m) => ({
    default: m.PageActivityChart,
  })),
);

type OverviewPageItem = OverviewResponse["pages"][number];
type PageMetric = OverviewPageItem["subscriberCount"];
type QueryState = {
  data?: unknown;
  isLoading?: boolean;
  isFetching?: boolean;
  isError?: boolean;
  isPlaceholderData?: boolean;
  refetch?: () => unknown;
};

const PERIOD_LABELS: Record<string, string> = {
  today: "Today",
  "7d": "7 Days",
  "30d": "30 Days",
  all: "All Time",
};

interface ModelGroup {
  modelSlug: string;
  modelName: string;
  pages: OverviewPageItem[];
}

function groupByModel(pages: OverviewPageItem[]): ModelGroup[] {
  const map = new Map<string, ModelGroup>();
  for (const page of pages) {
    let group = map.get(page.modelSlug);
    if (!group) {
      group = {
        modelSlug: page.modelSlug,
        modelName: page.modelName,
        pages: [],
      };
      map.set(page.modelSlug, group);
    }
    group.pages.push(page);
  }
  return Array.from(map.values());
}

function hasCurrentData(query: QueryState) {
  return (
    query.data !== undefined && query.data !== null && !query.isPlaceholderData
  );
}

function isWaiting(query: QueryState) {
  return !hasCurrentData(query) && Boolean(query.isLoading || query.isFetching);
}

function formatGrowthValue(value: number) {
  return `${value > 0 ? "+" : ""}${value.toLocaleString()}`;
}

function supportsFollowerGrowth(page: OverviewPageItem) {
  return page.platform === "fansly";
}

function getPageMetricValue(metric: PageMetric) {
  return metric.available && typeof metric.value === "number"
    ? metric.value
    : null;
}

function summarizeValues(values: Array<number | null>) {
  const known = values.filter((value): value is number => value !== null);
  return {
    value:
      known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null,
    known: known.length,
    total: values.length,
    partial: known.length > 0 && known.length < values.length,
  };
}

function MetricValue({
  value,
  loading = false,
  format = (n) => n.toLocaleString(),
  growth = false,
  partial = false,
}: {
  value: number | null;
  loading?: boolean;
  format?: (value: number) => string;
  growth?: boolean;
  partial?: boolean;
}) {
  if (loading)
    return (
      <span
        className="overview-value-skeleton"
        role="status"
        aria-label="Loading metric"
      />
    );
  if (value === null)
    return (
      <span
        className="text-text-muted"
        aria-label="Not available"
        title="Data is not available"
      >
        —
      </span>
    );
  return (
    <span
      className={
        growth && value !== 0
          ? value > 0
            ? "text-green"
            : "text-danger"
          : undefined
      }
    >
      {format(value)}
      {partial && (
        <span
          className="overview-partial"
          title="Some page values are unavailable; this is a subtotal"
        >
          Partial
        </span>
      )}
    </span>
  );
}

function QueryNotice({ query, label }: { query: QueryState; label: string }) {
  if (!query.isError) return null;
  return (
    <div role="alert" className="overview-query-notice">
      <span>
        {hasCurrentData(query)
          ? `${label} could not refresh. Showing saved data.`
          : `${label} could not be loaded.`}
      </span>
      <button
        type="button"
        disabled={query.isFetching}
        onClick={() => void query.refetch?.()}
      >
        {query.isFetching ? "Retrying…" : "Try again"}
      </button>
    </div>
  );
}

function SummaryMetric({
  label,
  value,
  detail,
  primary = false,
}: {
  label: string;
  value: ReactNode;
  detail: ReactNode;
  primary?: boolean;
}) {
  return (
    <div
      className={`overview-summary-metric${primary ? " overview-summary-primary" : ""}`}
    >
      <dt>{label}</dt>
      <dd className="overview-summary-value tabular-nums">{value}</dd>
      <dd className="overview-summary-detail">{detail}</dd>
    </div>
  );
}
const MS_PER_DAY = 86_400_000;

// Audit B2: OnlyFans trailing windows deliberately cover one more calendar day
// than other platforms', so a mixed-platform total under one period label sums
// different window widths. Returns the disclosure line, or null when every
// platform's window has the same width (single platform, custom range, etc.).
export function describeMixedRevenueWindows(
  windows: PlatformRevenueWindow[] | undefined,
  periodLabel: string,
): string | null {
  if (!windows || windows.length < 2) {
    return null;
  }

  const spans = windows
    .filter((window) => window.from && window.to)
    .map((window) => ({
      platform: PLATFORM_DISPLAY_NAME[window.platform] ?? window.platform,
      days: Math.round(
        (new Date(window.to!).getTime() - new Date(window.from!).getTime()) /
          MS_PER_DAY,
      ),
    }));

  if (spans.length < 2 || new Set(spans.map((span) => span.days)).size < 2) {
    return null;
  }

  const parts = spans.map((span) => `${span.days} days on ${span.platform}`);
  return `“${periodLabel}” uses ${parts.join(", ")}. Revenue and comparisons follow each platform’s billing calendar.`;
}

export function OverviewPage() {
  const { data: auth } = useAuthMe();
  const { period } = usePeriodStore();
  const overview = useOverview();
  const revenue = useOverviewRevenue(period);
  const growth = useOverviewGrowth(period);
  const daily = useOverviewRevenueDaily(period);
  const byModel = useOverviewRevenueByModel(period);
  const isOwner = auth?.user.role === "owner";
  const periodLabel = PERIOD_LABELS[period] ?? "30 Days";

  const overviewReady = hasCurrentData(overview);
  const revenueReady = hasCurrentData(revenue);
  const growthReady = hasCurrentData(growth);
  const dailyReady = hasCurrentData(daily);
  const modelsReady = hasCurrentData(byModel);
  const pages = overviewReady ? (overview.data?.pages ?? []) : [];
  const groups = groupByModel(pages);
  const revenueByPageId = new Map(
    revenueReady
      ? revenue.data?.pages.map((page) => [page.pageId, page.netEarningsMills])
      : [],
  );
  const growthByPageId = new Map(
    growthReady ? growth.data?.pages.map((page) => [page.pageId, page]) : [],
  );
  const currentSubs = summarizeValues(
    pages.map((page) => getPageMetricValue(page.subscriberCount)),
  );
  const newSubs = summarizeValues(
    pages.map((page) => growthByPageId.get(page.id)?.newSubscribers ?? null),
  );
  const newFollowers = summarizeValues(
    pages
      .filter(supportsFollowerGrowth)
      .map((page) => growthByPageId.get(page.id)?.newFollowers ?? null),
  );
  const queries = [overview, revenue, growth, daily, byModel];
  const refreshing = queries.some((query) => query.isFetching);
  const mixedWindowsNote = revenueReady
    ? describeMixedRevenueWindows(revenue.data?.platformWindows, periodLabel)
    : null;
  // Decision #131: agency totals retain historical revenue from deleted pages.
  const retiredRevenuePages = revenueReady
    ? (revenue.data?.pages ?? []).filter(
        (page) => page.status === "deleted" && page.netEarningsMills !== 0,
      )
    : [];

  return (
    <div className="overview-page">
      <header className="overview-header">
        <div>
          <h1>Agency overview</h1>
          <p>
            {overviewReady
              ? `${groups.length} ${groups.length === 1 ? "model" : "models"} · ${pages.length} ${pages.length === 1 ? "page" : "pages"}`
              : "Revenue and audience across your pages"}
          </p>
        </div>
        <div className="overview-controls">
          <PeriodSelector />
          <button
            type="button"
            className="overview-refresh"
            disabled={refreshing}
            onClick={() =>
              void Promise.all(queries.map((query) => query.refetch()))
            }
            aria-label="Refresh overview"
          >
            <RefreshCw
              size={15}
              className={refreshing ? "animate-spin" : ""}
              aria-hidden="true"
            />
            <span>{refreshing ? "Updating…" : "Refresh"}</span>
          </button>
        </div>
      </header>

      <section aria-label="Agency summary">
        <dl className="overview-summary">
          <SummaryMetric
            label="Net revenue"
            primary
            value={
              <MetricValue
                value={
                  revenueReady ? (revenue.data?.netEarningsMills ?? null) : null
                }
                loading={isWaiting(revenue)}
                format={formatUsdFromMills}
              />
            }
            detail={
              <>
                <span>{periodLabel}</span>
                {revenueReady &&
                  period !== "all" &&
                  revenue.data?.comparison?.deltaPct != null && (
                    <>
                      <DeltaIndicator pct={revenue.data.comparison.deltaPct} />
                      <span>vs previous period</span>
                    </>
                  )}
              </>
            }
          />
          <SummaryMetric
            label="Subscribers now"
            value={
              <MetricValue
                value={currentSubs.value}
                loading={isWaiting(overview)}
                partial={currentSubs.partial}
              />
            }
            detail={
              currentSubs.partial
                ? `${currentSubs.known} of ${currentSubs.total} pages reporting`
                : "Current audience · all platforms"
            }
          />
          <SummaryMetric
            label="New followers"
            value={
              <MetricValue
                value={newFollowers.value}
                loading={isWaiting(overview) || isWaiting(growth)}
                growth
                format={formatGrowthValue}
                partial={newFollowers.partial}
              />
            }
            detail={`${periodLabel} · Fansly only`}
          />
          <SummaryMetric
            label="New subscribers"
            value={
              <MetricValue
                value={newSubs.value}
                loading={isWaiting(overview) || isWaiting(growth)}
                growth
                format={formatGrowthValue}
                partial={newSubs.partial}
              />
            }
            detail={`${periodLabel} · all platforms`}
          />
        </dl>
        <QueryNotice query={revenue} label="Revenue" />
        <QueryNotice query={growth} label="Audience growth" />
        {mixedWindowsNote && (
          <p className="overview-footnote">{mixedWindowsNote}</p>
        )}
        {retiredRevenuePages.length > 0 && (
          <p className="overview-footnote">
            Totals include {retiredRevenuePages.length} retired{" "}
            {retiredRevenuePages.length === 1 ? "page" : "pages"} (
            {retiredRevenuePages.map((page) => page.pageLabel).join(", ")}).
            History is kept after deletion.
          </p>
        )}
      </section>

      <section
        className="overview-pages"
        aria-labelledby="overview-pages-heading"
      >
        <div className="overview-section-heading">
          <h2 id="overview-pages-heading">Models & pages</h2>
          {pages.length > 0 && <span>
            Open a page to see its details{" "}
            <ArrowUpRight size={14} aria-hidden="true" />
          </span>}
        </div>
        {isWaiting(overview) ? (
          <OverviewSkeleton />
        ) : !overviewReady ? (
          <StatusPanel
            title="Overview failed to load"
            description="Page details could not be fetched. Available revenue reports are shown separately."
            tone="error"
            action={
              <button
                type="button"
                className="overview-text-button"
                onClick={() => void overview.refetch()}
              >
                Try again
              </button>
            }
          />
        ) : pages.length === 0 ? (
          <StatusPanel
            title="No pages yet"
            description={
              isOwner
                ? "Connect your first page to start tracking revenue and audience."
                : "Your assigned pages will appear here."
            }
            action={
              isOwner ? (
                <Link
                  className="overview-text-button"
                  to={buildSettingsRoute("pages")}
                >
                  Manage pages
                </Link>
              ) : undefined
            }
          />
        ) : (
          <>
            <QueryNotice query={overview} label="Page details" />
            <div className="overview-table-frame">
              <table className="overview-table">
                <caption className="sr-only">
                  Revenue and audience by model and page. Revenue and new
                  audience use {periodLabel}; subscribers are the current count.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Model / page</th>
                    <th scope="col">
                      Net revenue<span>{periodLabel}</span>
                    </th>
                    <th scope="col">
                      Subscribers<span>Current</span>
                    </th>
                    <th scope="col">
                      New followers<span>Fansly · {periodLabel}</span>
                    </th>
                    <th scope="col">
                      New subscribers<span>{periodLabel}</span>
                    </th>
                  </tr>
                </thead>
                {groups.map((group) => (
                  <ModelGroupRows
                    key={group.modelSlug}
                    group={group}
                    revenueByPageId={revenueByPageId}
                    growthByPageId={growthByPageId}
                    revenueLoading={isWaiting(revenue)}
                    growthLoading={isWaiting(growth)}
                    isOwner={isOwner}
                  />
                ))}
              </table>
            </div>
          </>
        )}
      </section>

      <section className="overview-charts" aria-label="Revenue reports">
        <div className="overview-trend">
          <QueryNotice query={daily} label="Revenue trend" />
          {dailyReady && (daily.data?.series.length ?? 0) > 0 ? (
            <Suspense
              fallback={<ReportPlaceholder title="Revenue trend" loading />}
            >
              <PageActivityChart
                title="Revenue trend"
                selectedPeriod={period}
                selectedPeriodLabel={periodLabel}
                points={(daily.data?.series ?? []).map((point) => ({
                  businessDate: point.businessDate,
                  value: point.netAmountMills,
                }))}
                valueFormatter={formatUsdFromMills}
                yAxisWidth={72}
                color="var(--color-accent)"
              />
            </Suspense>
          ) : (
            <ReportPlaceholder
              title="Revenue trend"
              loading={isWaiting(daily)}
              error={daily.isError}
            />
          )}
        </div>
        <div className="overview-model-report">
          <div className="overview-section-heading">
            <h2>Earnings by model</h2>
            <span>{periodLabel}</span>
          </div>
          <QueryNotice query={byModel} label="Model earnings" />
          {modelsReady && (byModel.data?.models.length ?? 0) > 0 ? (
            <div className="overview-model-list">
              {(byModel.data?.models ?? []).map((model) => (
                <div key={model.modelSlug} className="overview-model-earnings">
                  <div>
                    <h3>{model.modelName}</h3>
                    <p>
                      {model.pageCount}{" "}
                      {model.pageCount === 1 ? "page" : "pages"} ·{" "}
                      {model.transactionCount.toLocaleString()} transactions
                    </p>
                  </div>
                  <div className="overview-model-amount">
                    <TrendSparkline
                      values={model.series.map((point) => point.netAmountMills)}
                    />
                    <strong className="tabular-nums">
                      {formatUsdFromMills(model.totalNetAmountMills)}
                    </strong>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <ReportPlaceholder
              loading={isWaiting(byModel)}
              error={byModel.isError}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function ModelGroupRows({
  group,
  revenueByPageId,
  growthByPageId,
  revenueLoading,
  growthLoading,
  isOwner,
}: {
  group: ModelGroup;
  revenueByPageId: Map<number, number>;
  growthByPageId: Map<number, { newFollowers: number; newSubscribers: number }>;
  revenueLoading: boolean;
  growthLoading: boolean;
  isOwner: boolean;
}) {
  const navigate = useNavigate();
  const groupRevenue = summarizeValues(
    group.pages.map((page) => revenueByPageId.get(page.id) ?? null),
  );
  const groupSubs = summarizeValues(
    group.pages.map((page) => getPageMetricValue(page.subscriberCount)),
  );
  const groupNewFollowers = summarizeValues(
    group.pages
      .filter(supportsFollowerGrowth)
      .map((page) => growthByPageId.get(page.id)?.newFollowers ?? null),
  );
  const groupNewSubs = summarizeValues(
    group.pages.map(
      (page) => growthByPageId.get(page.id)?.newSubscribers ?? null,
    ),
  );

  return (
    <tbody>
      <tr className="overview-model-row">
        <th scope="row">
          <span className="overview-model-name">{group.modelName}</span>
          <span className="overview-page-count">
            {group.pages.length} {group.pages.length === 1 ? "page" : "pages"}
          </span>
        </th>
        <td data-label="Net revenue">
          <MetricValue
            value={groupRevenue.value}
            partial={groupRevenue.partial}
            loading={revenueLoading}
            format={formatUsdFromMills}
          />
        </td>
        <td data-label="Subscribers now">
          <MetricValue value={groupSubs.value} partial={groupSubs.partial} />
        </td>
        <td data-label="New followers · Fansly">
          <MetricValue
            value={groupNewFollowers.value}
            partial={groupNewFollowers.partial}
            loading={growthLoading}
            growth
            format={formatGrowthValue}
          />
        </td>
        <td data-label="New subscribers">
          <MetricValue
            value={groupNewSubs.value}
            partial={groupNewSubs.partial}
            loading={growthLoading}
            growth
            format={formatGrowthValue}
          />
        </td>
      </tr>
      {group.pages.map((page) => {
        const isFansly = supportsFollowerGrowth(page);
        const syncMode = getSyncUxDisplayMode(page.syncUx, "overview_row");
        const exceptionKind = getSyncUxExceptionKind(page.syncUx);
        const tone = getSyncUxTone(page.syncUx.state);
        return (
          <tr
            key={page.id}
            className="overview-page-row"
            onClick={(event) => {
              if (
                !(event.target as HTMLElement).closest("a, button") &&
                !window.getSelection()?.toString()
              )
                navigate(buildPageRoute(page.label));
            }}
          >
            <th scope="row">
              <Link
                to={buildPageRoute(page.label)}
                className="overview-page-link"
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`}
                  role="img"
                  aria-label={page.syncUx.label}
                  title={page.syncUx.headline}
                />
                <span className="overview-page-label">{page.label}</span>
                <PlatformBadge platform={page.platform} />
                <ArrowUpRight
                  size={14}
                  className="overview-page-arrow"
                  aria-hidden="true"
                />
              </Link>
              {syncMode === "exception" &&
                exceptionKind &&
                exceptionKind !== "credentials" && (
                  <div className={`overview-sync-notice ${tone.panel}`}>
                    <span className={tone.text}>
                      {exceptionKind === "off"
                        ? page.syncUx.headline
                        : "Data may be incomplete — updates need attention"}
                    </span>
                    {isOwner && (
                      <Link to={buildSettingsRoute("sync", page.label)}>
                        Check sync settings
                      </Link>
                    )}
                  </div>
                )}
            </th>
            <td data-label="Net revenue">
              <MetricValue
                value={revenueByPageId.get(page.id) ?? null}
                loading={revenueLoading}
                format={formatUsdFromMills}
              />
            </td>
            <td data-label="Subscribers now">
              <MetricValue value={getPageMetricValue(page.subscriberCount)} />
            </td>
            <td data-label="New followers · Fansly">
              {isFansly ? (
                <MetricValue
                  value={growthByPageId.get(page.id)?.newFollowers ?? null}
                  loading={growthLoading}
                  growth
                  format={formatGrowthValue}
                />
              ) : (
                <span
                  className="text-text-muted"
                  title="Follower growth is available for Fansly pages only"
                  aria-label="Follower growth is not available for this platform"
                >
                  —
                </span>
              )}
            </td>
            <td data-label="New subscribers">
              <MetricValue
                value={growthByPageId.get(page.id)?.newSubscribers ?? null}
                loading={growthLoading}
                growth
                format={formatGrowthValue}
              />
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}

function ReportPlaceholder({
  title,
  loading = false,
  error = false,
}: {
  title?: string;
  loading?: boolean;
  error?: boolean;
}) {
  return (
    <div className="overview-report-placeholder" role="status">
      {title && <h2>{title}</h2>}
      <div>
        {loading ? (
          <>
            <span className="overview-value-skeleton" />
            <span className="sr-only">Loading report</span>
          </>
        ) : error ? (
          "Report unavailable. Try again above."
        ) : (
          "No revenue data for this period."
        )}
      </div>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div
      className="overview-table-skeleton"
      role="status"
      aria-label="Loading pages"
    >
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index}>
          <span className="overview-value-skeleton" />
          <span className="overview-value-skeleton" />
        </div>
      ))}
    </div>
  );
}
