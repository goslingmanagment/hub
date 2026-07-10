import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AdminAssignPageBody,
  AdminCreateUserBody,
  AdminIssueApiKeyBody,
  AdminSetPasswordBody,
} from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

export function useAdminUsers() {
  return useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => kernel.adminListUsers(),
  });
}

export function useAdminCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminCreateUserBody) =>
      kernel.adminCreateUser({ body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}

export function useAdminUserApiKeys(username: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["admin", "users", username, "apiKeys"],
    queryFn: () => kernel.adminListApiKeys({ params: { username } }),
    enabled: options.enabled ?? true,
  });
}

export function useAdminIssueApiKey(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminIssueApiKeyBody) =>
      kernel.adminIssueApiKey({ params: { username }, body }),
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
      kernel.adminRevokeApiKeys({ params: { username } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      qc.invalidateQueries({ queryKey: ["admin", "users", username, "apiKeys"] });
    },
  });
}

export function useAdminDeactivateUser(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () =>
      kernel.adminDeactivateUser({ params: { username } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      qc.invalidateQueries({ queryKey: ["admin", "users", username, "apiKeys"] });
    },
  });
}

export function useAdminReactivateUser(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () =>
      kernel.adminReactivateUser({ params: { username } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}

export function useAdminSetPassword(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminSetPasswordBody) =>
      kernel.adminSetPassword({ params: { username }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}

export function useAdminAssignPage(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminAssignPageBody) =>
      kernel.adminAssignPage({ params: { username }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}

export function useAdminUnassignPage(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (pageLabel: string) =>
      kernel.adminUnassignPage({ params: { username, pageLabel } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}
