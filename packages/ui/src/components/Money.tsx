import type { MillsLike } from "@agency_hub_core/shared";
import { formatAiUsd, formatCount, formatMills, formatSignedMills, formatUsdFromCents } from "../format.js";
import type { ReactNode } from "react";
import { cx } from "./cx.js";
import { Tooltip } from "./Tooltip.js";

export interface MoneyProps {
  /** Platform money: integer mills ($0.001), as Hub sends it. */
  mills?: MillsLike | null | undefined;
  /** Cents, where an answer has them. */
  cents?: number | null | undefined;
  /** AI spend: micro-USD. «< $0.01» below a cent. */
  microUsd?: number | null | undefined;
  /** «+$880.00»: a change. */
  signed?: boolean;
  /** 600: a total, the answer of a screen. */
  strong?: boolean;
  /** Context: the period before, a small sum. */
  muted?: boolean;
  /** What the sum is, on hover (the app's Tooltip): «после комиссии площадки». */
  hint?: ReactNode;
  /** The same as `hint` (kept for old calls). */
  title?: string;
  className?: string;
}

/**
 * Money as the platforms and the payout sheet write it: «$11,183.60», always the
 * cents, a real minus. No answer is not a zero: null shows «—».
 */
export function Money({ mills, cents, microUsd, signed = false, strong = false, muted = false, hint, title, className }: MoneyProps) {
  let text: string | null = null;
  if (mills !== undefined && mills !== null) text = signed ? formatSignedMills(mills) : formatMills(mills);
  else if (cents !== undefined && cents !== null) text = formatUsdFromCents(cents);
  else if (microUsd !== undefined && microUsd !== null) text = formatAiUsd(microUsd);
  const words = hint ?? title;
  if (text === null) {
    // No answer is not a zero; the hint says so only when the screen has nothing better to say.
    return withHint(<span className={cx("ui-money ui-money--none", className)}>—</span>, words ?? "Нет данных");
  }
  return withHint(<span className={cx("ui-money", strong && "ui-money--strong", muted && "ui-money--muted", className)}>{text}</span>, words);
}

function withHint(node: ReactNode, words: ReactNode): ReactNode {
  return words === undefined || words === null || words === "" ? node : <Tooltip content={words}>{node}</Tooltip>;
}

/**
 * A count: «1 420», a real zero «0», no answer «—». With a noun, pass `one`,
 * `few`, `many`: «5 смен».
 */
export function Count({ value, one, few, many, className, title }: {
  value: number | null | undefined;
  one?: string;
  few?: string;
  many?: string;
  className?: string;
  title?: string;
}) {
  const number = formatCount(value);
  let noun = "";
  if (value !== null && value !== undefined && one && few && many) {
    const mod10 = Math.abs(value) % 10;
    const mod100 = Math.abs(value) % 100;
    noun = mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
  }
  return <span title={title} className={cx("ui-count-text", className)}>{noun ? `${number}\u00a0${noun}` : number}</span>;
}
