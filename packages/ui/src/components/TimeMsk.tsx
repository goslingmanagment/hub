import { useEffect, useState } from "react";
import { formatAgo, formatDateTime, formatDay, formatTimeOfDay, formatWeekdayDay } from "../format.js";
import { cx } from "./cx.js";

export type TimeShow = "time" | "date" | "weekday" | "datetime" | "ago" | "datetime-ago";

/** Seconds since the epoch of the last minute: the same for every TimeMsk on a screen. */
function useMinuteTick(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [enabled]);
  return now;
}

/**
 * A moment in Moscow time (never the browser's, no «МСК» written):
 * - `time` «14:05»
 * - `date` «3 нояб.»
 * - `weekday` «вт, 3 нояб.»
 * - `datetime` «3 нояб., 14:05» (another year carries it)
 * - `ago` «5 мин назад» (only next to an exact time somewhere)
 * - `datetime-ago` «3 нояб., 14:05, 2 ч назад»
 * The full date and time is on hover. A relative time refreshes every half minute.
 */
export function TimeMsk({ at, show = "datetime", className }: { at: string | number | Date | null | undefined; show?: TimeShow; className?: string }) {
  const relative = show === "ago" || show === "datetime-ago";
  const now = useMinuteTick(relative);
  if (at === null || at === undefined || at === "") return <span className={cx("ui-time ui-muted", className)}>—</span>;
  const instant = new Date(at);
  if (Number.isNaN(instant.getTime())) return <span className={cx("ui-time ui-muted", className)}>—</span>;
  const iso = instant.toISOString();
  const full = formatDateTime(iso, { yearUnlessCurrent: true });
  let text: string;
  switch (show) {
    case "time":
      text = formatTimeOfDay(instant);
      break;
    case "date":
      text = formatDay(instant);
      break;
    case "weekday":
      text = formatWeekdayDay(instant);
      break;
    case "ago":
      text = formatAgo(instant, now);
      break;
    case "datetime-ago":
      text = `${full}, ${formatAgo(instant, now)}`;
      break;
    default:
      text = full;
  }
  return <time dateTime={iso} title={full} className={cx("ui-time", className)}>{text}</time>;
}
