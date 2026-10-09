// The link-series schedule as data: the scheduled windows (UTC), the cron that
// fires them, and the window an instant belongs to. One definition for the
// reconcile that stamps `window_at` on every attempt row and for everything
// that later asks "which window is this" or "how far apart are the windows".
// Pure: no imports, no clock of its own.

/** Hours (UTC) at which a window opens; the minute is shared. */
export const OFAPI_LINK_STATS_WINDOW_HOURS_UTC: readonly number[] = [4, 16];
export const OFAPI_LINK_STATS_WINDOW_MINUTE = 45;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** pg-boss cron for the windows above (evaluated in UTC). */
export const OFAPI_LINK_STATS_CRON =
  `${OFAPI_LINK_STATS_WINDOW_MINUTE} ${OFAPI_LINK_STATS_WINDOW_HOURS_UTC.join(",")} * * *`;

function windowsOfUtcDay(dayStartMs: number): number[] {
  return OFAPI_LINK_STATS_WINDOW_HOURS_UTC
    .map((hour) => dayStartMs + hour * HOUR_MS + OFAPI_LINK_STATS_WINDOW_MINUTE * 60 * 1000)
    .sort((left, right) => left - right);
}

function utcDayStartMs(at: Date): number {
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

/** The window an instant belongs to: the latest one that has opened by `at`.
 * A window stays open until the next one opens, so a late attempt — a retry,
 * a run after a rebind — still names the window whose point it is filling. */
export function ofapiLinkStatsWindowAt(at: Date): Date {
  const dayStartMs = utcDayStartMs(at);
  const opened = [...windowsOfUtcDay(dayStartMs - DAY_MS), ...windowsOfUtcDay(dayStartMs)]
    .filter((windowMs) => windowMs <= at.getTime());
  // Yesterday's windows are all in the past, so the list is never empty.
  return new Date(opened[opened.length - 1]!);
}

/** The window that opens after `windowAt` — the moment `windowAt` closes. */
export function nextOfapiLinkStatsWindowAt(windowAt: Date): Date {
  const dayStartMs = utcDayStartMs(windowAt);
  const later = [...windowsOfUtcDay(dayStartMs), ...windowsOfUtcDay(dayStartMs + DAY_MS)]
    .filter((windowMs) => windowMs > windowAt.getTime());
  return new Date(later[0]!);
}

/** The window that opened before `windowAt`. */
export function previousOfapiLinkStatsWindowAt(windowAt: Date): Date {
  return ofapiLinkStatsWindowAt(new Date(windowAt.getTime() - 1));
}

/** The longest gap between two consecutive windows: "one interval" for
 * anything that measures the series' freshness in windows. */
export const OFAPI_LINK_STATS_WINDOW_INTERVAL_MS = (() => {
  const windows = windowsOfUtcDay(0);
  const cycle = [...windows, windows[0]! + DAY_MS];
  let longest = 0;
  for (let index = 1; index < cycle.length; index += 1) {
    longest = Math.max(longest, cycle[index]! - cycle[index - 1]!);
  }
  return longest;
})();
