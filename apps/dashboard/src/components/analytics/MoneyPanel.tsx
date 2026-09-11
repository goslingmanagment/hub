import { useMemo } from "react";

import type { MoneyRevenueMixResponse } from "@agency_hub_core/contracts";
import { ANALYTICS_COVERAGE_PLANES } from "@agency_hub_core/shared";

import { StackedBarChart, type StackedBarChartSeries } from "@/components/shared/StackedBarChart";
import { formatMills } from "@/lib/format";

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
  coverageBadgeVerdict,
  emptyPanelReason,
  type AnalyticsCoverageWindow,
  type CoverageRow,
} from "./coverage.js";

const PALETTE = ["#5b8def", "#4ead6b", "#e0a14f", "#9b7ede", "#d16a8a", "#5fb5c4", "#8b8b9e"];

/**
 * Panel 5 — the revenue mix, stacked by RAW TYPE CODE.
 *
 * Stacked by code, not by label, and that is the whole point. A22-2: one
 * visible label maps to TWO live codes — legacy and current — and this ledger
 * reaches back to 2025-03-06, well into legacy territory. Stacking by label
 * would silently merge the pair; the legend shows `label (code)` so a reader
 * sees the merge that Fansly's own chart performs, and can refuse it.
 */
export function RevenueMixPanel({
  state,
  coverage,
  selectedWindow,
  onRetry,
}: {
  state: AnalyticsPanelState<MoneyRevenueMixResponse>;
  coverage: AnalyticsPanelState<readonly CoverageRow[]>;
  selectedWindow: AnalyticsCoverageWindow;
  onRetry: () => void;
}) {
  const verdict = coverageBadgeVerdict(coverage, ANALYTICS_COVERAGE_PLANES.revenue, selectedWindow);
  const data = panelData(state);
  const cached = state.status === "ready" && state.refreshFailed;

  const { rows, series } = useMemo(() => {
    const byDate = new Map<string, Record<string, string | number>>();
    const codes = new Map<number, string>();
    for (const row of data?.daily ?? []) {
      codes.set(row.typeCode, `${row.typeLabel} (${row.typeCode})`);
      const bucket = byDate.get(row.businessDate) ?? { businessDate: row.businessDate };
      // NET is what the breakdown is stacked on: it is the figure the platform
      // actually serves per type, and mixing it with gross across types would
      // be adding two different bases.
      if (row.netMills !== null) {
        const key = String(row.typeCode);
        bucket[key] = Number(bucket[key] ?? 0) + row.netMills;
      }
      byDate.set(row.businessDate, bucket);
    }
    const orderedCodes = [...codes.entries()].sort((left, right) => left[0] - right[0]);
    return {
      rows: [...byDate.values()].sort((left, right) =>
        String(left.businessDate).localeCompare(String(right.businessDate))),
      series: orderedCodes.map(([code, label], index): StackedBarChartSeries => ({
        key: String(code),
        label,
        color: PALETTE[index % PALETTE.length]!,
      })),
    };
  }, [data]);

  const months = data?.months ?? [];
  const realMonths = months.filter((month) => !month.rollup);
  const rollup = months.find((month) => month.rollup);

  return (
    <>
      <AnalyticsPanel
        title="Revenue mix"
        verdict={verdict}
        cached={cached}
        limited={data?.nextCursor ? "Разбивка дохода получена частично: показаны записи из ограниченного ответа. Это не полный итог периода." : undefined}
        footnote={
          "Stacked by RAW type code, and the legend shows the code beside the label: one "
          + "label maps to two live codes (legacy and current), and this ledger reaches "
          + "back into legacy territory. Values are NET per type — the basis the platform "
          + "serves for this breakdown."
        }
      >
        {state.status === "loading" ? (
          <AnalyticsLoading />
        ) : state.status === "error" ? (
          <AnalyticsError message={state.message} onRetry={onRetry} />
        ) : rows.length === 0 ? (
          <AnalyticsEmpty
            reason={emptyPanelReason(
              verdict,
              "No earnings breakdown captured for this range.",
            )}
          />
        ) : (
          <StackedBarChart
            title=""
            data={rows}
            xKey="businessDate"
            series={series}
            valueFormatter={(value) => formatMills(value)}
            height={280}
          />
        )}
      </AnalyticsPanel>

      <AnalyticsPanel
        title="Month totals"
        verdict={verdict}
        cached={cached}
        footnote={
          "The rolling rollup is the creator's Statements header, not a month. It is "
          + "shown apart from the months because summing it with them double-counts the "
          + "year — which is exactly what a table that quietly included it would do."
        }
      >
        {state.status === "loading" ? (
          <AnalyticsLoading />
        ) : state.status === "error" ? (
          <AnalyticsError message={state.message} onRetry={onRetry} />
        ) : months.length === 0 ? (
          <AnalyticsEmpty
            reason={emptyPanelReason(verdict, "No month totals captured for this page.")}
          />
        ) : (
          <div className="space-y-3">
            <div role="region" aria-label="Таблица аналитики" tabIndex={0} className="max-h-[32rem] overflow-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-text-muted">
                    <th className="pb-2 font-semibold">Month</th>
                    <th className="pb-2 text-right font-semibold">Gross</th>
                    <th className="pb-2 text-right font-semibold">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {realMonths.map((month) => (
                    <tr key={`${month.year}-${month.month}`} className="border-t border-border">
                      <td className="py-2">
                        {month.year}-{String(month.month).padStart(2, "0")}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {month.totalGrossMills === null ? "—" : formatMills(month.totalGrossMills)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {month.totalNetMills === null ? "—" : formatMills(month.totalNetMills)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rollup ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-3 text-[12px]">
                <span className="font-semibold text-text-primary">Rolling rollup</span>
                <span className="ml-2 text-text-muted">
                  (the `0/0` row — never summed with the months above)
                </span>
                <div className="mt-1 tabular-nums text-text-secondary">
                  gross {rollup.totalGrossMills === null ? "—" : formatMills(rollup.totalGrossMills)}
                  {" · net "}
                  {rollup.totalNetMills === null ? "—" : formatMills(rollup.totalNetMills)}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </AnalyticsPanel>
    </>
  );
}
