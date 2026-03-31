import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AdminSyncBlockBody,
  AdminSyncBlockResponse,
  ConnectionItem,
  PageMessagesBlockResponse,
  PageSyncBlocksResponse,
  SyncMonitorResponse,
  SyncOverviewResponse,
  SyncRunItem,
  VerifyCredentialsBody,
} from "@agency_hub_core/contracts";
import { api } from "./client.js";
import { qs } from "./utils.js";

export function useAdminConnections(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["admin", "connections"],
    queryFn: () => api.get<ConnectionItem[]>("/api/v1/admin/connections"),
    enabled: options.enabled ?? true,
  });
}

export function useAdminSyncTrigger() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: { pageLabel: string; scope: "light" | "followers" | "all" | "data" | "messages" }) =>
      api.post("/api/v1/admin/sync/trigger", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["syncMonitor"] });
      void qc.invalidateQueries({ queryKey: ["admin", "syncRuns"] });
      void qc.invalidateQueries({ queryKey: ["overview"] });
      void qc.invalidateQueries({ queryKey: ["admin", "connections"] });
    },
  });
}

export function useAdminSyncTriggerAll() {
  return useMutation({
    mutationFn: () => api.post("/api/v1/admin/sync/trigger-all"),
  });
}

export function useAdminSyncRuns(params: { pageLabel?: string; limit?: number; since?: string } = {}) {
  return useQuery({
    queryKey: ["admin", "syncRuns", params],
    queryFn: () => api.get<SyncRunItem[]>(`/api/v1/admin/sync/runs${qs(params)}`),
    refetchInterval: 10_000,
    placeholderData: (previousData) => previousData,
  });
}

export function useSyncMonitor(params: { pageLabel?: string; windowHours?: number; eventLimit?: number } = {}) {
  return useQuery({
    queryKey: ["syncMonitor", params],
    queryFn: () => api.get<SyncMonitorResponse>(`/api/v1/sync/status${qs(params)}`),
    refetchInterval: 10_000,
  });
}

export function useSyncOverview() {
  return useQuery({
    queryKey: ["syncBlocks", "overview"],
    queryFn: () => api.get<SyncOverviewResponse>("/api/v1/sync/overview"),
    refetchInterval: 10_000,
  });
}

export function usePageSyncBlocks(pageLabel: string) {
  return useQuery({
    queryKey: ["syncBlocks", "page", pageLabel],
    queryFn: () =>
      api.get<PageSyncBlocksResponse>(
        `/api/v1/pages/${encodeURIComponent(pageLabel)}/sync/blocks`,
      ),
    refetchInterval: 10_000,
    enabled: !!pageLabel,
  });
}

export function usePageMessagesBlock(pageLabel: string) {
  return useQuery({
    queryKey: ["syncBlocks", "page", pageLabel, "messages"],
    queryFn: () =>
      api.get<PageMessagesBlockResponse>(
        `/api/v1/pages/${encodeURIComponent(pageLabel)}/sync/blocks/messages`,
      ),
    refetchInterval: 10_000,
    enabled: !!pageLabel,
  });
}

export function useAdminSyncBlockTrigger() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminSyncBlockBody) =>
      api.post<AdminSyncBlockResponse>("/api/v1/admin/sync/blocks/trigger", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["syncBlocks"] });
    },
  });
}

export function useAdminSyncBlockPause() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminSyncBlockBody) =>
      api.post<AdminSyncBlockResponse>("/api/v1/admin/sync/blocks/pause", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["syncBlocks"] });
    },
  });
}

export function useAdminSyncBlockResume() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminSyncBlockBody) =>
      api.post<AdminSyncBlockResponse>("/api/v1/admin/sync/blocks/resume", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["syncBlocks"] });
    },
  });
}

export function useAdminSyncBlockReset() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminSyncBlockBody) =>
      api.post<AdminSyncBlockResponse>("/api/v1/admin/sync/blocks/reset", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["syncBlocks"] });
    },
  });
}

export function useAdminUpdateCredentials(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: VerifyCredentialsBody) =>
      api.patch(`/api/v1/admin/pages/${pageLabel}/credentials`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "connections"] }),
  });
}

