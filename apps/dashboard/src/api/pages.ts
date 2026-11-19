import { queryOptions, useQuery } from "@tanstack/react-query";
import type { RevenueQuery } from "@agency_hub_core/contracts";

import { queryClient } from "@/lib/queryClient";

import { kernel } from "./sdk.js";

type QueryOptions = { enabled?: boolean; windowAt?: string };

/**
 * The page catalog, straight from `GET /api/v1/pages`.
 *
 * Deliberately NOT `useOverview().pages`: the overview response is a whole
 * dashboard's worth of aggregates (fan counts, revenue windows, sync state)
 * and costs seconds on a cold cache, so any surface that only needs "which
 * pages exist" was paying for all of it before it could fire a single request
 * of its own. This query is the cheap catalog — id, label, platform.
 *
 * ONE options object, shared by the hook and by every prefetch: React Query
 * deduplicates by query KEY, not by query-function identity, so a prefetch
 * already in flight is the same request `usePages()` mounts onto. Two
 * hand-written copies of the same key would work until one of them drifted.
 *
 * `suppressGlobalError`: Analytics renders the catalog's failure itself, with
 * a retry, and a toast on top of that is the same news twice.
 */
export const pagesQueryOptions = queryOptions({
  queryKey: ["pages"],
  queryFn: () => kernel.pages(),
  meta: { suppressGlobalError: true },
});

export function usePages(options: { enabled?: boolean } = {}) {
  return useQuery({ ...pagesQueryOptions, ...options });
}

/**
 * Warm the catalog before the route that needs it has even been parsed.
 *
 * The Analytics route is lazily chunked and fires nothing until it knows which
 * page is active, so the catalog request could not start until the chunk had
 * downloaded, mounted and rendered. Starting it at boot (or on hover) buys
 * that whole gap. `prefetchQuery` never rejects — a failed warm-up is recorded
 * as a cache error and refetched when `usePages()` mounts (`retryOnMount`
 * defaults true), so the page still reports the failure itself.
 */
export function prefetchPages(): void {
  void queryClient.prefetchQuery(pagesQueryOptions);
}

export function usePageRevenue(pageLabel: string, period: string, options: QueryOptions = {}) {
  return useQuery({
    queryKey: ["pageRevenue", pageLabel, period, options.windowAt],
    queryFn: () =>
      kernel.pageRevenue({ params: { pageLabel }, query: { period, windowAt: options.windowAt } as RevenueQuery }),
    enabled: options.enabled ?? true,
    meta: { suppressGlobalError: Boolean(options.windowAt) },
  });
}
