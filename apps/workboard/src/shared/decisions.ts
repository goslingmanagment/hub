import { queryOptions } from "@tanstack/react-query";
import { kernel } from "./hub.js";

/**
 * What a line of «Ждут вас» needs beyond its matter (screens/waiting): the
 * words of a question «whose is this sale» and the held send itself. Read
 * only while the list has such a matter, at most once a minute (the ledger's,
 * every five) and only while the tab is visible.
 */

const MINUTE = 60_000;

/**
 * The open questions «whose is this sale» the team's chat agent asked (`teamLedgerQuestions`, the owner's only, the
 * agency ledger's through Hub): those that wait for the owner are decisions, the chatters' own are information.
 */
export const saleQuestionsQuery = queryOptions({
  queryKey: ["decisions", "sale-questions"] as const,
  queryFn: () => kernel.teamLedgerQuestions(),
  staleTime: MINUTE,
});

/** Held sends of the chat extension (`clientSendCustodyList`, state `held`). */
export function heldSendsQuery(params: { limit: number; offset: number }) {
  return queryOptions({
    queryKey: ["decisions", "held", params] as const,
    queryFn: () => kernel.clientSendCustodyList({ query: { state: "held", ...params } }),
    staleTime: 30_000,
  });
}
