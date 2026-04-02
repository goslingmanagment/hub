import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  WorkboardPresenceResponse,
  WorkboardResponse,
  WorkboardSnoozeResponse,
} from "@agency_hub_core/contracts";
import { api } from "./client.js";

export function useWorkboard(
  pageLabel: string,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["workboard", pageLabel],
    queryFn: () => api.get<WorkboardResponse>(`/api/v1/pages/${pageLabel}/workboard`),
    enabled: options.enabled ?? true,
  });
}

export function useWorkboardPresence(
  pageLabel: string,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["workboard", "presence", pageLabel],
    queryFn: () => api.get<WorkboardPresenceResponse>(`/api/v1/pages/${pageLabel}/workboard/presence`),
    enabled: options.enabled ?? true,
  });
}

export function useWorkboardSnooze(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { fanId: number; days: number }) =>
      api.post<WorkboardSnoozeResponse>(`/api/v1/pages/${pageLabel}/workboard/snooze`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workboard", pageLabel] });
    },
  });
}

export function useWorkboardUnsnooze(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fanId: number) =>
      api.del<{ ok: true }>(`/api/v1/pages/${pageLabel}/workboard/snooze/${fanId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workboard", pageLabel] });
    },
  });
}
