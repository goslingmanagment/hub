import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccountStartResponse } from "@agency_hub_core/contracts";
import { kernel } from "./hub.js";
import { useMe } from "./useMe.js";

/**
 * «Начало», a newcomer's way to the first shift (`accountStart`: the session's
 * own person, never anyone else's). The menu, the home address, the screen and
 * the account's payout card read the same entry, a narrow session (from the
 * extension) too; it only does not write where payouts go
 * (`accountPayoutDetailsSet` needs the password).
 */

export const START_KEY = ["account", "start"] as const;
/** Its address in Workboard: /join lands the newcomer here, signed in. */
export const START_PATH = "/start";

/** `always`: read it for any session (the account's payout card, «Начало» itself); else a chatter's only (the menu). */
export function useAccountStart(always = false) {
  const { role } = useMe();
  return useQuery({
    queryKey: START_KEY,
    queryFn: () => kernel.accountStart(),
    enabled: always || role === "chatter",
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
