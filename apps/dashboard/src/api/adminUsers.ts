import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AdminAssignPageBody,
  AdminCreateUserBody,
  AdminIssueApiKeyBody,
  AdminUser,
  ApiKeyItem,
  AuthUser,
  IssuedApiKeyResponse,
} from "@agency_hub_core/contracts";
import { api } from "./client.js";
import { pathSegment } from "@/lib/path";

export function useAdminUsers() {
  return useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => api.get<AdminUser[]>("/api/v1/admin/users"),
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

export function useAdminUserApiKeys(username: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["admin", "users", username, "apiKeys"],
    queryFn: () => api.get<ApiKeyItem[]>(`/api/v1/admin/users/${pathSegment(username)}/api-keys`),
    enabled: options.enabled ?? true,
  });
}

export function useAdminIssueApiKey(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminIssueApiKeyBody) =>
      api.post<IssuedApiKeyResponse>(`/api/v1/admin/users/${pathSegment(username)}/api-keys`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      qc.invalidateQueries({ queryKey: ["admin", "users", username, "apiKeys"] });
    },
  });
}

export function useAdminRevokeApiKeys(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () =>
      api.del<{ revokedCount: number }>(`/api/v1/admin/users/${pathSegment(username)}/api-keys`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      qc.invalidateQueries({ queryKey: ["admin", "users", username, "apiKeys"] });
    },
  });
}

export function useAdminAssignPage(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminAssignPageBody) =>
      api.post<AuthUser>(`/api/v1/admin/users/${pathSegment(username)}/pages`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}

export function useAdminUnassignPage(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (pageLabel: string) =>
      api.del<{ ok: true }>(`/api/v1/admin/users/${pathSegment(username)}/pages/${pathSegment(pageLabel)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}
