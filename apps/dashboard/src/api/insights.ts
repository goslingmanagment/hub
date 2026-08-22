import { useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

/**
 * WP-S1's serving routes, through the generated SDK.
 *
 * READ-ONLY, and that is not incidental: **serving never authorizes capture**.
 * Nothing here can start a sync — the routes behind these hooks are GETs over
 * projections some capture lane already filled, and a page whose lane flag is
 * off answers with what it holds and says the flag is off.
 */

type QueryOptions = { enabled?: boolean };

export function useStatsTraffic(
  pageLabel: string,
  window: { from: string; to: string },
  subjectKind: "account_profile" | "account_media",
  options: QueryOptions = {},
) {
  return useQuery({
    queryKey: ["statsTraffic", pageLabel, window.from, window.to, subjectKind],
    queryFn: () => kernel.statsTraffic({
      params: { pageLabel },
      query: { ...window, subjectKind },
    }),
    enabled: (options.enabled ?? true) && pageLabel.length > 0,
  });
}

export function useStatsMedia(
  pageLabel: string,
  window: { from: string; to: string },
  options: QueryOptions = {},
) {
  return useQuery({
    queryKey: ["statsMedia", pageLabel, window.from, window.to],
    queryFn: () => kernel.statsMedia({
      params: { pageLabel },
      // Bounded on purpose: the sparklines need a handful of media with their
      // series, not the whole catalogue with a year of buckets.
      query: { ...window, limit: 25, bucketLimit: 500 },
    }),
    enabled: (options.enabled ?? true) && pageLabel.length > 0,
  });
}

export function useStatsTags(
  pageLabel: string,
  window: { from: string; to: string },
  options: QueryOptions = {},
) {
  return useQuery({
    queryKey: ["statsTags", pageLabel, window.from, window.to],
    queryFn: () => kernel.statsTags({ params: { pageLabel }, query: { ...window, limit: 50 } }),
    enabled: (options.enabled ?? true) && pageLabel.length > 0,
  });
}

export function useStatsCoverage(pageLabel: string, options: QueryOptions = {}) {
  return useQuery({
    queryKey: ["statsCoverage", pageLabel],
    queryFn: () => kernel.statsCoverage({ params: { pageLabel } }),
    enabled: (options.enabled ?? true) && pageLabel.length > 0,
  });
}

export function useContentMedia(pageLabel: string, options: QueryOptions = {}) {
  return useQuery({
    queryKey: ["contentMedia", pageLabel],
    queryFn: () => kernel.contentMedia({ params: { pageLabel }, query: { limit: 100 } }),
    enabled: (options.enabled ?? true) && pageLabel.length > 0,
  });
}

export function useContentComments(
  pageLabel: string,
  window: { from: string; to: string },
  options: QueryOptions = {},
) {
  return useQuery({
    queryKey: ["contentComments", pageLabel, window.from, window.to],
    queryFn: () => kernel.contentComments({
      params: { pageLabel },
      query: { ...window, limit: 200 },
    }),
    enabled: (options.enabled ?? true) && pageLabel.length > 0,
  });
}

export function useMoneyRevenueMix(
  pageLabel: string,
  window: { from: string; to: string },
  options: QueryOptions = {},
) {
  return useQuery({
    queryKey: ["moneyRevenueMix", pageLabel, window.from, window.to],
    queryFn: () => kernel.moneyRevenueMix({
      params: { pageLabel },
      // The mix window is BUSINESS DATES, not instants: the platform's earnings
      // breakdown is a per-day fact and has no time of day.
      query: { from: window.from.slice(0, 10), to: window.to.slice(0, 10), limit: 500 },
    }),
    enabled: (options.enabled ?? true) && pageLabel.length > 0,
  });
}
