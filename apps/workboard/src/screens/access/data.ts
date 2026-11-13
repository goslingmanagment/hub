import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { AdminCreateInviteBody, KernelOperationResponse } from "@agency_hub_core/contracts";
import { moscowToday } from "@agency_hub_core/ui/moscow";
import { kernel } from "@/shared/hub";
import { usersQuery } from "@/shared/reads";

/**
 * Доступ — the data layer (spec §4.8, and the «Доступ» tab of Человек §4.4 through
 * src/screens/access/PersonAccess.tsx). The screen and the panel read only this file.
 *
 * Reads (the owner's only; Hub refuses everyone else): `adminListUsers`,
 * `adminPages`, `adminListDeviceTokens`, `adminListAccountLinks`,
 * `adminAiChatterLimits` (read only: the limit is changed in the console).
 *
 * Writes — each the console's request with the console's body
 * (apps/dashboard/src/api/adminUsers.ts):
 *   - invite: `adminCreateInvite` { username, role, pageLabels, expiresInHours } — one call (:55-66);
 *   - a new link: `adminCreateAccountLink` { params: { userId }, body: { kind } } (:76-91);
 *   - revoke a link: `adminRevokeAccountLink` { userId, linkId } (:93-105);
 *   - end one device sign-in: `adminRevokeDeviceToken` { userId, tokenId } (:116-131);
 *   - every device: `adminRevokeDeviceTokens` { userId } (:135-149);
 *   - every sign-in: `adminTerminateAllAccess` { userId } (:153-168);
 *   - disable / restore: `adminDeactivateUser` / `adminReactivateUser` { userId } (:189-212);
 *   - delete for good: `adminDeleteUser` { userId }, with the console's cache care (:214-245);
 *   - open / remove a page: `adminAssignPage` { userId } { pageLabel } / `adminUnassignPage` { userId, pageLabel } (:247-267).
 * A minted link lives only in its mutation's result (gcTime 0) until the window
 * showing it closes and resets it: never in a query cache, a log or a URL path.
 * Query keys start with "access".
 */

export type AdminUser = KernelOperationResponse<"adminListUsers">[number];
export type AdminPage = KernelOperationResponse<"adminPages">[number];
export type DeviceItem = KernelOperationResponse<"adminListDeviceTokens">[number];
export type LinkItem = KernelOperationResponse<"adminListAccountLinks">[number];
type AiLimits = KernelOperationResponse<"adminAiChatterLimits">;

/** The people list is the entry Люди reads too (src/shared/reads.ts): a write here refreshes them all. */
const USERS_KEY = usersQuery.queryKey;
const PAGES_KEY = ["access", "pages"] as const;
const devicesKey = (userId: number) => ["access", "user", userId, "devices"] as const;
const linksKey = (userId: number) => ["access", "user", userId, "links"] as const;

export function useAccessUsers(enabled = true) {
  return useQuery({ ...usersQuery, enabled });
}

export function useAccessPages(enabled = true) {
  return useQuery({ queryKey: PAGES_KEY, queryFn: () => kernel.adminPages(), enabled, staleTime: 5 * 60_000 });
}

export function useUserDevices(userId: number) {
  return useQuery({ queryKey: devicesKey(userId), queryFn: () => kernel.adminListDeviceTokens({ params: { userId } }) });
}

export function useUserLinks(userId: number) {
  return useQuery({ queryKey: linksKey(userId), queryFn: () => kernel.adminListAccountLinks({ params: { userId } }) });
}

/** Today's AI limit and spend of one person (`adminAiChatterLimits`), read only. */
export function useAiLimit(userId: number) {
  const day = moscowToday();
  return useQuery({
    queryKey: ["access", "ai-limits", day] as const,
    queryFn: () => kernel.adminAiChatterLimits({ query: { day } }),
    select: (data: AiLimits) => ({ row: data.chatters.find((chatter) => chatter.userId === userId) ?? null }),
    staleTime: 60_000,
  });
}

/** Pages under their models, in the catalog's order. */
export function pagesByModel(pages: readonly AdminPage[]): { modelSlug: string; modelName: string; pages: AdminPage[] }[] {
  const groups = new Map<string, { modelSlug: string; modelName: string; pages: AdminPage[] }>();
  for (const page of pages) {
    const group = groups.get(page.modelSlug);
    if (group) group.pages.push(page);
    else groups.set(page.modelSlug, { modelSlug: page.modelSlug, modelName: page.modelName, pages: [page] });
  }
  return [...groups.values()];
}

// ── writes ───────────────────────────────────────────────────────────────────

function refreshPerson(qc: QueryClient, userId: number, also: { devices?: boolean; links?: boolean } = {}) {
  const work = [qc.invalidateQueries({ queryKey: USERS_KEY, exact: true })];
  if (also.devices) work.push(qc.invalidateQueries({ queryKey: devicesKey(userId) }));
  if (also.links) work.push(qc.invalidateQueries({ queryKey: linksKey(userId) }));
  return Promise.all(work);
}

/** One call creates the account, assigns every page and mints the link (adminUsers.ts:55-66). */
export function useCreateInvite() {
  const qc = useQueryClient();
  return useMutation({
    gcTime: 0,
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminCreateInviteBody) => kernel.adminCreateInvite({ body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: USERS_KEY, exact: true }),
  });
}

/** A new invite or password-reset link (adminUsers.ts:76-91); it supersedes the one before. */
export function useCreateLink() {
  const qc = useQueryClient();
  return useMutation({
    gcTime: 0,
    meta: { suppressGlobalError: true },
    mutationFn: ({ userId, kind }: { userId: number; kind: "invite" | "password_reset" }) =>
      kernel.adminCreateAccountLink({ params: { userId }, body: { kind } }),
    onSuccess: (_result, { userId }) => refreshPerson(qc, userId, { links: true }),
  });
}

export function useRevokeLink(userId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["access", userId, "revoke-link"],
    meta: { suppressGlobalError: true },
    mutationFn: (linkId: number) => kernel.adminRevokeAccountLink({ params: { userId, linkId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: linksKey(userId) }),
  });
}

/** «Завершить вход на устройстве»: exactly one device sign-in. */
export function useRevokeDevice(userId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["access", userId, "revoke-device"],
    meta: { suppressGlobalError: true },
    mutationFn: (tokenId: number) => kernel.adminRevokeDeviceToken({ params: { userId, tokenId } }),
    onSuccess: () => refreshPerson(qc, userId, { devices: true }),
  });
}

/** «Отозвать все устройства»: every device sign-in; the console and the password are untouched. */
export function useRevokeAllDevices(userId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["access", userId, "revoke-devices"],
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.adminRevokeDeviceTokens({ params: { userId } }),
    onSuccess: () => refreshPerson(qc, userId, { devices: true }),
  });
}

/** «Завершить все входы»: devices, sessions and active links; the password keeps working. */
export function useTerminateAccess(userId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["access", userId, "terminate-access"],
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.adminTerminateAllAccess({ params: { userId } }),
    onSuccess: () => refreshPerson(qc, userId, { devices: true, links: true }),
  });
}

export function useDeactivate(userId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["access", userId, "deactivate"],
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.adminDeactivateUser({ params: { userId } }),
    onSuccess: () => refreshPerson(qc, userId, { devices: true, links: true }),
  });
}

export function useReactivate(userId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["access", userId, "reactivate"],
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.adminReactivateUser({ params: { userId } }),
    onSuccess: () => refreshPerson(qc, userId),
  });
}

/**
 * Deletion ends this identity for good; a reused login gets a different id.
 * The console's cache care: a list read started before the deletion must not
 * bring the row back, and a lost answer is checked against a fresh list.
 */
export function useDeleteUser(userId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["access", userId, "delete"],
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.adminDeleteUser({ params: { userId } }),
    onSuccess: async () => {
      await qc.cancelQueries({ queryKey: USERS_KEY, exact: true });
      await qc.cancelQueries({ queryKey: ["access", "user", userId] });
      qc.setQueryData<AdminUser[]>(USERS_KEY, (users) => users?.filter((user) => user.id !== userId));
      qc.removeQueries({ queryKey: ["access", "user", userId] });
      await qc.invalidateQueries({ queryKey: USERS_KEY, exact: true });
    },
    onError: async () => {
      await qc.cancelQueries({ queryKey: USERS_KEY, exact: true });
      await qc.invalidateQueries({ queryKey: USERS_KEY, exact: true });
      const users = qc.getQueryData<AdminUser[]>(USERS_KEY);
      if (qc.getQueryState(USERS_KEY)?.status === "success" && users && !users.some((user) => user.id === userId)) {
        await qc.cancelQueries({ queryKey: ["access", "user", userId] });
        qc.removeQueries({ queryKey: ["access", "user", userId] });
      }
    },
  });
}

/** Open a page to a person (`adminAssignPage`): the console's request, any person of the matrix. */
export function useAssignPage() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: ({ userId, pageLabel }: { userId: number; pageLabel: string }) => kernel.adminAssignPage({ params: { userId }, body: { pageLabel } }),
    onSettled: () => qc.invalidateQueries({ queryKey: USERS_KEY, exact: true }),
  });
}

/** Remove a page from a person (`adminUnassignPage`). Always after a question (spec §6: it had none). */
export function useUnassignPage() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: ({ userId, pageLabel }: { userId: number; pageLabel: string }) => kernel.adminUnassignPage({ params: { userId, pageLabel } }),
    onSettled: () => qc.invalidateQueries({ queryKey: USERS_KEY, exact: true }),
  });
}
