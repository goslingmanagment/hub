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
   * The definition of a term that needs one (D14), on hover and focus: the
   * LABEL gets the dotted underline («Ответ, медиана» → «половина ответов
   * быстрее…»), never the number; hovering a plain number shows it too. Only
   * for terms a reader may not know — not for «Сообщений», «Чатов», «Продажи»:
   * at most 2–3 on one line of facts.
   */
  hint?: ReactNode;
  /** A note about this very value, on hover, without any underline: «из них $41.00 — у коллег». */
  title?: ReactNode;
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
        const hinted = filled(item.hint);
        // The definition belongs to the term (D14): the label is underlined and takes the focus; a plain number
        // shows the same definition on hover, without a line (a number with its own hints keeps them).
        const plain = typeof item.value === "string" || typeof item.value === "number";
        const value = filled(item.title)
          ? <Tooltip content={item.title} align="start">{item.value}</Tooltip>
          : hinted && plain ? <Tooltip content={item.hint} align="start">{item.value}</Tooltip> : item.value;
        return (
          <div key={index} className={cx("ui-fact", item.strong && "ui-fact--strong", grid && index % (columns ?? 1) === 0 && "ui-fact--row-start")}>
            <dt className="ui-fact__label">{hinted ? <Hint content={item.hint} align="start">{item.label}</Hint> : item.label}</dt>
            <dd className="ui-fact__value" style={{ margin: 0 }}>{value}</dd>
            {layout === "stacked" && item.meta !== undefined && <dd className="ui-fact__meta" style={{ margin: 0 }}>{item.meta}</dd>}
          </div>
        );
      })}
    </dl>
  );
}

function filled(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== "";
}
