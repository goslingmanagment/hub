import { MOSCOW_TIME_ZONE, businessDateToUtcStart } from "@agency_hub_core/shared";

/** The month before or after: «2026-11», 1 → «2026-12». */
export function stepMonth(month: string, by: number): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  const date = new Date(Date.UTC(year, number - 1 + by, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The month as Hub's income read takes a custom period: from the first day to the first day of the NEXT month,
 * because that read's upper bound is exclusive (`resolveCustomPeriodBounds`, [from, to)). With the month's last
 * day as `to` the last day's income was left out, and a closed month read «ledger больше» by exactly that day.
 * With `until` (the ledger card's cut, `monthCut`) the read counts only what occurred before that moment.
 */
export function monthWindow(month: string, until?: string | null): { from: string; to: string; until?: string } {
  return { from: `${month}-01`, to: `${stepMonth(month, 1)}-01`, ...(until ? { until } : {}) };
}

/**
 * The ledger's cut when its card covers the month only up to it: an `asOf` before the month's end, Moscow. The
 * card's «Доход страниц» is then what occurred before the cut — the month goes on, or the ledger has not taken the
 * facts since the month ended — and Hub's own income is asked up to the same moment, to set like beside like. Null:
 * the card is of the whole month (a cut at or past its end), or its cut is not known.
 */
export function monthCut(month: string, asOf: string | null): string | null {
  const at = asOf === null ? Number.NaN : Date.parse(asOf);
  if (asOf === null || !Number.isFinite(at)) return null;
  return at < businessDateToUtcStart(monthWindow(month).to, MOSCOW_TIME_ZONE).getTime() ? asOf : null;
}
