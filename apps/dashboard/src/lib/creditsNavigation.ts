/** The server supplies a dense UTC day series for the exact breakdown window.
 * Use those days, including zero days, rather than recalculating with the browser clock. */
export function creditBreakdownWindow(
  days: readonly { day: string }[] | undefined,
) {
  const dates = days?.map((row) => row.day).sort();
  if (!dates?.length) return null;
  return { from: dates[0]!, to: dates[dates.length - 1]! };
}
