import { useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

/**
 * The page's own Fansly profile (`GET /pages/:label/profile`, 0336): its
 * versions and the counters per day. Read-only: it serves what the hourly
 * `/account/me` poll already wrote.
 */
export function usePageProfile(pageLabel: string, days: number) {
  return useQuery({
    meta: { suppressGlobalError: true },
    queryKey: ["pageProfile", pageLabel, days],
    queryFn: () => kernel.pageProfile({ params: { pageLabel }, query: { days } }),
    enabled: pageLabel.length > 0,
    staleTime: 60_000,
  });
}
