import { useCallback, useState, type ReactNode } from "react";

import { tickBudget } from "./scale.js";

/**
 * The pieces every chart in the console is built from, so they read as one
 * system: recessive solid-hairline grid, muted axis text, one HTML legend, one
 * tooltip that lists every series at the hovered date in the legend's order.
 *
 * Series identity is the coloured MARK; every piece of text here wears the
 * text tokens, never a series colour.
 */

export interface ChartSeries {
  /** Key into each data row holding this series' value. */
  key: string;
  label: string;
  color: string;
  /** A lighter twin of another series' hue (e.g. the legacy code of a type). */
  fillOpacity?: number | undefined;
}

/** The right margin holds half of the last date label: it sits on the last
 *  point, at the plot's edge. */
export const CHART_MARGIN = { top: 8, right: 20, left: 0, bottom: 0 } as const;

/**
 * Off. An entrance animation replays on every resize and period switch, costs
 * a frame loop per series, and for its duration draws a chart that is not the
 * data — a stack growing from zero. A dashboard chart appears drawn.
 */
export const CHART_ANIMATION = { isAnimationActive: false } as const;

/** Horizontal hairlines only, solid: a dashed grid reads as a threshold. */
export const chartGridProps = {
  vertical: false,
  stroke: "var(--color-border)",
} as const;

const axisTick = { fontSize: 12, fill: "var(--color-text-muted)" };

export const xAxisProps = {
  axisLine: false,
  tickLine: false,
  tick: axisTick,
  tickMargin: 8,
  // Ticks are chosen by the caller (evenTickIndices), so every one is drawn.
  interval: 0,
} as const;

export const yAxisProps = {
  axisLine: false,
  tickLine: false,
  tick: axisTick,
  tickMargin: 6,
  width: "auto",
} as const;

/** The crosshair: one hairline at the hovered date. */
export const lineCursor = { stroke: "var(--color-border-strong)", strokeWidth: 1 } as const;
/** On bars the hovered band is washed instead. */
export const bandCursor = { fill: "var(--color-hover)", fillOpacity: 0.7 } as const;

/** The hover dot: filled with the series, ringed in the card colour so it
 *  stays legible where it crosses another line. */
export function activeDot(color: string) {
  return { r: 4, fill: color, stroke: "var(--color-card)", strokeWidth: 2 };
}

/**
 * How many date labels the chart's current width affords. Wire `onResize`
 * into the chart's ResponsiveContainer.
 */
export function useTickBudget(spacingPx = 72, max = 10) {
  const [width, setWidth] = useState(0);
  const onResize = useCallback((next: number) => {
    setWidth((current) => (Math.abs(current - next) < 1 ? current : next));
  }, []);
  return { budget: tickBudget(width, spacingPx, max), onResize };
}

/** The legend, above the plot: a swatch shaped like the mark, then the name. */
export function ChartLegend({ series }: { series: readonly ChartSeries[] }) {
  if (series.length < 2) {
    // One series: the card's title already says what is drawn.
    return null;
  }
  return (
    <ul className="chart-legend" aria-label="Легенда">
      {series.map((entry) => (
        <li key={entry.key} className="chart-legend-item">
          <span
            aria-hidden="true"
            className="chart-legend-swatch"
            style={{ background: entry.color, opacity: entry.fillOpacity ?? 1 }}
          />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** What recharts hands a custom tooltip; only the hovered row is read. */
export interface ChartTooltipRenderProps {
  active?: boolean | undefined;
  label?: string | number | undefined;
  payload?: ReadonlyArray<{ payload?: unknown }> | undefined;
}

/**
 * The tooltip: the date, then every series at it — even the ones at zero —
 * in the legend's order, the value strong and the name quiet.
 *
 * It reads the hovered ROW, not recharts' payload: a series the row does not
 * carry is "—", and a row that carries none of them is a bucket nobody
 * captured, which says so instead of vanishing.
 */
export function ChartTooltipCard({
  active,
  label,
  payload,
  series,
  formatValue,
  formatLabel = (value) => String(value),
  totalLabel,
  emptyText = "Нет данных за этот день",
  note,
}: ChartTooltipRenderProps & {
  series: readonly ChartSeries[];
  formatValue: (value: number) => string;
  formatLabel?: ((label: string | number) => ReactNode) | undefined;
  /** Adds a summed row (stacked charts), named so. */
  totalLabel?: string | undefined;
  emptyText?: string | undefined;
  /** A line under the values, for the row it is given. */
  note?: ((row: Record<string, unknown>) => ReactNode) | undefined;
}) {
  if (!active) {
    return null;
  }
  const row = payload?.[0]?.payload;
  if (row === null || typeof row !== "object") {
    return null;
  }
  const record = row as Record<string, unknown>;
  const values = series.map((entry) => ({ ...entry, value: finite(record[entry.key]) }));
  const served = values.filter((entry) => entry.value !== null);
  const total = served.reduce((sum, entry) => sum + entry.value!, 0);
  const extra = note?.(record);

  return (
    <div className="chart-tooltip">
      {label !== undefined ? <div className="chart-tooltip-label">{formatLabel(label)}</div> : null}
      {served.length === 0 ? (
        <div>{emptyText}</div>
      ) : (
        <>
          {values.map((entry) => (
            <div key={entry.key} className="chart-tooltip-row">
              <span
                aria-hidden="true"
                className="chart-tooltip-key"
                style={{ background: entry.color, opacity: entry.fillOpacity ?? 1 }}
              />
              <span className="chart-tooltip-name">{entry.label}</span>
              <span className="chart-tooltip-value">
                {entry.value === null ? "—" : formatValue(entry.value)}
              </span>
            </div>
          ))}
          {totalLabel && values.length > 1 ? (
            <div className="chart-tooltip-row chart-tooltip-total">
              <span aria-hidden="true" />
              <span className="chart-tooltip-name">{totalLabel}</span>
              <span className="chart-tooltip-value">{formatValue(total)}</span>
            </div>
          ) : null}
        </>
      )}
      {extra ? <div className="chart-tooltip-note">{extra}</div> : null}
    </div>
  );
}

/**
 * A dot only where a value stands alone between two holes. An area or line
 * draws nothing for a lone point — the one measured day between two
 * uncaptured ones would otherwise be invisible.
 */
export function isolatedDot(
  rows: readonly Record<string, unknown>[],
  key: string,
  color: string,
) {
  return function IsolatedDot(props: { cx?: number | undefined; cy?: number | undefined; index: number }) {
    const { cx, cy, index } = props;
    const here = finite(rows[index]?.[key]);
    const before = index > 0 ? finite(rows[index - 1]?.[key]) : null;
    const after = index < rows.length - 1 ? finite(rows[index + 1]?.[key]) : null;
    if (here === null || before !== null || after !== null || cx == null || cy == null) {
      return <g key={`${key}-${index}`} />;
    }
    return (
      <circle
        key={`${key}-${index}`}
        cx={cx}
        cy={cy}
        r={3}
        fill={color}
        stroke="var(--color-card)"
        strokeWidth={1.5}
      />
    );
  };
}

/**
 * Where the line is broken: each run of buckets carrying none of `keys`, as
 * the x-span between the measured neighbours around it (or the plot's edge).
 * Drawn as a faint band, so a hole reads as "not captured" and never as a
 * drop to zero.
 */
export function gapSpans(
  rows: readonly Record<string, unknown>[],
  xKey: string,
  keys: readonly string[],
): Array<{ x1: unknown; x2: unknown }> {
  const measured = rows.map((row) => keys.some((key) => finite(row[key]) !== null));
  const spans: Array<{ x1: unknown; x2: unknown }> = [];
  let index = 0;
  while (index < rows.length) {
    if (measured[index]) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < rows.length && !measured[index]) index += 1;
    const left = Math.max(0, start - 1);
    const right = Math.min(rows.length - 1, index);
    if (right > left) {
      spans.push({ x1: rows[left]![xKey], x2: rows[right]![xKey] });
    }
  }
  // A window with nothing measured at all is the empty state, not a band.
  return measured.some(Boolean) ? spans : [];
}
