import type { MouseEventHandler, ReactNode } from "react";
import { Chip } from "./Chip.js";
import { cx } from "./cx.js";
import { Tooltip } from "./Tooltip.js";

const PLATFORM_WORD: Readonly<Record<string, string>> = { fansly: "Fansly", onlyfans: "OnlyFans", telegram: "Telegram" };

/** «Fansly», «OnlyFans»: a platform in plain words (no brand colours anywhere). */
export function platformWord(platform: string | null | undefined): string | undefined {
  if (!platform) return undefined;
  return PLATFORM_WORD[platform] ?? platform;
}

export interface PageLabelProps {
  /** The page's label: «mia-1». */
  label: string;
  /** `fansly` | `onlyfans` | `telegram`: in words on hover. */
  platform?: string | null;
  /**
   * The page is a filter or a switch here (the review's «only mia-1»): then,
   * and only then, it is a chip — a button with a hover and a hint.
   */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** The filter is on: the chip in ink. */
  selected?: boolean;
  /** What a press does, on hover of the chip: «Только чаты mia-1». Defaults to the platform. */
  hint?: ReactNode;
  /** `sm` 28 px (in a row of filters), `md` 36 px (in a header). Chips only. */
  size?: "sm" | "md";
  className?: string;
}

/**
 * One way to show a page (spec r2): quiet text in rows, headers and lists —
 * «mia-1», the platform on hover. A chip only where it is a filter or a
 * switch (`onClick`), with a hover and a hint of what it does.
 */
export function PageLabel({ label, platform, onClick, selected = false, hint, size = "sm", className }: PageLabelProps) {
  const word = platformWord(platform);
  if (onClick) {
    const chip = <Chip size={size} selected={selected} onClick={onClick} className={className}>{label}</Chip>;
    const tip = hint ?? (word ? `${label} · ${word}` : undefined);
    return tip ? <Tooltip content={tip}>{chip}</Tooltip> : chip;
  }
  const text = <span className={cx("ui-page", className)}>{label}</span>;
  return word ? <Tooltip content={`${label} · ${word}`}>{text}</Tooltip> : text;
}

/**
 * Several pages as one quiet line: «mia-1, mia-2 и ещё 2» — the rest named on
 * hover. In a table cell, a header, a person's card.
 */
export function PageLabels({ labels, max = 3, className }: {
  labels: readonly string[];
  /** How many by name before «и ещё N» (3). */
  max?: number;
  className?: string;
}) {
  if (labels.length === 0) return <span className={cx("ui-page ui-page--none", className)}>—</span>;
  const shown = labels.length > max ? labels.slice(0, Math.max(1, max - 1)) : labels;
  const rest = labels.slice(shown.length);
  return (
    <span className={cx("ui-pages", className)}>
      <span className="ui-page">{shown.join(", ")}</span>
      {rest.length > 0 && (
        <Tooltip content={rest.join(", ")}>
          <span className="ui-page ui-page--more">и ещё {rest.length}</span>
        </Tooltip>
      )}
    </span>
  );
}
