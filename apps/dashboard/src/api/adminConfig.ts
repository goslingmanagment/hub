import { useQuery } from "@tanstack/react-query";
import type { ConfigViewResponse } from "@agency_hub_core/contracts";
import { api } from "./client.js";

export function useAdminConfig() {
  return useQuery({
    queryKey: ["admin", "config"],
    queryFn: () => api.get<ConfigViewResponse>("/api/v1/admin/config"),
    refetchInterval: 30_000,
  });
}
