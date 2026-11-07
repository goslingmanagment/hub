import type { CSSProperties, ReactNode } from "react";
import { cx } from "./cx.js";
import { Hint, Tooltip } from "./Tooltip.js";

export interface FactItem {
  label: ReactNode;
  value: ReactNode;
  /** A quiet line under the value (stacked only): a change, a comparison. Wraps inside its tile. */
  meta?: ReactNode;
  /** The answer of the row (money): a size up, 600. */
  strong?: boolean;
  /**
   * What the number means, on hover and focus: the value gets a dotted
   * underline («Ответ, медиана» → «половина ответов быстрее»).
   */
  hint?: ReactNode;
  /** A hint over the value without the underline (kept for old calls; prefer `hint`). */
  title?: string;
}

/**
 * A few numbers about one thing, read together. `inline`: one 15 px line,
 * label then value («Продажи $412.50   Сообщений 214 …») — the facts line of a
 * shift. `stacked`: a strip of tiles split by hairlines — value 24 px above its
 * label (the top of a screen); `columns` makes the tiles an even grid that
 * wraps by whole rows. Never more than six.
 */
export function Facts({ items, layout = "inline", columns, className, label }: {
  items: readonly FactItem[];
  layout?: "inline" | "stacked";
  /** Stacked only: tiles of equal width, so many per row (the rest go to the next row, lined up). */
  columns?: number;
  className?: string;
  /** What these numbers are about, for a screen reader. */
  label?: string;
}) {
  const grid = layout === "stacked" && columns !== undefined && columns > 0;
  return (
    <dl
      aria-label={label}
      className={cx("ui-facts", layout === "stacked" && "ui-facts--stacked", grid && "ui-facts--grid", className)}
      style={grid ? ({ "--ui-facts-columns": columns } as CSSProperties) : undefined}
    >
      {items.map((item, index) => {
        const hinted = item.hint !== undefined && item.hint !== null && item.hint !== "";
        const value = hinted
          ? <Hint content={item.hint} align="start">{item.value}</Hint>
          : item.title ? <Tooltip content={item.title} align="start">{item.value}</Tooltip> : item.value;
        return (
          <div key={index} className={cx("ui-fact", item.strong && "ui-fact--strong", grid && index % (columns ?? 1) === 0 && "ui-fact--row-start")}>
            <dt className="ui-fact__label">{item.label}</dt>
            <dd className="ui-fact__value" style={{ margin: 0 }}>{value}</dd>
            {layout === "stacked" && item.meta !== undefined && <dd className="ui-fact__meta" style={{ margin: 0 }}>{item.meta}</dd>}
          </div>
        );
      })}
    </dl>
  );
}
