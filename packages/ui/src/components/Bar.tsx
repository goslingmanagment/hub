import { cx } from "./cx.js";

/**
 * A horizontal bar of a share: `value` of `max` (0…1 when `max` is left out).
 * `compare` puts a thin mark where the team (or the last period) stands.
 * Neutral ink by default; `mark` for the one outlier worth a look, `muted` for
 * a sample too small to trust.
 */
export function Bar({ value, max = 1, compare, tone = "neutral", size = "md", label, className }: {
  value: number;
  max?: number;
  compare?: number | null;
  tone?: "neutral" | "accent" | "mark" | "muted";
  size?: "md" | "lg";
  /** What the bar says in words, for a screen reader: «41 % купили». */
  label?: string;
  className?: string;
}) {
  const share = (part: number) => (max > 0 ? Math.min(1, Math.max(0, part / max)) : 0);
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cx("ui-bar", tone !== "neutral" && `ui-bar--${tone}`, size === "lg" && "ui-bar--lg", className)}
      style={{ display: "block" }}
    >
      <span className="ui-bar__fill" style={{ width: `${share(value) * 100}%` }} />
      {compare !== undefined && compare !== null && <span className="ui-bar__compare" style={{ left: `${share(compare) * 100}%` }} />}
    </span>
  );
}
