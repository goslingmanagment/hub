import { useMemo } from "react";

import type {
  ContentCommentsResponse,
  StatsMediaResponse,
  StatsTagsResponse,
} from "@agency_hub_core/contracts";
import { ANALYTICS_COVERAGE_PLANES } from "@agency_hub_core/shared";

import { TrendSparkline } from "@/components/shared/TrendSparkline";
import { formatMills } from "@/lib/format";

import { AnalyticsEmpty, AnalyticsPanel } from "./AnalyticsPanel.js";
import {
  coverageVerdict,
  type AnalyticsCoverageWindow,
  type CoverageRow,
} from "./coverage.js";

/** `—` rather than `0`: an unserved metric is not a measurement of nothing. */
function metric(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

function money(value: number | null): string {
  return value === null ? "—" : formatMills(value);
}

/**
 * Panel 3 — top media, each with the sparkline of its own buckets.
 *
 * The ranking rows and the series come from the same response but are DIFFERENT
 * facts: `stats_top_media` is what the platform ranked over its window, and the
 * sparkline is what our own per-media buckets hold. Missing series are labelled
 * by what the response can actually prove; absence alone never means unpolled.
 */
export function TopMediaPanel({
  data,
  coverage,
  isLoading,
  selectedWindow,
}: {
  data: StatsMediaResponse | undefined;
  coverage: readonly CoverageRow[] | undefined;
  isLoading: boolean;
  selectedWindow: AnalyticsCoverageWindow;
}) {
  const verdict = coverageVerdict(coverage, ANALYTICS_COVERAGE_PLANES.topMedia, selectedWindow);

  const rows = useMemo(() => {
    const seriesByMedia = new Map<string, number[]>();
    const mediaWithHeads = new Set<string>();
    for (const media of data?.media ?? []) {
      mediaWithHeads.add(media.mediaOfferRef);
      const points = media.buckets
        .filter((bucket) => bucket.views !== null)
        .sort((left, right) => left.bucketStart.localeCompare(right.bucketStart))
        .map((bucket) => bucket.views!);
      seriesByMedia.set(media.mediaOfferRef, points);
    }
    return (data?.top ?? []).slice(0, 15).map((entry) => ({
      ...entry,
      series: seriesByMedia.get(entry.mediaOfferRef) ?? [],
      missingSeriesLabel: !mediaWithHeads.has(entry.mediaOfferRef)
        ? "catalogue head unavailable"
        : data?.bucketsTruncated === true
          ? "series omitted by response limit"
          : "no captured buckets in range",
    }));
  }, [data]);

  return (
    <AnalyticsPanel
      title="Top media"
      verdict={verdict}
      footnote={
        "Rank comes from the window Fansly itself ranked; the sparkline comes from our "
        + "own per-media buckets. A missing series says whether its catalogue head is "
        + "absent, the response budget truncated buckets, or no bucket exists in this range."
      }
    >
      {isLoading ? (
        <AnalyticsEmpty reason="Loading…" />
      ) : rows.length === 0 ? (
        <AnalyticsEmpty reason="No top-media window captured for this range." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-text-muted">
                <th className="pb-2 font-semibold">#</th>
                <th className="pb-2 font-semibold">Media</th>
                <th className="pb-2 text-right font-semibold">Views</th>
                <th className="pb-2 text-right font-semibold">Preview views</th>
                <th className="pb-2 pl-4 font-semibold">Our series</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.plane}:${row.requestedEnd}:${row.mediaOfferRef}`} className="border-t border-border">
                  <td className="py-2 text-text-muted">{row.rank}</td>
                  <td className="py-2 font-mono text-[12px] text-text-secondary">
                    {row.mediaOfferRef}
                  </td>
                  <td className="py-2 text-right tabular-nums">{metric(row.views)}</td>
                  <td className="py-2 text-right tabular-nums">{metric(row.previewViews)}</td>
                  <td className="py-2 pl-4">
                    {row.series.length > 0
                      ? <TrendSparkline values={row.series} />
                      : <span className="text-[11px] text-text-muted">{row.missingSeriesLabel}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AnalyticsPanel>
  );
}

/**
 * Panel 4 — the page's top FYP tags, and the platform-global counters beside
 * them.
 *
 * Two different populations on one card, deliberately: the left is this page's
 * attribution, the right is how big the tag is on Fansly as a whole. A tag the
 * page ranks for and the platform barely uses is a different opportunity from
 * one where the reverse is true.
 */
export function TopTagsPanel({
  data,
  coverage,
  isLoading,
  selectedWindow,
}: {
  data: StatsTagsResponse | undefined;
  coverage: readonly CoverageRow[] | undefined;
  isLoading: boolean;
  selectedWindow: AnalyticsCoverageWindow;
}) {
  const verdict = coverageVerdict(coverage, ANALYTICS_COVERAGE_PLANES.topTags, selectedWindow);

  const globalByTag = useMemo(() => {
    const map = new Map<string, { viewCount: number | null; postCount: number | null }>();
    for (const row of data?.platformTags ?? []) {
      // Latest business date wins; the route already ordered them that way.
      if (!map.has(row.tagRef)) {
        map.set(row.tagRef, { viewCount: row.viewCount, postCount: row.postCount });
      }
    }
    return map;
  }, [data]);

  const tags = (data?.topTags ?? []).slice(0, 20);

  return (
    <AnalyticsPanel
      title="Top FYP tags"
      verdict={verdict}
      footnote={
        "A blank name is a tag whose name the response's own `tags[]` sidecar did not "
        + "carry. It is left blank rather than reconstructed from the id — a fabricated "
        + "name is indistinguishable from a real one a year from now."
      }
    >
      {isLoading ? (
        <AnalyticsEmpty reason="Loading…" />
      ) : tags.length === 0 ? (
        <AnalyticsEmpty reason="No tag window captured for this range." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-text-muted">
                <th className="pb-2 font-semibold">#</th>
                <th className="pb-2 font-semibold">Tag</th>
                <th className="pb-2 text-right font-semibold">Page views</th>
                <th className="pb-2 text-right font-semibold">Platform views</th>
                <th className="pb-2 text-right font-semibold">Platform posts</th>
              </tr>
            </thead>
            <tbody>
              {tags.map((tag) => {
                const global = globalByTag.get(tag.tagRef);
                return (
                  <tr key={`${tag.requestedEnd}:${tag.tagRef}`} className="border-t border-border">
                    <td className="py-2 text-text-muted">{tag.rank}</td>
                    <td className="py-2">
                      {tag.tagName ?? (
                        <span className="font-mono text-[12px] text-text-muted">
                          {tag.tagRef} <span className="italic">(name not served)</span>
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums">{metric(tag.views)}</td>
                    <td className="py-2 text-right tabular-nums">
                      {metric(global?.viewCount ?? null)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {metric(global?.postCount ?? null)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </AnalyticsPanel>
  );
}

/**
 * Panel 6 — content performance.
 *
 * Price, sales count, NET (as served) and GROSS (ours). A12 settled that
 * `saleStats.total` is the creator's net share, so the gross column is a
 * read-time derivation and carries the word "derived" in its own header rather
 * than in a footnote nobody scrolls to. The two are never added together.
 *
 * There is deliberately NO average-watch column here. [E5]: the per-media route
 * serves no video fields at all — the account-level figure lives on the traffic
 * card, where its components actually exist.
 */
export function ContentPerformancePanel({
  data,
  coverage,
  isLoading,
  accountWatchPercent,
  selectedWindow,
}: {
  data: StatsMediaResponse | undefined;
  coverage: readonly CoverageRow[] | undefined;
  isLoading: boolean;
  selectedWindow: AnalyticsCoverageWindow;
  /** Null whenever the account-level components were not both served. */
  accountWatchPercent: number | null;
}) {
  const verdict = coverageVerdict(
    coverage,
    ANALYTICS_COVERAGE_PLANES.contentPerformance,
    selectedWindow,
  );

  const rows = useMemo(() => (data?.media ?? []).map((media) => {
    let views: number | null = null;
    for (const bucket of media.buckets) {
      if (bucket.views !== null) {
        views = (views ?? 0) + bucket.views;
      }
    }
    return { media, views };
  }), [data]);

  return (
    <AnalyticsPanel
      title="Content performance"
      verdict={verdict}
      headerExtra={(
        <span className="text-[12px] text-text-secondary">
          Avg. watch{" "}
          <span className="font-semibold text-text-primary">
            {accountWatchPercent === null ? "not served" : `${accountWatchPercent.toFixed(1)}%`}
          </span>
          <span className="ml-1 text-text-muted">· account level, Hub-derived</span>
        </span>
      )}
      footnote={
        "Gross is DERIVED from net (Fansly keeps 20%), never stored and never summed "
        + "with a net figure. Average watch is shown at ACCOUNT level only: the "
        + "per-media statistics route serves no video fields at all ([E5]), so a "
        + "per-media watch number would be invented rather than measured."
      }
    >
      {isLoading ? (
        <AnalyticsEmpty reason="Loading…" />
      ) : rows.length === 0 ? (
        <AnalyticsEmpty reason="No media captured for this page yet." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-text-muted">
                <th className="pb-2 font-semibold">Media</th>
                <th className="pb-2 text-right font-semibold">Price</th>
                <th className="pb-2 text-right font-semibold">Sales</th>
                <th className="pb-2 text-right font-semibold">Net (served)</th>
                <th className="pb-2 text-right font-semibold">Gross (derived)</th>
                <th className="pb-2 text-right font-semibold">Views in window</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ media, views }) => (
                <tr key={media.mediaOfferRef} className="border-t border-border">
                  <td className="py-2 font-mono text-[12px] text-text-secondary">
                    {media.mediaOfferRef}
                  </td>
                  <td className="py-2 text-right tabular-nums">{money(media.priceMills)}</td>
                  <td className="py-2 text-right tabular-nums">{metric(media.sales.count)}</td>
                  <td className="py-2 text-right tabular-nums">{money(media.sales.netMills)}</td>
                  <td className="py-2 text-right tabular-nums text-text-secondary">
                    {money(media.sales.grossMills?.value ?? null)}
                  </td>
                  <td className="py-2 text-right tabular-nums">{metric(views)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AnalyticsPanel>
  );
}

/**
 * Panel 7 — comments per post, and the liker panel that is honestly empty.
 *
 * `possiblyTruncated` is carried per post rather than summarised away: the
 * comment route has no established pagination, so a full page means the WINDOW
 * was captured, never the whole surface, and the doubt belongs to the row that
 * outlives the sweep that created it.
 */
export function CommentsPanel({
  data,
  coverage,
  isLoading,
  selectedWindow,
}: {
  data: ContentCommentsResponse | undefined;
  coverage: readonly CoverageRow[] | undefined;
  isLoading: boolean;
  selectedWindow: AnalyticsCoverageWindow;
}) {
  const verdict = coverageVerdict(coverage, ANALYTICS_COVERAGE_PLANES.comments, selectedWindow);
  const perPost = (data?.perPost ?? []).slice(0, 20);

  return (
    <>
      <AnalyticsPanel
        title="Comments per post"
        verdict={verdict}
        footnote={
          "A post marked “pagination unproven” had at least one suspiciously full page: "
          + "the reply route has no confirmed cursor, so its completeness is unknown, not "
          + "confirmed. Empty replies are stored and counted — a fan who answered with "
          + "only an attachment still answered."
        }
      >
        {isLoading ? (
          <AnalyticsEmpty reason="Loading…" />
        ) : perPost.length === 0 ? (
          <AnalyticsEmpty reason="No comments captured in this window." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-text-muted">
                  <th className="pb-2 font-semibold">Post</th>
                  <th className="pb-2 text-right font-semibold">Comments</th>
                  <th className="pb-2 text-right font-semibold">Marked missing</th>
                  <th className="pb-2 pl-4 font-semibold">Completeness</th>
                </tr>
              </thead>
              <tbody>
                {perPost.map((row) => (
                  <tr key={row.postRef} className="border-t border-border">
                    <td className="py-2 font-mono text-[12px] text-text-secondary">
                      {row.postRef}
                    </td>
                    <td className="py-2 text-right tabular-nums">{row.commentCount}</td>
                    <td className="py-2 text-right tabular-nums">{row.missingCount}</td>
                    <td className="py-2 pl-4">
                      {row.possiblyTruncatedCount > 0 ? (
                        <span className="rounded-full border border-warning-dark/60 px-2 py-0.5 text-[11px] text-warning-dark">
                          pagination unproven ({row.possiblyTruncatedCount})
                        </span>
                      ) : (
                        <span className="text-[11px] text-text-muted">window captured</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AnalyticsPanel>

      <AnalyticsPanel
        title="Likers"
        verdict={{
          state: "not_started",
          label: "not started",
          detail:
            "No Fansly like code is live-confirmed ([E4]), so the liker lane writes "
            + "nothing. The panel is shown empty rather than hidden.",
        }}
      >
        <AnalyticsEmpty
          reason={
            data?.likers.rows.length
              ? `${data.likers.rows.length} liker rows (OnlyFans webhook origin).`
              : "Empty by design: no Fansly like code is live-confirmed, so nothing is captured. "
                + "This is a hole we can name, not a page nobody likes."
          }
        />
      </AnalyticsPanel>
    </>
  );
}
