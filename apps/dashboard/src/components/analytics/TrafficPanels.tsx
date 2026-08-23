import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { StatsTrafficResponse } from "@agency_hub_core/contracts";
import { ANALYTICS_COVERAGE_PLANES } from "@agency_hub_core/shared";

import {
  panelData,
  type AnalyticsPanelState,
} from "@/pages/analytics-query-state";

import {
  AnalyticsEmpty,
  AnalyticsError,
  AnalyticsLoading,
  AnalyticsPanel,
} from "./AnalyticsPanel.js";
import {
  SUGGESTIONS_DENOMINATOR_NOTE,
  coverageBadgeVerdict,
  emptyPanelReason,
  type AnalyticsCoverageWindow,
  type CoverageRow,
} from "./coverage.js";
import { buildFypMediaViewSummary } from "./traffic-metrics.js";

type TrafficRow = StatsTrafficResponse["rows"][number];

const gridProps = {
  strokeDasharray: "3 3",
  vertical: false,
  stroke: "var(--color-border, #333)",
} as const;

const tooltipProps = {
  contentStyle: {
    backgroundColor: "var(--color-card, #1a1a2e)",
    border: "1px solid var(--color-border, #333)",
    borderRadius: 8,
    fontSize: 13,
  },
  wrapperStyle: { zIndex: 20 },
};

/**
 * The four profile families, in the order the §2.1 census lists them, plus a
 * fifth series for codes this build cannot name.
 *
 * THE FIFTH SERIES IS NOT DECORATION. A1: an unknown or new type code is
 * journaled and SURFACED, never dropped. Folding it silently into a known
 * family — or omitting it from the chart — would make a platform change look
 * like a dip in traffic.
 */
const FAMILY_SERIES = [
  { key: "10000", label: "Direct / timeline", color: "#5b8def" },
  { key: "44000", label: "FYP promotion", color: "#4ead6b" },
  { key: "44010", label: "Suggestions", color: "#e0a14f" },
  { key: "44030", label: "Search", color: "#9b7ede" },
  { key: "unknown", label: "Unknown code", color: "#8b8b9e" },
] as const;

type Measure = "visits" | "dwell";

const MEASURE_LABEL: Readonly<Record<Measure, string>> = {
  visits: "Visits (member 1 — the counter Fansly's widget shows)",
  dwell: "Dwell (member 0 — the interaction-time series)",
};

function bucketLabel(iso: string): string {
  return iso.slice(5, 10);
}

/**
 * Panel 1 — traffic by source.
 *
 * The 8-code structure served as four stacked families and one measure at a
 * time. The two members are NOT summed: member 1 is a visit count and member 0
 * carries dwell with its OWN, differing view count, and the precise meaning of
 * member 0's counts is unproven. Adding them would invent a number.
 */
export function TrafficBySourcePanel({
  state,
  coverage,
  selectedWindow,
  showDenominatorNote,
  onRetry,
}: {
  state: AnalyticsPanelState<StatsTrafficResponse>;
  coverage: AnalyticsPanelState<readonly CoverageRow[]>;
  selectedWindow: AnalyticsCoverageWindow;
  /** A8: the footnote belongs to the 30-DAY view and to no other. */
  showDenominatorNote: boolean;
  onRetry: () => void;
}) {
  const [measure, setMeasure] = useState<Measure>("visits");
  const verdict = coverageBadgeVerdict(
    coverage,
    ANALYTICS_COVERAGE_PLANES.traffic,
    selectedWindow,
  );
  const data = panelData(state);

  const series = useMemo(() => {
    const buckets = new Map<string, Record<string, number | string>>();
    for (const row of data?.rows ?? []) {
      const known = row.measure !== null && row.family !== null;
      if (known && row.measure !== measure) {
        continue;
      }
      const value = measure === "visits" ? row.views : row.interactionTimeMs;
      // NULL IS NOT ZERO: a metric the platform never served contributes
      // nothing to the stack rather than a floor of zero.
      if (value === null) {
        continue;
      }
      const key = known ? row.family! : "unknown";
      const bucket = buckets.get(row.bucketStart) ?? { bucketStart: row.bucketStart };
      bucket[key] = Number(bucket[key] ?? 0) + value;
      buckets.set(row.bucketStart, bucket);
    }
    return [...buckets.values()].sort((left, right) =>
      String(left.bucketStart).localeCompare(String(right.bucketStart)));
  }, [data, measure]);

  return (
    <AnalyticsPanel
      title="Traffic by source"
      subtitle={MEASURE_LABEL[measure]}
      verdict={verdict}
      cached={state.status === "ready" && state.refreshFailed}
      {...(showDenominatorNote ? { footnote: SUGGESTIONS_DENOMINATOR_NOTE } : {})}
      headerExtra={(
        <div className="flex gap-1 rounded-lg border border-border p-0.5">
          {(["visits", "dwell"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setMeasure(option)}
              className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                measure === option
                  ? "bg-hover text-text-primary"
                  : "text-text-muted hover:text-text-secondary"
              }`}
            >
              {option === "visits" ? "Visits" : "Dwell"}
            </button>
          ))}
        </div>
      )}
    >
      {state.status === "loading" ? (
        <AnalyticsLoading />
      ) : state.status === "error" ? (
        <AnalyticsError message={state.message} onRetry={onRetry} />
      ) : series.length === 0 ? (
        <AnalyticsEmpty
          reason={emptyPanelReason(
            verdict,
            "The statistics lane holds no bucket in this window.",
          )}
        />
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={series} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis
              dataKey="bucketStart"
              tickFormatter={bucketLabel}
              tick={{ fontSize: 11, fill: "var(--color-text-muted, #888)" }}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 11, fill: "var(--color-text-muted, #888)" }}
              axisLine={false}
              tickLine={false}
              width="auto"
            />
            <Tooltip {...tooltipProps} labelFormatter={(label) => bucketLabel(String(label))} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {FAMILY_SERIES.map((entry) => (
              <Area
                key={entry.key}
                type="monotone"
                dataKey={entry.key}
                name={entry.label}
                stackId="traffic"
                stroke={entry.color}
                fill={entry.color}
                fillOpacity={0.25}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      )}
    </AnalyticsPanel>
  );
}

/**
 * Panel 2 — FYP against direct, on MEDIA views, plus the FYP share.
 *
 * The share is ours, computed at read time from each lane's full + preview
 * views, and it says so. A13: the platform serves no averages and no shares;
 * anything of that shape in this system was computed here.
 */
export function FypSharePanel({
  state,
  coverage,
  selectedWindow,
  onRetry,
}: {
  state: AnalyticsPanelState<StatsTrafficResponse>;
  coverage: AnalyticsPanelState<readonly CoverageRow[]>;
  selectedWindow: AnalyticsCoverageWindow;
  onRetry: () => void;
}) {
  const verdict = coverageBadgeVerdict(coverage, ANALYTICS_COVERAGE_PLANES.fyp, selectedWindow);
  const data = panelData(state);

  const { series, sharePercent: share } = useMemo(
    () => buildFypMediaViewSummary(data?.rows ?? []),
    [data],
  );

  return (
    <AnalyticsPanel
      title="FYP vs direct media views"
      verdict={verdict}
      cached={state.status === "ready" && state.refreshFailed}
      headerExtra={share === null ? null : (
        <span className="text-[12px] text-text-secondary">
          FYP share{" "}
          <span className="font-semibold text-text-primary">{share.toFixed(1)}%</span>
          <span className="ml-1 text-text-muted">· Hub-derived</span>
        </span>
      )}
      footnote={
        "The share is computed here from served full and preview views — Fansly sends no share "
        + "and no average anywhere in this payload. It is labelled Hub-derived for that reason."
      }
    >
      {state.status === "loading" ? (
        <AnalyticsLoading />
      ) : state.status === "error" ? (
        <AnalyticsError message={state.message} onRetry={onRetry} />
      ) : series.length === 0 ? (
        <AnalyticsEmpty
          reason={emptyPanelReason(
            verdict,
            "No account-level media datapoints in this window.",
          )}
        />
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={series} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis
              dataKey="bucketStart"
              tickFormatter={bucketLabel}
              tick={{ fontSize: 11, fill: "var(--color-text-muted, #888)" }}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 11, fill: "var(--color-text-muted, #888)" }}
              axisLine={false}
              tickLine={false}
              width="auto"
            />
            <Tooltip {...tooltipProps} labelFormatter={(label) => bucketLabel(String(label))} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area
              type="monotone"
              dataKey="fyp"
              name="FYP"
              stackId="media"
              stroke="#4ead6b"
              fill="#4ead6b"
              fillOpacity={0.25}
            />
            <Area
              type="monotone"
              dataKey="direct"
              name="Direct"
              stackId="media"
              stroke="#5b8def"
              fill="#5b8def"
              fillOpacity={0.25}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </AnalyticsPanel>
  );
}

/**
 * The account-level watch figure, and the ONLY place this page shows one.
 *
 * `totalVideoPercentWatched` is a SUM over views on the wire, so the average is
 * `sum / videoViews` — computed here, from components, labelled Hub-derived,
 * and shown only where BOTH components were actually served. It is never shown
 * per media offer: [E5] found the per-media route serves no video fields at
 * all, so a per-media watch figure would be an invention.
 */
export function accountWatchAverage(rows: readonly TrafficRow[] | undefined): number | null {
  let sum = 0;
  let views = 0;
  for (const row of rows ?? []) {
    if (row.videoPercentWatchedSum === null || row.videoViews === null) {
      continue;
    }
    sum += Number(row.videoPercentWatchedSum);
    views += row.videoViews;
  }
  return views > 0 ? sum / views : null;
}
