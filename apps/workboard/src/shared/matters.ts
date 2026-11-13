import { queryOptions } from "@tanstack/react-query";
import { kernel } from "./hub.js";

/**
 * Дела (ecosystem plan §6, packages D and K): «Ждут вас» as one list of what
 * waits for a person. The team's screens read matters and nothing else: the
 * address `/decisions` is the list, the menu's badge counts its groups.
 */

/**
 * «Ждут вас» counted from matters by the list's groups: the team's read (a chatter is refused it). The
 * key is the menu's (packages/ui/src/place.ts `waitingQuery`): one answer for the badge and the list.
 */
export function mattersWaitingQuery() {
  return queryOptions({
    queryKey: ["matters", "waiting", ""] as const,
    queryFn: () => kernel.mattersWaiting({ query: {} }),
    staleTime: 30_000,
  });
}

/** The person's open matters (shared/myMatters.ts, the chatter's screens import it from there). */
export { mattersListQuery } from "./myMatters.js";
