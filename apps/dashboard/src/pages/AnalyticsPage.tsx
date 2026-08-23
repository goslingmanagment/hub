import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { BarChart3 } from "lucide-react";

import {
  useContentComments,
  useMoneyRevenueMix,
  useStatsCoverage,
  useStatsMedia,
  useStatsTags,
  useStatsTraffic,
} from "@/api/insights";
import { usePages } from "@/api/pages";
import {
  CommentsPanel,
  ContentPerformancePanel,
  TopMediaPanel,
  TopTagsPanel,
} from "@/components/analytics/CatalogPanels";
import { CoveragePanel } from "@/components/analytics/CoveragePanel";
import { RevenueMixPanel } from "@/components/analytics/MoneyPanel";
import {
  FypSharePanel,
  TrafficBySourcePanel,
  accountWatchAverage,
} from "@/components/analytics/TrafficPanels";
import { analyticsRange, resolveAnalyticsRange, type AnalyticsRange } from "@/lib/navigation";

import { analyticsQueryState } from "./analytics-query-state.js";

/**
 * WP-S1 — the Analytics page: everything F0–F7 and F4 captured, served.
 *
 * FANSLY ONLY (A28-2). The page selector lists Fansly pages because no
 * OnlyFans lane writes any of the projections behind these panels, and a page
 * selector that offered them would be offering eight permanently empty charts.
 *
 * THE RULE THE WHOLE PAGE IS BUILT AROUND: partial data is never visually
 * indistinguishable from complete data. Every panel carries its own coverage
 * verdict in its header, and the honesty panel at the bottom is what makes an
 * empty chart readable — an empty chart over an exhausted lane and an empty
 * chart over a lane whose flag is off look identical without it, and mean
 * opposite things.
 *
 * The page catalog comes from `usePages()` and NOT from the shell's
 * `useOverview()`: this page fires nothing until it knows which page is
 * active, so hanging the catalog off the dashboard-wide overview aggregate
 * meant seven analytics requests waited seconds on a response none of them
 * needed. The same honesty rule applies to the catalog itself — "no Fansly
 * pages" is a claim about a SUCCEEDED query, never about a pending one.
 */
export function AnalyticsPage() {
  const pagesQuery = usePages();
  const [searchParams, setSearchParams] = useSearchParams();
  const fanslyPages = useMemo(
    () => (pagesQuery.data ?? []).filter((page) => page.platform === "fansly"),
    [pagesQuery.data],
  );

  const requestedPage = searchParams.get("page") ?? "";
  const activeLabel = fanslyPages.some((page) => page.label === requestedPage)
    ? requestedPage
    : fanslyPages[0]?.label ?? "";
  const range = resolveAnalyticsRange(searchParams.get("range"));
  const window = useMemo(() => analyticsRange(range), [range]);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    next.set(key, value);
    setSearchParams(next);
  }

  const enabled = activeLabel.length > 0;
  const profileTraffic = useStatsTraffic(activeLabel, window, "account_profile", { enabled });
  const mediaTraffic = useStatsTraffic(activeLabel, window, "account_media", { enabled });
  const media = useStatsMedia(activeLabel, window, { enabled });
  const tags = useStatsTags(activeLabel, window, { enabled });
  const coverage = useStatsCoverage(activeLabel, { enabled });
  const comments = useContentComments(activeLabel, window, { enabled });
  const revenue = useMoneyRevenueMix(activeLabel, window, { enabled });

  const analyticsQueries = [
    { label: "profile traffic", query: profileTraffic },
    { label: "media traffic", query: mediaTraffic },
    { label: "media", query: media },
    { label: "tags", query: tags },
    { label: "coverage", query: coverage },
    { label: "comments", query: comments },
    { label: "revenue", query: revenue },
  ] as const;
  const queryState = analyticsQueryState(analyticsQueries.map(({ label, query }) => ({
    label,
    isError: query.isError,
    isSuccess: query.isSuccess,
  })));

  const coverageRows = coverage.data?.planes;
  // The ONLY watch figure on this page, and it comes from account-level
  // datapoints — the only rows that carry the components. [E5] keeps it off
  // every per-media surface.
  const watchPercent = accountWatchAverage(mediaTraffic.data?.rows);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
            <BarChart3 size={18} className="text-accent" />
            Analytics
          </h1>
          <p className="text-[13px] text-text-secondary">
            Traffic, content, tags and money — with what was captured, and what was not.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {fanslyPages.length > 0 ? (
            <label className="flex items-center gap-2 text-[12px] text-text-secondary">
              Page
              <select
                value={activeLabel}
                onChange={(event) => setParam("page", event.target.value)}
                className="rounded-md border border-border bg-card px-2 py-1.5 text-[13px] font-medium text-text-primary"
              >
                {fanslyPages.map((page) => (
                  <option key={page.id} value={page.label}>{page.label}</option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="flex gap-1 rounded-lg border border-border p-0.5">
            {(["7d", "30d", "90d"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setParam("range", option)}
                className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                  range === option
                    ? "bg-hover text-text-primary"
                    : "text-text-muted hover:text-text-secondary"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      </header>

      {pagesQuery.isPending ? (
        <div className="rounded-xl border border-border bg-card px-4 py-12 text-center text-[13px] text-text-muted">
          Loading pages…
        </div>
      ) : pagesQuery.isError ? (
        <div
          role="alert"
          className="rounded-xl border border-warning-dark/60 bg-card px-5 py-8 text-center"
        >
          <p className="text-[13px] font-medium text-text-primary">
            The page list could not be loaded.
          </p>
          <p className="mt-1 text-[12px] text-text-muted">
            Without it there is nothing to analyse — this is a failed request, not an empty agency.
          </p>
          <button
            type="button"
            onClick={() => void pagesQuery.refetch()}
            className="mt-3 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:text-text-primary"
          >
            Retry
          </button>
        </div>
      ) : fanslyPages.length === 0 ? (
        <div className="rounded-xl border border-border bg-card px-4 py-12 text-center text-[13px] text-text-muted">
          No Fansly pages to analyse.
        </div>
      ) : queryState.state === "error" ? (
        <div
          role="alert"
          className="rounded-xl border border-warning-dark/60 bg-card px-5 py-8 text-center"
        >
          <p className="text-[13px] font-medium text-text-primary">
            Analytics could not be loaded.
          </p>
          <p className="mt-1 text-[12px] text-text-muted">
            Failed: {queryState.failedLabels.join(", ")}. No empty chart is shown for a failed request.
          </p>
          <button
            type="button"
            onClick={() => {
              for (const { query } of analyticsQueries) {
                if (query.isError) void query.refetch();
              }
            }}
            className="mt-3 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:text-text-primary"
          >
            Retry failed requests
          </button>
        </div>
      ) : queryState.state === "loading" ? (
        <div className="rounded-xl border border-border bg-card px-4 py-12 text-center text-[13px] text-text-muted">
          Loading analytics and capture coverage…
        </div>
      ) : (
      <div className="space-y-4">
        <TrafficBySourcePanel
          data={profileTraffic.data}
          coverage={coverageRows}
          isLoading={profileTraffic.isLoading}
          selectedWindow={window}
          // A8: the Suggestions-denominator warning is a property of Fansly's
          // 30-DAY widget. On any other range there is nothing to reconcile,
          // and a permanent footnote is a footnote nobody reads.
          showDenominatorNote={range === "30d"}
        />
        <FypSharePanel
          data={mediaTraffic.data}
          coverage={coverageRows}
          isLoading={mediaTraffic.isLoading}
          selectedWindow={window}
        />
        <TopMediaPanel
          data={media.data}
          coverage={coverageRows}
          isLoading={media.isLoading}
          selectedWindow={window}
        />
        <TopTagsPanel
          data={tags.data}
          coverage={coverageRows}
          isLoading={tags.isLoading}
          selectedWindow={window}
        />
        <RevenueMixPanel
          data={revenue.data}
          coverage={coverageRows}
          isLoading={revenue.isLoading}
          selectedWindow={window}
        />
        <ContentPerformancePanel
          data={media.data}
          coverage={coverageRows}
          isLoading={media.isLoading}
          accountWatchPercent={watchPercent}
          selectedWindow={window}
        />
        <CommentsPanel
          data={comments.data}
          coverage={coverageRows}
          isLoading={comments.isLoading}
          selectedWindow={window}
        />
        <CoveragePanel data={coverage.data} isLoading={coverage.isLoading} />
      </div>
      )}
    </div>
  );
}

export type { AnalyticsRange };
