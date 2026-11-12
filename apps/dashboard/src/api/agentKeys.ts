import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentKeyCreateBody, AgentKeyReplaceBody, AgentKeyUpdateBody } from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

// Agent Read Plane keys (slice B). Owner-session only; the raw token exists in
// the create mutation's RESULT and nowhere else, so the caller must show it
// immediately or lose it.

const AGENT_KEYS_QUERY_KEY = ["admin", "agentKeys"] as const;

export function useAgentKeys(enabled = true) {
  return useQuery({
    queryKey: AGENT_KEYS_QUERY_KEY,
    queryFn: () => kernel.agentKeyList(),
    enabled,
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

/**
 * A key issued as the replacement of an agent's live key (`id`): the same agent, pages and rights, and the old key
 * works one more day. The new key's token is in the RESULT and nowhere else, as at issuance.
 */
export function useReplaceAgentKey() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: ({ id, ...body }: { id: number } & AgentKeyReplaceBody) => kernel.agentKeyReplace({ params: { id }, body }),
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

/** The whole new capability set of a live key; its pages stay as issued. */
export function useUpdateAgentKeyCapabilities() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: ({ id, capabilities }: { id: number } & AgentKeyUpdateBody) =>
      kernel.agentKeyUpdate({ params: { id }, body: { capabilities } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: AGENT_KEYS_QUERY_KEY }),
  });
}

/**
 * The agents a key may belong to: the people registry's persons of kind agent
 * who are not gone (the team's people list, which the owner reads).
 */
export function useKeyAgents(enabled = true) {
  return useQuery({
    queryKey: ["admin", "agentKeys", "agents"] as const,
    queryFn: () => kernel.teamPeople(),
    select: (data) => data.people
      .filter((person) => person.kind === "agent" && person.state !== "left")
      .map((person) => ({ code: person.code, displayName: person.displayName })),
    enabled,
  });
}

/** Links a key issued before the registry to its agent: the person's card takes the key (adminPersonUpdate). */
export function useLinkAgentKey() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: ({ agentCode, keyId }: { agentCode: string; keyId: number }) =>
      kernel.adminPersonUpdate({ params: { code: agentCode }, body: { agentKeys: { add: [keyId] } } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: AGENT_KEYS_QUERY_KEY }),
  });
}
