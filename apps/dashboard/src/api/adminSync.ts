import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AdminSyncBlockBody,
  SyncHistoryRequestsQuery,
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

/** The Fansly Sync Engine's status of every page (`/api/v1/sync/pages`,
 *  owner session): mode, owner, holds, socket, queue by why it waits. */
export function useSyncEnginePages(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["syncEngine", "pages"],
    queryFn: () => kernel.syncPages(),
    refetchInterval: 10_000,
    enabled: options.enabled ?? true,
  });
}

/** The engine's history requests, newest first (`/api/v1/sync/history-requests`,
 *  owner session): fans ready, reads made and left, the ETA and why each
 *  waits. A request moves one read at a time, so it is polled slower than the
 *  page status. */
export function useSyncHistoryRequests(
  query: Partial<Pick<SyncHistoryRequestsQuery, "pageLabel" | "state" | "limit">>,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["syncEngine", "historyRequests", query.pageLabel ?? null, query.state ?? null, query.limit ?? null],
    queryFn: () => kernel.syncHistoryRequests({ query }),
    refetchInterval: 30_000,
    enabled: options.enabled ?? true,
  });
}
