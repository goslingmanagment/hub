import type { CSSProperties, ReactNode } from "react";
import { formatOf, formatPercent } from "../format.js";
import { Bar } from "./Bar.js";
import { cx } from "./cx.js";
import { Tooltip } from "./Tooltip.js";

export interface RateBarProps {
  /** How many of `of` (bought, answered…). With `of` the share is `hits / of`. */
  hits?: number;
  /** Out of how many. 0 — nothing to show: the `empty` words stand in the number's place. */
  of?: number;
  /** The share itself (0…1), when there is no count behind it. Ignored when `of` is given. */
  value?: number | null;
  /**
   * From how many the share counts (5): below it the bar goes pale and the
   * number becomes «3 из 4» — chance, not a fact.
   */
  min?: number;
  /** The scale of the column (1 = 100 %): give all bars of a column the same one. */
  max?: number;
  /** Where the team (or the period before) stands: a thin mark on the bar. */
  compare?: number | null;
  /** Words for the mark in the hint: «команда», «все страницы». */
  compareLabel?: string;
  /** `mark` — worse than the team (the one warm colour). Never for «best». */
  tone?: "neutral" | "mark";
  /** The best of the column: the number in 600, the bar in its usual ink (the screen adds the word). */
  strong?: boolean;
  /** The row matters less (a retired approach): drawn as quietly as a small sample. */
  quiet?: boolean;
  /** Nothing to show (`of` 0, `value` null): «—» by default; «зреет», «не было». */
  empty?: ReactNode;
  /** Why it is empty, on hover: «Ответили ли за 72 ч, станет видно 10 нояб.». */
  emptyHint?: ReactNode;
  /** Quiet words after the number, 14 px: «из 18 ответов», «команда 33 %». */
  detail?: ReactNode;
  /** The detail's slot, px (136): the same for every row of a column, so the bars line up. */
  detailWidth?: number;
  /** The hint on hover instead of the made one («41 % — 7 из 17, команда 33 %»). */
  hint?: ReactNode;
  className?: string;
}

/**
 * A share in a cell or a row: a bar, its number on the right, an optional
 * quiet detail. A small sample is pale and says «3 из 4» instead of a percent;
 * an empty one keeps the number's place («—», «зреет»), so a column lines up.
 * The words of the hint are made from the numbers unless `hint` is given.
 */
export function RateBar({
  hits,
  of,
  value,
  min = 5,
  max = 1,
  compare,
  compareLabel = "команда",
  tone = "neutral",
  strong = false,
  quiet = false,
  empty = "—",
  emptyHint,
  detail,
  detailWidth,
  hint,
  className,
}: RateBarProps) {
  const counted = of !== undefined;
  const share = counted ? (of > 0 ? (hits ?? 0) / of : null) : value ?? null;
  const detailNode = detail !== undefined && detail !== null ? <span className="ui-rate__detail">{detail}</span> : null;
  const style = detailWidth !== undefined ? ({ "--ui-rate-detail": `${detailWidth}px` } as CSSProperties) : undefined;

  if (share === null || !Number.isFinite(share)) {
    const slot = (
      <span className={cx("ui-rate ui-rate--empty", detailNode && "ui-rate--detail", className)} style={style}>
        <span aria-hidden className="ui-rate__track" />
        <span className="ui-rate__value">{empty}</span>
        {detailNode}
      </span>
    );
    return emptyHint ? <Tooltip content={emptyHint} className="ui-rate-tip">{slot}</Tooltip> : slot;
  }

  const small = counted && of < min;
  const weak = small || quiet;
  const percent = formatPercent(share * 100);
  const comparison = compare !== undefined && compare !== null ? `, ${compareLabel} ${formatPercent(compare * 100)}` : "";
  const words = counted ? `${percent} — ${formatOf(hits ?? 0, of)}${comparison}${small ? ". Мало, чтобы судить" : ""}` : `${percent}${comparison}`;
  return (
    <Tooltip content={hint ?? words} className="ui-rate-tip">
      <span className={cx("ui-rate", weak && "ui-rate--weak", strong && !weak && "ui-rate--strong", detailNode && "ui-rate--detail", className)} style={style}>
        <Bar value={share} max={max} compare={compare ?? null} tone={weak ? "muted" : tone} label={words} className="ui-rate__bar" />
        <span className="ui-rate__value">{small ? formatOf(hits ?? 0, of) : percent}</span>
        {detailNode}
      </span>
    </Tooltip>
  );
}
