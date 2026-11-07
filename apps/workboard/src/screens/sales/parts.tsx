import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router";
import { Bar, Disclosure, ErrorState, Money, Notice, PageLabel, Person, Segmented, Tabs, Tooltip, cx, type Column } from "@agency_hub_core/ui";
import { formatDayRange } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { carryParams } from "@/shared/links";
import { usePeriod } from "@/shared/usePeriod";
import type { ReadWindow, SalesBy } from "./data";
import "./sales.css";

/**
 * The bits every tab of «Что продаёт» shares: its header with the tabs, the
 * cut (by page / by chatter) and the open panel in the address, money per
 * message as a bar, the row's «›», the honest line when a read covers other
 * days than the period. A share in a cell is the package's RateBar.
 */

export const TABS = [
  { tab: "price", label: "Цена" },
  { tab: "speed", label: "Скорость ответа" },
  { tab: "win-back", label: "Возврат фанов" },
  { tab: "greetings", label: "Приветствия и охват" },
] as const;

export type SalesTab = (typeof TABS)[number]["tab"];

/** The back label of a card opened from here: «← Что продаёт». */
export const BACK_LABEL = "Что продаёт";

/** The cut and the open panel, in the address: `?by=chatters`, `?open=chatter:4`. */
export function useSalesParams() {
  const [search, setSearch] = useSearchParams();
  const by: SalesBy = search.get("by") === "chatters" ? "chatters" : "pages";
  const open = search.get("open");
  const set = (key: "by" | "open", value: string | null) => setSearch((current) => {
    const next = new URLSearchParams(current);
    if (value === null) next.delete(key);
    else next.set(key, value);
    if (key === "by") next.delete("open");
    return next;
  }, { replace: key === "open" ? false : true });
  return {
    by,
    open,
    setBy: (value: SalesBy) => set("by", value === "pages" ? null : value),
    setOpen: (value: string | null) => set("open", value),
  };
}

/** The screen's header: h1, the period, the page filter, the tabs (the cut travels with them). */
export function SalesHeader({ meta, updatedAt, onRefresh, refreshing }: {
  meta: ReactNode;
  updatedAt: number | undefined;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const location = useLocation();
  const carried = carryParams(location.search);
  const by = new URLSearchParams(location.search).get("by");
  if (by === "chatters") carried.set("by", by);
  const search = carried.toString();
  return (
    <ScreenHeader
      title="Что продаёт"
      period
      pageFilter
      meta={meta}
      {...(updatedAt ? { updatedAt } : {})}
      onRefresh={onRefresh}
      refreshing={refreshing}
      tabs={<Tabs label="Разделы" items={TABS.map((item) => ({ to: { pathname: `/sales/${item.tab}`, search: search ? `?${search}` : "" }, label: item.label }))} />}
    />
  );
}

/** «По страницам | По чаттерам»: one switch for the lists that have both cuts. */
export function BySwitch<Value extends string = SalesBy>({ value, onChange, options }: {
  value: Value;
  onChange: (value: Value) => void;
  options?: ReadonlyArray<{ value: Value; label: string }>;
}) {
  const shown = options ?? ([{ value: "pages", label: "По страницам" }, { value: "chatters", label: "По чаттерам" }] as unknown as ReadonlyArray<{ value: Value; label: string }>);
  return <Segmented<Value> label="Как разбить" value={value} onChange={onChange} options={shown.map((option) => ({ ...option }))} />;
}

/** The window a read covers, in words: «2–7 нояб.». */
export function windowWords(from: string, to: string): string {
  return formatDayRange(from, to);
}

/**
 * The read covers other days than the period on screen (Hub counts back from
 * today, at most so many days): said once, above the numbers.
 */
export function WindowNotice({ window, maxDays, shown }: { window: ReadWindow; maxDays: number; shown?: string }) {
  const { period } = usePeriod();
  if (window.exact) return null;
  const words = shown ?? formatDayRange(window.from, window.to);
  return (
    <Notice title={`Здесь ${words}, а не ${period.label}`}>
      {window.clipped
        ? `Hub отдаёт эти числа не дальше чем на ${maxDays} ${ruPlural(maxDays, "день", "дня", "дней")} назад, поэтому начало периода не вошло.`
        : "Hub пока считает эти числа только до сегодняшнего дня, поэтому в них вошли и дни после периода."}
    </Notice>
  );
}

/** A share counts for a column's scale from this sample on: a small one may set it, «1 из 1» may not. */
export const SCALE_SAMPLE = 5;

/**
 * The scale of a column of bars: the largest share with a little room above it,
 * rounded up to 10 %, so the longest bar (and a team's mark next to it) never
 * runs into the end of the track.
 */
export function scaleOf(values: ReadonlyArray<number | null>): number {
  const top = Math.max(0, ...values.map((value) => value ?? 0));
  return top <= 0 ? 1 : Math.min(1, Math.ceil(top * 1.15 * 10) / 10);
}

/**
 * Money one sent message brought, as a bar of the column's largest and the sum.
 * A small sample has no bar, only a pale sum: a long pale bar would argue with
 * the marked best. The best is the sum in bold ink and a word (never yellow).
 */
export function MoneyBar({ mills, max, weak, best = false, total = false, wordSlot = false, compare, hint, emptyHint }: {
  mills: number | null;
  max: number;
  weak: boolean;
  best?: boolean;
  /** The total row: the sum in 600 under the column's sums, no bar of its own. */
  total?: boolean;
  /** Keep the slot for the best's word («больше всего») in every row, so the column lines up. */
  wordSlot?: boolean;
  /** Where everyone together stands: a thin mark on the bar. */
  compare?: number | null;
  hint?: ReactNode;
  emptyHint?: ReactNode;
}) {
  if (mills === null) {
    const empty = (
      <span className={cx("sales-money sales-money--weak", wordSlot && "sales-money--word")}>
        <span aria-hidden />
        <span className="sales-money__value">—</span>
        {wordSlot && <span aria-hidden />}
      </span>
    );
    return emptyHint ? <Tooltip content={emptyHint} className="sales-money-tip">{empty}</Tooltip> : empty;
  }
  const cell = (
    <span className={cx("sales-money", wordSlot && "sales-money--word", weak && "sales-money--weak", (best || total) && !weak && "sales-money--best")}>
      {weak || total ? <span aria-hidden className="sales-money__track" /> : <Bar value={mills} max={max} compare={compare ?? null} className="sales-money__bar" />}
      <span className="sales-money__value"><Money mills={mills} muted={weak} /></span>
      {wordSlot && <span className="sales-money__word">{best && !weak ? "больше всего" : null}</span>}
    </span>
  );
  return hint ? <Tooltip content={hint} className="sales-money-tip">{cell}</Tooltip> : cell;
}

/**
 * A table's columns for a side panel: only the named ones, at these widths.
 * `nowrapFirst` for a first column of one word (a price, a delay); a long name
 * (an approach) wraps instead of pushing the table out of the panel.
 */
export function panelColumns<Row>(columns: readonly Column<Row>[], widths: Readonly<Record<string, string>>, options: { nowrapFirst?: boolean } = {}): Column<Row>[] {
  return columns
    .filter((column) => widths[column.key] !== undefined)
    .map((column, index) => ({ ...column, width: widths[column.key], headerWrap: true, ...(index === 0 && options.nowrapFirst ? { nowrap: true } : {}) }));
}

/**
 * A bar column's width: its share of a table on 1440, but never wider than
 * the bar and its numbers need — on 1920 the spare room goes to the name
 * column (`grow`), not into a hole between the bar and its number.
 */
export function barWidth(percent: number, px: number): string {
  return `min(${percent}%, ${px}px)`;
}

/** A row that opens a panel ends in a quiet «›» (instead of «Нажмите на строку…» above the table). */
export function openColumn<Row>(): Column<Row> {
  return {
    key: "open",
    header: <span className="ui-sr-only">Открыть</span>,
    cell: () => <ChevronRight size={18} strokeWidth={1.75} aria-hidden className="sales-open" />,
    width: 44,
  };
}

/** The columns of a skeleton: no «›» (a grey bar there would stretch the narrow column). */
export function skeletonColumns<Row>(columns: readonly Column<Row>[]): Column<Row>[] {
  return columns.filter((column) => column.key !== "open");
}

/** A chatter, a page or an approach as the first cell of a row (inside a row that opens a panel: no link of its own). */
export function LineName({ kind, name, hint, platform, order, quiet = false }: {
  kind: "page" | "chatter" | "approach";
  name: string;
  hint?: ReactNode;
  platform?: string | null;
  /** An approach's place in the extension's list: a quiet «2» before the name. */
  order?: number | null;
  quiet?: boolean;
}) {
  if (kind === "chatter") return <Person name={name} {...(hint !== undefined ? { hint } : {})} />;
  if (kind === "page") return <PageLabel label={name} platform={platform ?? null} className="sales-name__main" />;
  return (
    <span className="sales-name">
      <span className={cx("sales-name__main", order !== undefined && order !== null && "sales-name__main--ordered", quiet && "sales-name__main--quiet")}>
        {order !== undefined && order !== null && <span className="sales-order">{order}</span>}
        <span>{name}</span>
      </span>
      {hint !== undefined && hint !== null && <span className="sales-sub">{hint}</span>}
    </span>
  );
}

/** «Как это считается»: the rules in plain words, folded at the bottom. */
export function HowItCounts({ children }: { children: ReactNode }) {
  return (
    <Disclosure summary="Как это считается">
      <div className="sales-how wb-readable">{children}</div>
    </Disclosure>
  );
}

/** Hub did not answer a block's read: not a zero. */
export function NoAnswer({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return <ErrorState compact onRetry={onRetry} retrying={retrying} />;
}
