import type { ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router";
import { Bar, Disclosure, ErrorState, Notice, Person, Segmented, Skeleton, Tabs, cx, type Column } from "@agency_hub_core/ui";
import { formatDayRange, formatPercent } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { carryParams } from "@/shared/links";
import { usePeriod } from "@/shared/usePeriod";
import type { ReadWindow, Rate, SalesBy } from "./data";
import "./sales.css";

/**
 * The bits every tab of «Что продаёт» shares: its header with the tabs, the
 * cut (by page / by chatter) and the open panel in the address, a share drawn
 * as a bar, the honest line when a read covers other days than the period.
 */

export const TABS = [
  { tab: "price", label: "Цена" },
  { tab: "speed", label: "Скорость ответа" },
  { tab: "win-back", label: "Возврат фанов" },
  { tab: "greetings", label: "Приветствия и охват" },
] as const;

export type SalesTab = (typeof TABS)[number]["tab"];

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
export function BySwitch({ value, onChange, chattersTitle }: { value: SalesBy; onChange: (value: SalesBy) => void; chattersTitle?: string }) {
  return (
    <Segmented<SalesBy>
      label="Как разбить"
      value={value}
      onChange={onChange}
      options={[
        { value: "pages", label: "По страницам" },
        { value: "chatters", label: "По чаттерам", ...(chattersTitle ? { title: chattersTitle } : {}) },
      ]}
    />
  );
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

/** The scale of a column of bars: the largest share, rounded up to 10 %. */
export function scaleOf(values: ReadonlyArray<number | null>): number {
  const top = Math.max(0, ...values.map((value) => value ?? 0));
  return top <= 0 ? 1 : Math.min(1, Math.ceil(top * 10) / 10);
}

/**
 * A share as a bar and its number. A small sample is drawn quietly and says
 * «2 из 4» instead of a percent: chance, not a fact. `of` 0 — «—».
 */
export function RateCell({ rate, min, max = 1, compare, tone = "neutral", empty = "—", emptyTitle, quiet = false }: {
  rate: Rate;
  min: number;
  max?: number;
  compare?: number | null;
  tone?: "neutral" | "mark";
  empty?: ReactNode;
  emptyTitle?: string;
  /** The row matters less (a retired approach): drawn as quietly as a small sample. */
  quiet?: boolean;
}) {
  if (rate.of === 0) {
    // Where the number would stand, so a column of «—» and «зреет» lines up with its percents.
    return (
      <span className="sales-rate sales-rate--weak" title={emptyTitle}>
        <span aria-hidden />
        <span className="sales-rate__num">{empty}</span>
      </span>
    );
  }
  const value = rate.hits / rate.of;
  const weak = rate.of < min || quiet;
  const words = `${formatPercent(value * 100)}: ${rate.hits} из ${rate.of}`;
  return (
    <span className={cx("sales-rate", weak && "sales-rate--weak")} title={rate.of < min ? `${words} — мало, чтобы судить` : words}>
      <Bar value={value} max={max} compare={compare ?? null} tone={weak ? "muted" : tone} label={words} className="sales-rate__bar" />
      <span className="sales-rate__num">{rate.of < min ? `${rate.hits} из ${rate.of}` : formatPercent(value * 100)}</span>
    </span>
  );
}

/**
 * A table's columns for a side panel: only the named ones, at these widths,
 * the first never wrapping (a price or a delay is one word there).
 */
export function panelColumns<Row>(columns: readonly Column<Row>[], widths: Readonly<Record<string, string>>): Column<Row>[] {
  return columns
    .filter((column) => widths[column.key] !== undefined)
    .map((column, index) => ({ ...column, width: widths[column.key], headerWrap: false, ...(index === 0 ? { nowrap: true } : {}) }));
}

/** A chatter or a page as the first cell of a row (inside a row that opens a panel: no link of its own). */
export function LineName({ kind, name, hint, quiet = false }: { kind: "page" | "chatter" | "approach"; name: string; hint?: ReactNode; quiet?: boolean }) {
  if (kind === "chatter") return <Person name={name} {...(hint !== undefined ? { hint } : {})} />;
  return (
    <span className="sales-name">
      <span className={cx("sales-name__main", quiet && "sales-name__main--quiet")}>{name}</span>
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

/** The first load of a block: grey lines of its shape. */
export function BlockSkeleton({ rows = 5, height = 48 }: { rows?: number; height?: number }) {
  return (
    <div className="sales-skeleton" aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="sales-skeleton__row" style={{ height }}>
          <Skeleton width={96 + ((index * 29) % 60)} />
          <Skeleton width={56} />
          <Skeleton width="40%" />
        </div>
      ))}
    </div>
  );
}

/** Hub did not answer a block's read: not a zero. */
export function NoAnswer({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return <ErrorState compact onRetry={onRetry} retrying={retrying} />;
}
