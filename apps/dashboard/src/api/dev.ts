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
    queryFn: () => kernel.adminSyncRunDetail({ params: { runId } }),
    enabled: runId > 0,
  });
}

export function useAdminQueueJobs(params: { state?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: ["admin", "queue", "jobs", params],
    queryFn: () => kernel.adminQueueJobs({
      query: params as Parameters<typeof kernel.adminQueueJobs>[0]["query"],
    }),
    refetchInterval: 10_000,
  });
}

export function useAdminDbStats() {
  return useQuery({
    queryKey: ["admin", "db", "stats"],
    queryFn: () => kernel.adminDbStats(),
  });
}

export function useAdminIncidents(params: { severity?: string; code?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: ["admin", "incidents", params],
    queryFn: () => kernel.adminIncidents({
      query: params as Parameters<typeof kernel.adminIncidents>[0]["query"],
    }),
    refetchInterval: 30_000,
  });
}

/** The owner's view of the chat extension's health reports for a range of days (chat-extension H-11c). */
export function useAdminClientHealth(params: { from: string; to: string }) {
  return useQuery({
    queryKey: ["admin", "client-health", params],
    queryFn: () => kernel.adminClientHealth({ query: params }),
    // The extension reports every 15 minutes; a minute is as fresh as the page gets.
    refetchInterval: 60_000,
  });
}
