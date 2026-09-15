import { mutationOptions, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  AdminAssignPageBody,
  AdminCreateAccountLinkBody,
  AdminCreateInviteBody,
} from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

// Decision 348: the Team tab talks to the kernel through these hooks only.
// People are invited by a one-time link (adminCreateInvite), never created
// with a hand-typed password.
//
// The raw link arrives in the mutation RESULT and lives nowhere else — no
// query cache, no log, no URL path. It does, however, stay in the MUTATION
// cache for as long as the mutation is retained, so the caller that showed it
// must call `.reset()` when the reveal dialog closes; TeamTab does.
//
// Each mutation is exported twice: as options (driveable by a MutationObserver,
// the pattern of api/workboard.ts) and as the hook the components use. The
// options carry the kernel call and the invalidations, so
// tests/team-access-intents.test.ts can pin which route each button fires
// without a DOM.

// Invalidated with `exact: true` everywhere below. The per-user device and
// link caches hang off this same prefix, so a prefix invalidation would mark
// every person's devices stale on any one person's revoke; each mutation
// invalidates the individual keys it actually touched instead.
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

/** One call creates the account, assigns every page and mints the link. */
export function createInviteMutationOptions(qc: QueryClient) {
  return mutationOptions({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminCreateInviteBody) => kernel.adminCreateInvite({ body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: USERS_KEY, exact: true }),
  });
}

export function useCreateInvite() {
  return useMutation(createInviteMutationOptions(useQueryClient()));
}

export function useUserLinks(username: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: userLinksKey(username),
    queryFn: () => kernel.adminListAccountLinks({ params: { username } }),
    enabled: options.enabled ?? true,
  });
}

export function createAccountLinkMutationOptions(qc: QueryClient, username: string) {
  return mutationOptions({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminCreateAccountLinkBody) =>
      kernel.adminCreateAccountLink({ params: { username }, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: USERS_KEY, exact: true });
      qc.invalidateQueries({ queryKey: userLinksKey(username) });
    },
  });
}

export function useCreateAccountLink(username: string) {
  return useMutation(createAccountLinkMutationOptions(useQueryClient(), username));
}

export function revokeLinkMutationOptions(qc: QueryClient, username: string) {
  return mutationOptions({
    meta: { suppressGlobalError: true },
    mutationFn: (linkId: number) =>
      kernel.adminRevokeAccountLink({ params: { username, linkId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: userLinksKey(username) }),
  });
}

export function useRevokeLink(username: string) {
  return useMutation(revokeLinkMutationOptions(useQueryClient(), username));
}

export function useUserDevices(username: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: userDevicesKey(username),
    queryFn: () => kernel.adminListDeviceTokens({ params: { username } }),
    enabled: options.enabled ?? true,
  });
}

/** §4.4 "Завершить вход на устройстве": exactly one device sign-in. */
export function revokeDeviceMutationOptions(qc: QueryClient, username: string) {
  return mutationOptions({
    meta: { suppressGlobalError: true },
    mutationFn: (tokenId: number) =>
      kernel.adminRevokeDeviceToken({ params: { username, tokenId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: USERS_KEY, exact: true });
      qc.invalidateQueries({ queryKey: userDevicesKey(username) });
    },
  });
}

export function useRevokeDevice(username: string) {
  return useMutation(revokeDeviceMutationOptions(useQueryClient(), username));
}

/** §4.4 "Отозвать все устройства": every device sign-in (dashboard sessions
 * and links are untouched). */
export function revokeAllDevicesMutationOptions(qc: QueryClient, username: string) {
  return mutationOptions({
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.adminRevokeDeviceTokens({ params: { username } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: USERS_KEY, exact: true });
      qc.invalidateQueries({ queryKey: userDevicesKey(username) });
    },
  });
}

export function useRevokeAllDevices(username: string) {
  return useMutation(revokeAllDevicesMutationOptions(useQueryClient(), username));
}

/** §4.4 "Завершить все входы": devices + sessions + legacy credentials +
 * active links. The account stays enabled and the password stays valid. */
export function terminateAccessMutationOptions(qc: QueryClient, username: string) {
  return mutationOptions({
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.adminTerminateAllAccess({ params: { username } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: USERS_KEY, exact: true });
      qc.invalidateQueries({ queryKey: userDevicesKey(username) });
      qc.invalidateQueries({ queryKey: userLinksKey(username) });
    },
  });
}

export function useTerminateAccess(username: string) {
  return useMutation(terminateAccessMutationOptions(useQueryClient(), username));
}

/** Technical tab only: bind (UUID) or remove (null) a device's Desktop
 * harvest capability. */
export function setHarvestCapabilityMutationOptions(qc: QueryClient, username: string) {
  return mutationOptions({
    meta: { suppressGlobalError: true },
    mutationFn: (input: { tokenId: number; machineId: string | null }) =>
      kernel.adminSetDeviceTokenHarvestCapability({
        params: { username, tokenId: input.tokenId },
        body: { machineId: input.machineId },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: userDevicesKey(username) }),
  });
}

export function useSetHarvestCapability(username: string) {
  return useMutation(setHarvestCapabilityMutationOptions(useQueryClient(), username));
}

export function useAdminDeactivateUser(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.adminDeactivateUser({ params: { username } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: USERS_KEY, exact: true });
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
    onSuccess: () => qc.invalidateQueries({ queryKey: USERS_KEY, exact: true }),
  });
}

export function useAdminAssignPage(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminAssignPageBody) =>
      kernel.adminAssignPage({ params: { username }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: USERS_KEY, exact: true }),
  });
}

export function useAdminUnassignPage(username: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (pageLabel: string) =>
      kernel.adminUnassignPage({ params: { username, pageLabel } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: USERS_KEY, exact: true }),
  });
}
