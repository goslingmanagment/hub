import type { ReactNode } from "react";
import { Link } from "react-router";

/** One tile: a label, the value in the main colour, what it changed by. No answer
 *  from the hub is «—» and «Hub не ответил», never a zero. */
export function Stat({ label, value, meta, to }: {
  label: ReactNode;
  value: ReactNode;
  meta?: ReactNode;
  to?: string;
}) {
  const body = (
    <>
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      {meta && <p className="stat-meta">{meta}</p>}
    </>
  );
  return to ? <Link to={to} className="stat block">{body}</Link> : <div className="stat">{body}</div>;
}

/** One strip with hairlines, not a row of frames. The first tile answers the
 *  screen's question; no more than four in a row. */
export function StatGrid({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`stat-grid ${className}`.trim()}>{children}</div>;
}
