import { useIsMutating, useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentKeyCreateBody, AgentKeyCreateResponse } from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

// Agent Read Plane keys (slice B). Owner-session only; the raw token exists in
// the create mutation's RESULT. Keep that response in session memory until
// acknowledgement so a settings-tab remount cannot discard it.

const AGENT_KEYS_QUERY_KEY = ["admin", "agentKeys"] as const;
const ISSUE_AGENT_KEY = ["admin", "issuedAgentKey"] as const;

export function useAgentKeys(options: { suppressGlobalError?: boolean } = {}) {
  return useQuery({
    queryKey: AGENT_KEYS_QUERY_KEY,
    meta: { suppressGlobalError: options.suppressGlobalError ?? false },
    queryFn: () => kernel.agentKeyList(),
  });
}

export function useCreateAgentKey() {
  const qc = useQueryClient();
  const pending = useIsMutating({ mutationKey: ISSUE_AGENT_KEY }) > 0;
  const mutation = useMutation({
    mutationKey: ISSUE_AGENT_KEY,
    gcTime: Infinity,
    meta: { suppressGlobalError: true },
    mutationFn: (body: AgentKeyCreateBody) => kernel.agentKeyCreate({ body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: AGENT_KEYS_QUERY_KEY }); },
  });
  return { ...mutation, isPending: mutation.isPending || pending };
}

/** Session-memory receipt of the only response carrying the raw token. Never
 * persisted or fetched again; acknowledgement removes the recoverable receipt. */
export function useIssuedAgentKeys() {
  const qc = useQueryClient();
  const issued = useMutationState({
    filters: { mutationKey: ISSUE_AGENT_KEY, status: "success" },
    select: (mutation) => ({ id: mutation.mutationId, result: mutation.state.data as AgentKeyCreateResponse }),
  });
  function acknowledge(id: number) {
    const cache = qc.getMutationCache();
    const mutation = cache.getAll().find((entry) => entry.mutationId === id);
    if (mutation?.state.status === "success") cache.remove(mutation);
  }
  return { issued, acknowledge };
}

export function useRevokeAgentKey() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (id: number) => kernel.agentKeyRevoke({ params: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: AGENT_KEYS_QUERY_KEY }),
  });
}
