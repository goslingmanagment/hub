import { useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

/** The owner's AI spend analytics for a Moscow-day period. */
export function useAdminAiSpend(range: { from: string; to: string }) {
  return useQuery({
    queryKey: ["admin", "ai-spend", range.from, range.to] as const,
    queryFn: () => kernel.adminAiSpend({ query: range }),
    placeholderData: (previous) => previous,
  });
}
