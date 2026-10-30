import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminAiChatterLimitUpdateBody } from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

/** The owner's AI spend analytics for a Moscow-day period. */
export function useAdminAiSpend(range: { from: string; to: string }) {
  return useQuery({
    queryKey: ["admin", "ai-spend", range.from, range.to] as const,
    queryFn: () => kernel.adminAiSpend({ query: range }),
    placeholderData: (previous) => previous,
  });
}

const AI_CHATTER_LIMITS_QUERY_KEY = ["admin", "ai-chatter-limits"] as const;

/** Each person's personal daily AI limit and what their AI cost today (Moscow day). */
export function useAdminAiChatterLimits() {
  return useQuery({
    queryKey: AI_CHATTER_LIMITS_QUERY_KEY,
    queryFn: () => kernel.adminAiChatterLimits(),
    refetchInterval: 60_000,
  });
}

/** The owner sets or removes (null) a person's daily AI limit. */
export function useAdminUpdateAiChatterLimit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: number; body: AdminAiChatterLimitUpdateBody }) =>
      kernel.adminAiChatterLimitUpdate({ params: { userId: input.userId }, body: input.body }),
    onSuccess: (data) => {
      qc.setQueryData(AI_CHATTER_LIMITS_QUERY_KEY, data);
    },
  });
}
