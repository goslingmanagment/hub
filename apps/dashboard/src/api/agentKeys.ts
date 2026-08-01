import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentKeyCreateBody } from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

// Agent Read Plane keys (slice B). Owner-session only; the raw token exists in
// the create mutation's RESULT and nowhere else, so the caller must show it
// immediately or lose it.

const AGENT_KEYS_QUERY_KEY = ["admin", "agentKeys"] as const;

export function useAgentKeys() {
  return useQuery({
    queryKey: AGENT_KEYS_QUERY_KEY,
    queryFn: () => kernel.agentKeyList(),
  });
}

export function useCreateAgentKey() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AgentKeyCreateBody) => kernel.agentKeyCreate({ body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: AGENT_KEYS_QUERY_KEY }),
  });
}

export function useRevokeAgentKey() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (id: number) => kernel.agentKeyRevoke({ params: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: AGENT_KEYS_QUERY_KEY }),
  });
}
