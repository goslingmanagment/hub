import { useQuery } from "@tanstack/react-query";
import type { RevenueDailyQuery, RevenueQuery } from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

export function useOverview() {
  return useQuery({
    queryKey: ["overview"],
    queryFn: () => kernel.overview(),
  });
}

export function useOverviewRevenue(period: string) {
  return useQuery({
    queryKey: ["overviewRevenue", period],
    queryFn: () =>
      kernel.overviewRevenue({ query: { period } as RevenueQuery }),
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
