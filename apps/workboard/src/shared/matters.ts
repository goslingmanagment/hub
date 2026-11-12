import { queryOptions, useQuery } from "@tanstack/react-query";
import { kernel } from "./hub.js";
import { useMe } from "./useMe.js";

/**
 * Дела (ecosystem plan §6, packages D and K): «Ждут вас» as one list of what
 * waits for a person. The owner's switch (`mattersReadEnabled`, said by
 * `mattersWaiting` as `active`) decides whether Workboard reads matters: off,
 * every screen keeps its own reads exactly as before; on, «Решения» becomes
 * the list «Ждут вас» at the same address, its badge and the «Ждут решения»
 * line of Смены count matters.
 */

const MINUTE = 60_000;

/** «Ждут вас» and «Решения» counted from matters, and the switch: the team's read (a chatter is refused it). */
export function mattersWaitingQuery(pageLabel: string | null = null) {
  return queryOptions({
    queryKey: ["matters", "waiting", pageLabel ?? ""] as const,
    queryFn: () => kernel.mattersWaiting({ query: pageLabel === null ? {} : { pageLabel } }),
    staleTime: 30_000,
  });
}

/** The person's open matters (shared/myMatters.ts, the chatter's screens import it from there). */
export { mattersListQuery } from "./myMatters.js";

export interface MattersSwitch {
  /** null while the switch is not known yet; an unanswered read is «off»: the screens keep their own reads. */
  active: boolean | null;
}

/**
 * Whether the team's screens read matters. A chatter has no switch to read:
 * their strip above «Мои смены» shows their own matters either way.
 */
export function useMattersActive(): MattersSwitch {
  const { user, role } = useMe();
  const team = role === "owner" || role === "team_lead";
  const query = useQuery({ ...mattersWaitingQuery(), enabled: user !== undefined && team, refetchInterval: MINUTE });
  if (!team) return { active: false };
  if (query.data) return { active: query.data.active };
  return { active: query.isError ? false : null };
}

/** The badge of «Ждут вас» while the switch is on: what waits (never what only informs), and whether something was not checked. */
export function useWaitingTotal(): { total: number; failed: boolean; settled: boolean } {
  const { user, role } = useMe();
  const team = role === "owner" || role === "team_lead";
  const query = useQuery({ ...mattersWaitingQuery(), enabled: user !== undefined && team, refetchInterval: MINUTE });
  if (!query.data) return { total: 0, failed: query.isError, settled: query.isError };
  return { total: query.data.total, failed: query.data.failed.length > 0, settled: true };
}
