import { useQuery } from "@tanstack/react-query";
import type { RevenueDailyQuery, RevenueQuery } from "@agency_hub_core/contracts";

import { businessDayOf } from "@/lib/revenueWindow";

import { kernel } from "./sdk.js";

export function useOverview() {
  return useQuery({
    queryKey: ["overview"],
    queryFn: () => kernel.overview(),
    meta: { suppressGlobalError: true },
  });
}

/** The home's money reads itself again every minute while the tab is in view,
 *  and at once when the owner comes back to it: new sales show without a reload. */
export const REVENUE_REFRESH_MS = 60_000;

export function useOverviewRevenue(period: string) {
  return useQuery({
    queryKey: ["overviewRevenue", period],
    queryFn: () =>
      kernel.overviewRevenue({ query: { period } as RevenueQuery }),
    refetchInterval: REVENUE_REFRESH_MS,
    refetchOnWindowFocus: true,
    meta: { suppressGlobalError: true },
  });
}

/** A new clock of the same chart keeps the old line until the new one comes, so
 *  the minute refresh does not blink; another scope or period starts clean. */
function sameChart(scope: string, period: string) {
  return <T,>(previous: T | undefined, previousQuery: { queryKey: readonly unknown[] } | undefined) =>
    previousQuery?.queryKey[1] === scope && previousQuery.queryKey[2] === period ? previous : undefined;
}

export function useRevenueChart(scope: string, period: string, windowAt: string | undefined, enabled: boolean) {
  const query = { period, windowAt } as RevenueDailyQuery;
  return useQuery({
    queryKey: ["revenueChart", scope, period, windowAt],
    placeholderData: sameChart(scope, period),
    queryFn: () => {
      if (scope.startsWith("page:")) return kernel.pageRevenueDaily({ params: { pageLabel: scope.slice(5) }, query });
      if (scope.startsWith("model:")) return kernel.modelRevenueDaily({ params: { modelSlug: scope.slice(6) }, query });
      return kernel.overviewRevenueDaily({ query });
    },
    enabled,
    meta: { suppressGlobalError: true },
  });
}

/**
 * The same chart's line for the previous window, as its own read: the from and to
 * of `comparisonFrom`, `comparisonTo` as Moscow days. The hub's end is exclusive
 * here too, so `to` is the day the window's end falls on (packages/shared/src/time.ts).
 */
export function useRevenueChartComparison(scope: string, from: string | null | undefined, to: string | null | undefined, enabled: boolean) {
  const days = from && to ? { from: businessDayOf(from), to: businessDayOf(to) } : null;
  const query = { period: "custom", ...days } as RevenueDailyQuery;
  return useQuery({
    queryKey: ["revenueChart", scope, "custom", days],
    queryFn: () => {
      if (scope.startsWith("page:")) return kernel.pageRevenueDaily({ params: { pageLabel: scope.slice(5) }, query });
      if (scope.startsWith("model:")) return kernel.modelRevenueDaily({ params: { modelSlug: scope.slice(6) }, query });
      return kernel.overviewRevenueDaily({ query });
    },
    enabled: enabled && days !== null,
    meta: { suppressGlobalError: true },
  });
}
