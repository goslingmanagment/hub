import { useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

// The people list, as the console still reads it. Inviting, links, revoking,
// disabling, deleting, device sign-ins and pages per person are Workboard's
// «Доступ» now (apps/workboard/src/screens/access).

const USERS_KEY = ["admin", "users"] as const;

/** The people list; the owner's only. `enabled: false` for a viewer the hub would refuse. */
export function useAdminUsers(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: USERS_KEY,
    queryFn: () => kernel.adminListUsers(),
    enabled: options.enabled ?? true,
  });
}
