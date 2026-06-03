import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  WorkboardPresenceResponse,
  WorkboardResponse,
  WorkboardSnoozeResponse,
  WorkboardV2AiClassifyResponse,
  WorkboardV2AiReport,
  WorkboardV2AiRunsResponse,
  WorkboardV2AiSettingsBody,
  WorkboardV2ListsResponse,
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

// Spender lists (gross-spend bands) — optional view over the v2 board. Keyed under
// the same ["workboard-v2", pageLabel] prefix so the existing contact/snooze
// mutations invalidate it too (React Query matches keys by prefix).
export function useWorkboardV2Lists(
  pageLabel: string,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["workboard-v2", pageLabel, "lists"],
    queryFn: () =>
      api.get<WorkboardV2ListsResponse>(
        `/api/v1/pages/${pathSegment(pageLabel)}/workboard/v2/lists`,
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

export function useWorkboardV2Snooze(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { fanId: number; days: number }) =>
      api.post<{ ok: true; fanId: number; snoozedUntil: string | null }>(
        `/api/v1/pages/${pathSegment(pageLabel)}/workboard/v2/snooze`,
        body,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workboard-v2", pageLabel] });
    },
  });
}

export function useWorkboardV2Unsnooze(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fanId: number) =>
      api.del<{ ok: true; fanId: number }>(`/api/v1/pages/${pathSegment(pageLabel)}/workboard/v2/snooze/${fanId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workboard-v2", pageLabel] });
    },
  });
}

export function useWorkboardV2UndoContact(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fanId: number) =>
      api.del<{ ok: true; fanId: number }>(`/api/v1/pages/${pathSegment(pageLabel)}/workboard/v2/contact/${fanId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workboard-v2", pageLabel] });
    },
  });
}

// ── Workboard v2 AI analytics (L2 closing classifier) ────────────────────────

export function useWorkboardV2Ai(
  pageLabel: string,
  options: { enabled?: boolean; refetchInterval?: number | false } = {},
) {
  return useQuery({
    queryKey: ["workboard-v2-ai", pageLabel],
    queryFn: () =>
      api.get<WorkboardV2AiReport>(`/api/v1/pages/${pathSegment(pageLabel)}/workboard/v2/ai`),
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchInterval,
  });
}

export function useWorkboardV2AiSettings(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: WorkboardV2AiSettingsBody) =>
      api.put<WorkboardV2AiReport>(`/api/v1/pages/${pathSegment(pageLabel)}/workboard/v2/ai/settings`, body),
    onSuccess: (data) => {
      qc.setQueryData(["workboard-v2-ai", pageLabel], data);
      qc.invalidateQueries({ queryKey: ["workboard-v2", pageLabel] });
    },
  });
}

export function useWorkboardV2AiClassify(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { reclassify?: boolean }) =>
      api.post<WorkboardV2AiClassifyResponse>(
        `/api/v1/pages/${pathSegment(pageLabel)}/workboard/v2/ai/classify`,
        body,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workboard-v2-ai", pageLabel] });
      qc.invalidateQueries({ queryKey: ["workboard-v2", pageLabel] });
      qc.invalidateQueries({ queryKey: ["workboard-v2-ai-runs"] });
    },
  });
}

export function useWorkboardV2AiRuns(
  options: {
    enabled?: boolean;
    // number | false, or a fn of the latest data (so callers can poll fast while a run is live).
    refetchInterval?: number | false | ((data: WorkboardV2AiRunsResponse | undefined) => number | false);
  } = {},
) {
  const ri = options.refetchInterval;
  return useQuery({
    queryKey: ["workboard-v2-ai-runs"],
    queryFn: () => api.get<WorkboardV2AiRunsResponse>(`/api/v1/workboard/ai/runs`),
    enabled: options.enabled ?? true,
    refetchInterval: typeof ri === "function" ? (query) => ri(query.state.data) : ri,
  });
}
