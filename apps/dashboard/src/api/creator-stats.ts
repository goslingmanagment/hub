import { useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

/** The periods «Статистика» offers: Fansly's own three and two longer ones. */
export type CreatorStatsDays = 7 | 30 | 90 | 180 | 365;

const STATS_DAYS: readonly CreatorStatsDays[] = [7, 30, 90, 180, 365];

/** The screen's period in the days the server takes; anything else is the nearest smaller. */
export function statsDays(days: number): CreatorStatsDays {
  return [...STATS_DAYS].reverse().find((value) => value <= days) ?? 7;
}

const STATS_META = { suppressGlobalError: true } as const;

/**
 * While a period changes on the same page, the old numbers stay (dimmed); when
 * the PAGE changes they never do: another page's numbers under a new label would
 * be a lie. The page is the second part of every key here.
 */
function samePage<T>(pageLabel: string) {
  return (previous: T | undefined, previousQuery: { queryKey: readonly unknown[] } | undefined) =>
    previousQuery?.queryKey[1] === pageLabel ? previous : undefined;
}

/** The poll writes once an hour; a minute is fresh enough and keeps switching between periods instant. */
const STALE = 60_000;

/**
 * Fansly's 2026-10 statistics of one page (`GET /pages/:label/stats/creator`):
 * «Главное» and «Доход Fansly» read this one answer (one key, one cache).
 * Read-only, like every insights route: it serves what the hourly poll wrote.
 */
export function useCreatorStats(pageLabel: string, days: CreatorStatsDays, options: { enabled?: boolean } = {}) {
  return useQuery({
    meta: STATS_META,
    queryKey: ["creatorStats", pageLabel, days],
    queryFn: () => kernel.creatorStatsOverview({ params: { pageLabel }, query: { days } }),
    enabled: (options.enabled ?? true) && pageLabel.length > 0,
    placeholderData: samePage(pageLabel),
    staleTime: STALE,
  });
}

/** The page's media by views in the window and what sells (`/stats/creator/content`). */
export function useCreatorStatsContent(pageLabel: string, days: CreatorStatsDays, options: { enabled?: boolean } = {}) {
  return useQuery({
    meta: STATS_META,
    queryKey: ["creatorStatsContent", pageLabel, days],
    queryFn: () => kernel.creatorStatsContent({ params: { pageLabel }, query: { days } }),
    enabled: (options.enabled ?? true) && pageLabel.length > 0,
    placeholderData: samePage(pageLabel),
    staleTime: STALE,
  });
}

/** One media offer's days, hours, retention and tags. */
export function useCreatorStatsMedia(pageLabel: string, mediaOfferId: string | null, days: CreatorStatsDays) {
  return useQuery({
    meta: STATS_META,
    queryKey: ["creatorStatsMedia", pageLabel, mediaOfferId, days],
    queryFn: () => kernel.creatorStatsMedia({ params: { pageLabel, mediaOfferId: mediaOfferId! }, query: { days } }),
    enabled: pageLabel.length > 0 && mediaOfferId !== null,
    retry: false,
    staleTime: STALE,
  });
}

/** Countries, tags, active hours, benchmarks and media shown (`/stats/creator/audience`). */
export function useCreatorStatsAudience(pageLabel: string, days: CreatorStatsDays, options: { enabled?: boolean } = {}) {
  return useQuery({
    meta: STATS_META,
    queryKey: ["creatorStatsAudience", pageLabel, days],
    queryFn: () => kernel.creatorStatsAudience({ params: { pageLabel }, query: { days } }),
    enabled: (options.enabled ?? true) && pageLabel.length > 0,
    placeholderData: samePage(pageLabel),
    staleTime: STALE,
  });
}

/** The day after a UTC day: the server's custom window does not include its end. */
function dayAfter(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * The page's money by Hub's operations over exactly Fansly's days `fromDay`…`toDay`
 * (`pageRevenue`, custom window). Fansly's days are UTC and Hub's are Moscow, so it
 * asks for UTC days (`utcDays`). Not `usePageRevenue`: that one is keyed by its
 * clock and cannot ask for a custom window.
 */
export function useHubRevenueWindow(pageLabel: string, window: { fromDay: string; toDay: string } | null) {
  return useQuery({
    meta: STATS_META,
    queryKey: ["statsHubRevenue", pageLabel, window?.fromDay, window?.toDay],
    queryFn: () => kernel.pageRevenue({
      params: { pageLabel },
      query: { period: "custom", from: window!.fromDay, to: dayAfter(window!.toDay), utcDays: true },
    }),
    enabled: pageLabel.length > 0 && window !== null,
    staleTime: STALE,
  });
}

/** The same window by UTC day (`pageRevenueDaily`): asked only when the sums disagree. */
export function useHubRevenueDays(pageLabel: string, window: { fromDay: string; toDay: string } | null, enabled: boolean) {
  return useQuery({
    meta: STATS_META,
    queryKey: ["statsHubRevenueDays", pageLabel, window?.fromDay, window?.toDay],
    queryFn: () => kernel.pageRevenueDaily({
      params: { pageLabel },
      query: { period: "custom", from: window!.fromDay, to: dayAfter(window!.toDay), groupByType: false, utcDays: true },
    }),
    enabled: enabled && pageLabel.length > 0 && window !== null,
    staleTime: STALE,
  });
}
