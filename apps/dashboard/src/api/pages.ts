import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CrossPageFanTransactionListResponse,
  FanNoteResponse,
  FanProfileDocument,
  FanProfileResponse,
  FanProfileVersionListResponse,
  FanTransactionListResponse,
  FollowerDailyResponse,
  FollowerListResponse,
  PageFanDetailResponse,
  PageDeletedFansResponse,
  PageRevenueResponse,
  PageSpenderAutoListDetailResponse,
  PageSpenderAutoListsResponse,
  RevenueDailyResponse,
  SpenderBatchBody,
  SpenderBatchResponse,
  SpenderDetailResponse,
  SpenderListResponse,
  SubscriberDailyResponse,
  SubscriberListResponse,
  TransactionListResponse,
} from "@agency_hub_core/contracts";
import { api } from "./client.js";
import { qs } from "./utils.js";
import { pathSegment } from "@/lib/path";

type QueryOptions = { enabled?: boolean };

export function usePageRevenue(pageLabel: string, period: string, options: QueryOptions = {}) {
  return useQuery({
    queryKey: ["pageRevenue", pageLabel, period],
    queryFn: () =>
      api.get<PageRevenueResponse>(`/api/v1/pages/${pathSegment(pageLabel)}/revenue?period=${period}`),
    enabled: options.enabled ?? true,
  });
}

export function usePageRevenueDaily(pageLabel: string, period = "30d", options: QueryOptions = {}) {
  return useQuery({
    queryKey: ["pageRevenueDaily", pageLabel, period],
    queryFn: () =>
      api.get<RevenueDailyResponse>(`/api/v1/pages/${pathSegment(pageLabel)}/revenue/daily?period=${period}`),
    enabled: options.enabled ?? true,
  });
}

export function usePageSubscribers(
  pageLabel: string,
  params: {
    limit?: number;
    offset?: number;
    query?: string;
    expiringWithinDays?: number;
    startedWithinHours?: number;
    autoRenew?: boolean;
  } = {},
  options: QueryOptions = {},
) {
  return useQuery({
    queryKey: ["pageSubscribers", pageLabel, params],
    queryFn: () =>
      api.get<SubscriberListResponse>(`/api/v1/pages/${pathSegment(pageLabel)}/subscribers${qs(params)}`),
    enabled: options.enabled ?? true,
  });
}

export function usePageSubscribersDaily(pageLabel: string, period = "30d", options: QueryOptions = {}) {
  return useQuery({
    queryKey: ["pageSubscribersDaily", pageLabel, period],
    queryFn: () =>
      api.get<SubscriberDailyResponse>(`/api/v1/pages/${pathSegment(pageLabel)}/subscribers/daily?period=${period}`),
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
      api.get<FollowerListResponse>(`/api/v1/pages/${pathSegment(pageLabel)}/followers${qs(params)}`),
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
      api.get<FollowerDailyResponse>(`/api/v1/pages/${pathSegment(pageLabel)}/followers/daily?period=${period}`),
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
      api.get<TransactionListResponse>(`/api/v1/pages/${pathSegment(pageLabel)}/transactions${qs(params)}`),
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
      api.get<PageSpenderAutoListsResponse>(`/api/v1/pages/${pathSegment(pageLabel)}/spender-autolists${qs(params)}`),
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
      api.get<PageSpenderAutoListDetailResponse>(
        `/api/v1/pages/${pathSegment(pageLabel)}/spender-autolists/${pathSegment(bucketKey)}${qs(params)}`,
      ),
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
      api.get<PageDeletedFansResponse>(`/api/v1/pages/${pathSegment(pageLabel)}/deleted-fans${qs(params)}`),
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
      api.get<FanTransactionListResponse>(
        `/api/v1/pages/${pathSegment(pageLabel)}/fans/${pathSegment(platformUserId)}/transactions${qs(params)}`,
      ),
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
      api.get<CrossPageFanTransactionListResponse>(
        `/api/v1/fans/${pathSegment(platform)}/${pathSegment(platformUserId)}/transactions${qs(params)}`,
      ),
    enabled: !!platformUserId,
  });
}

export function usePageFanDetail(pageLabel: string, platformUserId: string) {
  return useQuery({
    queryKey: ["pageFanDetail", pageLabel, platformUserId],
    queryFn: () =>
      api.get<PageFanDetailResponse>(`/api/v1/pages/${pathSegment(pageLabel)}/fans/${pathSegment(platformUserId)}`),
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
      api.get<FanProfileResponse>(`/api/v1/pages/${pathSegment(pageLabel)}/fans/${pathSegment(platformUserId)}/profile`),
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
      api.get<FanProfileVersionListResponse>(
        `/api/v1/pages/${pathSegment(pageLabel)}/fans/${pathSegment(platformUserId)}/profile/versions`,
      ),
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
      api.get<FanProfileDocument>(
        `/api/v1/pages/${pathSegment(pageLabel)}/fans/${pathSegment(platformUserId)}/profile/versions/${version}`,
      ),
    enabled: !!platformUserId && version !== null && (options.enabled ?? true),
  });
}

export function useCreateFanNote(pageLabel: string, platformUserId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: { body: string }) =>
      api.post<FanNoteResponse>(`/api/v1/pages/${pathSegment(pageLabel)}/fans/${pathSegment(platformUserId)}/notes`, body),
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
    queryFn: () => api.get<SpenderListResponse>(`/api/v2/spenders${qs(params)}`),
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
      api.get<SpenderDetailResponse>(`/api/v2/spenders/${pathSegment(platform)}/${pathSegment(platformUserId)}${qs(params)}`),
    enabled: !!platformUserId,
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
    queryFn: () => api.post<SpenderBatchResponse>("/api/v2/spenders:batch", body!),
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
