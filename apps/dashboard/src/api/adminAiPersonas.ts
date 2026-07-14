import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  AdminAiPersonaCreateBody,
  AdminAiPersonaUpdateBody,
} from "@agency_hub_core/contracts";

import { KernelApiError, kernel } from "./sdk.js";

const PERSONAS_QUERY_KEY = ["admin", "ai-personas"] as const;

function refreshPersonas(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: PERSONAS_QUERY_KEY });
}

function refreshOnConflict(qc: QueryClient, error: unknown) {
  if (error instanceof KernelApiError && error.status === 409) {
    void refreshPersonas(qc);
  }
}

export function useAdminAiPersonas() {
  return useQuery({
    queryKey: PERSONAS_QUERY_KEY,
    queryFn: () => kernel.adminAiPersonasList(),
  });
}

export function useAdminCreateAiPersona() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminAiPersonaCreateBody) =>
      kernel.adminAiPersonaCreate({ body }),
    onSuccess: () => refreshPersonas(qc),
    onError: (error) => refreshOnConflict(qc, error),
  });
}

export function useAdminUpdateAiPersona(key: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminAiPersonaUpdateBody) =>
      kernel.adminAiPersonaUpdate({ params: { key }, body }),
    onSuccess: () => refreshPersonas(qc),
    onError: (error) => refreshOnConflict(qc, error),
  });
}

export function useAdminArchiveAiPersona(key: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (expectedVersion: number) =>
      kernel.adminAiPersonaArchive({ params: { key }, query: { expectedVersion } }),
    onSuccess: () => refreshPersonas(qc),
    onError: (error) => refreshOnConflict(qc, error),
  });
}
