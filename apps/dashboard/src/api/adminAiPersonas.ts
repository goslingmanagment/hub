import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  AdminAiPersonaCreateBody,
  AdminAiPersonaOpenerCreateBody,
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

// Hi's openers of one persona (0320): the texts and how fans answered each.
const openersQueryKey = (key: string) => ["admin", "ai-persona-openers", key] as const;

export function useAdminAiPersonaOpeners(key: string | null) {
  return useQuery({
    queryKey: openersQueryKey(key ?? ""),
    queryFn: () => kernel.adminAiPersonaOpenersList({ params: { key: key ?? "" } }),
    enabled: key !== null,
  });
}

export function useAdminCreateAiPersonaOpener(key: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminAiPersonaOpenerCreateBody) =>
      kernel.adminAiPersonaOpenerCreate({ params: { key }, body }),
    onSuccess: (data) => qc.setQueryData(openersQueryKey(key), data),
  });
}

export function useAdminSetAiPersonaOpenerEnabled(key: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (input: { id: number; enabled: boolean }) =>
      kernel.adminAiPersonaOpenerUpdate({ params: { key, id: input.id }, body: { enabled: input.enabled } }),
    onSuccess: (data) => qc.setQueryData(openersQueryKey(key), data),
  });
}
