import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChangePasswordBody } from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

// Decision 351: the chatter's own surface — the invitation page (/join, public)
// and the cabinet (/account, any live session). Everything goes through the
// generated SDK, like every other domain module (dashboard-sdk-ban).
//
// The invitation secret only ever travels in the POST body: it is passed in as
// an argument, never stored in a query key, never appended to a URL.

export function useInspectAccountLink() {
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (input: { token: string }) =>
      kernel.authInspectAccountLink({ body: input }),
  });
}

export function useRedeemAccountLink() {
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (input: { token: string; password: string }) =>
      kernel.authRedeemAccountLink({ body: input }),
  });
}

export function useMyDevices(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["account", "devices"],
    queryFn: () => kernel.authListDevices(),
    enabled: options.enabled ?? true,
  });
}

export function useRevokeMyDevice() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (deviceId: number) =>
      kernel.authRevokeDevice({ params: { deviceId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["account", "devices"] }),
  });
}

export function useRevokeMyDevices() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.authRevokeAllDevices(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["account", "devices"] }),
  });
}

export function useChangeMyPassword() {
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: ChangePasswordBody) =>
      kernel.authChangePassword({ body }),
  });
}

export function useMyUsage(params: { from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: ["account", "usage", params],
    queryFn: () => kernel.authMyUsage({ query: params }),
  });
}
