import type { ReactNode } from "react";
import { cx } from "./cx.js";

export interface FactItem {
  label: ReactNode;
  value: ReactNode;
  /** A quiet line under the value (stacked only): a change, a comparison. */
  meta?: ReactNode;
  /** The answer of the row (money): a size up, 600. */
  strong?: boolean;
  title?: string;
}

/**
 * A few numbers about one thing, read together. `inline`: one 15 px line,
 * label then value («Продажи $412.50   Сообщений 214 …») — the facts line of a
 * shift. `stacked`: a strip of tiles split by hairlines — value 24 px above its
 * label (the top of a screen). Never more than six.
 */
export function Facts({ items, layout = "inline", className, label }: {
  items: readonly FactItem[];
  layout?: "inline" | "stacked";
  className?: string;
  /** What these numbers are about, for a screen reader. */
  label?: string;
}) {
  return (
    <dl aria-label={label} className={cx("ui-facts", layout === "stacked" && "ui-facts--stacked", className)}>
      {items.map((item, index) => (
        <div key={index} className={cx("ui-fact", item.strong && "ui-fact--strong")} title={item.title}>
          <dt className="ui-fact__label">{item.label}</dt>
          <dd className="ui-fact__value" style={{ margin: 0 }}>{item.value}</dd>
          {layout === "stacked" && item.meta !== undefined && <dd className="ui-fact__meta" style={{ margin: 0 }}>{item.meta}</dd>}
        </div>
      ))}
    </dl>
  );
}
