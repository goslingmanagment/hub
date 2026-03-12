import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type {
  AdminAssignPageBody,
  AdminCreatePageResponse,
  AdminCreateUserBody,
  ApiKeyItem,
  AuthState,
  AuthUser,
  ConnectionItem,
  CreateFanNoteBody,
  CreateModelBody,
  CreateModelResponse,
  CreatePageBody,
  CrossPageFanDetailResponse,
  CrossPageFanTransactionListResponse,
  CrossPageTransactionListResponse,
  FanFlagsResponse,
  FanNoteResponse,
  FansSearchResponse,
  IssuedApiKeyResponse,
  LoginBody,
  ModelListItem,
  OverviewResponse,
  RevenueDailyResponse,
  SetFanFlagsBody,
  SpenderListResponse,
  SpenderSeriesResponse,
  SyncRunDetailResponse,
  SyncRunItem,
  SyncTriggerAllResponse,
  SyncTriggerBody,
  SyncTriggerResponse,
  UpdateCredentialsBody,
  UpdateCredentialsResponse,
  VerifyCredentialsBody,
  VerifyCredentialsResponse,
  VerifyPageResponse,
  paths,
} from "@fansly-connect/contracts";
import { api, ApiError } from "./client";
import { useAuthStore } from "@/stores/auth";

type QueryHookOptions<TData, TKey extends readonly unknown[]> = Omit<
  UseQueryOptions<TData, ApiError, TData, TKey>,
  "queryKey" | "queryFn"
>;

type OkResponse = { ok: true };
type RevokeApiKeysResponse = { revokedCount: number };
type OpenApiSpec = paths["/api/v1/openapi.json"]["get"]["responses"][200]["content"]["application/json"];

// --- Key factories ---
export const keys = {
  me: () => ["me"] as const,
  overview: () => ["overview"] as const,
  models: () => ["models"] as const,
  pages: () => ["pages"] as const,
  pageRevenue: (label: string, query: string) => ["pageRevenue", label, query] as const,
  overviewRevenue: (query: string) => ["overviewRevenue", query] as const,
  modelRevenue: (slug: string, query: string) => ["modelRevenue", slug, query] as const,
  transactions: (query: string) => ["transactions", query] as const,
  fan: (platform: string, id: string) => ["fan", platform, id] as const,
  fanTransactions: (platform: string, id: string, query: string) =>
    ["fanTransactions", platform, id, query] as const,
  fansSearch: (query: string) => ["fansSearch", query] as const,
  spenders: (query: string) => ["spenders", query] as const,
  spenderSeries: (platform: string, id: string, query: string) =>
    ["spenderSeries", platform, id, query] as const,
  adminUsers: () => ["adminUsers"] as const,
  adminApiKeys: (username: string) => ["adminApiKeys", username] as const,
  adminConnections: () => ["adminConnections"] as const,
  adminSyncRuns: (query: string) => ["adminSyncRuns", query] as const,
  adminSyncRunDetail: (runId: number) => ["adminSyncRunDetail", runId] as const,
  openapi: () => ["openapi"] as const,
};

// --- Auth hooks ---
export function useMe(options?: QueryHookOptions<AuthState, ReturnType<typeof keys.me>>) {
  return useQuery({
    queryKey: keys.me(),
    queryFn: () => api.get<AuthState>("/api/v1/auth/me"),
    staleTime: 5 * 60_000,
    retry: false,
    ...options,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  const setAuth = useAuthStore((s) => s.setAuth);

  return useMutation({
    mutationFn: (input: LoginBody) =>
      api.post<AuthState>("/api/v1/auth/login", input),
    onSuccess: (data) => {
      setAuth(data.user, data.authMethod);
      queryClient.setQueryData(keys.me(), data);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  const clearAuth = useAuthStore((s) => s.clearAuth);

  return useMutation({
    mutationFn: () => api.post<OkResponse>("/api/v1/auth/logout"),
    onSuccess: () => {
      clearAuth();
      queryClient.clear();
    },
  });
}

// --- Overview ---
export function useOverview() {
  return useQuery({
    queryKey: keys.overview(),
    queryFn: () => api.get<OverviewResponse>("/api/v1/overview"),
    staleTime: 30_000,
  });
}

export function useModels() {
  return useQuery({
    queryKey: keys.models(),
    queryFn: () => api.get<ModelListItem[]>("/api/v1/models"),
    staleTime: 30_000,
  });
}

// --- Revenue daily ---
export function useOverviewRevenueDaily(query: Record<string, string>) {
  const qs = new URLSearchParams(query).toString();
  return useQuery({
    queryKey: keys.overviewRevenue(qs),
    queryFn: () => api.get<RevenueDailyResponse>(`/api/v1/overview/revenue/daily?${qs}`),
    staleTime: 30_000,
  });
}

export function usePageRevenueDaily(label: string, query: Record<string, string>) {
  const qs = new URLSearchParams(query).toString();
  return useQuery({
    queryKey: keys.pageRevenue(label, qs),
    queryFn: () => api.get<RevenueDailyResponse>(`/api/v1/pages/${label}/revenue/daily?${qs}`),
    staleTime: 30_000,
  });
}

export function useModelRevenueDaily(slug: string, query: Record<string, string>) {
  const qs = new URLSearchParams(query).toString();
  return useQuery({
    queryKey: keys.modelRevenue(slug, qs),
    queryFn: () => api.get<RevenueDailyResponse>(`/api/v1/models/${slug}/revenue/daily?${qs}`),
    staleTime: 30_000,
  });
}

// --- Transactions ---
export function useTransactions(query: Record<string, string>) {
  const qs = new URLSearchParams(query).toString();
  return useQuery({
    queryKey: keys.transactions(qs),
    queryFn: () => api.get<CrossPageTransactionListResponse>(`/api/v1/transactions?${qs}`),
    staleTime: 30_000,
  });
}

// --- Fans ---
export function useFansSearch(query: Record<string, string>, enabled = true) {
  const qs = new URLSearchParams(query).toString();
  return useQuery({
    queryKey: keys.fansSearch(qs),
    queryFn: () => api.get<FansSearchResponse>(`/api/v2/fans/search?${qs}`),
    staleTime: 30_000,
    enabled,
  });
}

export function useFanDetail(platform: string, platformUserId: string) {
  return useQuery({
    queryKey: keys.fan(platform, platformUserId),
    queryFn: () => api.get<CrossPageFanDetailResponse>(`/api/v1/fans/${platform}/${platformUserId}`),
    staleTime: 30_000,
  });
}

export function useFanTransactions(
  platform: string,
  platformUserId: string,
  query: Record<string, string>,
) {
  const qs = new URLSearchParams(query).toString();
  return useQuery({
    queryKey: keys.fanTransactions(platform, platformUserId, qs),
    queryFn: () =>
      api.get<CrossPageFanTransactionListResponse>(
        `/api/v1/fans/${platform}/${platformUserId}/transactions?${qs}`,
      ),
    staleTime: 30_000,
  });
}

export function useCreateFanNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      pageLabel,
      platformUserId,
      ...body
    }: {
      pageLabel: string;
      platformUserId: string;
    } & CreateFanNoteBody) =>
      api.post<FanNoteResponse>(`/api/v1/pages/${pageLabel}/fans/${platformUserId}/notes`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fan"] });
    },
  });
}

export function useSetFanFlags() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      platform,
      platformUserId,
      ...body
    }: {
      platform: string;
      platformUserId: string;
    } & SetFanFlagsBody) =>
      api.patch<FanFlagsResponse>(`/api/v1/fans/${platform}/${platformUserId}/flags`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fan"] });
    },
  });
}

// --- Spenders ---
export function useSpenders(query: Record<string, string>) {
  const qs = new URLSearchParams(query).toString();
  return useQuery({
    queryKey: keys.spenders(qs),
    queryFn: () => api.get<SpenderListResponse>(`/api/v2/spenders?${qs}`),
    staleTime: 30_000,
  });
}

export function useSpenderSeries(
  platform: string,
  platformUserId: string,
  query: Record<string, string>,
) {
  const qs = new URLSearchParams(query).toString();
  return useQuery({
    queryKey: keys.spenderSeries(platform, platformUserId, qs),
    queryFn: () =>
      api.get<SpenderSeriesResponse>(`/api/v2/spenders/${platform}/${platformUserId}/series?${qs}`),
    staleTime: 30_000,
  });
}

// --- Admin: Users ---
export function useAdminUsers() {
  return useQuery({
    queryKey: keys.adminUsers(),
    queryFn: () => api.get<AuthUser[]>("/api/v1/admin/users"),
    staleTime: 30_000,
  });
}

export function useAdminCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AdminCreateUserBody) =>
      api.post<AuthUser>("/api/v1/admin/users", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.adminUsers() }),
  });
}

export function useAdminSetPassword() {
  return useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) =>
      api.patch<OkResponse>(`/api/v1/admin/users/${username}/password`, { password }),
  });
}

export function useAdminAssignPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ username, ...body }: { username: string } & AdminAssignPageBody) =>
      api.post<AuthUser>(`/api/v1/admin/users/${username}/pages`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.adminUsers() }),
  });
}

export function useAdminUnassignPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ username, pageLabel }: { username: string; pageLabel: string }) =>
      api.delete<OkResponse>(`/api/v1/admin/users/${username}/pages/${pageLabel}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.adminUsers() }),
  });
}

// --- Admin: API Keys ---
export function useAdminApiKeys(username: string) {
  return useQuery({
    queryKey: keys.adminApiKeys(username),
    queryFn: () => api.get<ApiKeyItem[]>(`/api/v1/admin/users/${username}/api-keys`),
    staleTime: 30_000,
  });
}

export function useAdminIssueApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ username, pageLabel }: { username: string; pageLabel?: string }) =>
      api.post<IssuedApiKeyResponse>(`/api/v1/admin/users/${username}/api-keys`, { pageLabel }),
    onSuccess: (_data, vars) =>
      queryClient.invalidateQueries({ queryKey: keys.adminApiKeys(vars.username) }),
  });
}

export function useAdminRevokeApiKeys() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ username }: { username: string }) =>
      api.delete<RevokeApiKeysResponse>(`/api/v1/admin/users/${username}/api-keys`),
    onSuccess: (_data, vars) =>
      queryClient.invalidateQueries({ queryKey: keys.adminApiKeys(vars.username) }),
  });
}

// --- Admin: Connections ---
export function useAdminConnections() {
  return useQuery({
    queryKey: keys.adminConnections(),
    queryFn: () => api.get<ConnectionItem[]>("/api/v1/admin/connections"),
    staleTime: 30_000,
  });
}

// --- Admin: Sync ---
export function useAdminSyncRuns(query: Record<string, string>, refetchInterval?: number) {
  const qs = new URLSearchParams(query).toString();
  return useQuery({
    queryKey: keys.adminSyncRuns(qs),
    queryFn: () => api.get<SyncRunItem[]>(`/api/v1/admin/sync/runs?${qs}`),
    staleTime: 5_000,
    refetchInterval,
  });
}

export function useAdminSyncRunDetail(
  runId: number,
  options?: QueryHookOptions<SyncRunDetailResponse, ReturnType<typeof keys.adminSyncRunDetail>>,
) {
  return useQuery({
    queryKey: keys.adminSyncRunDetail(runId),
    queryFn: () => api.get<SyncRunDetailResponse>(`/api/v1/admin/sync/runs/${runId}`),
    staleTime: 5_000,
    ...options,
  });
}

export function useAdminSyncTrigger() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SyncTriggerBody) =>
      api.post<SyncTriggerResponse>("/api/v1/admin/sync/trigger", input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["adminSyncRuns"] }),
  });
}

export function useAdminSyncTriggerAll() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<SyncTriggerAllResponse>("/api/v1/admin/sync/trigger-all"),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["adminSyncRuns"] }),
  });
}

// --- Admin: Models + Pages + Credentials ---
export function useAdminCreateModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateModelBody) =>
      api.post<CreateModelResponse>("/api/v1/admin/models", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.models() });
      queryClient.invalidateQueries({ queryKey: keys.overview() });
    },
  });
}

export function useAdminCreatePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePageBody) => api.post<AdminCreatePageResponse>("/api/v1/admin/pages", input),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: keys.adminConnections() });
      queryClient.invalidateQueries({ queryKey: keys.overview() });
    },
  });
}

export function useAdminVerifyCredentials() {
  return useMutation({
    mutationFn: (input: VerifyCredentialsBody) =>
      api.post<VerifyCredentialsResponse>("/api/v1/admin/credentials/verify", input),
  });
}

export function useAdminVerifyPage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ pageLabel }: { pageLabel: string }) =>
      api.post<VerifyPageResponse>(`/api/v1/admin/pages/${pageLabel}/verify`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: keys.adminConnections() }),
  });
}

export function useAdminUpdateCredentials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ pageLabel, ...body }: { pageLabel: string } & UpdateCredentialsBody) =>
      api.patch<UpdateCredentialsResponse>(`/api/v1/admin/pages/${pageLabel}/credentials`, body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: keys.adminConnections() }),
  });
}

// --- OpenAPI spec ---
export function useOpenApiSpec() {
  return useQuery({
    queryKey: keys.openapi(),
    queryFn: () => api.get<OpenApiSpec>("/api/v1/openapi.json"),
    staleTime: Infinity,
  });
}

// --- Global 401 handler ---
export function handle401(error: unknown) {
  if (error instanceof ApiError && error.status === 401) {
    useAuthStore.getState().clearAuth();
    if (window.location.pathname !== "/login") {
      window.location.replace("/login");
    }
  }
}
