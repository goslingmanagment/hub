import { useQuery } from "@tanstack/react-query";
import type {
  OverviewGrowthResponse,
  OverviewResponse,
  OverviewRevenueResponse,
  RevenueDailyResponse,
} from "@agency_hub_core/contracts";
import { api } from "./client.js";

export function useOverview() {
  return useQuery({
    queryKey: ["overview"],
    queryFn: () => api.get<OverviewResponse>("/api/v1/overview"),
  });
}

export function useOverviewRevenue(period: string) {
  return useQuery({
    queryKey: ["overviewRevenue", period],
    queryFn: () =>
      api.get<OverviewRevenueResponse>(`/api/v1/overview/revenue?period=${period}`),
  });
}

export function useOverviewGrowth(period: string) {
  return useQuery({
    queryKey: ["overviewGrowth", period],
    queryFn: () =>
      api.get<OverviewGrowthResponse>(`/api/v1/overview/growth?period=${period}`),
    placeholderData: (previousData) => previousData,
  });
}

export function useOverviewRevenueDaily(period = "30d") {
  return useQuery({
    queryKey: ["overviewRevenueDaily", period],
    queryFn: () =>
      api.get<RevenueDailyResponse>(`/api/v1/overview/revenue/daily?period=${period}`),
  });
}

