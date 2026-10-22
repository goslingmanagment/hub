import { useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

/** The periods the «Статистика» page offers: Fansly's own three and two longer ones. */
export type CreatorStatsDays = 7 | 30 | 90 | 180 | 365;

/**
 * Fansly's 2026-10 statistics of one page (`GET /pages/:label/stats/creator`):
 * the "Статистика" page reads everything from this one answer. Read-only, like
 * every insights route — it serves what the hourly poll already wrote.
 */
export function useCreatorStats(pageLabel: string, days: CreatorStatsDays, options: { enabled?: boolean } = {}) {
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

/** The page's media by views in the window (`/stats/creator/content`). */
export function useCreatorStatsContent(pageLabel: string, days: CreatorStatsDays, options: { enabled?: boolean } = {}) {
  return useQuery({
    meta: { suppressGlobalError: true },
    queryKey: ["creatorStatsContent", pageLabel, days],
    queryFn: () => kernel.creatorStatsContent({ params: { pageLabel }, query: { days } }),
    enabled: (options.enabled ?? true) && pageLabel.length > 0,
    staleTime: 60_000,
  });
}

/** One media offer's days, hours, retention and tags. */
export function useCreatorStatsMedia(pageLabel: string, mediaOfferId: string | null, days: CreatorStatsDays) {
  return useQuery({
    meta: { suppressGlobalError: true },
    queryKey: ["creatorStatsMedia", pageLabel, mediaOfferId, days],
    queryFn: () => kernel.creatorStatsMedia({ params: { pageLabel, mediaOfferId: mediaOfferId! }, query: { days } }),
    enabled: pageLabel.length > 0 && mediaOfferId !== null,
    staleTime: 60_000,
  });
}

/** Countries, tags, active hours, benchmarks and media shown (`/stats/creator/audience`). */
export function useCreatorStatsAudience(pageLabel: string, days: CreatorStatsDays, options: { enabled?: boolean } = {}) {
  return useQuery({
    meta: { suppressGlobalError: true },
    queryKey: ["creatorStatsAudience", pageLabel, days],
    queryFn: () => kernel.creatorStatsAudience({ params: { pageLabel }, query: { days } }),
    enabled: (options.enabled ?? true) && pageLabel.length > 0,
    staleTime: 60_000,
  });
}
