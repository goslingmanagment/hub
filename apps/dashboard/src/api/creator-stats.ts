import { useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

/**
 * Fansly's 2026-10 statistics of one page (`GET /pages/:label/stats/creator`):
 * the "Статистика" page reads everything from this one answer. Read-only, like
 * every insights route — it serves what the hourly poll already wrote.
 */
export function useCreatorStats(pageLabel: string, days: 7 | 30 | 90, options: { enabled?: boolean } = {}) {
  return useQuery({
    meta: { suppressGlobalError: true },
    queryKey: ["creatorStats", pageLabel, days],
    queryFn: () => kernel.creatorStatsOverview({ params: { pageLabel }, query: { days } }),
    enabled: (options.enabled ?? true) && pageLabel.length > 0,
    // The poll writes once an hour; a minute is fresh enough and keeps
    // switching between periods instant.
    staleTime: 60_000,
  });
}
