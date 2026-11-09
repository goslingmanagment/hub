import type { ReactNode } from "react";
import { cx } from "./cx.js";
import { Tooltip } from "./Tooltip.js";

export interface MarkProps {
  children: ReactNode;
  /**
   * `worse` (default): worse than the team — the one warm ground of the app,
   * nothing else ever wears it. `best`: the best of a column — no ground, the
   * main ink in 600; the screen puts the word next to it («больше всего денег»).
   */
  tone?: "worse" | "best";
  /** Why it is marked, on hover: «Обычно у команды — 2 мин 10 с». */
  hint?: ReactNode;
  /** The same as `hint` (kept for old calls): shown by the app's Tooltip, not the browser's. */
  title?: string;
  className?: string;
}

/**
 * An outlier inside a cell. Colour means only «worse than the team» (spec r2):
 * a calm warm ground, no grading. The best of a column is bold ink and a word,
 * never yellow or gold.
 */
export function Mark({ children, tone = "worse", hint, title, className }: MarkProps) {
  const mark = <span className={cx("ui-mark", tone === "best" && "ui-mark--best", className)}>{children}</span>;
  const words = hint ?? title;
  return words === undefined || words === null || words === "" ? mark : <Tooltip content={words}>{mark}</Tooltip>;
}
