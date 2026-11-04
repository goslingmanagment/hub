/** A bar inside a table cell: the share of the largest value. Decoration: the
 *  number stands in its own column. */
export function ShareBar({ value, max, color = "var(--color-chart-blue)" }: { value: number; max: number; color?: string }) {
  const width = max > 0 && value > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="share-bar" aria-hidden="true">
      <div className="share-bar-fill" style={{ width: `${width}%`, background: color }} />
    </div>
  );
}
