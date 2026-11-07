import type { MillsLike } from "@agency_hub_core/shared";
import { changeDirection, formatMills, formatSignedMills, formatSignedPercent } from "../format.js";
import type { ReactNode } from "react";
import { cx } from "./cx.js";
import { Tooltip } from "./Tooltip.js";

export interface DeltaProps {
  /** The change in percent against the period before; null: nothing to compare with («—»). */
  pct?: number | null | undefined;
  /** The change in money, shown before the percent: «+$880.00 (+64 %)». */
  mills?: MillsLike | null | undefined;
  /**
   * Someone (or something) that had money before and has none now: «было $419.94»
   * instead of a «−100 %».
   */
  was?: MillsLike | null | undefined;
  /**
   * `gain` (default): more is better, rise and fall get their calm colours.
   * `cost`: spending (AI) — a change is written in the text's colour, neither good nor bad.
   */
  kind?: "gain" | "cost";
  /** What it is compared with, on hover (the app's Tooltip): «к 26 окт. – 1 нояб.». */
  title?: ReactNode;
  /**
   * Words instead of «—» when there is nothing to compare with: «не с чем сравнить»,
   * «первая неделя». Quiet, like the dash.
   */
  noneText?: ReactNode;
  className?: string;
}

/**
 * A change against the last period. A calm green-grey up and a brown down, never
 * the alarm red: a weaker week is not a breakage. No arrows, the sign always.
 */
export function Delta({ pct, mills, was, kind = "gain", title, noneText, className }: DeltaProps) {
  if (was !== undefined && was !== null) {
    return withHint(<span className={cx("ui-delta ui-delta--was", className)}>было {formatMills(was)}</span>, title);
  }
  const hasPct = pct !== undefined && pct !== null && Number.isFinite(pct);
  const hasMoney = mills !== undefined && mills !== null;
  if (!hasPct && !hasMoney) {
    if (noneText !== undefined) return withHint(<span className={cx("ui-delta ui-delta--none ui-delta--words", className)}>{noneText}</span>, title);
    return withHint(<span className={cx("ui-delta ui-delta--none", className)}>—</span>, title ?? "Сравнивать не с чем");
  }
  const rounded = hasPct ? Math.round(pct) : 0;
  const direction = hasPct ? (rounded > 0 ? "up" : rounded < 0 ? "down" : "flat") : changeDirection(mills);
  const tone = kind === "cost" && direction !== "flat" ? "neutral" : direction;
  const text = hasMoney
    ? hasPct ? `${formatSignedMills(mills)} (${formatSignedPercent(pct)})` : formatSignedMills(mills)
    : formatSignedPercent(rounded);
  return withHint(<span className={cx("ui-delta", `ui-delta--${tone}`, className)}>{text}</span>, title);
}

function withHint(node: ReactNode, words: ReactNode): ReactNode {
  return words === undefined || words === null || words === "" ? node : <Tooltip content={words}>{node}</Tooltip>;
}
