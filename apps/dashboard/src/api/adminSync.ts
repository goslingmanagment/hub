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

export function useAdminSyncBlockTrigger() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminSyncBlockBody) =>
      kernel.adminSyncBlockTrigger({ body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["syncBlocks"] });
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
    },
  });
}
