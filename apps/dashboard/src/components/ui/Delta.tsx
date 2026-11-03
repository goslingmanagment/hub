/**
 * The change against the last period: a sign, the sum, the percent. On income
 * and counters only, where more is better; a drop is not an alarm, so it never
 * wears the status red. On costs it stays in the main colour.
 */
export function Delta({ direction, children }: { direction: "up" | "down" | "flat"; children: string }) {
  const tone = direction === "up" ? "delta-up" : direction === "down" ? "delta-down" : "";
  return <span className={`delta ${tone}`.trim()}>{children}</span>;
}
