import { useMemo } from "react";

import type { MoneyRevenueMixResponse } from "@agency_hub_core/contracts";
import { ANALYTICS_COVERAGE_PLANES } from "@agency_hub_core/shared";

import { usdAxisFormatter } from "@/components/charts/format";
import { businessDateRange } from "@/components/charts/scale";
import { StackedBarChart, type StackedBarChartSeries } from "@/components/shared/StackedBarChart";
import { formatMills } from "@/lib/format";

import {
  panelData,
  type AnalyticsPanelState,
} from "@/pages/analytics-query-state";

import {
  ANALYTICS_TABLE_WRAP,
  AnalyticsEmpty,
  AnalyticsError,
  AnalyticsLoading,
  AnalyticsPanel,
} from "./AnalyticsPanel.js";
import { formatBucketDay, formatMonth, revenueTypeLabel } from "./analytics-words.js";
import {
  coverageBadgeVerdict,
  emptyPanelReason,
  type AnalyticsCoverageWindow,
  type CoverageRow,
} from "./coverage.js";

/* A type's colour belongs to the TYPE, never to its place in this window's
 * list: a period where tips are absent must not repaint subscriptions. The
 * common types take the validated six-slot order; a legacy code wears its
 * current twin's hue, lighter; refunds and anything rarer are neutral grey
 * (named in the legend and the tooltip, so grey never has to tell them apart). */
const TYPE_COLORS: Readonly<Record<string, string>> = {
  subscriptions: "var(--color-chart-blue)",
  tips: "var(--color-chart-orange)",
  media: "var(--color-chart-aqua)",
  media_sets: "var(--color-chart-violet)",
  locked_text: "var(--color-chart-magenta)",
  stream_tickets: "var(--color-chart-lime)",
};
const REFUND_COLOR = "var(--color-text-muted)";
const OTHER_COLOR = "var(--color-border-strong)";
const LEGACY_OPACITY = 0.5;

function typeColor(label: string): string {
  if (label === "refund") return REFUND_COLOR;
  return TYPE_COLORS[label] ?? OTHER_COLOR;
}

type RevenueType = { code: number; label: string; era: string | null };

/** A type's legend name. A label shared by a legacy and a current code is
 *  told apart by its era; anything still shared gets a number — the codes
 *  themselves are listed behind the panel's "?". */
function legendNames(types: readonly RevenueType[]): Map<number, string> {
  const base = types.map((type) => ({
    ...type,
    name: revenueTypeLabel(type.label) + (type.era === "legacy" ? " (старый тип)" : ""),
  }));
  const counts = new Map<string, number>();
  for (const type of base) counts.set(type.name, (counts.get(type.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  const names = new Map<number, string>();
  for (const type of base) {
    if ((counts.get(type.name) ?? 0) > 1) {
      const index = (seen.get(type.name) ?? 0) + 1;
      seen.set(type.name, index);
      names.set(type.code, `${type.name} ${index}`);
    } else {
      names.set(type.code, type.name);
    }
  }
  return names;
}

function moneyOrDash(value: number | null): string {
  return value === null ? "—" : formatMills(value);
}

/**
 * Panel 5 — the revenue mix, stacked by RAW TYPE CODE.
 *
 * Stacked by code, not by label, and that is the whole point. A22-2: one
 * visible label maps to TWO live codes — legacy and current — and this ledger
 * reaches back to 2025-03-06, well into legacy territory. Stacking by label
 * would silently merge the pair; the legend names the legacy half apart so a
 * reader sees the merge that Fansly's own chart performs, and can refuse it.
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

  const { rows, served, series, codes } = useMemo(() => {
    const byDate = new Map<string, Record<string, string | number>>();
    const types = new Map<number, RevenueType>();
    for (const row of data?.daily ?? []) {
      types.set(row.typeCode, { code: row.typeCode, label: row.typeLabel, era: row.typeEra });
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
    const orderedTypes = [...types.values()].sort((left, right) => left.code - right.code);
    const names = legendNames(orderedTypes);
    // Every date of the window, so the bars keep their place in time; a date
    // nothing came back for is an empty slot that says "no data" on hover.
    const window = data?.window;
    const dates = window === undefined ? [] : businessDateRange(window.from, window.to);
    for (const date of byDate.keys()) {
      if (!dates.includes(date)) dates.push(date);
    }
    dates.sort();
    return {
      rows: dates.map((date) => byDate.get(date) ?? { businessDate: date }),
      served: byDate.size,
      series: orderedTypes.map((type): StackedBarChartSeries => ({
        key: String(type.code),
        label: names.get(type.code) ?? String(type.code),
        color: typeColor(type.label),
        fillOpacity: type.era === "legacy" ? LEGACY_OPACITY : undefined,
      })),
      codes: orderedTypes.map((type) => `${names.get(type.code) ?? ""} — ${type.code}`),
    };
  }, [data]);

  const months = data?.months ?? [];
  const realMonths = months.filter((month) => !month.rollup);
  const rollup = months.find((month) => month.rollup);

  return (
    <>
      <AnalyticsPanel
        title="Структура дохода"
        description="После комиссии, по типам дохода."
        verdict={verdict}
        cached={cached}
        help={(
          <>
            <p>
              Доход по каждому типу показан после комиссии — так его отдаёт Fansly.
              Суммы до комиссии по типам не смешиваются с ними.
            </p>
            <p>
              Один и тот же тип дохода Fansly присылает под старым и новым кодом. Они
              показаны отдельно («старый тип»), чтобы не сливать их незаметно.
            </p>
            {codes.length > 0 ? (
              <p className="text-xs text-text-muted">Коды типов Fansly: {codes.join("; ")}.</p>
            ) : null}
          </>
        )}
      >
        {state.status === "loading" ? (
          <AnalyticsLoading />
        ) : state.status === "error" ? (
          <AnalyticsError message={state.message} onRetry={onRetry} />
        ) : served === 0 ? (
          <AnalyticsEmpty
            reason={emptyPanelReason(
              verdict,
              "Структура дохода за этот период не собрана.",
            )}
          />
        ) : (
          <div className="card-body">
            <StackedBarChart
              title=""
              data={rows}
              xKey="businessDate"
              series={series}
              xTickFormatter={formatBucketDay}
              valueFormatter={(value) => formatMills(value)}
              axisFormatter={usdAxisFormatter}
              height={280}
            />
          </div>
        )}
      </AnalyticsPanel>

      <AnalyticsPanel
        title="Итоги по месяцам"
        verdict={verdict}
        cached={cached}
        help={(
          <p>
            «Сводный итог Fansly» — шапка раздела выписок Fansly, а не отдельный месяц.
            Он показан отдельно, потому что включает те же месяцы: если сложить его
            с ними, доход за год посчитается дважды.
          </p>
        )}
      >
        {state.status === "loading" ? (
          <AnalyticsLoading />
        ) : state.status === "error" ? (
          <AnalyticsError message={state.message} onRetry={onRetry} />
        ) : months.length === 0 ? (
          <AnalyticsEmpty
            reason={emptyPanelReason(verdict, "Итоги по месяцам для этой страницы не собраны.")}
          />
        ) : (
          <>
            <div className={ANALYTICS_TABLE_WRAP}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Месяц</th>
                    <th className="num">До комиссии</th>
                    <th className="num">После комиссии</th>
                  </tr>
                </thead>
                <tbody>
                  {realMonths.map((month) => (
                    <tr key={`${month.year}-${month.month}`}>
                      <td>{formatMonth(month.year, month.month)}</td>
                      <td className="num muted">{moneyOrDash(month.totalGrossMills)}</td>
                      <td className="num">{moneyOrDash(month.totalNetMills)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rollup ? (
              <div className="card-footer mt-auto flex-wrap" data-rollup>
                <span>
                  <span className="font-medium text-text-primary">Сводный итог Fansly</span>
                  <span className="ml-1.5 text-text-muted">· не складывается с месяцами</span>
                </span>
                <span className="tabular-nums">
                  до комиссии {moneyOrDash(rollup.totalGrossMills)}
                  {" · после комиссии "}
                  <span className="font-medium text-text-primary">{moneyOrDash(rollup.totalNetMills)}</span>
                </span>
              </div>
            ) : null}
          </>
        )}
      </AnalyticsPanel>
    </>
  );
}
