import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccountStartResponse } from "@agency_hub_core/contracts";
import { kernel } from "./hub.js";
import { useMe } from "./useMe.js";

/**
 * «Начало», a newcomer's way to the first shift (`accountStart`: the session's
 * own person, never anyone else's). The menu, the home address and the screen
 * read the same entry. A narrow session (from the extension) has no «Начало»:
 * Hub refuses it the read, so it is never asked.
 */

export const START_KEY = ["account", "start"] as const;
/** Its address in Workboard: /join lands the newcomer here, signed in. */
export const START_PATH = "/start";

export function useAccountStart() {
  const { role, narrow } = useMe();
  return useQuery({
    queryKey: START_KEY,
    queryFn: () => kernel.accountStart(),
    enabled: role === "chatter" && !narrow,
    staleTime: 30_000,
    // A step closes when Hub sees it: the screen reads again while it is open.
    refetchInterval: (query) => (startOpen(query.state.data) ? 60_000 : false),
  });
}

/** «Начало» is in the menu and is the home: a newcomer with a step still open. */
export function startOpen(data: AccountStartResponse | undefined): boolean {
  const start = data?.start;
  return start !== null && start !== undefined && start.newcomer && start.done < start.total;
}

/** Where the person's payouts go: their own, written from «Начало». */
export function useSetPayoutDetails() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (text: string) => kernel.accountPayoutDetailsSet({ body: { text } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: START_KEY, exact: true }),
  });
}
