import { queryOptions, useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

// The people list, as the console still reads it. Inviting, links, revoking,
// disabling, deleting, device sign-ins and pages per person are in
// Hub «Люди» now (apps/dashboard/src/pages/people/data.ts).

/** `adminListUsers` (the owner's): every login, one cache entry for every screen that reads it (Люди too). */
export const usersQuery = queryOptions({
  queryKey: ["team", "users"] as const,
  queryFn: () => kernel.adminListUsers(),
});

/** A write that changes a login invalidates this key: every reader of the logins sees it. */
export const USERS_KEY = usersQuery.queryKey;

/** The people list; the owner's only. `enabled: false` for a viewer the hub would refuse. */
export function useAdminUsers(options: { enabled?: boolean } = {}) {
  return useQuery({
    ...usersQuery,
    enabled: options.enabled ?? true,
  });
}
