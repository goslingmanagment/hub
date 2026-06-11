import { useQuery } from "@tanstack/react-query";
import type {
  OfapiCreditsDailyResponse,
  OfapiCreditsLedgerResponse,
  OfapiCreditsSummaryResponse,
} from "@agency_hub_core/contracts";
import { api } from "./client.js";
import { qs } from "./utils.js";

export function useAdminOfapiCreditsSummary() {
  return useQuery({
    queryKey: ["admin", "ofapi-credits", "summary"],
    queryFn: () => api.get<OfapiCreditsSummaryResponse>("/api/v1/admin/ofapi/credits/summary"),
    refetchInterval: 60_000,
  });
}

export function useAdminOfapiCreditsDaily(days: number) {
  return useQuery({
    queryKey: ["admin", "ofapi-credits", "daily", days],
    queryFn: () => api.get<OfapiCreditsDailyResponse>(`/api/v1/admin/ofapi/credits/daily${qs({ days })}`),
  });
}

export interface AdminOfapiCreditsLedgerParams {
  offset: number;
  limit: number;
  source?: string;
  pageId?: number;
  operation?: string;
  from?: string;
  to?: string;
}

export function useAdminOfapiCreditsLedger(params: AdminOfapiCreditsLedgerParams) {
  return useQuery({
    queryKey: ["admin", "ofapi-credits", "ledger", params],
    queryFn: () => api.get<OfapiCreditsLedgerResponse>(`/api/v1/admin/ofapi/credits/ledger${qs({ ...params })}`),
  });
}
