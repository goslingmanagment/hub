import { useEffect } from "react";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  RevenueDailyQuery,
  RevenueQuery,
  SpenderBatchBody,
  SpenderBatchResponse,
} from "@agency_hub_core/contracts";

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

export function usePages() {
  return useQuery(pagesQueryOptions);
}

/**
 * Warm the catalog before the route that needs it has even been parsed.
 *
 * The Analytics route is lazily chunked and fires nothing until it knows which
 * page is active, so the catalog request could not start until the chunk had
 * downloaded, mounted and rendered. Starting it in the authorized shell (or on hover) buys
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

export function usePageRevenueDaily(pageLabel: string, period = "30d", options: QueryOptions = {}) {
  return useQuery({
    queryKey: ["pageRevenueDaily", pageLabel, period],
    queryFn: () =>
      kernel.pageRevenueDaily({ params: { pageLabel }, query: { period } as RevenueDailyQuery }),
    enabled: options.enabled ?? true,
  });
}

export function usePageSubscribers(
  pageLabel: string,
  // `| undefined` per key: callers pass literals where undefined means "not
  // filtered", which exactOptionalPropertyTypes otherwise rejects.
  params: {
    limit?: number | undefined;
    offset?: number | undefined;
    query?: string | undefined;
    expiringWithinDays?: number | undefined;
    startedWithinHours?: number | undefined;
    autoRenew?: boolean | undefined;
  } = {},
  options: QueryOptions & { suppressGlobalError?: boolean } = {},
) {
  return useQuery({
    queryKey: ["pageSubscribers", pageLabel, params],
    queryFn: () =>
      kernel.pageSubscribers({ params: { pageLabel }, query: params }),
    enabled: options.enabled ?? true,
    meta: { suppressGlobalError: options.suppressGlobalError ?? false },
  });
}

export function usePageSubscribersDaily(pageLabel: string, period = "30d", options: QueryOptions = {}) {
  return useQuery({
    queryKey: ["pageSubscribersDaily", pageLabel, period],
    queryFn: () =>
      kernel.pageSubscribersDaily({
        params: { pageLabel },
        query: { period } as Parameters<typeof kernel.pageSubscribersDaily>[0]["query"],
      }),
    enabled: options.enabled ?? true,
  });
}

export function usePageFollowers(
  pageLabel: string,
  params: {
    limit?: number;
    offset?: number;
    query?: string;
    followedWithinHours?: number;
    subscriber?: boolean;
    dmStatus?: "none" | "has_dm";
    activeWithinMinutes?: number;
  } = {},
) {
  return useQuery({
    queryKey: ["pageFollowers", pageLabel, params],
    queryFn: () =>
      kernel.pageFollowers({ params: { pageLabel }, query: params }),
  });
}

export function usePageFollowersDaily(
  pageLabel: string,
  period = "30d",
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["pageFollowersDaily", pageLabel, period],
    queryFn: () =>
      kernel.pageFollowersDaily({
        params: { pageLabel },
        query: { period } as Parameters<typeof kernel.pageFollowersDaily>[0]["query"],
      }),
    enabled: options.enabled ?? true,
  });
}

export function usePageTransactions(
  pageLabel: string,
  params: { limit?: number; offset?: number; type?: string; state?: string } = {},
  options: QueryOptions = {},
) {
  return useQuery({
    queryKey: ["pageTransactions", pageLabel, params],
    queryFn: () =>
      kernel.pageTransactions({
        params: { pageLabel },
        query: params as Parameters<typeof kernel.pageTransactions>[0]["query"],
      }),
    enabled: options.enabled ?? true,
  });
}

export function usePageSpenderAutoLists(
  pageLabel: string,
  params: {
    period?: string;
    from?: string;
    to?: string;
  } = {},
  options: QueryOptions = {},
) {
  return useQuery({
    queryKey: ["pageSpenderAutoLists", pageLabel, params],
    queryFn: () =>
      kernel.pageSpenderAutoLists({
        params: { pageLabel },
        query: params as Parameters<typeof kernel.pageSpenderAutoLists>[0]["query"],
      }),
    enabled: options.enabled ?? true,
  });
}

export function usePageSpenderAutoList(
  pageLabel: string,
  bucketKey: string,
  params: {
    limit?: number;
    offset?: number;
    query?: string;
    excludeNonFollowers?: boolean;
    period?: string;
    from?: string;
    to?: string;
  } = {},
  options: QueryOptions = {},
) {
  return useQuery({
    queryKey: ["pageSpenderAutoList", pageLabel, bucketKey, params],
    queryFn: () =>
      kernel.pageSpenderAutoListDetail({
        params: { pageLabel, bucketKey } as Parameters<typeof kernel.pageSpenderAutoListDetail>[0]["params"],
        query: params as Parameters<typeof kernel.pageSpenderAutoListDetail>[0]["query"],
      }),
    enabled: options.enabled ?? true,
  });
}

export function usePageDeletedFans(
  pageLabel: string,
  params: {
    limit?: number;
    offset?: number;
  } = {},
  options: QueryOptions = {},
) {
  return useQuery({
    queryKey: ["pageDeletedFans", pageLabel, params],
    queryFn: () =>
      kernel.pageDeletedFans({ params: { pageLabel }, query: params }),
    enabled: options.enabled ?? true,
  });
}

export function usePageFanTransactions(
  pageLabel: string,
  platformUserId: string,
  params: { limit?: number; offset?: number } = {},
) {
  return useQuery({
    queryKey: ["pageFanTransactions", pageLabel, platformUserId, params],
    queryFn: () =>
      kernel.pageFanTransactions({
        params: { pageLabel, platformUserId },
        query: params,
      }),
    enabled: !!platformUserId,
  });
}

export function useFanTransactions(
  platform: string,
  platformUserId: string,
  params: { limit?: number; offset?: number } = {},
) {
  return useQuery({
    queryKey: ["fanTransactions", platform, platformUserId, params],
    queryFn: () =>
      kernel.crossPageFanTransactions({
        params: { platform, platformUserId } as Parameters<typeof kernel.crossPageFanTransactions>[0]["params"],
        query: params,
      }),
    enabled: !!platformUserId,
  });
}

export function usePageFanDetail(pageLabel: string, platformUserId: string) {
  return useQuery({
    queryKey: ["pageFanDetail", pageLabel, platformUserId],
    queryFn: () =>
      kernel.pageFanDetail({ params: { pageLabel, platformUserId } }),
    enabled: !!platformUserId,
  });
}

export function usePageFanProfile(
  pageLabel: string,
  platformUserId: string,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["pageFanProfile", pageLabel, platformUserId],
    queryFn: () =>
      kernel.pageFanProfile({ params: { pageLabel, platformUserId } }),
    enabled: !!platformUserId && (options.enabled ?? true),
  });
}

export function usePageFanProfileVersions(
  pageLabel: string,
  platformUserId: string,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["pageFanProfileVersions", pageLabel, platformUserId],
    queryFn: () =>
      kernel.pageFanProfileVersions({ params: { pageLabel, platformUserId } }),
    enabled: !!platformUserId && (options.enabled ?? true),
  });
}

export function usePageFanProfileVersion(
  pageLabel: string,
  platformUserId: string,
  version: number | null,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["pageFanProfileVersion", pageLabel, platformUserId, version],
    queryFn: () =>
      kernel.pageFanProfileVersion({
        params: { pageLabel, platformUserId, version: version! },
      }),
    enabled: !!platformUserId && version !== null && (options.enabled ?? true),
  });
}

export function useCreateFanNote(pageLabel: string, platformUserId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: { body: string }) =>
      kernel.createFanNote({ params: { pageLabel, platformUserId }, body }),
    onMutate: () => ({ pageLabel, platformUserId }),
    onSuccess: (_result, _variables, origin) => {
      qc.invalidateQueries({ queryKey: ["pageFanDetail", origin.pageLabel, origin.platformUserId] });
    },
  });
}

export function useSpenders(params: {
  scope: string;
  pageLabel?: string;
  period?: string;
  platform?: string;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortDir?: string;
  query?: string;
  retentionStatus?: string;
}, options: QueryOptions = {}) {
  return useQuery({
    queryKey: ["spenders", params],
    queryFn: () => kernel.spenders({
      query: params as Parameters<typeof kernel.spenders>[0]["query"],
    }),
    enabled: options.enabled ?? true,
  });
}

export function useSpenderDetail(
  platform: string,
  platformUserId: string,
  params: { scope: string; pageLabel?: string; period?: string },
) {
  return useQuery({
    queryKey: ["spenderDetail", platform, platformUserId, params],
    queryFn: () =>
      kernel.spenderDetail({
        params: { platform, platformUserId } as Parameters<typeof kernel.spenderDetail>[0]["params"],
        query: params as Parameters<typeof kernel.spenderDetail>[0]["query"],
      }),
    enabled: !!platformUserId,
  });
}

export function useSpenderSeries(
  platform: string,
  platformUserId: string,
  params: { scope: string; pageLabel?: string; period: string; granularity?: string },
  options: QueryOptions = {},
) {
  return useQuery({
    queryKey: ["spenderSeries", platform, platformUserId, params],
    queryFn: () =>
      kernel.spenderSeries({
        params: { platform, platformUserId } as Parameters<typeof kernel.spenderSeries>[0]["params"],
        query: params as Parameters<typeof kernel.spenderSeries>[0]["query"],
      }),
    enabled: (options.enabled ?? true) && !!platformUserId,
  });
}

export function useSpenderBatch(body: SpenderBatchBody | null) {
  const qc = useQueryClient();
  const requestFingerprint = body !== null && body.fans.length > 0
    ? JSON.stringify(body)
    : null;
  const queryKey = ["spenderBatch", requestFingerprint] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => kernel.spenderBatch({ body: body! }),
    enabled: false,
    retry: false,
  });

  useEffect(() => {
    if (requestFingerprint === null) {
      return;
    }

    if (qc.getQueryState<SpenderBatchResponse>(queryKey)?.fetchStatus === "fetching") {
      return;
    }

    if (qc.getQueryData<SpenderBatchResponse>(queryKey) !== undefined) {
      return;
    }

    void query.refetch();
  }, [qc, query.refetch, requestFingerprint]);

  return query;
}
