import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  WorkboardPresenceResponse,
  WorkboardResponse,
  WorkboardSnoozeResponse,
  WorkboardV2Response,
} from "@agency_hub_core/contracts";
import { api } from "./client.js";
import { pathSegment } from "@/lib/path";

export type WorkboardV2Tab = "subscribers" | "spenders" | "fresh_mass" | "old_mass" | "service";

export function useWorkboard(
  pageLabel: string,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["workboard", pageLabel],
    queryFn: () => api.get<WorkboardResponse>(`/api/v1/pages/${pathSegment(pageLabel)}/workboard`),
    enabled: options.enabled ?? true,
  });
}

export function useWorkboardPresence(
  pageLabel: string,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["workboard", "presence", pageLabel],
    queryFn: () => api.get<WorkboardPresenceResponse>(`/api/v1/pages/${pathSegment(pageLabel)}/workboard/presence`),
    enabled: options.enabled ?? true,
  });
}

export function useWorkboardSnooze(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { fanId: number; days: number }) =>
      api.post<WorkboardSnoozeResponse>(`/api/v1/pages/${pathSegment(pageLabel)}/workboard/snooze`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workboard", pageLabel] });
    },
  });
}

export function useWorkboardUnsnooze(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fanId: number) =>
      api.del<{ ok: true }>(`/api/v1/pages/${pathSegment(pageLabel)}/workboard/snooze/${fanId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workboard", pageLabel] });
    },
  });
}

// ── Workboard v2 (priority engine) ──────────────────────────────────────────

export function useWorkboardV2(
  pageLabel: string,
  params: { tab: WorkboardV2Tab; status?: string[]; limit?: number; offset?: number },
  options: { enabled?: boolean } = {},
) {
  const query = new URLSearchParams({ tab: params.tab });
  if (params.status && params.status.length > 0) {
    query.set("status", params.status.join(","));
  }
  if (params.limit != null) query.set("limit", String(params.limit));
  if (params.offset != null) query.set("offset", String(params.offset));

  return useQuery({
    queryKey: [
      "workboard-v2",
      pageLabel,
      params.tab,
      params.status?.join(",") ?? null,
      params.limit ?? 50,
      params.offset ?? 0,
    ],
    queryFn: () =>
      api.get<WorkboardV2Response>(
        `/api/v1/pages/${pathSegment(pageLabel)}/workboard/v2?${query.toString()}`,
      ),
    enabled: options.enabled ?? true,
  });
}

export function useWorkboardV2Contact(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { fanId: number; action?: "opened" | "handled" | "snoozed"; wasProductive?: boolean }) =>
      api.post<{ ok: true; fanId: number }>(
        `/api/v1/pages/${pathSegment(pageLabel)}/workboard/v2/contact`,
        body,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workboard-v2", pageLabel] });
    },
  });
}

export function useWorkboardV2Recompute(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ ok: true; evaluated: number }>(
        `/api/v1/pages/${pathSegment(pageLabel)}/workboard/v2/recompute`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workboard-v2", pageLabel] });
    },
  });
}
