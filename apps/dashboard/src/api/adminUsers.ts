import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AdminAssignPageBody,
  AdminCreateAccountLinkBody,
  AdminCreateInviteBody,
} from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

// Decision 348: the Team tab talks to the kernel through these hooks only.
// People are invited by a one-time link (adminCreateInvite), never created
// with a hand-typed password; the raw link token exists in the mutation
// RESULT and nowhere else — the caller shows it once or loses it (a lost link
// is superseded by creating another, §4.1 p.5/p.10).

const USERS_KEY = ["admin", "users"] as const;

function userDevicesKey(username: string) {
  return ["admin", "users", username, "devices"] as const;
}

function userLinksKey(username: string) {
  return ["admin", "users", username, "links"] as const;
}

export function useAdminUsers() {
  return useQuery({
    queryKey: USERS_KEY,
    queryFn: () => kernel.adminListUsers(),
  });
}

export function useCreateInvite() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminCreateInviteBody) => kernel.adminCreateInvite({ body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: USERS_KEY }),
  });
}

export function useUserLinks(username: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: userLinksKey(username),
    queryFn: () => kernel.adminListAccountLinks({ params: { username } }),
    enabled: options.enabled ?? true,
  });
}

export function useCreateAccountLink(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminCreateAccountLinkBody) =>
      kernel.adminCreateAccountLink({ params: { username }, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: USERS_KEY });
      qc.invalidateQueries({ queryKey: userLinksKey(username) });
    },
  });
}

export function useRevokeLink(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (linkId: number) =>
      kernel.adminRevokeAccountLink({ params: { username, linkId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: userLinksKey(username) }),
  });
}

export function useUserDevices(username: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: userDevicesKey(username),
    queryFn: () => kernel.adminListDeviceTokens({ params: { username } }),
    enabled: options.enabled ?? true,
  });
}

/** §4.4 "Отозвать вход": exactly one device sign-in. */
export function useRevokeDevice(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (tokenId: number) =>
      kernel.adminRevokeDeviceToken({ params: { username, tokenId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: USERS_KEY });
      qc.invalidateQueries({ queryKey: userDevicesKey(username) });
    },
  });
}

/** §4.4 "Отозвать все устройства": every device sign-in (dashboard sessions
 * and links are untouched). */
export function useRevokeAllDevices(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.adminRevokeDeviceTokens({ params: { username } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: USERS_KEY });
      qc.invalidateQueries({ queryKey: userDevicesKey(username) });
    },
  });
}

/** §4.4 "Завершить все входы": devices + sessions + legacy credentials +
 * active links. The account stays enabled and the password stays valid. */
export function useTerminateAccess(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.adminTerminateAllAccess({ params: { username } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: USERS_KEY });
      qc.invalidateQueries({ queryKey: userDevicesKey(username) });
      qc.invalidateQueries({ queryKey: userLinksKey(username) });
    },
  });
}

/** Technical tab only: bind (UUID) or remove (null) a device's Desktop
 * harvest capability. */
export function useSetHarvestCapability(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (input: { tokenId: number; machineId: string | null }) =>
      kernel.adminSetDeviceTokenHarvestCapability({
        params: { username, tokenId: input.tokenId },
        body: { machineId: input.machineId },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: userDevicesKey(username) }),
  });
}

export function useAdminDeactivateUser(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.adminDeactivateUser({ params: { username } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: USERS_KEY });
      qc.invalidateQueries({ queryKey: userDevicesKey(username) });
      qc.invalidateQueries({ queryKey: userLinksKey(username) });
    },
  });
}

export function useAdminReactivateUser(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.adminReactivateUser({ params: { username } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: USERS_KEY }),
  });
}

export function useAdminAssignPage(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminAssignPageBody) =>
      kernel.adminAssignPage({ params: { username }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: USERS_KEY }),
  });
}

export function useAdminUnassignPage(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (pageLabel: string) =>
      kernel.adminUnassignPage({ params: { username, pageLabel } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: USERS_KEY }),
  });
}
