/** A grey line the height of the text to come: the same shape, no running shine. */
export function Skeleton({ width, className = "" }: { width?: number | string; className?: string }) {
  return <span className={`skeleton ${className}`.trim()} style={{ width }} aria-hidden="true" />;
}

/** A button or a control is waiting for its one answer. */
export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}
