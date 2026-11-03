import type { ReactNode } from "react";

export interface KeyValueRow {
  label: ReactNode;
  value: ReactNode;
}

/** The properties of one object: a label and its value. An empty value is «—». */
export function KeyValue({ rows, className = "" }: { rows: readonly KeyValueRow[]; className?: string }) {
  return (
    <dl className={`kv ${className}`.trim()}>
      {rows.map((row, index) => (
        <div key={index} className="contents">
          <dt>{row.label}</dt>
          <dd>{row.value === null || row.value === undefined || row.value === "" ? "—" : row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
