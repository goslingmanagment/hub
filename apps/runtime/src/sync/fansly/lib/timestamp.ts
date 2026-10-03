/** A Fansly REST timestamp as an instant: seconds, or milliseconds once the
 *  value reaches 1e12. */
export function normalizeFanslyTimestamp(value: number) {
  const ms = value >= 1_000_000_000_000 ? value : value * 1000;
  return new Date(ms);
}
