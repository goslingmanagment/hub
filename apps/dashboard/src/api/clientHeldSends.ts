import { mutationOptions, queryOptions, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { ClientSendCustodyListState, ClientSendCustodyResolveBody } from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

/**
 * Held sends of the chat extension and their manual resolve (chat-extension
 * H-7e). Both routes are the owner's and a team lead's cookie session; the
 * hub scopes the list to the pages the viewer reaches.
 */
const HELD_SENDS_KEY = ["client-send-custody"] as const;

export interface ClientHeldSendsParams {
  state: ClientSendCustodyListState;
  /** One page; absent = every page the viewer reaches. */
  pageLabel?: string;
  limit: number;
  offset: number;
}

/** Exported as options too: a test drives them with a QueryObserver, without a DOM. */
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

export function useClientHeldSends(params: ClientHeldSendsParams) {
  return useQuery(clientHeldSendsQueryOptions(params));
}

export interface ResolveClientSendInput {
  pageLabel: string;
  attemptId: string;
  body: ClientSendCustodyResolveBody;
}

/**
 * Exported as options too, like the other mutations of api/: a test can drive
 * it with a MutationObserver and pin the route and the refresh without a DOM.
 */
export function resolveClientSendMutationOptions(qc: QueryClient) {
  return mutationOptions({
    // Its 409s (already reported, resolved otherwise, still in flight) are
    // answered inside the dialog, in words; a global toast would only repeat
    // the server's English.
    meta: { suppressGlobalError: true },
    mutationFn: (input: ResolveClientSendInput) => kernel.clientSendCustodyResolve({
      params: { pageLabel: input.pageLabel, attemptId: input.attemptId },
      body: input.body,
    }),
    // Settled, not only succeeded: after a refusal the row may be gone (the
    // client reported, someone else resolved), and after a lost answer the
    // resolve may have been recorded. Both lists are read again either way.
    onSettled: () => qc.invalidateQueries({ queryKey: HELD_SENDS_KEY }),
  });
}

export function useResolveClientSend() {
  return useMutation(resolveClientSendMutationOptions(useQueryClient()));
}
