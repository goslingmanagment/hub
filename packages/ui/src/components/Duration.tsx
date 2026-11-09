import { formatDuration } from "../format.js";
import { cx } from "./cx.js";

/**
 * How long: «7 ч 28 мин», «47 мин»; `days` for how long something has been so:
 * «2 дня 4 ч». Hours of work are never a fraction. null: «—».
 */
export function Duration({ minutes, seconds, days = false, className, title }: {
  minutes?: number | null | undefined;
  /** When the answer counts seconds: rounded to minutes. */
  seconds?: number | null | undefined;
  days?: boolean;
  className?: string;
  title?: string;
}) {
  const value = minutes ?? (seconds === null || seconds === undefined ? null : Math.round(seconds / 60));
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className={cx("ui-duration ui-muted", className)} title={title}>—</span>;
  }
  if (seconds !== undefined && seconds !== null && minutes === undefined && seconds < 60) {
    return <span className={cx("ui-duration", className)} title={title}>{`${Math.round(seconds)} с`}</span>;
  }
  return <span className={cx("ui-duration", className)} title={title}>{formatDuration(Math.max(0, Math.round(value)), { days })}</span>;
}
