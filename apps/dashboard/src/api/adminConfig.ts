import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ConfigClearResponse,
  ConfigStagedBody,
  ConfigStagedResponse,
  ConfigUpdateBody,
  ConfigUpdateResponse,
  ConfigViewResponse,
} from "@agency_hub_core/contracts";
import { api } from "./client.js";
import { qs } from "./utils.js";

export function useAdminConfig() {
  return useQuery({
    queryKey: ["admin", "config"],
    queryFn: () => api.get<ConfigViewResponse>("/api/v1/admin/config"),
    refetchInterval: 30_000,
  });
}

export function useUpdateConfig() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: ConfigUpdateBody) =>
      api.patch<ConfigUpdateResponse>("/api/v1/admin/config", body),
    // Refetch after success AND failure: a 409 means the row changed elsewhere, so
    // the view (and overrideVersion) must refresh for the message to be true and the
    // retry to send the right expectedVersion.
    onSettled: () => qc.invalidateQueries({ queryKey: ["admin", "config"] }),
  });
}

export function useStagedConfig() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: ConfigStagedBody) =>
      api.patch<ConfigStagedResponse>("/api/v1/admin/config/staged", body),
    // Refetch after success AND failure: a 409 means the override row changed elsewhere
    // (refresh overrideVersion for the retry), and a 400 (order/ack) leaves running +
    // desired untouched but a refetch keeps the gate honest against the latest heartbeat.
    onSettled: () => qc.invalidateQueries({ queryKey: ["admin", "config"] }),
  });
}

export function useClearConfig() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: ({
      key,
      expectedVersion,
      note,
    }: {
      key: string;
      expectedVersion?: number;
      note?: string;
    }) =>
      api.del<ConfigClearResponse>(
        `/api/v1/admin/config/${encodeURIComponent(key)}${qs({ expectedVersion, note })}`,
      ),
    // Refetch after success AND failure: a 409 means the row changed elsewhere, so
    // the view (and overrideVersion) must refresh for the message to be true and the
    // retry to send the right expectedVersion.
    onSettled: () => qc.invalidateQueries({ queryKey: ["admin", "config"] }),
  });
}
