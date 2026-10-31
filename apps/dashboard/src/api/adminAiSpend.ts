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

/** Each person's personal daily AI limit and what their AI cost on a Moscow day; today's view refreshes itself. */
export function useAdminAiChatterLimits(day: string, live: boolean) {
  return useQuery({
    queryKey: [...AI_CHATTER_LIMITS_QUERY_KEY, day] as const,
    queryFn: () => kernel.adminAiChatterLimits({ query: { day } }),
    placeholderData: (previous) => previous,
    refetchInterval: live ? 60_000 : false,
  });
}

/** The owner sets or removes (null) a person's daily AI limit. */
export function useAdminUpdateAiChatterLimit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: number; body: AdminAiChatterLimitUpdateBody }) =>
      kernel.adminAiChatterLimitUpdate({ params: { userId: input.userId }, body: input.body }),
    onSuccess: (data) => {
      // The answer is today's view; other days show the new limit too ("Лимит сейчас").
      qc.setQueryData([...AI_CHATTER_LIMITS_QUERY_KEY, data.day], data);
      void qc.invalidateQueries({ queryKey: AI_CHATTER_LIMITS_QUERY_KEY, predicate: (query) => query.queryKey[2] !== data.day });
    },
  });
}
