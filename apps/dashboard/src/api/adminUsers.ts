import { useIsMutating, useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AdminAssignPageBody,
  AdminCreateUserBody,
  AdminIssueApiKeyBody,
  AdminSetPasswordBody,
  IssuedApiKeyResponse,
} from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

export function useAdminUsers(options: { suppressGlobalError?: boolean } = {}) {
  return useQuery({
    queryKey: ["admin", "users"],
    meta: { suppressGlobalError: options.suppressGlobalError ?? false },
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

export function useAdminUserApiKeys(username: string, options: { enabled?: boolean; suppressGlobalError?: boolean } = {}) {
  return useQuery({
    queryKey: ["admin", "users", username, "apiKeys"],
    meta: { suppressGlobalError: options.suppressGlobalError ?? false },
    queryFn: () => kernel.adminListApiKeys({ params: { username } }),
    enabled: options.enabled ?? true,
  });
}

export function useAdminIssueApiKey(username: string) {
  const qc = useQueryClient();
  const mutationKey = ["admin", "issuedUserKey", username];
  const pending = useIsMutating({ mutationKey }) > 0;
  const mutation = useMutation({
    mutationKey,
    gcTime: Infinity,
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminIssueApiKeyBody) =>
      kernel.adminIssueApiKey({ params: { username }, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      qc.invalidateQueries({ queryKey: ["admin", "users", username, "apiKeys"] });
    },
  });
  return { ...mutation, isPending: mutation.isPending || pending };
}

/** Keep the one response in session memory until acknowledged, including when
 * settings navigation unmounts the issuing control. Logout clears the client. */
export function useIssuedUserApiKeys() {
  const qc = useQueryClient();
  const pending = useIsMutating({ mutationKey: ["admin", "issuedUserKey"] }) > 0;
  const issued = useMutationState({
    filters: { mutationKey: ["admin", "issuedUserKey"], status: "success" },
    select: (mutation) => ({
      id: mutation.mutationId,
      username: String(mutation.options.mutationKey?.[2] ?? ""),
      result: mutation.state.data as IssuedApiKeyResponse,
    }),
  });
  function acknowledge(id: number) {
    const cache = qc.getMutationCache();
    const mutation = cache.getAll().find((entry) => entry.mutationId === id);
    if (mutation?.state.status === "success") cache.remove(mutation);
  }
  return { issued, acknowledge, pending };
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
  const mutationKey = ["admin", "users", username, "setPassword"];
  const pending = useIsMutating({ mutationKey }) > 0;
  const mutation = useMutation({
    mutationKey,
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminSetPasswordBody) =>
      kernel.adminSetPassword({ params: { username }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
  return { ...mutation, isPending: mutation.isPending || pending };
}

export function useAdminAssignPage(username: string) {
  const qc = useQueryClient();
  const mutationKey = ["admin", "users", username, "assignPage"];
  const pending = useIsMutating({ mutationKey }) > 0;
  const mutation = useMutation({
    mutationKey,
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminAssignPageBody) =>
      kernel.adminAssignPage({ params: { username }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
  return { ...mutation, isPending: mutation.isPending || pending };
}

export function useAdminUnassignPage(username: string) {
  const qc = useQueryClient();
  const mutationKey = ["admin", "users", username, "unassignPage"];
  const pending = useIsMutating({ mutationKey }) > 0;
  const mutation = useMutation({
    mutationKey,
    meta: { suppressGlobalError: true },
    mutationFn: (pageLabel: string) =>
      kernel.adminUnassignPage({ params: { username, pageLabel } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
  return { ...mutation, isPending: mutation.isPending || pending };
}
