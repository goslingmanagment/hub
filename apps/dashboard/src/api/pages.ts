import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  RevenueDailyQuery,
  RevenueQuery,
  SpenderBatchBody,
  SpenderBatchResponse,
} from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

type QueryOptions = { enabled?: boolean };

export function usePageRevenue(pageLabel: string, period: string, options: QueryOptions = {}) {
  return useQuery({
    queryKey: ["pageRevenue", pageLabel, period],
    queryFn: () =>
      kernel.pageRevenue({ params: { pageLabel }, query: { period } as RevenueQuery }),
    enabled: options.enabled ?? true,
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
  options: QueryOptions = {},
) {
  return useQuery({
    queryKey: ["pageSubscribers", pageLabel, params],
    queryFn: () =>
      kernel.pageSubscribers({ params: { pageLabel }, query: params }),
    enabled: options.enabled ?? true,
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pageFanDetail", pageLabel, platformUserId] });
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
