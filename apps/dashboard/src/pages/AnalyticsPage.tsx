import { useMemo } from "react";
import { useSearchParams } from "react-router";

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
  LikersNote,
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
import { StatusPanel } from "@/components/shared/StatusPanel";
import { PageHeader } from "@/components/ui/PageHeader";
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
 * watch; comments feeding the likers note; coverage feeding every badge) is a
 * place where a pending request could have been rendered as a fact.
 *
 * LAYOUT. One grid of cards: two columns from 1280px, one below. The wide
 * panels (traffic, content performance, coverage) span both columns; the rest
 * pair up — FYP with tags, top media with comments, revenue with its months.
 * How each panel counts sits behind its "?"; coverage is collapsed at the end.
 */
const RANGE_OPTIONS: readonly { value: AnalyticsRange; label: string }[] = [
  { value: "7d", label: "7 дней" },
  { value: "30d", label: "30 дней" },
  { value: "90d", label: "90 дней" },
];

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

  const headerActions = fanslyPages.length > 0 ? (
    <>
      <label className="flex items-center">
        <span className="sr-only">Страница</span>
        <select
          value={activeLabel}
          onChange={(event) => setParam("page", event.target.value)}
          className="select w-auto min-w-[160px] max-w-[240px]"
        >
          {fanslyPages.map((page) => (
            <option key={page.id} value={page.label}>{page.label}</option>
          ))}
        </select>
      </label>
      <div className="segmented" role="group" aria-label="Период">
        {RANGE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className="segment"
            aria-pressed={range === option.value}
            onClick={() => setParam("range", option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </>
  ) : null;

  return (
    <div>
      <PageHeader
        title="Аналитика"
        description="Трафик, контент, теги и доход страницы Fansly."
        actions={headerActions}
      />
      {pagesQuery.isError && pagesQuery.data ? (
        <div role="alert" className="notice notice-warning mb-4 items-center">
          <span className="min-w-0 flex-1">
            Не удалось обновить список страниц. Показан прежний список.
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={pagesQuery.isFetching}
            onClick={() => void pagesQuery.refetch()}
          >
            Повторить
          </button>
        </div>
      ) : null}

      {pagesQuery.isPending && !pagesQuery.data ? (
        <StatusPanel title="Загружаем страницы…" />
      ) : pagesQuery.isError && !pagesQuery.data ? (
        <div role="alert">
          <StatusPanel
            tone="error"
            title="Не удалось загрузить список страниц"
            description="Это ошибка загрузки, а не отсутствие страниц: без списка анализировать нечего."
            action={(
              <button type="button" className="btn btn-sm" onClick={() => void pagesQuery.refetch()}>
                Повторить
              </button>
            )}
          />
        </div>
      ) : fanslyPages.length === 0 ? (
        <StatusPanel
          title="Нет страниц Fansly для аналитики"
          description="Аналитика строится только по страницам Fansly. Когда в Hub появится страница Fansly, её данные будут здесь."
        />
      ) : (
      <div className="space-y-4">
        {requestedPage && requestedPage !== activeLabel ? (
          <p role="status" className="notice notice-warning">
            Страница «{requestedPage}» недоступна в этом списке. Показана «{activeLabel}».
          </p>
        ) : null}
        {/*
          * The compact banner: one line naming the SURFACES behind the failed
          * requests, and one retry that fires each failed query exactly once —
          * `media` feeds two panels and `comments` feeds two surfaces, and a
          * per-consumer retry would double the load on the box that was
          * already too slow to answer. Panels that failed say so themselves;
          * this is the summary, not the report.
          */}
        {failedSurfaces.length > 0 ? (
          <div role="alert" className="notice notice-warning flex-wrap items-center">
            <p className="min-w-0 flex-1">
              <span className="font-medium">Часть данных не загрузилась.</span>{" "}
              Не показано: {failedSurfaces.join(", ")}.
            </p>
            <button
              type="button"
              onClick={() => retryFailedAnalytics(queryEntries)}
              className="btn btn-sm"
            >
              Повторить
            </button>
          </div>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-2">
          <TrafficBySourcePanel
            state={profileTrafficState}
            coverage={coverageRows}
            selectedWindow={window}
            // A8: the Suggestions-denominator note is a property of Fansly's
            // 30-DAY widget. On any other range there is nothing to reconcile,
            // and a permanent note is a note nobody reads.
            showDenominatorNote={range === "30d"}
            onRetry={() => void profileTraffic.refetch()}
          />
          <FypSharePanel
            state={mediaTrafficState}
            coverage={coverageRows}
            selectedWindow={window}
            onRetry={() => void mediaTraffic.refetch()}
          />
          <TopTagsPanel
            state={tagsState}
            coverage={coverageRows}
            selectedWindow={window}
            onRetry={() => void tags.refetch()}
          />
          <TopMediaPanel
            state={mediaState}
            coverage={coverageRows}
            selectedWindow={window}
            onRetry={() => void media.refetch()}
          />
          <CommentsPanel
            state={commentsState}
            coverage={coverageRows}
            selectedWindow={window}
            onRetry={() => void comments.refetch()}
          />
          <ContentPerformancePanel
            state={mediaState}
            coverage={coverageRows}
            accountWatch={accountWatch}
            selectedWindow={window}
            onRetry={() => void media.refetch()}
          />
          <RevenueMixPanel
            state={revenueState}
            coverage={coverageRows}
            selectedWindow={window}
            onRetry={() => void revenue.refetch()}
          />
          <CoveragePanel
            state={coverageState}
            pageId={fanslyPages.find((page) => page.label === activeLabel)?.id ?? null}
            onRetry={() => void coverage.refetch()}
            likers={(
              <LikersNote
                state={commentsState}
                coverage={coverageRows}
                onRetry={() => void comments.refetch()}
              />
            )}
          />
        </div>
      </div>
      )}
    </div>
  );
}

export type { AnalyticsRange };
