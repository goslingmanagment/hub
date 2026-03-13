import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  AdminCreateUserBody,
  AuthState,
  AuthUser,
  OverviewResponse,
  PageRevenueResponse,
  OverviewRevenueResponse,
  RevenueDailyResponse,
  SubscriberListResponse,
  SubscriberDailyResponse,
  FollowerListResponse,
  FollowerDailyResponse,
  TransactionListResponse,
  CrossPageTransactionListResponse,
  FanTransactionListResponse,
  CrossPageFanTransactionListResponse,
  PageFanDetailResponse,
  CrossPageFanDetailResponse,
  SpenderListResponse,
  SpenderDetailResponse,
  ConnectionItem,
  SyncRunItem,
  FanNoteResponse,
  FanFlagsResponse,
  FanListResponse,
  VerifyCredentialsBody,
} from "@fansly-connect/contracts";
import { api } from "./client";

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "";
  return "?" + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

// Auth
export function useAuthMe() {
  return useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => api.get<AuthState>("/api/v1/auth/me"),
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: { username: string; password: string }) =>
      api.post<AuthState>("/api/v1/auth/login", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth"] }),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () => api.post<void>("/api/v1/auth/logout"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth"] }),
  });
}

// Overview
export function useOverview() {
  return useQuery({
    queryKey: ["overview"],
    queryFn: () => api.get<OverviewResponse>("/api/v1/overview"),
  });
}

// Revenue
export function usePageRevenue(pageLabel: string, period: string) {
  return useQuery({
    queryKey: ["pageRevenue", pageLabel, period],
    queryFn: () =>
      api.get<PageRevenueResponse>(`/api/v1/pages/${pageLabel}/revenue?period=${period}`),
  });
}

export function useOverviewRevenue(period: string) {
  return useQuery({
    queryKey: ["overviewRevenue", period],
    queryFn: () =>
      api.get<OverviewRevenueResponse>(`/api/v1/overview/revenue?period=${period}`),
  });
}

export function usePageRevenueDaily(pageLabel: string, period = "30d") {
  return useQuery({
    queryKey: ["pageRevenueDaily", pageLabel, period],
    queryFn: () =>
      api.get<RevenueDailyResponse>(`/api/v1/pages/${pageLabel}/revenue/daily?period=${period}`),
  });
}

export function useOverviewRevenueDaily(period = "30d") {
  return useQuery({
    queryKey: ["overviewRevenueDaily", period],
    queryFn: () =>
      api.get<RevenueDailyResponse>(`/api/v1/overview/revenue/daily?period=${period}`),
  });
}

// Subscribers & Followers
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
) {
  return useQuery({
    queryKey: ["pageSubscribers", pageLabel, params],
    queryFn: () =>
      api.get<SubscriberListResponse>(`/api/v1/pages/${pageLabel}/subscribers${qs(params)}`),
  });
}

export function usePageSubscribersDaily(pageLabel: string, period = "30d") {
  return useQuery({
    queryKey: ["pageSubscribersDaily", pageLabel, period],
    queryFn: () =>
      api.get<SubscriberDailyResponse>(`/api/v1/pages/${pageLabel}/subscribers/daily?period=${period}`),
  });
}

export function usePageFollowers(
  pageLabel: string,
  params: {
    limit?: number;
    offset?: number;
    query?: string;
    followedWithinHours?: number;
  } = {},
) {
  return useQuery({
    queryKey: ["pageFollowers", pageLabel, params],
    queryFn: () =>
      api.get<FollowerListResponse>(`/api/v1/pages/${pageLabel}/followers${qs(params)}`),
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
      api.get<FollowerDailyResponse>(`/api/v1/pages/${pageLabel}/followers/daily?period=${period}`),
    enabled: options.enabled ?? true,
  });
}

// Transactions
export function usePageTransactions(
  pageLabel: string,
  params: { limit?: number; offset?: number; type?: string; state?: string } = {},
) {
  return useQuery({
    queryKey: ["pageTransactions", pageLabel, params],
    queryFn: () =>
      api.get<TransactionListResponse>(`/api/v1/pages/${pageLabel}/transactions${qs(params)}`),
  });
}

export function useTransactions(params: { limit?: number; offset?: number; pageLabel?: string } = {}) {
  return useQuery({
    queryKey: ["transactions", params],
    queryFn: () =>
      api.get<CrossPageTransactionListResponse>(`/api/v1/transactions${qs(params)}`),
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
        `/api/v1/fans/${platform}/${platformUserId}/transactions${qs(params)}`,
      ),
    enabled: !!platformUserId,
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
        `/api/v1/pages/${pageLabel}/fans/${platformUserId}/transactions${qs(params)}`,
      ),
    enabled: !!platformUserId,
  });
}

// Fans
export function usePageFanDetail(pageLabel: string, platformUserId: string) {
  return useQuery({
    queryKey: ["pageFanDetail", pageLabel, platformUserId],
    queryFn: () =>
      api.get<PageFanDetailResponse>(`/api/v1/pages/${pageLabel}/fans/${platformUserId}`),
    enabled: !!platformUserId,
  });
}

export function useFanDetail(platform: string, platformUserId: string) {
  return useQuery({
    queryKey: ["fanDetail", platform, platformUserId],
    queryFn: () =>
      api.get<CrossPageFanDetailResponse>(`/api/v1/fans/${platform}/${platformUserId}`),
    enabled: !!platformUserId,
  });
}

export function usePageFans(pageLabel: string, params: { limit?: number; offset?: number; query?: string } = {}) {
  return useQuery({
    queryKey: ["pageFans", pageLabel, params],
    queryFn: () =>
      api.get<FanListResponse>(`/api/v1/pages/${pageLabel}/fans${qs(params)}`),
  });
}

export function useCreateFanNote(pageLabel: string, platformUserId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: { body: string }) =>
      api.post<FanNoteResponse>(`/api/v1/pages/${pageLabel}/fans/${platformUserId}/notes`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pageFanDetail", pageLabel, platformUserId] });
    },
  });
}

export function useSetFanFlags(platform: string, platformUserId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { flags: string[] }) =>
      api.patch<FanFlagsResponse>(`/api/v1/fans/${platform}/${platformUserId}/flags`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fanDetail", platform, platformUserId] });
    },
  });
}

// Spenders
export function useSpenders(params: {
  scope: string;
  pageLabel?: string;
  period?: string;
  platform?: string;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortDir?: string;
}) {
  return useQuery({
    queryKey: ["spenders", params],
    queryFn: () => api.get<SpenderListResponse>(`/api/v2/spenders${qs(params)}`),
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
      api.get<SpenderDetailResponse>(`/api/v2/spenders/${platform}/${platformUserId}${qs(params)}`),
    enabled: !!platformUserId,
  });
}

// Admin
export function useAdminConnections() {
  return useQuery({
    queryKey: ["admin", "connections"],
    queryFn: () => api.get<ConnectionItem[]>("/api/v1/admin/connections"),
  });
}

export function useAdminUsers() {
  return useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => api.get<AuthUser[]>("/api/v1/admin/users"),
  });
}

export function useAdminCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminCreateUserBody) =>
      api.post<AuthUser>("/api/v1/admin/users", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}

export function useAdminSyncTrigger() {
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: { pageLabel: string; scope: "light" | "followers" | "all" }) =>
      api.post("/api/v1/admin/sync/trigger", body),
  });
}

export function useAdminSyncTriggerAll() {
  return useMutation({
    mutationFn: () => api.post("/api/v1/admin/sync/trigger-all"),
  });
}

export function useAdminSyncRuns(params: { pageLabel?: string; limit?: number; since?: string } = {}) {
  return useQuery({
    queryKey: ["admin", "syncRuns", params],
    queryFn: () => api.get<SyncRunItem[]>(`/api/v1/admin/sync/runs${qs(params)}`),
  });
}

export function useAdminUpdateCredentials(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: VerifyCredentialsBody) =>
      api.patch(`/api/v1/admin/pages/${pageLabel}/credentials`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "connections"] }),
  });
}
