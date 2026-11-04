import type { ReactNode } from "react";

import { ChartTable, type ChartTableColumn } from "@/components/charts/ChartTable";
import { formatCount, formatSignedPercent } from "@/lib/format";

import { changePercent, formatWatchTime, type Kpi } from "./creator-stats-model.js";

/**
 * A block of «Статистика»: a title, one sentence of what it shows, the choice of
 * measure on the right (never a period: that is the header's), the body. Nothing
 * else: no badges of collection, no «?» — the explanations live in «Как это
 * считается» at the bottom of the tab.
 */
export function StatsCard({ title, description, measure, wide = false, children, footer, id }: {
  title: string;
  description?: ReactNode;
  measure?: ReactNode;
  wide?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  id?: string;
}) {
  return (
    <section className={`card stats-card${wide ? " stats-wide" : ""}`} aria-labelledby={id} id={id ? `${id}-card` : undefined}>
      <div className="card-header stats-card-header">
        <div className="min-w-0">
          <h2 className="card-title" id={id}>{title}</h2>
          {description && <p className="card-description">{description}</p>}
        </div>
        {measure && <div className="stats-card-measure">{measure}</div>}
      </div>
      {children}
      {footer}
    </section>
  );
}

/** The body of a chart card: the chart, then «Числа таблицей». */
export function ChartBody<Row>({ chart, rows, columns, rowKey, caption }: {
  chart: ReactNode;
  rows: readonly Row[];
  columns: readonly ChartTableColumn<Row>[];
  rowKey: (row: Row) => string;
  caption: string;
}) {
  return (
    <div className="card-body">
      {chart}
      <div className="stats-chart-table">
        <ChartTable rows={rows} columns={columns} rowKey={rowKey} caption={caption} />
      </div>
    </div>
  );
}

/** An empty block: what is empty, said with the page's name. */
export function StatsEmpty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty stats-empty">
      <p className="empty-text">{children}</p>
      {action && <div className="empty-actions">{action}</div>}
    </div>
  );
}

const MINUS = "−";

/** A whole number with its sign: «+404», «−79», «0». */
export function formatSignedCount(value: number): string {
  if (value === 0) return "0";
  return `${value > 0 ? "+" : MINUS}${formatCount(Math.abs(value))}`;
}

/**
 * The change of a counter or a time against the last period: «−34 141 (−13 %)»,
 * the amount in the colour of its direction, the percent quiet. Nothing to
 * compare with is «—». More is better here, so up is the up colour.
 */
export function KpiDelta({ kpi, unit = "count" }: { kpi: Kpi | null; unit?: "count" | "duration" }) {
  if (kpi === null || kpi.value === null || kpi.previous === null) {
    return (
      <span className="delta delta-pct">
        <span aria-hidden="true">—</span>
        <span className="sr-only">нет сравнения</span>
      </span>
    );
  }
  const change = kpi.value - kpi.previous;
  const pct = changePercent(kpi);
  const tone = change > 0 ? "delta-up" : change < 0 ? "delta-down" : "";
  const amount = unit === "duration"
    ? `${change > 0 ? "+" : change < 0 ? MINUS : ""}${formatWatchTime(Math.abs(change))}`
    : formatSignedCount(change);
  return (
    <span className="delta">
      <span className={tone}>{amount}</span>
      {pct !== null && <span className="delta-pct"> ({formatSignedPercent(pct)})</span>}
    </span>
  );
}

/** A strip's heading with the period it compares with, once for the strip. */
export function StripHeading({ title, compare, action }: { title: string; compare?: string | null | undefined; action?: ReactNode }) {
  return (
    <div className="stats-strip-heading">
      <h2 className="section-title">{title}</h2>
      {compare && <span className="stats-strip-compare">к {compare}</span>}
      {action && <span className="stats-strip-action">{action}</span>}
    </div>
  );
}
