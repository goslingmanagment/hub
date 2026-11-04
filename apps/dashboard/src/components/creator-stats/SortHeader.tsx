import { ArrowDown, ArrowUp } from "lucide-react";

export type SortDir = "asc" | "desc";

/** A column's header that sorts by it: the arrow only on the current column. */
export function SortHeader<K extends string>({ label, sortKey, current, dir, onSort, num = false }: {
  label: string;
  sortKey: K;
  current: K;
  dir: SortDir;
  onSort: (key: K) => void;
  num?: boolean;
}) {
  const active = sortKey === current;
  return (
    <th
      scope="col"
      className={[num ? "num" : "", active ? "is-sorted" : ""].filter(Boolean).join(" ") || undefined}
      aria-sort={active ? (dir === "desc" ? "descending" : "ascending") : undefined}
    >
      {/* A number's header keeps its text on the column's right edge: the arrow goes before it. */}
      <button type="button" className={`sort stats-sort${num ? " stats-sort-num" : ""}`} onClick={() => onSort(sortKey)}>
        {label}
        <span className="stats-sort-icon" aria-hidden="true">
          {active && dir === "asc" ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
        </span>
      </button>
    </th>
  );
}
