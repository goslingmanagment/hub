import type { PlatformRevenueWindow } from "@agency_hub_core/contracts";
import { BUSINESS_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";
import { formatWindowRange } from "./format.js";

/**
 * The words of a revenue report's window (design/screens/home-money.md, «Даты»). The
 * hub counts these days in Moscow with an exclusive end; every platform shares the
 * same window.
 */
export type RevenueWindow = Pick<PlatformRevenueWindow, "platform" | "from" | "to" | "comparisonFrom" | "comparisonTo">;

/** The Moscow day (`YYYY-MM-DD`) an instant of a window falls on — Hub's business day. */
export function businessDayOf(at: string): string {
  return toBusinessDate(new Date(at), BUSINESS_TIME_ZONE);
}

/** The last day inside a window whose end is exclusive. */
export function lastBusinessDayOf(toExclusive: string): string {
  return toBusinessDate(new Date(Date.parse(toExclusive) - 1), BUSINESS_TIME_ZONE);
}

/** The window everything else is said against: Fansly's when there is one. */
export function mainRevenueWindow(windows: readonly RevenueWindow[]): RevenueWindow | null {
  return windows.find((window) => window.platform === "fansly") ?? windows[0] ?? null;
}

/** «21–27 окт.», or null when there is nothing to compare with. */
export function revenueComparisonRange(window: RevenueWindow | null): string | null {
  return window?.comparisonFrom && window.comparisonTo ? formatWindowRange(window.comparisonFrom, window.comparisonTo) : null;
}

/** «21–27 окт.», the previous window. */
export function revenuePreviousLabel(windows: readonly RevenueWindow[]): string | null {
  return revenueComparisonRange(mainRevenueWindow(windows));
}

/**
 * The header's dates:
 * «28 окт. – 3 нояб., сравнение с 21–27 окт.»,
 * with a page «mia-1 · 28 окт. – 3 нояб., сравнение с 21–27 окт.»,
 * today «3 нояб.», all time «Вся сохранённая история».
 */
export function revenueWindowLabel(input: { windows: readonly RevenueWindow[]; period: string; pageLabel?: string | null | undefined }): string {
  const { windows, period, pageLabel } = input;
  const prefix = pageLabel ? `${pageLabel} · ` : "";
  const main = mainRevenueWindow(windows);
  if (period === "all" || !main?.from || !main.to) return `${prefix}Вся сохранённая история`;
  const range = formatWindowRange(main.from, main.to);
  if (period === "today") return `${prefix}${range}`;
  const comparison = revenueComparisonRange(main);
  return `${prefix}${range}${comparison ? `, сравнение с ${comparison}` : ""}`;
}
