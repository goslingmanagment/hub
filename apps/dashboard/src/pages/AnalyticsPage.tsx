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

import {
  analyticsFailureBanner,
  analyticsPanelState,
  mapPanelState,
  retryFailedAnalytics,
  type AnalyticsQueryEntry,
} from "./analytics-query-state.js";

/**
 * WP-S1 — the Analytics page: everything F0–F7 and F4 captured, served.
 *
 * FANSLY ONLY (A28-2). The page selector lists Fansly pages because nothing
 * writes any of the projections behind these panels for an OnlyFans page, and
 * a selector that offered them would be offering eight permanently empty charts.
 *
 * THE RULE THE WHOLE PAGE IS BUILT AROUND: partial data is never visually
 * indistinguishable from complete data. Every panel carries its own coverage
 * verdict in its header, and the honesty panel at the bottom is what makes an
 * empty chart readable — an empty chart over a walk that reached its end and
 * an empty chart over a stream nobody reads look identical without it, and
 * mean opposite things.
 *
 * The page catalog comes from `usePages()` and NOT from the shell's
 * `useOverview()`: this page fires nothing until it knows which page is
 * active, so hanging the catalog off the dashboard-wide overview aggregate
 * meant seven analytics requests waited seconds on a response none of them
 * needed. The same honesty rule applies to the catalog itself — "no Fansly
 * pages" is a claim about a SUCCEEDED query, never about a pending one.
 *
 * PER PANEL, NOT PER PAGE (PR 4). The seven requests used to share one gate:
 * the slowest decided when anything rendered and any one failure blanked the
 * lot. Each panel now waits only on the queries it actually reads — the map is
 * in `analytics-query-state.ts`, written down because it is not one-to-one and
 * every hidden edge in it (media traffic feeding Content Performance's average
 * watch; comments feeding the Likers card; coverage feeding every badge) is a
 * place where a pending request could have been rendered as a fact.
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

  const profileTrafficState = analyticsPanelState(profileTraffic);
  const mediaTrafficState = analyticsPanelState(mediaTraffic);
  const mediaState = analyticsPanelState(media);
  const tagsState = analyticsPanelState(tags);
  const coverageState = analyticsPanelState(coverage);
  const commentsState = analyticsPanelState(comments);
  const revenueState = analyticsPanelState(revenue);

  // The badges read the planes; the honesty panel reads the whole response.
  const coverageRows = mapPanelState(coverageState, (data) => data.planes);
  // The ONLY watch figure on this page, and it comes from account-level
  // datapoints — the only rows that carry the components ([E5] keeps it off
  // every per-media surface). It travels with the STATE of the request that
  // carries it, so "not served" stays a claim about Fansly's payload.
  const accountWatch = mapPanelState(mediaTrafficState, (data) =>
    accountWatchAverage(data.rows));

  const queryEntries: readonly AnalyticsQueryEntry[] = [
    { id: "profileTraffic", failed: profileTrafficState.status === "error", refetch: () => void profileTraffic.refetch() },
    { id: "mediaTraffic", failed: mediaTrafficState.status === "error", refetch: () => void mediaTraffic.refetch() },
    { id: "media", failed: mediaState.status === "error", refetch: () => void media.refetch() },
    { id: "tags", failed: tagsState.status === "error", refetch: () => void tags.refetch() },
    { id: "coverage", failed: coverageState.status === "error", refetch: () => void coverage.refetch() },
    { id: "comments", failed: commentsState.status === "error", refetch: () => void comments.refetch() },
    { id: "revenue", failed: revenueState.status === "error", refetch: () => void revenue.refetch() },
  ];
  const failedSurfaces = analyticsFailureBanner(queryEntries);

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
                aria-pressed={range === option}
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
      {pagesQuery.isError && pagesQuery.data && <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning-dark/60 bg-card px-4 py-3 text-[12px] text-text-secondary"><p>The page list could not be refreshed. The previous list is still shown.</p><button type="button" disabled={pagesQuery.isFetching} onClick={() => void pagesQuery.refetch()} className="rounded-md border border-border px-3 py-1.5">Retry page list</button></div>}

      {pagesQuery.isPending && !pagesQuery.data ? (
        <div className="rounded-xl border border-border bg-card px-4 py-12 text-center text-[13px] text-text-muted">
          Loading pages…
        </div>
      ) : pagesQuery.isError && !pagesQuery.data ? (
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
      ) : (
      <div className="space-y-4">
        {requestedPage && requestedPage !== activeLabel && <p role="status" className="text-[12px] text-warning-dark">Page “{requestedPage}” is unavailable in this list. Showing {activeLabel}.</p>}
        {/*
          * The compact banner: one line naming the SURFACES behind the failed
          * requests, and one retry that fires each failed query exactly once —
          * `media` feeds two panels and `comments` feeds two cards, and a
          * per-consumer retry would double the load on the box that was
          * already too slow to answer. Panels that failed say so themselves;
          * this is the summary, not the report.
          */}
        {failedSurfaces.length > 0 ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning-dark/60 bg-card px-4 py-3"
          >
            <p className="text-[12px] text-text-secondary">
              <span className="font-medium text-text-primary">Some requests failed.</span>{" "}
              Not shown: {failedSurfaces.join(", ")}. Other panels show their own loading and coverage state.
            </p>
            <button
              type="button"
              onClick={() => retryFailedAnalytics(queryEntries)}
              className="rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:text-text-primary"
            >
              Retry failed requests
            </button>
          </div>
        ) : null}

        <TrafficBySourcePanel
          state={profileTrafficState}
          coverage={coverageRows}
          selectedWindow={window}
          // A8: the Suggestions-denominator warning is a property of Fansly's
          // 30-DAY widget. On any other range there is nothing to reconcile,
          // and a permanent footnote is a footnote nobody reads.
          showDenominatorNote={range === "30d"}
          onRetry={() => void profileTraffic.refetch()}
        />
        <FypSharePanel
          state={mediaTrafficState}
          coverage={coverageRows}
          selectedWindow={window}
          onRetry={() => void mediaTraffic.refetch()}
        />
        <TopMediaPanel
          state={mediaState}
          coverage={coverageRows}
          selectedWindow={window}
          onRetry={() => void media.refetch()}
        />
        <TopTagsPanel
          state={tagsState}
          coverage={coverageRows}
          selectedWindow={window}
          onRetry={() => void tags.refetch()}
        />
        <RevenueMixPanel
          state={revenueState}
          coverage={coverageRows}
          selectedWindow={window}
          onRetry={() => void revenue.refetch()}
        />
        <ContentPerformancePanel
          state={mediaState}
          coverage={coverageRows}
          accountWatch={accountWatch}
          selectedWindow={window}
          onRetry={() => void media.refetch()}
        />
        <CommentsPanel
          state={commentsState}
          coverage={coverageRows}
          selectedWindow={window}
          onRetry={() => void comments.refetch()}
        />
        <CoveragePanel
          state={coverageState}
          pageId={fanslyPages.find((page) => page.label === activeLabel)?.id ?? null}
          onRetry={() => void coverage.refetch()}
        />
      </div>
      )}
    </div>
  );
}

export type { AnalyticsRange };
