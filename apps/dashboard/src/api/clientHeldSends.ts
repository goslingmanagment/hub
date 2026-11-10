import { queryOptions } from "@tanstack/react-query";
import type { ClientSendCustodyListState } from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

/**
 * Held sends of the chat extension (chat-extension H-7e), counted in «Ждут
 * вас»; they are resolved in Workboard's «Решения». The owner's and a team
 * lead's cookie session; the hub scopes the list to the pages the viewer reaches.
 */
const HELD_SENDS_KEY = ["client-send-custody"] as const;

export interface ClientHeldSendsParams {
  state: ClientSendCustodyListState;
  /** One page; absent = every page the viewer reaches. */
  pageLabel?: string;
  limit: number;
  offset: number;
}

export function clientHeldSendsQueryOptions(params: ClientHeldSendsParams) {
  return queryOptions({
    queryKey: [...HELD_SENDS_KEY, params] as const,
    queryFn: () => kernel.clientSendCustodyList({ query: params }),
    // The page says in its own words that the list did not load or did not
    // refresh. Without this every failed poll, twice a minute, would also
    // toast the hub's English error.
    meta: { suppressGlobalError: true },
    // A held send appears when a ticket runs out, with nobody on this page
    // doing anything: half a minute is as stale as the queue gets. The
    // resolved list changes only by a resolve, which refreshes it below.
    refetchInterval: params.state === "held" ? 30_000 : false,
    // Paging and switching the page filter keep the previous rows on screen
    // instead of collapsing the table to a spinner. Never across the two
    // lists: a resolved send shown for a moment under "held" would offer a
    // resolve of a send that needs none.
    placeholderData: (previous, previousQuery) => {
      const before = previousQuery?.queryKey[HELD_SENDS_KEY.length] as ClientHeldSendsParams | undefined;
      return before?.state === params.state ? previous : undefined;
    },
  });
}
