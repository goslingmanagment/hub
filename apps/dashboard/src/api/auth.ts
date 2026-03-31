import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuthState } from "@agency_hub_core/contracts";
import { api } from "./client.js";

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

