import { ArrowDown, ArrowRight, ArrowUp } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { Link, useHref, useNavigate } from "react-router";
import { ruPlural } from "../plural.js";
import { cx } from "./cx.js";
import { Skeleton } from "./Skeleton.js";
import { Tooltip } from "./Tooltip.js";

export { Mark, type MarkProps } from "./Mark.js";

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
  /**
   * What the column counts, on hover and focus of its header (the app's
   * Tooltip; the header gets a dotted underline): «Половина ответов быстрее».
   */
  hint?: ReactNode;
  /** The same as `hint` (kept for old calls). */
  title?: string;
  /** Whether a long header may take two lines (default: only a text header longer than 12 letters). */
  headerWrap?: boolean;
  /**
   * The column that takes the room left over on a wide screen (a name, a text):
   * the numbers then stand close together instead of spreading over 1920 px.
   * Without any, a table of up to five columns gives it to its first text column.
   */
  grow?: boolean;
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
  /**
   * The router state the row's link leaves (a plain click and Enter; a new tab
   * has no history): `{ back }` from `useBackState(…)`, so «←» there comes back
   * here with the filters.
   */
  rowState?: (row: Row) => unknown;
  /** Instead of an address: a row that opens a panel. */
  onRowClick?: (row: Row) => void;
  /** The row that is open now (in a panel next to it): ink ground. */
  selectedKey?: string | null;
  /**
   * A row that matters less (someone switched off, a retired approach):
   * everything in it goes quiet — the name, the money, the numbers, the bars.
   */
  rowQuiet?: (row: Row) => boolean;
  /**
   * A total row among the rows («Вся команда» on top): 600, a quiet ground, a
   * firmer line under it; the table's own sorting leaves it on top.
   */
  rowEmphasis?: (row: Row) => boolean;
  /** A class of one's own for a row (rarely needed: prefer `rowQuiet`, `rowEmphasis`). */
  rowClassName?: (row: Row) => string | undefined;
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
  /**
   * How many lines the real rows have (a Person with a hint under the name is
   * two): the skeleton rows stand as tall, so nothing jumps when the rows come.
   */
  skeletonLines?: 1 | 2;
  /** No rows: one line across the table (an EmptyState). Without it an empty table renders nothing. */
  empty?: ReactNode;
  /** What the table is, for a screen reader. */
  label: string;
  /** 40 px rows instead of 48: long journals only. */
  dense?: boolean;
  /**
   * `middle` (default): every cell in the middle of its row. `first-line`: the
   * cells start at the top, so in rows of two-line cells («$115.95 / 7 продаж»)
   * every main number stands on the same line.
   */
  align?: "middle" | "first-line";
  /** `framed` (default): its own sheet. `bare`: inside a Card. */
  frame?: "framed" | "bare";
  /** The header sticks under the app's header while the page scrolls (default). */
  stickyHeader?: boolean;
  /** Always scroll sideways inside the frame (the header then does not stick). Without it the table does so by itself only when it does not fit. */
  scrollX?: boolean;
  /**
   * When the table is wider than its frame: the first so many columns stay in
   * place while the rest scroll (a name, a page, a total). The right edge then
   * fades and says how many columns are out of sight («ещё 5 →», a button that
   * scrolls).
   */
  stickyColumns?: number;
  /** The words of that button, an arrow follows by itself: `(n) => \`ещё ${n} ${ruPlural(n, "день", "дня", "дней")}\``. */
  moreLabel?: (hidden: number) => string;
  /** At most this wide (a short table on a 1920 screen that should not spread). */
  maxWidth?: number | string;
  className?: string;
}

const PLAIN_CONTROL = "a, button, input, select, textarea, label, [role='button'], [role='switch'], [role='menu'], [tabindex]:not([tabindex='-1']), [contenteditable]:not([contenteditable='false'])";

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
 * A header's words with the sort arrow glued to the nearest word (before the
 * first word in a number column, after the last one otherwise), so a header
 * that wraps keeps its arrow in its line; the hint's dotted underline under
 * the words only.
 */
function headerWords(header: ReactNode, icon: ReactNode, numeric: boolean, hinted: boolean): ReactNode {
  const underline = (node: ReactNode) => (hinted ? <span className="ui-hint">{node}</span> : node);
  if (icon === null) return underline(header);
  if (typeof header !== "string" || !header.trim().includes(" ")) {
    return <span className="ui-table__glue">{numeric && icon}{underline(header)}{!numeric && icon}</span>;
  }
  const words = header.trim().split(/\s+/);
  if (numeric) {
    const [first, ...rest] = words;
    return <><span className="ui-table__glue">{icon}{underline(first)}</span>{underline(` ${rest.join(" ")}`)}</>;
  }
  const last = words.pop();
  return <>{underline(`${words.join(" ")} `)}<span className="ui-table__glue">{underline(last)}{icon}</span></>;
}

const defaultMoreLabel = (hidden: number) => `ещё ${hidden} ${ruPlural(hidden, "столбец", "столбца", "столбцов")}`;

/** How wide the right edge fades when columns are out of sight (`.ui-table-frame--more` in the stylesheet). */
const FADE = 56;

/** Below this many pixels per column a table has no spare room to give away. */
const ROOMY_COLUMN = 220;

/**
 * The column that takes the spare width: the one marked `grow`; else, in a
 * roomy frame, a table of up to five columns without widths gives it to its
 * first text column.
 */
function growKeyOf<Row>(columns: readonly Column<Row>[], roomy: boolean): string | null {
  const marked = columns.find((column) => column.grow);
  if (marked) return marked.key;
  if (!roomy || columns.length > 5 || columns.some((column) => column.width !== undefined)) return null;
  return columns.find((column) => !column.numeric)?.key ?? null;
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
  rowState,
  onRowClick,
  selectedKey,
  rowQuiet,
  rowEmphasis,
  rowClassName,
  defaultSort = null,
  sort: controlledSort,
  onSortChange,
  loading = false,
  refreshing = false,
  skeletonRows = 6,
  skeletonLines = 1,
  empty,
  label,
  dense = false,
  align = "middle",
  frame = "framed",
  stickyHeader = true,
  scrollX = false,
  stickyColumns = 0,
  moreLabel = defaultMoreLabel,
  maxWidth,
  className,
}: TableProps<Row>) {
  const [ownSort, setOwnSort] = useState<SortState | null>(defaultSort);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const sticky = Math.max(0, Math.min(stickyColumns, columns.length - 1));
  // Wider than its place (many columns, a narrow window): scroll sideways inside
  // the frame instead of cutting the last columns. Only then does the header stop sticking.
  const [overflowing, setOverflowing] = useState(false);
  // Where the sticky columns stand (px from the table's left edge), how many columns are out of sight on the right, whether it has scrolled.
  const [stickyLeft, setStickyLeft] = useState<readonly number[]>([]);
  const [hidden, setHidden] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  // A frame with room to spare (a short table on a wide screen).
  const [roomy, setRoomy] = useState(false);

  const measure = useCallback(() => {
    const scroller = scrollRef.current;
    const table = tableRef.current;
    if (!scroller || !table) return;
    const over = table.scrollWidth > scroller.clientWidth + 1;
    setOverflowing(over);
    setRoomy(scroller.clientWidth >= columns.length * ROOMY_COLUMN);
    const heads = [...table.querySelectorAll<HTMLTableCellElement>(":scope > thead > tr > th")];
    if (sticky > 0 && heads.length > 0) {
      // Each fixed column stands right after the ones before it (no spacing between cells).
      const lefts: number[] = [];
      let left = 0;
      for (const head of heads.slice(0, sticky)) {
        lefts.push(left);
        left += head.offsetWidth;
      }
      setStickyLeft((current) => (current.length === lefts.length && current.every((value, index) => value === lefts[index]) ? current : lefts));
    }
    if (!over) {
      setHidden(0);
      setScrolled(false);
      return;
    }
    // The faded edge (56 px, the stylesheet's mask) is out of sight too; at the very end nothing is.
    const atEnd = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 1;
    const edge = scroller.getBoundingClientRect().right - FADE;
    setHidden(atEnd ? 0 : heads.slice(sticky).filter((head) => {
      const box = head.getBoundingClientRect();
      return box.left + box.width / 2 > edge;
    }).length);
    setScrolled(scroller.scrollLeft > 0);
  }, [columns.length, sticky]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const table = tableRef.current;
    if (!scroller || !table || typeof ResizeObserver === "undefined") return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    observer.observe(table);
    return () => observer.disconnect();
  }, [measure, rows.length === 0, loading, columns.length]);

  const sort = controlledSort !== undefined ? controlledSort : ownSort;
  const navigate = useNavigate();
  const base = useHref("/").replace(/\/$/, "");
  const growKey = useMemo(() => growKeyOf(columns, roomy), [columns, roomy]);

  const sorted = useMemo(() => {
    if (!sort || onSortChange) return rows;
    const column = columns.find((item) => item.key === sort.key);
    if (!column?.sortValue) return rows;
    const factor = sort.direction === "asc" ? 1 : -1;
    const sortValue = column.sortValue;
    // A total row («Вся команда») keeps its place on top: it is not one of the people being compared.
    const pinned = rowEmphasis ? rows.filter((row) => rowEmphasis(row)) : [];
    const rest = pinned.length > 0 ? rows.filter((row) => !rowEmphasis?.(row)) : [...rows];
    return [...pinned, ...rest.sort((left, right) => {
      const a = sortValue(left);
      const b = sortValue(right);
      // Missing values stay last in both directions.
      if (a === null || a === undefined || b === null || b === undefined) return compare(a, b);
      return compare(a, b) * factor;
    })];
  }, [columns, onSortChange, rowEmphasis, rows, sort]);

  function pressSort(column: Column<Row>) {
    const first = column.sortFirst ?? (column.numeric ? "desc" : "asc");
    const next: SortState = sort?.key === column.key
      ? { key: column.key, direction: sort.direction === "asc" ? "desc" : "asc" }
      : { key: column.key, direction: first };
    if (onSortChange) onSortChange(next);
    if (controlledSort === undefined) setOwnSort(next);
  }

  function scrollOn() {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const fixed = [...(tableRef.current?.querySelectorAll<HTMLTableCellElement>(":scope > thead > tr > th") ?? [])]
      .slice(0, sticky)
      .reduce((sum, head) => sum + head.offsetWidth, 0);
    scroller.scrollBy({ left: Math.max(120, scroller.clientWidth - fixed - 48), behavior: "smooth" });
  }

  const showEmpty = !loading && rows.length === 0;
  if (showEmpty && empty === undefined) return null;
  const hasFooter = !loading && rows.length > 0 && columns.some((column) => column.footer !== undefined);
  const scrolling = scrollX || overflowing;

  const stickyStyle = (index: number): CSSProperties | undefined => (index < sticky ? { left: stickyLeft[index] ?? 0 } : undefined);
  const stickyClass = (index: number) => index < sticky && cx("ui-table__sticky", index === sticky - 1 && "ui-table__sticky--last");
  const shrinks = (column: Column<Row>) => growKey !== null && column.key !== growKey && column.width === undefined && (column.numeric || column.nowrap);

  const cellClass = (column: Column<Row>, index: number) => cx(
    column.numeric && "ui-table__num",
    column.muted && "ui-table__muted",
    column.truncate && "ui-table__truncate",
    column.nowrap && "ui-table__nowrap",
    stickyClass(index),
    column.className,
  );

  return (
    <div
      className={cx("ui-table-frame", frame === "bare" && "ui-table-frame--bare", scrolling && "ui-table-frame--scroll", hidden > 0 && "ui-table-frame--more", className)}
      style={maxWidth !== undefined ? { maxWidth } : undefined}
    >
      <div ref={scrollRef} className="ui-table-scroll" onScroll={scrolling ? measure : undefined}>
        <table
          ref={tableRef}
          aria-label={label}
          aria-busy={loading || refreshing || undefined}
          className={cx(
            "ui-table",
            dense && "ui-table--dense",
            align === "first-line" && "ui-table--top",
            (!stickyHeader || scrolling) && "ui-table--static-head",
            refreshing && "ui-table--refreshing",
            scrolled && "ui-table--scrolled",
          )}
        >
          <colgroup>
            {columns.map((column) => (
              <col key={column.key} style={column.width !== undefined ? { width: column.width } : shrinks(column) ? { width: "1%" } : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((column, index) => {
                const active = sort?.key === column.key;
                const ariaSort = active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined;
                const SortIcon = active && sort.direction === "asc" ? ArrowUp : ArrowDown;
                const hint = column.hint ?? column.title;
                const hinted = hint !== undefined && hint !== null && hint !== "";
                const wraps = column.headerWrap ?? (!shrinks(column) && typeof column.header === "string" && column.header.length > 12);
                const icon = column.sortValue ? <SortIcon size={14} strokeWidth={2} aria-hidden className="ui-table__sort-icon" /> : null;
                const words = headerWords(column.header, icon, !!column.numeric, hinted);
                const content = column.sortValue ? (
                  <button type="button" className="ui-table__sort" onClick={() => pressSort(column)}>{words}</button>
                ) : hinted ? <span tabIndex={0} className="ui-table__head-hint">{words}</span> : column.header;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={ariaSort}
                    style={stickyStyle(index)}
                    className={cx(column.numeric && "ui-table__num", !wraps && "ui-table__th--nowrap", stickyClass(index)) || undefined}
                  >
                    {hinted ? <Tooltip content={hint} align={column.numeric ? "end" : "start"}>{content}</Tooltip> : content}
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
                    <td key={column.key} className={cellClass(column, columnIndex)} style={stickyStyle(columnIndex)}>
                      {/* As tall as the rows to come: a line is 24 px; a Person with a hint is two lines (44 px). */}
                      <span className="ui-table__skeleton" style={{ height: skeletonLines === 2 ? 44 : 24, justifyContent: column.numeric ? "flex-end" : "flex-start" }}>
                        {skeletonLines === 2 && columnIndex === 0 ? (
                          <>
                            <Skeleton width={28} height={28} radius="50%" />
                            <span className="ui-table__skeleton-lines">
                              <Skeleton width={96 + ((index * 37) % 60)} />
                              <Skeleton width={64 + ((index * 23) % 40)} height={12} />
                            </span>
                          </>
                        ) : (
                          <Skeleton width={column.numeric ? 64 : columnIndex === 0 ? 120 + ((index * 37) % 60) : 88 + ((index * 23 + columnIndex * 11) % 56)} />
                        )}
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
                        rowEmphasis?.(row) && "ui-table__row--emphasis",
                        rowClassName?.(row),
                      ) || undefined}
                      aria-selected={selectedKey === undefined ? undefined : selectedKey === key}
                      onClick={clickable ? (event) => {
                        if (href !== undefined && (event.metaKey || event.ctrlKey) && !(event.target as Element).closest("a")) {
                          window.open(`${base}${href}`, "_blank", "noopener");
                          return;
                        }
                        if (!isPlainClick(event) || event.metaKey || event.ctrlKey) return;
                        if (href !== undefined) navigate(href, rowState ? { state: rowState(row) } : undefined);
                        else onRowClick?.(row);
                      } : undefined}
                      onAuxClick={href !== undefined ? (event) => {
                        if (event.button === 1 && !(event.target as Element).closest("a")) window.open(`${base}${href}`, "_blank", "noopener");
                      } : undefined}
                    >
                      {columns.map((column, columnIndex) => {
                        const content = column.cell(row, rowIndex);
                        return (
                          <td key={column.key} className={cellClass(column, columnIndex)} style={stickyStyle(columnIndex)}>
                            {columnIndex === 0 && href !== undefined ? (
                              <Link to={href} state={rowState?.(row)} className="ui-table__rowlink">{content}</Link>
                            ) : columnIndex === 0 && onRowClick !== undefined ? (
                              <button type="button" className="ui-table__rowlink ui-table__rowbutton" onClick={() => onRowClick(row)}>
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
                {columns.map((column, index) => <td key={column.key} className={cellClass(column, index)} style={stickyStyle(index)}>{column.footer}</td>)}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {hidden > 0 && (
        <button type="button" className="ui-table__more" onClick={scrollOn}>
          {moreLabel(hidden)}
          <ArrowRight size={14} strokeWidth={2} aria-hidden />
        </button>
      )}
    </div>
  );
}
