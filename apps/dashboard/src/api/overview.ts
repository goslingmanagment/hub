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

export function useOverviewGrowth(period: string) {
  return useQuery({
    queryKey: ["overviewGrowth", period],
    queryFn: () =>
      kernel.overviewGrowth({ query: { period } as RevenueQuery }),
    placeholderData: (previousData) => previousData,
  });
}

export function useOverviewRevenueDaily(period = "30d") {
  return useQuery({
    queryKey: ["overviewRevenueDaily", period],
    queryFn: () =>
      kernel.overviewRevenueDaily({ query: { period } as RevenueDailyQuery }),
  });
}

export function useOverviewRevenueByModel(period = "30d", windowAt?: string) {
  return useQuery({
    queryKey: ["overviewRevenueByModel", period, windowAt],
    queryFn: () =>
      kernel.overviewRevenueByModel({ query: { period, windowAt } as RevenueDailyQuery }),
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
