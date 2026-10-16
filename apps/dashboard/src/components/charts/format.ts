import { formatDurationMs } from "@/components/analytics/analytics-words";

/** Axis labels for money in mills. Presentation only — the exact amount is in
 *  the tooltip, formatted by the ledger's own `formatUsdFromMills`. */
const usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});
const usdWhole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const usdCents = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** `$0` · `$250` · `$1,500` · `$12K`; cents only when the axis steps below a
 *  dollar. `stepMills` is the axis' tick step. */
export function usdAxisFormatter(stepMills: number) {
  return (mills: number): string => {
    const dollars = mills / 1_000;
    if (Math.abs(dollars) >= 10_000) return usdCompact.format(dollars);
    return stepMills >= 1_000 ? usdWhole.format(dollars) : usdCents.format(dollars);
  };
}

const countCompact = new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 });
const countFull = new Intl.NumberFormat("ru-RU");

/** `0` · `500` · `1 500` · `12 тыс.` — a count on an axis. */
export function countAxisLabel(value: number): string {
  return Math.abs(value) >= 10_000 ? countCompact.format(value) : countFull.format(value);
}

/** A duration on an axis; the zero line is just `0`. */
export function durationAxisLabel(ms: number): string {
  return ms === 0 ? "0" : formatDurationMs(ms);
}
