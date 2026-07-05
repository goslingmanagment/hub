import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

export function useAuthMe() {
  return useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => kernel.me(),
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: { username: string; password: string }) =>
      kernel.login({ body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth"] }),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.logout(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth"] }),
  });
}
