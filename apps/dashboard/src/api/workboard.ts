import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  WorkboardV2AiRunsResponse,
  WorkboardV2AiSettingsBody,
} from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

export type WorkboardV2Tab = "subscribers" | "spenders" | "fresh_mass" | "old_mass" | "service";

// ── Workboard v2 (priority engine) ──────────────────────────────────────────

export function useWorkboardV2(
  pageLabel: string,
  params: { tab: WorkboardV2Tab; status?: string[]; limit?: number; offset?: number },
  options: { enabled?: boolean } = {},
) {
  // The wire shape keeps the comma-joined single `status` param the previous
  // client sent (the schema splits it server-side).
  const query = {
    tab: params.tab,
    status: params.status && params.status.length > 0 ? params.status.join(",") : undefined,
    limit: params.limit ?? undefined,
    offset: params.offset ?? undefined,
  };

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
      kernel.workboardV2({
        params: { pageLabel },
        query: query as Parameters<typeof kernel.workboardV2>[0]["query"],
      }),
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
    queryFn: () => kernel.workboardV2Lists({ params: { pageLabel } }),
    enabled: options.enabled ?? true,
  });
}

export function useWorkboardV2Contact(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { fanId: number; action?: "opened" | "handled" | "snoozed"; wasProductive?: boolean }) =>
      kernel.workboardV2Contact({ params: { pageLabel }, body }),
    onMutate: () => ({ pageLabel }),
    onSuccess: (_result, _variables, origin) => {
      qc.invalidateQueries({ queryKey: ["workboard-v2", origin.pageLabel] });
    },
  });
}

export function useWorkboardV2Recompute(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      kernel.workboardV2Recompute({ params: { pageLabel } }),
    onMutate: () => ({ pageLabel }),
    onSuccess: (_result, _variables, origin) => {
      qc.invalidateQueries({ queryKey: ["workboard-v2", origin.pageLabel] });
    },
  });
}

export function useWorkboardV2Snooze(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { fanId: number; days: number }) =>
      kernel.workboardV2Snooze({
        params: { pageLabel },
        body: body as Parameters<typeof kernel.workboardV2Snooze>[0]["body"],
      }),
    onMutate: () => ({ pageLabel }),
    onSuccess: (_result, _variables, origin) => {
      qc.invalidateQueries({ queryKey: ["workboard-v2", origin.pageLabel] });
    },
  });
}

export function useWorkboardV2Unsnooze() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (target: { pageLabel: string; fanId: number }) =>
      kernel.workboardV2Unsnooze({ params: target }),
    onSuccess: (_result, target) => {
      qc.invalidateQueries({ queryKey: ["workboard-v2", target.pageLabel] });
    },
  });
}

export function useWorkboardV2UndoContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (target: { pageLabel: string; fanId: number }) =>
      kernel.workboardV2UndoContact({ params: target }),
    onSuccess: (_result, target) => {
      qc.invalidateQueries({ queryKey: ["workboard-v2", target.pageLabel] });
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
    meta: { suppressGlobalError: true },
    queryFn: () => kernel.workboardV2Ai({ params: { pageLabel } }),
    enabled: options.enabled ?? true,
    ...(options.refetchInterval === undefined ? {} : { refetchInterval: options.refetchInterval }),
  });
}

export function useWorkboardV2AiSettings(pageLabel: string) {
  const qc = useQueryClient();
  const mutationKey = ["workboard-v2-ai-settings", pageLabel];
  const pending = useIsMutating({ mutationKey });
  const mutation = useMutation({
    mutationKey,
    meta: { suppressGlobalError: true },
    mutationFn: (body: WorkboardV2AiSettingsBody) =>
      kernel.workboardV2AiSettings({ params: { pageLabel }, body }),
    onMutate: () => ({ pageLabel, session: qc.getQueryCache().find({ queryKey: ["auth", "me"], exact: true }) }),
    onSuccess: (data, _body, origin) => {
      if (qc.getQueryCache().find({ queryKey: ["auth", "me"], exact: true }) !== origin.session) return;
      qc.setQueryData(["workboard-v2-ai", origin.pageLabel], data);
      qc.invalidateQueries({ queryKey: ["workboard-v2", origin.pageLabel] });
    },
  });
  return { ...mutation, isPending: mutation.isPending || pending > 0 };
}

export function useWorkboardV2AiClassify(pageLabel: string) {
  const qc = useQueryClient();
  const mutationKey = ["workboard-v2-ai-classify", pageLabel];
  const pending = useIsMutating({ mutationKey });
  const mutation = useMutation({
    mutationKey,
    meta: { suppressGlobalError: true },
    mutationFn: (body: { reclassify?: boolean }) =>
      kernel.workboardV2AiClassify({ params: { pageLabel }, body }),
    onMutate: () => ({ pageLabel }),
    onSuccess: (_result, _body, origin) => {
      qc.invalidateQueries({ queryKey: ["workboard-v2-ai", origin.pageLabel] });
      qc.invalidateQueries({ queryKey: ["workboard-v2", origin.pageLabel] });
      qc.invalidateQueries({ queryKey: ["workboard-v2-ai-runs"] });
    },
  });
  return { ...mutation, isPending: mutation.isPending || pending > 0 };
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
    queryFn: () => kernel.workboardV2AiRuns(),
    enabled: options.enabled ?? true,
    refetchInterval: typeof ri === "function" ? (query) => ri(query.state.data) : ri ?? false,
  });
}
