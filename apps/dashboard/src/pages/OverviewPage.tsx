import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowUpRight, RefreshCw, ChevronDown, Info } from "lucide-react";
import {
  useAuthMe,
  useOverview,
  useOverviewRevenue,
  useOverviewRevenueDaily,
} from "@/api/queries";
import { PeriodSelector } from "@/components/shared/PeriodSelector";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { getSyncUxTone } from "@/components/shared/SyncUxBadge";
import {
  getSyncUxDisplayMode,
  getSyncUxExceptionKind,
} from "@/components/shared/syncUxDisplay";
import {
  buildPageRoute,
  buildPageSectionRoute,
  buildSettingsRoute,
} from "@/lib/navigation";
import { PLATFORM_DISPLAY_NAME } from "@/lib/platformUrls";
import {
  formatUsdFromMills,
  millsFromInteger,
  millsToNumber,
} from "@agency_hub_core/shared";
import { usePeriodStore } from "@/stores/periodStore";
import type {
  OverviewResponse,
  OverviewRevenueResponse,
  PlatformRevenueWindow,
} from "@agency_hub_core/contracts";

const PageActivityChart = lazy(() =>
  import("@/components/page/PageActivityChart").then((m) => ({
    default: m.PageActivityChart,
  })),
);
type Page = OverviewResponse["pages"][number];
type QueryState = {
  data?: unknown;
  isLoading?: boolean;
  isFetching?: boolean;
  isError?: boolean;
  isPlaceholderData?: boolean;
  refetch?: () => unknown;
};
type EarningsRow = {
  id: number;
  label: string;
  modelSlug: string;
  modelName: string;
  catalog: Page | undefined;
  retired: boolean;
  current: number | null;
  previous: number | null;
};
const PERIOD_LABELS: Record<string, string> = {
  today: "Today",
  "7d": "7 Days",
  "30d": "30 Days",
  all: "All Time",
};
const SOURCE_LABELS: Record<string, string> = {
  subscription: "Subscription payments",
  tip: "Tips",
  message_purchase: "Paid messages",
  post_purchase: "Paid posts",
  stream_tip: "Live stream tips",
  chargeback: "Chargebacks",
  refund: "Refunds",
  other: "Unclassified",
};
const MS_PER_DAY = 86_400_000;

function hasCurrentData(query: QueryState) {
  return query.data != null && !query.isPlaceholderData;
}
function isWaiting(query: QueryState) {
  return !hasCurrentData(query) && Boolean(query.isLoading || query.isFetching);
}
function metricValue(metric: Page["subscriberCount"]) {
  return metric.available && typeof metric.value === "number"
    ? metric.value
    : null;
}
function difference(current: number, previous: number) {
  return millsToNumber(millsFromInteger(current) - millsFromInteger(previous));
}
function signedMoney(value: number) {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatUsdFromMills(Math.abs(value))}`;
}
function dateLabel(value: string) {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
function windowLabel(from: string | null, to: string | null) {
  return from && to
    ? `${dateLabel(from)} – ${dateLabel(new Date(new Date(to).getTime() - 1).toISOString())}`
    : "All captured history";
}

export function describeMixedRevenueWindows(
  windows: PlatformRevenueWindow[] | undefined,
  periodLabel: string,
): string | null {
  if (!windows || windows.length < 2) return null;
  const spans = windows
    .filter((window) => window.from && window.to)
    .map((window) => ({
      platform: PLATFORM_DISPLAY_NAME[window.platform] ?? window.platform,
      days: Math.round(
        (new Date(window.to!).getTime() - new Date(window.from!).getTime()) /
          MS_PER_DAY,
      ),
    }));
  if (spans.length < 2 || new Set(spans.map((span) => span.days)).size < 2)
    return null;
  return `“${periodLabel}” uses ${spans.map((span) => `${span.days} days on ${span.platform}`).join(", ")}. Each page is compared with its own preceding window.`;
}

function MetricValue({
  value,
  loading = false,
  money = false,
}: {
  value: number | null;
  loading?: boolean;
  money?: boolean;
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
  return <>{money ? formatUsdFromMills(value) : value.toLocaleString()}</>;
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

function RevenueChange({
  current,
  previous,
  loading = false,
}: {
  current: number | null;
  previous: number | null;
  loading?: boolean;
}) {
  if (current === null || previous === null)
    return <MetricValue value={null} loading={loading} />;
  const delta = difference(current, previous);
  const pct = previous === 0 ? null : (delta / Math.abs(previous)) * 100;
  return (
    <div className="overview-change">
      <span
        className={delta < 0 ? "text-danger" : delta > 0 ? "text-green" : ""}
      >
        {signedMoney(delta)}
        {pct !== null && (
          <span className="overview-change-pct">
            {Math.abs(pct).toFixed(1)}% {delta < 0 ? "↓" : delta > 0 ? "↑" : ""}
          </span>
        )}
      </span>
      <small>
        from {formatUsdFromMills(previous)}
        {previous === 0 && delta !== 0 ? " · no recorded previous earnings" : ""}
      </small>
    </div>
  );
}

function PageIdentity({
  page,
  label,
  retired = false,
  isOwner = false,
}: {
  page?: Page | undefined;
  label: string;
  retired?: boolean;
  isOwner?: boolean;
}) {
  const tone = page ? getSyncUxTone(page.syncUx.state) : null;
  const exception = page ? getSyncUxExceptionKind(page.syncUx) : null;
  const showException =
    page &&
    getSyncUxDisplayMode(page.syncUx, "overview_row") === "exception" &&
    exception &&
    exception !== "credentials";
  const content = (
    <>
      {page && tone && (
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`}
          role="img"
          aria-label={page.syncUx.label}
          title={page.syncUx.headline}
        />
      )}
      <span className="overview-page-label">{label}</span>
      {page && <PlatformBadge platform={page.platform} />}
      {retired ? (
        <span className="overview-page-count">Retired</span>
      ) : (
        <ArrowUpRight
          size={14}
          className="overview-page-arrow"
          aria-hidden="true"
        />
      )}
    </>
  );
  return (
    <>
      {retired ? (
        <span className="overview-page-link">{content}</span>
      ) : (
        <Link className="overview-page-link" to={buildPageRoute(label)}>
          {content}
        </Link>
      )}
      {showException && (
        <div className={`overview-sync-notice ${tone?.panel}`}>
          <span className={tone?.text}>
            {exception === "off"
              ? page.syncUx.headline
              : "Data may be incomplete — updates need attention"}
          </span>
          {isOwner && (
            <Link to={buildSettingsRoute("sync", label)}>
              Check sync settings
            </Link>
          )}
        </div>
      )}
    </>
  );
}

function earningsRows(
  pages: Page[],
  report?: OverviewRevenueResponse,
): EarningsRow[] {
  const catalog = new Map(pages.map((p) => [p.id, p]));
  const amounts = new Map((report?.pages ?? []).map((p) => [p.pageId, p]));
  const ids = new Set([...catalog.keys(), ...amounts.keys()]);
  return [...ids].map((id) => {
    const page = catalog.get(id);
    const amount = amounts.get(id);
    return {
      id,
      label: page?.label ?? amount?.pageLabel ?? String(id),
      modelSlug: page?.modelSlug ?? amount?.modelSlug ?? "",
      modelName: page?.modelName ?? amount?.modelName ?? "",
      catalog: page,
      retired: amount?.status === "deleted",
      current: amount?.netEarningsMills ?? null,
      previous: amount?.previousNetEarningsMills ?? null,
    };
  });
}

function RevenueSources({
  report,
  loading,
}: {
  report?: OverviewRevenueResponse | undefined;
  loading: boolean;
}) {
  const breakdown = report?.breakdown;
  const sales = breakdown
    ?.filter((r) => r.bucket === "revenue")
    .sort((a, b) => b.netAmountMills - a.netAmountMills);
  const adjustments = breakdown?.filter(
    (r) =>
      (r.bucket === "adjustment" || r.bucket === "unclassified") &&
      r.netAmountMills !== 0,
  );
  return (
    <section
      className="overview-sources"
      aria-labelledby="overview-sources-heading"
    >
      <div className="overview-section-heading">
        <h2 id="overview-sources-heading">What earned money</h2>
      </div>
      <p className="overview-source-intro">
        Net amounts from recorded transactions
      </p>
      {loading ? (
        <ReportPlaceholder loading />
      ) : !breakdown ? (
        <p className="overview-empty">Revenue breakdown unavailable.</p>
      ) : (
        <>
          {(sales?.length ?? 0) === 0 && (
            <p className="overview-empty">No sales recorded for this period.</p>
          )}
          <div className="overview-source-list">
            {sales?.map((source) => {
              const share =
                report.revenueMills > 0 && source.netAmountMills >= 0
                  ? Math.min(
                      100,
                      (source.netAmountMills / report.revenueMills) * 100,
                    )
                  : null;
              return (
                <div key={source.canonicalType} className="overview-source">
                  <div>
                    <span>
                      {SOURCE_LABELS[source.canonicalType] ??
                        source.canonicalType}
                    </span>
                    <strong>{formatUsdFromMills(source.netAmountMills)}</strong>
                  </div>
                  {share !== null && (
                    <div className="overview-source-bar" aria-hidden="true">
                      <span style={{ width: `${share}%` }} />
                    </div>
                  )}
                  {share !== null && (
                    <small>{share.toFixed(1)}% of sales</small>
                  )}
                </div>
              );
            })}
          </div>
          {(adjustments?.length ?? 0) > 0 && (
            <div className="overview-adjustments">
              {adjustments?.map((item) => (
                <div key={item.canonicalType}>
                  <span>
                    {SOURCE_LABELS[item.canonicalType] ?? item.canonicalType}
                  </span>
                  <strong>{signedMoney(item.netAmountMills)}</strong>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <p className="overview-source-note">
        Subscription revenue comes from purchases and renewals. Free access does
        not generate subscription revenue.
      </p>
    </section>
  );
}

function AudienceSection({
  pages,
  isOwner,
}: {
  pages: Page[];
  isOwner: boolean;
}) {
  if (!pages.length) return null;
  return (
    <details className="overview-audience">
      <summary>
        <span>
          <strong>Audience by page</strong>
          <small>Followers & access subscriptions · latest stored counts</small>
        </span>
        <ChevronDown size={18} aria-hidden="true" />
      </summary>
      <div className="overview-audience-content">
        <p className="overview-audience-explanation">
          Subscriptions measure access to a page, including free access and
          trials. They do not tell you how many fans paid. Counts below are
          independent of the selected revenue period.
        </p>
        <div className="overview-table-frame">
          <table className="overview-table">
            <caption className="sr-only">
              Audience counts by page, without an agency total
            </caption>
            <thead>
              <tr>
                <th scope="col">Page</th>
                <th scope="col">
                  Followers<span>Fansly only</span>
                </th>
                <th scope="col">
                  Access subscriptions<span>Free and paid together</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {pages.map((page) => (
                <tr key={page.id} className="overview-page-row">
                  <th scope="row">
                    <PageIdentity
                      page={page}
                      label={page.label}
                      isOwner={isOwner}
                    />
                  </th>
                  <td data-label="Followers">
                    {page.platform === "fansly" ? (
                      <Link to={buildPageSectionRoute(page.label, "followers")}>
                        <MetricValue value={metricValue(page.followerCount)} />
                      </Link>
                    ) : (
                      <span
                        aria-label="Followers are not reported for OnlyFans"
                        className="text-text-muted"
                      >
                        —
                      </span>
                    )}
                  </td>
                  <td data-label="Access subscriptions">
                    <Link to={buildPageSectionRoute(page.label, "subscribers")}>
                      <MetricValue value={metricValue(page.subscriberCount)} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="overview-definitions">
          <div>
            <dt>Followers</dt>
            <dd>
              Fansly accounts following the page. Subscribers also count as
              followers, so the two numbers overlap.
            </dd>
          </div>
          <div>
            <dt>Access subscriptions</dt>
            <dd>
              Fansly’s reported subscription count; on OnlyFans, subscription
              records currently marked active in Hub. Neither is a count of
              paying customers.
            </dd>
          </div>
          <div>
            <dt>Why there is no total or conversion rate</dt>
            <dd>
              The same fan can appear on several pages. Paid, free and
              unknown-price subscriptions are not reliably separated. These
              counts cannot establish agency-wide unique fans or a sales
              conversion rate.
            </dd>
          </div>
        </dl>
      </div>
    </details>
  );
}

export function OverviewPage() {
  const { data: auth } = useAuthMe();
  const { period } = usePeriodStore();
  const overview = useOverview();
  const revenue = useOverviewRevenue(period);
  const daily = useOverviewRevenueDaily(period);
  const [sort, setSort] = useState("earnings");
  const isOwner = auth?.user.role === "owner";
  const periodLabel = PERIOD_LABELS[period] ?? "30 Days";
  const overviewReady = hasCurrentData(overview);
  const revenueReady = hasCurrentData(revenue);
  const dailyReady = hasCurrentData(daily);
  const pages = overviewReady ? (overview.data?.pages ?? []) : [];
  const report = revenueReady ? revenue.data : undefined;
  const rows = earningsRows(pages, report);
  const hasComparisons =
    period !== "all" &&
    rows.some((row) => row.current !== null && row.previous !== null);
  const activeSort = hasComparisons ? sort : "earnings";
  const modelTotals = new Map(
    (report?.models ?? []).map((model) => [model.modelSlug, model]),
  );
  const groups = [...new Set(rows.map((row) => row.modelSlug))].map((slug) => ({
    slug,
    name: rows.find((row) => row.modelSlug === slug)?.modelName ?? slug,
    pages: rows.filter((row) => row.modelSlug === slug),
    totals: modelTotals.get(slug),
  }));
  const order = (
    a: { current: number | null; previous: number | null },
    b: { current: number | null; previous: number | null },
  ) =>
    activeSort === "decrease"
      ? (a.current !== null && a.previous !== null
          ? difference(a.current, a.previous)
          : Infinity) -
        (b.current !== null && b.previous !== null
          ? difference(b.current, b.previous)
          : Infinity)
      : (b.current ?? -Infinity) - (a.current ?? -Infinity);
  groups.sort((a, b) =>
    order(
      {
        current: a.totals?.netEarningsMills ?? null,
        previous: a.totals?.previousNetEarningsMills ?? null,
      },
      {
        current: b.totals?.netEarningsMills ?? null,
        previous: b.totals?.previousNetEarningsMills ?? null,
      },
    ),
  );
  groups.forEach((group) => group.pages.sort(order));
  const largestDecrease = rows
    .filter(
      (r) =>
        r.current !== null && r.previous !== null && r.current < r.previous,
    )
    .sort(
      (a, b) =>
        difference(a.current!, a.previous!) -
        difference(b.current!, b.previous!),
    )[0];
  const queries = [overview, revenue, daily];
  const refreshing = queries.some((q) => q.isFetching);
  const mixedNote = describeMixedRevenueWindows(
    report?.platformWindows,
    periodLabel,
  );
  const retired = rows.filter(
    (row) => row.retired && (row.current !== 0 || row.previous !== 0),
  );
  return (
    <div className="overview-page">
      <header className="overview-header">
        <div>
          <h1>Agency overview</h1>
          <p>Earnings, changes and the pages behind them</p>
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
      <QueryNotice query={revenue} label="Revenue" />
      <section className="overview-earnings" aria-label="Agency earnings">
        <div className="overview-earnings-main">
          <div className="overview-earnings-head">
            <div>
              <p className="overview-eyebrow">Net earnings · {periodLabel}</p>
              <div className="overview-net-value">
                <MetricValue
                  value={report?.netEarningsMills ?? null}
                  loading={isWaiting(revenue)}
                  money
                />
              </div>
              <p className="overview-net-caption">
                After platform fees · includes pending transactions
              </p>
            </div>
            {period !== "all" && (
              <div className="overview-period-change">
                <span>vs previous period</span>
                <RevenueChange
                  current={report?.netEarningsMills ?? null}
                  previous={report?.comparison?.netEarningsMills ?? null}
                  loading={isWaiting(revenue)}
                />
              </div>
            )}
          </div>
          <div className="overview-trend">
            <QueryNotice query={daily} label="Revenue trend" />
            {dailyReady && (daily.data?.series.length ?? 0) > 0 ? (
              <Suspense
                fallback={<ReportPlaceholder title="Revenue trend" loading />}
              >
                <PageActivityChart
                  title="Daily net earnings"
                  selectedPeriod={period}
                  selectedPeriodLabel={periodLabel}
                  points={(daily.data?.series ?? []).map((point) => ({
                    businessDate: point.businessDate,
                    value: point.netAmountMills,
                  }))}
                  valueFormatter={formatUsdFromMills}
                  yAxisWidth={66}
                  height={220}
                  showYAxisLabel={false}
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
        </div>
        <RevenueSources report={report} loading={isWaiting(revenue)} />
      </section>
      <div className="overview-period-context">
        {mixedNote && <p>{mixedNote}</p>}
        {period !== "all" && (
          <p>
            Today is still in progress; the previous period includes full days.
            Dates are UTC.
          </p>
        )}
        <details>
          <summary>
            <Info size={13} aria-hidden="true" /> Dates and calculation
          </summary>
          <div className="overview-period-details">
            {report?.platformWindows?.map((window) => (
              <p key={window.platform}>
                <strong>{PLATFORM_DISPLAY_NAME[window.platform]}</strong>{" "}
                {windowLabel(window.from, window.to)}
                {window.comparisonFrom && (
                  <>
                    {" "}
                    · previous{" "}
                    {windowLabel(window.comparisonFrom, window.comparisonTo)}
                  </>
                )}
              </p>
            ))}
            <p>
              Recorded sales, refunds, chargebacks and unclassified amounts
              after platform fees. Payout reversals are excluded. This is not
              the payout balance or agency profit.
            </p>
          </div>
        </details>
      </div>
      <section
        className="overview-pages"
        aria-labelledby="overview-pages-heading"
      >
        <div className="overview-section-heading">
          <div>
            <h2 id="overview-pages-heading">Where earnings changed</h2>
            <p>Models and pages · {periodLabel}</p>
          </div>
          <label className="overview-sort">
            Sort{" "}
            <select
              value={activeSort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="earnings">Highest earnings</option>
              <option value="decrease" disabled={!hasComparisons}>
                Biggest decrease
              </option>
            </select>
          </label>
        </div>
        {largestDecrease && (
          <div className="overview-insight">
            <span>Largest decrease</span>
            {largestDecrease.retired ? (
              <strong>{largestDecrease.label} · retired</strong>
            ) : (
              <Link to={buildPageRoute(largestDecrease.label)}>
                {largestDecrease.label}
                <ArrowUpRight size={13} aria-hidden="true" />
              </Link>
            )}
            <strong>
              {signedMoney(
                difference(largestDecrease.current!, largestDecrease.previous!),
              )}
            </strong>
            <span>vs its previous period</span>
          </div>
        )}
        <QueryNotice query={overview} label="Page details" />
        {!overviewReady && !isWaiting(overview) && (
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
        )}
        {isWaiting(overview) && !rows.length ? (
          <ReportPlaceholder title="Loading pages" loading />
        ) : !rows.length && overviewReady ? (
          <StatusPanel
            title="No pages yet"
            description={
              isOwner
                ? "Connect your first page to start tracking earnings."
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
          rows.length > 0 && (
            <div className="overview-table-frame">
              <table className="overview-table">
                <caption className="sr-only">
                  Net earnings by model and page, compared with each platform’s
                  preceding period
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Model / page</th>
                    <th scope="col">
                      Net earnings<span>{periodLabel}</span>
                    </th>
                    <th scope="col">
                      Change<span>vs previous period</span>
                    </th>
                  </tr>
                </thead>
                {groups.map((group) => (
                  <tbody key={group.slug}>
                    <tr className="overview-model-row">
                      <th scope="row">
                        <span className="overview-model-name">
                          {group.name}
                        </span>
                        <span className="overview-page-count">
                          {group.pages.length}{" "}
                          {group.pages.length === 1 ? "page" : "pages"}
                        </span>
                      </th>
                      <td data-label="Net earnings">
                        <MetricValue
                          value={group.totals?.netEarningsMills ?? null}
                          loading={isWaiting(revenue)}
                          money
                        />
                      </td>
                      <td data-label="Change">
                        <RevenueChange
                          current={group.totals?.netEarningsMills ?? null}
                          previous={
                            group.totals?.previousNetEarningsMills ?? null
                          }
                          loading={isWaiting(revenue)}
                        />
                      </td>
                    </tr>
                    {group.pages.map((row) => (
                      <tr key={row.id} className="overview-page-row">
                        <th scope="row">
                          <PageIdentity
                            page={row.catalog}
                            label={row.label}
                            retired={row.retired}
                            isOwner={isOwner}
                          />
                        </th>
                        <td data-label="Net earnings">
                          <MetricValue
                            value={row.current}
                            loading={isWaiting(revenue)}
                            money
                          />
                        </td>
                        <td data-label="Change">
                          <RevenueChange
                            current={row.current}
                            previous={row.previous}
                            loading={isWaiting(revenue)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          )
        )}
        {retired.length > 0 && (
          <p className="overview-footnote">
            Totals include {retired.length} retired{" "}
            {retired.length === 1 ? "page" : "pages"} (
            {retired.map((r) => r.label).join(", ")}). History is kept after
            deletion.
          </p>
        )}
      </section>
      <AudienceSection pages={pages} isOwner={isOwner} />
    </div>
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
