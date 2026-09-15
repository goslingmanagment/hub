import { mutationOptions, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  AdminUser,
  AdminAssignPageBody,
  AdminCreateAccountLinkBody,
  AdminCreateInviteBody,
} from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

// Decision 350: the Team tab talks to the kernel through these hooks only.
// People are invited by a one-time link (adminCreateInvite), never created
// with a hand-typed password.
//
// The raw link arrives in the mutation RESULT and lives nowhere else — no
// query cache, no log, no URL path. Issuance mutations use gcTime: 0 so their
// results are collected once the observer releases them. The caller must
// `.reset()` when the reveal dialog closes; TeamTab does.
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

function requireUserId(userId: number | null): number {
  if (userId === null) throw new Error("Сначала выберите участника.");
  return userId;
}

function userDevicesKey(userId: number | null) {
  return ["admin", "users", userId, "devices"] as const;
}

function userLinksKey(userId: number | null) {
  return ["admin", "users", userId, "links"] as const;
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
    gcTime: 0,
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminCreateInviteBody) => kernel.adminCreateInvite({ body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: USERS_KEY, exact: true }),
  });
}

export function useCreateInvite() {
  return useMutation(createInviteMutationOptions(useQueryClient()));
}

export function useUserLinks(userId: number, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: userLinksKey(userId),
    queryFn: () => kernel.adminListAccountLinks({ params: { userId } }),
    enabled: userId !== null && (options.enabled ?? true),
  });
}

export function createAccountLinkMutationOptions(qc: QueryClient) {
  return mutationOptions({
    gcTime: 0,
    meta: { suppressGlobalError: true },
    mutationFn: ({ userId, ...body }: AdminCreateAccountLinkBody & { userId: number }) =>
      kernel.adminCreateAccountLink({ params: { userId }, body }),
    onSuccess: (_result, { userId }) => {
      qc.invalidateQueries({ queryKey: USERS_KEY, exact: true });
      qc.invalidateQueries({ queryKey: userLinksKey(userId) });
    },
  });
}

export function useCreateAccountLink() {
  return useMutation(createAccountLinkMutationOptions(useQueryClient()));
}

export function revokeLinkMutationOptions(qc: QueryClient, userId: number) {
  return mutationOptions({
    mutationKey: [...USERS_KEY, userId, "revoke-link"],
    meta: { suppressGlobalError: true },
    mutationFn: (linkId: number) =>
      kernel.adminRevokeAccountLink({ params: { userId, linkId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: userLinksKey(userId) }),
  });
}

export function useRevokeLink(userId: number) {
  return useMutation(revokeLinkMutationOptions(useQueryClient(), userId));
}

export function useUserDevices(userId: number | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: userDevicesKey(userId),
    queryFn: () => kernel.adminListDeviceTokens({ params: { userId: requireUserId(userId) } }),
    enabled: userId !== null && (options.enabled ?? true),
  });
}

/** §4.4 "Завершить вход на устройстве": exactly one device sign-in. */
export function revokeDeviceMutationOptions(qc: QueryClient, userId: number) {
  return mutationOptions({
    mutationKey: [...USERS_KEY, userId, "revoke-device"],
    meta: { suppressGlobalError: true },
    mutationFn: (tokenId: number) =>
      kernel.adminRevokeDeviceToken({ params: { userId, tokenId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: USERS_KEY, exact: true });
      qc.invalidateQueries({ queryKey: userDevicesKey(userId) });
    },
  });
}

export function useRevokeDevice(userId: number) {
  return useMutation(revokeDeviceMutationOptions(useQueryClient(), userId));
}

/** §4.4 "Отозвать все устройства": every device sign-in (dashboard sessions
 * and links are untouched). */
export function revokeAllDevicesMutationOptions(qc: QueryClient, userId: number) {
  return mutationOptions({
    mutationKey: [...USERS_KEY, userId, "revoke-devices"],
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.adminRevokeDeviceTokens({ params: { userId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: USERS_KEY, exact: true });
      qc.invalidateQueries({ queryKey: userDevicesKey(userId) });
    },
  });
}

export function useRevokeAllDevices(userId: number) {
  return useMutation(revokeAllDevicesMutationOptions(useQueryClient(), userId));
}

/** §4.4 "Завершить все входы": devices + sessions + legacy credentials +
 * active links. The account stays enabled and the password stays valid. */
export function terminateAccessMutationOptions(qc: QueryClient, userId: number) {
  return mutationOptions({
    mutationKey: [...USERS_KEY, userId, "terminate-access"],
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.adminTerminateAllAccess({ params: { userId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: USERS_KEY, exact: true });
      qc.invalidateQueries({ queryKey: userDevicesKey(userId) });
      qc.invalidateQueries({ queryKey: userLinksKey(userId) });
    },
  });
}

export function useTerminateAccess(userId: number) {
  return useMutation(terminateAccessMutationOptions(useQueryClient(), userId));
}

/** Technical tab only: bind (UUID) or remove (null) a device's Desktop
 * harvest capability. */
export function setHarvestCapabilityMutationOptions(qc: QueryClient, userId: number | null) {
  return mutationOptions({
    mutationKey: [...USERS_KEY, userId, "harvest-capability"],
    meta: { suppressGlobalError: true },
    mutationFn: (input: { tokenId: number; machineId: string | null }) =>
      kernel.adminSetDeviceTokenHarvestCapability({
        params: { userId: requireUserId(userId), tokenId: input.tokenId },
        body: { machineId: input.machineId },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: userDevicesKey(userId) }),
  });
}

export function useSetHarvestCapability(userId: number | null) {
  return useMutation(setHarvestCapabilityMutationOptions(useQueryClient(), userId));
}

export function useAdminDeactivateUser(userId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...USERS_KEY, userId, "deactivate"],
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.adminDeactivateUser({ params: { userId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: USERS_KEY, exact: true });
      qc.invalidateQueries({ queryKey: userDevicesKey(userId) });
      qc.invalidateQueries({ queryKey: userLinksKey(userId) });
    },
  });
}

export function useAdminReactivateUser(userId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...USERS_KEY, userId, "reactivate"],
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.adminReactivateUser({ params: { userId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: USERS_KEY, exact: true }),
  });
}

/** Deletion ends this identity permanently; a reused login gets a different ID. */
export function deleteUserMutationOptions(qc: QueryClient, userId: number) {
  return mutationOptions({
    mutationKey: [...USERS_KEY, userId, "delete"],
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.adminDeleteUser({ params: { userId } }),
    onSuccess: async () => {
      // A list response started before deletion must not restore the old row.
      await qc.cancelQueries({ queryKey: USERS_KEY, exact: true });
      await qc.cancelQueries({ queryKey: [...USERS_KEY, userId] });
      qc.setQueryData<AdminUser[]>(USERS_KEY, (users) => users?.filter((user) => user.id !== userId));
      qc.removeQueries({ queryKey: [...USERS_KEY, userId] });
      await qc.invalidateQueries({ queryKey: USERS_KEY, exact: true });
    },
  });
}

export function useAdminDeleteUser(userId: number) {
  return useMutation(deleteUserMutationOptions(useQueryClient(), userId));
}

export function useAdminAssignPage(userId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...USERS_KEY, userId, "assign-page"],
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminAssignPageBody) =>
      kernel.adminAssignPage({ params: { userId }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: USERS_KEY, exact: true }),
  });
}

export function useAdminUnassignPage(userId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...USERS_KEY, userId, "unassign-page"],
    meta: { suppressGlobalError: true },
    mutationFn: (pageLabel: string) =>
      kernel.adminUnassignPage({ params: { userId, pageLabel } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: USERS_KEY, exact: true }),
  });
}
