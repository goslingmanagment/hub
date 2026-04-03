import { useQuery } from "@tanstack/react-query";
import type { AdminChatterUsageResponse } from "@agency_hub_core/contracts";
import { api } from "./client.js";
import { qs } from "./utils.js";

export function useAdminChatterUsage(params: { from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: ["admin", "usage", "chatters", params],
    queryFn: () => api.get<AdminChatterUsageResponse>(`/api/v1/admin/usage/chatters${qs(params)}`),
  });
}
