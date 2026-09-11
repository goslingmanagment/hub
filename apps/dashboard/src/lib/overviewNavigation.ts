import type { CrossPageTransactionListQuery } from "@agency_hub_core/contracts";
import type { PeriodOption } from "@/stores/periodStore";
import { buildPageSectionRoute, isSafeInAppPath } from "./navigation.js";

export const OVERVIEW_PERIODS = ["today", "7d", "30d", "all"] as const;
export const PERIOD_LABELS: Record<PeriodOption, string> = {
  today: "Сегодня",
  "7d": "7 дней",
  "30d": "30 дней",
  all: "Всё время",
};
export type PageSort = "source" | "decline" | "growth";
export interface OverviewState {
  period: PeriodOption;
  row: string | null;
  chart: string;
  sort: PageSort;
}

export function parseOverviewState(
  params: URLSearchParams,
  fallback: PeriodOption,
): OverviewState {
  const period = params.get("period");
  const chart = params.get("chart");
  const sort = params.get("sort");
  return {
    period: OVERVIEW_PERIODS.includes(period as PeriodOption)
      ? (period as PeriodOption)
      : fallback,
    row: params.get("row") || null,
    chart:
      chart && /^(agency|(?:page|model):.+)$/.test(chart) ? chart : "agency",
    sort: sort === "decline" || sort === "growth" ? sort : "source",
  };
}

export function overviewSearch(state: OverviewState) {
  const params = new URLSearchParams({ period: state.period });
  if (state.row) params.set("row", state.row);
  if (state.chart !== "agency") params.set("chart", state.chart);
  if (state.sort !== "source") params.set("sort", state.sort);
  return params;
}

export function safeBackTo(params: URLSearchParams): string {
  const backTo = params.get("backTo");
  return backTo && isSafeInAppPath(backTo) ? backTo : "/";
}

export function buildRevenueTransactionsRoute(input: {
  pageLabel: string;
  from: string | null;
  to: string | null;
  type?: CrossPageTransactionListQuery["type"];
  backTo: string;
}) {
  const params = new URLSearchParams({
    pageLabel: input.pageLabel,
    reportableOnly: "true",
    backTo: input.backTo,
  });
  if (input.from && input.to) {
    params.set("from", input.from);
    params.set("to", input.to);
  }
  if (input.type) params.set("type", input.type);
  return `/transactions?${params}`;
}

export const SUBSCRIBER_FILTERS = [
  "all",
  "expiring7d",
  "new24h",
  "norenew",
] as const;
export type SubscriberFilter = (typeof SUBSCRIBER_FILTERS)[number];
export function subscriberFilter(value: string | null): SubscriberFilter {
  return SUBSCRIBER_FILTERS.includes(value as SubscriberFilter)
    ? (value as SubscriberFilter)
    : "all";
}
export function listOffset(value: string | null): number {
  const offset = Number(value);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}
export function buildSubscriberRoute(
  pageLabel: string,
  filter: SubscriberFilter,
  backTo: string,
) {
  return `${buildPageSectionRoute(pageLabel, "subscribers")}?${new URLSearchParams({ filter, backTo })}`;
}
