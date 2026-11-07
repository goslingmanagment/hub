import { useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { cx } from "./cx.js";
import { Tooltip, type ScreenRect } from "./Tooltip.js";

/** How strong a cell is: 0 — never (the empty ground), 1…4 — four calm steps of one ink. */
export type HeatStep = 0 | 1 | 2 | 3 | 4;

export interface HeatGridRow {
  key: string;
  /** The row's name on the left: a page, a chatter. */
  label: ReactNode;
  /** One value per column; null — not counted (drawn as the empty ground, the hint says why). */
  values?: readonly (number | null)[];
  /** Instead of the cells: one quiet line across the row («Смен ещё не было — не считается»). */
  note?: ReactNode;
  /** The last column: the row's total («38 %»). */
  total?: ReactNode;
}

export interface HeatGridProps {
  /** What the grid is, for a screen reader. */
  label: string;
  /** The column heads, 13 px: hours «00»…«23», days. */
  columns: readonly ReactNode[];
  rows: readonly HeatGridRow[];
  /** A value's step (0…4). By default: the share of the row's largest value in quarters. */
  stepOf?: (value: number, row: HeatGridRow, column: number) => HeatStep;
  /** Words for a cell, on hover and for a screen reader: «mia-of, 03:00–04:00 — пусто 5 из 6 дней». */
  cellHint?: (row: HeatGridRow, column: number, value: number | null) => string;
  /** The head of the total column («Пусто»); without it there is no total column. */
  totalHeader?: ReactNode;
  /** The words of the five steps, in order, for the legend under the grid («ни разу» … «почти всегда»). */
  legend?: { title?: ReactNode; steps: readonly [string, string, string, string, string]; note?: ReactNode };
  /** The left column's width (132 px). */
  labelWidth?: number;
  className?: string;
}

function defaultStep(value: number, row: HeatGridRow): HeatStep {
  const top = Math.max(0, ...(row.values ?? []).map((item) => item ?? 0));
  if (value <= 0 || top <= 0) return 0;
  const part = value / top;
  return part <= 0.25 ? 1 : part <= 0.5 ? 2 : part <= 0.75 ? 3 : 4;
}

/**
 * Rows × columns of calm squares of one ink, five steps from «never» to
 * «almost always» (a page × hour map of empty hours). A hint follows the
 * pointer over the cells (the app's Tooltip, not the browser's); every cell
 * has its words for a screen reader. Too wide for its place, it scrolls
 * sideways inside itself.
 */
export function HeatGrid({ label, columns, rows, stepOf = defaultStep, cellHint, totalHeader, legend, labelWidth = 132, className }: HeatGridProps) {
  const [hover, setHover] = useState<{ rect: ScreenRect; words: string } | null>(null);
  const withTotal = totalHeader !== undefined;

  const onMove = (event: MouseEvent<HTMLTableElement>) => {
    const cell = (event.target as Element).closest<HTMLElement>("td[data-heat]");
    const words = cell?.getAttribute("aria-label");
    if (!cell || !words) {
      if (hover) setHover(null);
      return;
    }
    if (hover?.words === words) return;
    const box = cell.getBoundingClientRect();
    setHover({ rect: { x: box.left, y: box.top, width: box.width, height: box.height }, words });
  };

  return (
    <div className={cx("ui-heat", className)} style={{ "--ui-heat-label": `${labelWidth}px` } as CSSProperties}>
      <div className="ui-heat__scroll">
        <table className="ui-heat__grid" aria-label={label} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <thead>
            <tr>
              <th scope="col" className="ui-heat__label"><span className="ui-sr-only">{label}</span></th>
              {columns.map((column, index) => <th key={index} scope="col" className="ui-heat__col">{column}</th>)}
              {withTotal && <th scope="col" className="ui-heat__total">{totalHeader}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row" className="ui-heat__label">{row.label}</th>
                {row.note !== undefined ? (
                  <td colSpan={columns.length} className="ui-heat__note">{row.note}</td>
                ) : columns.map((_, index) => {
                  const value = row.values?.[index] ?? null;
                  const step = value === null ? 0 : stepOf(value, row, index);
                  const words = cellHint?.(row, index, value);
                  return (
                    <td key={index} className="ui-heat__cell" data-heat={words ? "" : undefined} aria-label={words}>
                      <span className={cx("ui-heat__swatch", `ui-heat__swatch--${step}`, value === null && "ui-heat__swatch--none")} />
                    </td>
                  );
                })}
                {withTotal && <td className="ui-heat__total">{row.total}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {legend && (
        <div className="ui-heat__legend" aria-hidden>
          {legend.title !== undefined && <span>{legend.title}</span>}
          {legend.steps.map((word, step) => (
            <span key={word} className="ui-heat__key">
              <span className={cx("ui-heat__swatch", `ui-heat__swatch--${step}`)} />
              {word}
            </span>
          ))}
          {legend.note !== undefined && <span className="ui-heat__legend-note">{legend.note}</span>}
        </div>
      )}
      <Tooltip at={hover?.rect ?? null} content={hover?.words} />
    </div>
  );
}
