import { ArrowDown, ArrowUp } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Link, useHref, useNavigate } from "react-router";
import { cx } from "./cx.js";
import { Skeleton } from "./Skeleton.js";

export type SortDirection = "asc" | "desc";
export interface SortState {
  key: string;
  direction: SortDirection;
}

export interface Column<Row> {
  key: string;
  header: ReactNode;
  /** The cell. */
  cell: (row: Row, index: number) => ReactNode;
  /** Numbers: right edge, tabular figures, the header right too. */
  numeric?: boolean;
  /** Makes the column sortable: the value to compare (null and undefined go last). With `onSortChange` the caller sorts and this only marks the column sortable. */
  sortValue?: (row: Row) => number | string | bigint | null | undefined;
  /** The first press: numbers start from the largest. */
  sortFirst?: SortDirection;
  /** A line in the total row (tfoot). */
  footer?: ReactNode;
  /** Context, not the answer: the secondary colour. */
  muted?: boolean;
  /** One line, cut with «…» (give the column a width). */
  truncate?: boolean;
  /** Never wrap. */
  nowrap?: boolean;
  width?: number | string;
  /** On the header: what the column counts. */
  title?: string;
  /** Whether a long header may take two lines (default: only a text header longer than 12 letters). */
  headerWrap?: boolean;
  className?: string;
}

export interface TableProps<Row> {
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /**
   * The whole row opens this address. The first column's content becomes the
   * row's real link (keyboard, ⌘-click, middle click); a press anywhere else on
   * the row follows it too, unless it lands on a control inside.
   */
  rowHref?: (row: Row) => string | undefined;
  /** Instead of an address: a row that opens a panel. */
  onRowClick?: (row: Row) => void;
  /** The row that is open now (in a panel next to it): ink ground. */
  selectedKey?: string | null;
  /** A row that matters less (someone switched off): greyed. */
  rowQuiet?: (row: Row) => boolean;
  /** Uncontrolled sorting from here; null: the rows' own order. */
  defaultSort?: SortState | null;
  /** Controlled sorting (the server sorts, or the address keeps it). */
  sort?: SortState | null;
  onSortChange?: (sort: SortState) => void;
  /** The first load: skeleton rows of the same columns. */
  loading?: boolean;
  /** A new load over shown rows: the old rows at 60 %, no skeleton blinking. */
  refreshing?: boolean;
  skeletonRows?: number;
  /** No rows: one line across the table (an EmptyState). Without it an empty table renders nothing. */
  empty?: ReactNode;
  /** What the table is, for a screen reader. */
  label: string;
  /** 40 px rows instead of 48: long journals only. */
  dense?: boolean;
  /** `framed` (default): its own sheet. `bare`: inside a Card. */
  frame?: "framed" | "bare";
  /** The header sticks under the app's header while the page scrolls (default). */
  stickyHeader?: boolean;
  /** Always scroll sideways inside the frame (the header then does not stick). Without it the table does so by itself only when it does not fit. */
  scrollX?: boolean;
  className?: string;
}

const PLAIN_CONTROL = "a, button, input, select, textarea, label, [role='button'], [role='menu'], [tabindex]:not([tabindex='-1']), [contenteditable]:not([contenteditable='false'])";

function isPlainClick(event: MouseEvent<HTMLElement>): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.altKey || event.shiftKey) return false;
  if (window.getSelection()?.toString()) return false;
  return !(event.target as Element | null)?.closest?.(PLAIN_CONTROL);
}

function compare(left: unknown, right: unknown): number {
  const leftMissing = left === null || left === undefined;
  const rightMissing = right === null || right === undefined;
  if (leftMissing || rightMissing) return leftMissing === rightMissing ? 0 : leftMissing ? 1 : -1;
  if (typeof left === "string" && typeof right === "string") return left.localeCompare(right, "ru");
  const a = typeof left === "bigint" ? left : Number(left);
  const b = typeof right === "bigint" ? right : Number(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The one table. Comfortable rows (48 px, 15 px text), numbers on the right in
 * tabular figures, a header that sticks under the screen's header, sorting by
 * any column that has `sortValue`, the whole row as a link. Loading shows the
 * same columns as skeletons; an empty table shows one honest line.
 */
export function Table<Row>({
  columns,
  rows,
  rowKey,
  rowHref,
  onRowClick,
  selectedKey,
  rowQuiet,
  defaultSort = null,
  sort: controlledSort,
  onSortChange,
  loading = false,
  refreshing = false,
  skeletonRows = 6,
  empty,
  label,
  dense = false,
  frame = "framed",
  stickyHeader = true,
  scrollX = false,
  className,
}: TableProps<Row>) {
  const [ownSort, setOwnSort] = useState<SortState | null>(defaultSort);
  const frameRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  // Wider than its place (many columns, a narrow window): scroll sideways inside
  // the frame instead of cutting the last columns. Only then does the header stop sticking.
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const table = tableRef.current;
    if (!frame || !table || typeof ResizeObserver === "undefined") return;
    const check = () => setOverflowing(table.scrollWidth > frame.clientWidth + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(frame);
    observer.observe(table);
    return () => observer.disconnect();
  }, [rows.length === 0, loading]);
  const sort = controlledSort !== undefined ? controlledSort : ownSort;
  const navigate = useNavigate();
  const base = useHref("/").replace(/\/$/, "");

  const sorted = useMemo(() => {
    if (!sort || onSortChange) return rows;
    const column = columns.find((item) => item.key === sort.key);
    if (!column?.sortValue) return rows;
    const factor = sort.direction === "asc" ? 1 : -1;
    const sortValue = column.sortValue;
    return [...rows].sort((left, right) => {
      const a = sortValue(left);
      const b = sortValue(right);
      // Missing values stay last in both directions.
      if (a === null || a === undefined || b === null || b === undefined) return compare(a, b);
      return compare(a, b) * factor;
    });
  }, [columns, onSortChange, rows, sort]);

  function pressSort(column: Column<Row>) {
    const first = column.sortFirst ?? (column.numeric ? "desc" : "asc");
    const next: SortState = sort?.key === column.key
      ? { key: column.key, direction: sort.direction === "asc" ? "desc" : "asc" }
      : { key: column.key, direction: first };
    if (onSortChange) onSortChange(next);
    if (controlledSort === undefined) setOwnSort(next);
  }

  const showEmpty = !loading && rows.length === 0;
  if (showEmpty && empty === undefined) return null;
  const hasFooter = !loading && rows.length > 0 && columns.some((column) => column.footer !== undefined);

  const cellClass = (column: Column<Row>) => cx(
    column.numeric && "ui-table__num",
    column.muted && "ui-table__muted",
    column.truncate && "ui-table__truncate",
    column.nowrap && "ui-table__nowrap",
    column.className,
  );

  return (
    <div ref={frameRef} className={cx("ui-table-frame", frame === "bare" && "ui-table-frame--bare", (scrollX || overflowing) && "ui-table-frame--scroll", className)}>
      <table
        ref={tableRef}
        aria-label={label}
        aria-busy={loading || refreshing || undefined}
        className={cx("ui-table", dense && "ui-table--dense", (!stickyHeader || scrollX || overflowing) && "ui-table--static-head", refreshing && "ui-table--refreshing")}
      >
        <colgroup>
          {columns.map((column) => <col key={column.key} style={column.width !== undefined ? { width: column.width } : undefined} />)}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => {
              const active = sort?.key === column.key;
              const ariaSort = active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined;
              const SortIcon = active && sort.direction === "asc" ? ArrowUp : ArrowDown;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={ariaSort}
                  title={column.title}
                  className={cx(
                    column.numeric && "ui-table__num",
                    !(column.headerWrap ?? (typeof column.header === "string" && column.header.length > 12)) && "ui-table__th--nowrap",
                  ) || undefined}
                >
                  {column.sortValue ? (
                    <button type="button" className="ui-table__sort" onClick={() => pressSort(column)}>
                      {column.header}
                      <SortIcon size={14} strokeWidth={2} aria-hidden className="ui-table__sort-icon" />
                    </button>
                  ) : column.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: skeletonRows }, (_, index) => (
              <tr key={`skeleton-${index}`} aria-hidden>
                {columns.map((column, columnIndex) => (
                  <td key={column.key} className={cellClass(column)}>
                    {/* A line's height (24 px), so the skeleton rows stand as tall as the rows to come. */}
                    <span style={{ display: "flex", alignItems: "center", justifyContent: column.numeric ? "flex-end" : "flex-start", height: 24 }}>
                      <Skeleton width={column.numeric ? 64 : columnIndex === 0 ? 120 + ((index * 37) % 60) : 88 + ((index * 23 + columnIndex * 11) % 56)} />
                    </span>
                  </td>
                ))}
              </tr>
            ))
            : showEmpty
              ? (
                <tr className="ui-table__empty">
                  <td colSpan={columns.length}>{empty}</td>
                </tr>
              )
              : sorted.map((row, rowIndex) => {
                const key = rowKey(row);
                const href = rowHref?.(row);
                const clickable = href !== undefined || onRowClick !== undefined;
                return (
                  <tr
                    key={key}
                    className={cx(
                      clickable && "ui-table__row--link",
                      selectedKey === key && "ui-table__row--selected",
                      rowQuiet?.(row) && "ui-table__row--quiet",
                    )}
                    aria-selected={selectedKey === undefined ? undefined : selectedKey === key}
                    onClick={clickable ? (event) => {
                      if (href !== undefined && (event.metaKey || event.ctrlKey) && !(event.target as Element).closest("a")) {
                        window.open(`${base}${href}`, "_blank", "noopener");
                        return;
                      }
                      if (!isPlainClick(event) || event.metaKey || event.ctrlKey) return;
                      if (href !== undefined) navigate(href);
                      else onRowClick?.(row);
                    } : undefined}
                    onAuxClick={href !== undefined ? (event) => {
                      if (event.button === 1 && !(event.target as Element).closest("a")) window.open(`${base}${href}`, "_blank", "noopener");
                    } : undefined}
                  >
                    {columns.map((column, columnIndex) => {
                      const content = column.cell(row, rowIndex);
                      return (
                        <td key={column.key} className={cellClass(column)}>
                          {columnIndex === 0 && href !== undefined ? (
                            <Link to={href} className="ui-table__rowlink">{content}</Link>
                          ) : columnIndex === 0 && onRowClick !== undefined ? (
                            <button
                              type="button"
                              className="ui-table__rowlink"
                              style={{ padding: 0, border: 0, background: "transparent", font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer" }}
                              onClick={() => onRowClick(row)}
                            >
                              {content}
                            </button>
                          ) : content}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
        </tbody>
        {hasFooter && (
          <tfoot>
            <tr>
              {columns.map((column) => <td key={column.key} className={cellClass(column)}>{column.footer}</td>)}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** An outlier against the team inside a cell: one calm colour, no grading. */
export function Mark({ children, title }: { children: ReactNode; title?: string }) {
  return <span className="ui-mark" title={title}>{children}</span>;
}
