import { mutationOptions, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

// The people and their device sign-ins, as the console still reads them. Inviting,
// links, revoking, disabling, deleting and pages per person are Workboard's
// «Доступ» now (apps/workboard/src/screens/access).

// Invalidated with `exact: true`. The per-user device caches hang off this same
// prefix, so a prefix invalidation would mark every person's devices stale on
// any one person's change; each mutation invalidates the keys it touched.
const USERS_KEY = ["admin", "users"] as const;

function requireUserId(userId: number | null): number {
  if (userId === null) throw new Error("Сначала выберите участника.");
  return userId;
}

function userDevicesKey(userId: number | null) {
  return ["admin", "users", userId, "devices"] as const;
}

/** The people list; the owner's only. `enabled: false` for a viewer the hub would refuse. */
export function useAdminUsers(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: USERS_KEY,
    queryFn: () => kernel.adminListUsers(),
    enabled: options.enabled ?? true,
  });
}

export function useUserDevices(userId: number | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: userDevicesKey(userId),
    queryFn: () => kernel.adminListDeviceTokens({ params: { userId: requireUserId(userId) } }),
    enabled: userId !== null && (options.enabled ?? true),
  });
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
