import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AdminSyncBlockBody,
  UpdateCredentialsBody,
} from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

export function useAdminConnections(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["admin", "connections"],
    queryFn: () => kernel.adminConnections(),
    enabled: options.enabled ?? true,
  });
}

export function useAdminSyncTrigger() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: { pageLabel: string; scope: "light" | "followers" | "all" | "data" | "messages" }) =>
      kernel.adminSyncTrigger({ body }),
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
    mutationFn: () => kernel.adminSyncTriggerAll(),
  });
}

export function useAdminSyncRuns(params: { pageLabel?: string; limit?: number; since?: string } = {}) {
  return useQuery({
    queryKey: ["admin", "syncRuns", params],
    queryFn: () => kernel.adminSyncRuns({
      query: params as Parameters<typeof kernel.adminSyncRuns>[0]["query"],
    }),
    refetchInterval: 10_000,
    placeholderData: (previousData) => previousData,
  });
}

export function useSyncMonitor(params: { pageLabel?: string; windowHours?: number; eventLimit?: number } = {}) {
  return useQuery({
    queryKey: ["syncMonitor", params],
    queryFn: () => kernel.syncStatus({
      query: params as Parameters<typeof kernel.syncStatus>[0]["query"],
    }),
    refetchInterval: 10_000,
  });
}

export function useSyncOverview() {
  return useQuery({
    queryKey: ["syncBlocks", "overview"],
    queryFn: () => kernel.syncOverview(),
    refetchInterval: 10_000,
  });
}

export function usePageSyncBlocks(pageLabel: string) {
  return useQuery({
    queryKey: ["syncBlocks", "page", pageLabel],
    queryFn: () => kernel.pageSyncBlocks({ params: { pageLabel } }),
    refetchInterval: 10_000,
    enabled: !!pageLabel,
  });
}

export function usePageMessagesBlock(pageLabel: string) {
  return useQuery({
    queryKey: ["syncBlocks", "page", pageLabel, "messages"],
    queryFn: () => kernel.pageMessagesBlock({ params: { pageLabel } }),
    refetchInterval: 10_000,
    enabled: !!pageLabel,
  });
}

export function useAdminSyncBlockTrigger() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminSyncBlockBody) =>
      kernel.adminSyncBlockTrigger({ body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["syncBlocks"] });
      void qc.invalidateQueries({ queryKey: ["syncMonitor"] });
      void qc.invalidateQueries({ queryKey: ["admin", "connections"] });
      void qc.invalidateQueries({ queryKey: ["overview"] });
    },
  });
}

export function useAdminSyncBlockPause() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminSyncBlockBody) =>
      kernel.adminSyncBlockPause({ body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["syncBlocks"] });
      void qc.invalidateQueries({ queryKey: ["syncMonitor"] });
      void qc.invalidateQueries({ queryKey: ["admin", "connections"] });
      void qc.invalidateQueries({ queryKey: ["overview"] });
    },
  });
}

export function useAdminSyncBlockResume() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminSyncBlockBody) =>
      kernel.adminSyncBlockResume({ body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["syncBlocks"] });
      void qc.invalidateQueries({ queryKey: ["syncMonitor"] });
      void qc.invalidateQueries({ queryKey: ["admin", "connections"] });
      void qc.invalidateQueries({ queryKey: ["overview"] });
    },
  });
}

export function useAdminSyncBlockReset() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminSyncBlockBody) =>
      kernel.adminSyncBlockReset({ body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["syncBlocks"] });
      void qc.invalidateQueries({ queryKey: ["syncMonitor"] });
      void qc.invalidateQueries({ queryKey: ["admin", "connections"] });
      void qc.invalidateQueries({ queryKey: ["overview"] });
    },
  });
}

export function useAdminUpdateCredentials(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: UpdateCredentialsBody) =>
      kernel.adminUpdateCredentials({ params: { pageLabel }, body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "connections"] });
      void qc.invalidateQueries({ queryKey: ["overview"] });
      void qc.invalidateQueries({ queryKey: ["syncBlocks"] });
      void qc.invalidateQueries({ queryKey: ["syncMonitor"] });
    },
  });
}
