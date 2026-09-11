import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentHydrationRequestDecideBody } from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

/**
 * The owner approval queue for agent hydration requests (slice C).
 *
 * Both operations are owner-session: an agent key can file a request and poll
 * its own, and can never see the board or decide anything.
 */
export function useAgentHydrationRequests(params: { state?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: ["agent", "hydration", params],
    meta: { suppressGlobalError: true },
    queryFn: () => kernel.agentHydrationRequestList({
      query: params as Parameters<typeof kernel.agentHydrationRequestList>[0]["query"],
    }),
    refetchInterval: 15_000,
  });
}

export function useDecideAgentHydrationRequest() {
  const qc = useQueryClient();
  return useMutation({
    // The 409s of this operation (stale coverage, CAS conflict) are the point of
    // the screen: they must reach the form, not a global toast that hides which
    // one happened.
    meta: { suppressGlobalError: true },
    mutationFn: (input: { requestRef: string; body: AgentHydrationRequestDecideBody }) =>
      kernel.agentHydrationRequestDecide({
        params: { requestRef: input.requestRef },
        body: input.body,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agent", "hydration"] }),
  });
}
