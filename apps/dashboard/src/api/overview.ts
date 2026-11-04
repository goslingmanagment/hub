import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RevenueDailyQuery, RevenueQuery } from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

export function useOverview() {
  return useQuery({
    queryKey: ["overview"],
    queryFn: () => kernel.overview(),
    meta: { suppressGlobalError: true },
  });
}

export function useOverviewRevenue(period: string) {
  return useQuery({
    queryKey: ["overviewRevenue", period],
    queryFn: () =>
      kernel.overviewRevenue({ query: { period } as RevenueQuery }),
    meta: { suppressGlobalError: true },
  });
}

export function useRevenueChart(scope: string, period: string, windowAt: string | undefined, enabled: boolean) {
  const query = { period, windowAt } as RevenueDailyQuery;
  return useQuery({
    queryKey: ["revenueChart", scope, period, windowAt],
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
 * of `comparisonFrom`, `comparisonTo` as days. The hub's end is exclusive here too,
 * so `to` goes as it came (packages/shared/src/time.ts).
 */
export function useRevenueChartComparison(scope: string, from: string | null | undefined, to: string | null | undefined, enabled: boolean) {
  const days = from && to ? { from: from.slice(0, 10), to: to.slice(0, 10) } : null;
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

/** A report with a window reads anew when the UTC day turns, if the tab is in view. */
export function useRevenueMidnightRefetch(windowAt: string | undefined, period: string, refetch: () => unknown): void {
  useEffect(() => {
    if (!windowAt || period === "all") return;
    const windowDay = windowAt.slice(0, 10);
    function refreshIfNewDay() {
      if (document.visibilityState === "visible" && new Date().toISOString().slice(0, 10) !== windowDay) void refetch();
    }
    const nextDay = new Date();
    nextDay.setUTCHours(24, 0, 1, 0);
    const timer = window.setTimeout(refreshIfNewDay, windowDay === new Date().toISOString().slice(0, 10) ? nextDay.getTime() - Date.now() : 0);
    document.addEventListener("visibilitychange", refreshIfNewDay);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshIfNewDay);
    };
  }, [windowAt, period, refetch]);
}
