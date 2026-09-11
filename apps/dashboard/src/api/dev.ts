import { useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

export function useAdminLogs(params: { severity?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: ["admin", "logs", params],
    queryFn: () => kernel.adminLogs({
      query: params as Parameters<typeof kernel.adminLogs>[0]["query"],
    }),
    refetchInterval: 10_000,
  });
}

export function useAdminSyncRunDetail(runId: number) {
  return useQuery({
    queryKey: ["admin", "syncRunDetail", runId],
    meta: { suppressGlobalError: true },
    queryFn: () => kernel.adminSyncRunDetail({ params: { runId } }),
    enabled: runId > 0,
  });
}

export function useAdminQueueJobs(params: { state?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: ["admin", "queue", "jobs", params],
    meta: { suppressGlobalError: true },
    queryFn: () => kernel.adminQueueJobs({
      query: params as Parameters<typeof kernel.adminQueueJobs>[0]["query"],
    }),
    refetchInterval: 10_000,
  });
}

export function useAdminDbStats() {
  return useQuery({
    queryKey: ["admin", "db", "stats"],
    meta: { suppressGlobalError: true },
    queryFn: () => kernel.adminDbStats(),
  });
}

export function useAdminIncidents(params: { severity?: string; code?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: ["admin", "incidents", params],
    meta: { suppressGlobalError: true },
    queryFn: () => kernel.adminIncidents({
      query: params as Parameters<typeof kernel.adminIncidents>[0]["query"],
    }),
    refetchInterval: 30_000,
  });
}
