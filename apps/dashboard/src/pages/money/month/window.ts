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
 */
export function monthWindow(month: string): { from: string; to: string } {
  return { from: `${month}-01`, to: `${stepMonth(month, 1)}-01` };
}
