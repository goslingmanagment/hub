import { useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

/**
 * The insights routes «Статистика» reads besides Fansly's own statistics.
 *
 * READ-ONLY, and that is not incidental: **serving never authorizes capture**.
 * Nothing here can start a sync: the routes behind these hooks are GETs over what
 * the Fansly Sync Engine already filled.
 */

type QueryOptions = { enabled?: boolean };

/** Every block says its own failure with a retry: a toast on top would be the same news twice. */
const STATS_META = { suppressGlobalError: true } as const;

/** What the page's collection holds, every plane (the system group's «Полнота данных»). */
export function useStatsCoverage(pageLabel: string, options: QueryOptions = {}) {
  return useQuery({
    meta: STATS_META,
    queryKey: ["statsCoverage", pageLabel],
    queryFn: () => kernel.statsCoverage({ params: { pageLabel } }),
    enabled: (options.enabled ?? true) && pageLabel.length > 0,
  });
}

/**
 * What Hub holds of the page, per projection («Хранится в Hub»). An exact count
 * over every table of the page takes seconds, so the screen asks only once the
 * fold is open, and an answer stays fresh for a while.
 */
export function useStatsHoldings(pageLabel: string, options: QueryOptions = {}) {
  return useQuery({
    meta: STATS_META,
    queryKey: ["statsHoldings", pageLabel],
    queryFn: () => kernel.statsHoldings({ params: { pageLabel } }),
    enabled: (options.enabled ?? true) && pageLabel.length > 0,
    staleTime: 5 * 60_000,
  });
}

/** The comments of the posts, over the screen's UTC days (`from` 00:00Z … `to` exclusive). */
export function useContentComments(
  pageLabel: string,
  window: { from: string; to: string },
  options: QueryOptions = {},
) {
  return useQuery({
    meta: STATS_META,
    queryKey: ["contentComments", pageLabel, window.from, window.to],
    queryFn: () => kernel.contentComments({
      params: { pageLabel },
      query: { ...window, limit: 200 },
    }),
    enabled: (options.enabled ?? true) && pageLabel.length > 0,
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === pageLabel ? previous : undefined),
    staleTime: 60_000,
  });
}

/** Yesterday's UTC day: whole, and its tags fit the server's 500 rows (spec §0, п. 8). */
function yesterday(now = new Date()): string {
  return new Date(Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/**
 * The tags' numbers across all of Fansly, as of yesterday. Only `platformTags` is
 * read, so `limit: 1` (it bounds `topTags` alone). The key has no period: the
 * screen's period does not touch it.
 */
export function useFanslyTagTotals(pageLabel: string, options: QueryOptions = {}) {
  const day = yesterday();
  return useQuery({
    meta: STATS_META,
    queryKey: ["statsTagTotals", pageLabel, day],
    queryFn: () => kernel.statsTags({
      params: { pageLabel },
      query: { from: `${day}T00:00:00.000Z`, to: `${day}T23:59:59.000Z`, limit: 1 },
    }),
    enabled: (options.enabled ?? true) && pageLabel.length > 0,
    staleTime: 3_600_000,
  });
}

/**
 * The months of Fansly's statements and its rolling total. Months come whole on any
 * page of the answer and the days are not needed: today alone, one row, no cursor.
 */
export function useFanslyMonths(pageLabel: string, options: QueryOptions = {}) {
  const today = new Date().toISOString().slice(0, 10);
  return useQuery({
    meta: STATS_META,
    queryKey: ["statsMonths", pageLabel, today],
    queryFn: () => kernel.moneyRevenueMix({ params: { pageLabel }, query: { from: today, to: today, limit: 1 } }),
    enabled: (options.enabled ?? true) && pageLabel.length > 0,
    staleTime: 5 * 60_000,
  });
}

/** One media's price and all-time sales: the catalog's head, asked once when its card opens. */
export function useMediaSales(pageLabel: string, mediaOfferId: string | null, window: { from: string; to: string }) {
  return useQuery({
    meta: STATS_META,
    queryKey: ["statsMediaSales", pageLabel, mediaOfferId, window.from, window.to],
    queryFn: () => kernel.statsMedia({
      params: { pageLabel },
      query: { ...window, mediaOfferRef: mediaOfferId!, limit: 1, bucketLimit: 1 },
    }),
    enabled: pageLabel.length > 0 && mediaOfferId !== null,
    retry: false,
    staleTime: 5 * 60_000,
  });
}
