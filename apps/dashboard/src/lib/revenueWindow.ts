import type { PlatformRevenueWindow } from "@agency_hub_core/contracts";
import { formatUtcWindowRange } from "./format.js";

/**
 * The words of a revenue report's window (design/screens/home-money.md, «Даты»). The
 * hub counts these days in UTC with an exclusive end, and OnlyFans' windows run a day
 * longer: the dates are the server's, written as they are.
 */
export type RevenueWindow = Pick<PlatformRevenueWindow, "platform" | "from" | "to" | "comparisonFrom" | "comparisonTo">;

/** The window everything else is said against: Fansly's when there is one. */
export function mainRevenueWindow(windows: readonly RevenueWindow[]): RevenueWindow | null {
  return windows.find((window) => window.platform === "fansly") ?? windows[0] ?? null;
}

/** «21–27 окт.», or null when there is nothing to compare with. */
export function revenueComparisonRange(window: RevenueWindow | null): string | null {
  return window?.comparisonFrom && window.comparisonTo ? formatUtcWindowRange(window.comparisonFrom, window.comparisonTo) : null;
}

/**
 * The header's dates:
 * «28 окт. – 3 нояб., у OnlyFans с 27 окт., сравнение с 21–27 окт.»,
 * with a page «lora-1 · 28 окт. – 3 нояб., сравнение с 21–27 окт.»,
 * today «3 нояб., с 03:00 по Москве», all time «Вся сохранённая история».
 */
export function revenueWindowLabel(input: { windows: readonly RevenueWindow[]; period: string; pageLabel?: string | null | undefined }): string {
  const { windows, period, pageLabel } = input;
  const prefix = pageLabel ? `${pageLabel} · ` : "";
  const main = mainRevenueWindow(windows);
  if (period === "all" || !main?.from || !main.to) return `${prefix}Вся сохранённая история`;
  const range = formatUtcWindowRange(main.from, main.to);
  if (period === "today") return `${prefix}${range}, с 03:00 по Москве`;
  const other = windows.find((window) => window !== main && window.from && window.from !== main.from);
  const longer = other?.from ? `, у OnlyFans с ${formatUtcWindowRange(other.from, new Date(Date.parse(other.from) + 1).toISOString())}` : "";
  const comparison = revenueComparisonRange(main);
  return `${prefix}${range}${longer}${comparison ? `, сравнение с ${comparison}` : ""}`;
}
