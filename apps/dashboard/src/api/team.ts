import { queryOptions, useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

// What the console still reads of the team (Главная and a page's card): who is
// on shift, and the queues counted in «Ждут вас». The team's screens are
// Workboard's (lib/workboard.ts).

/**
 * Chat Memory: the team's actual shifts from the chat extension's activity
 * (`teamShifts`). The owner's and a team lead's cookie session; the hub scopes
 * it to the pages the viewer reaches.
 */
const TEAM_SHIFTS_KEY = ["team-shifts"] as const;

export interface TeamShiftsParams {
  from: string;
  to: string;
  /** One page; absent = every page the viewer reaches. */
  pageLabel?: string;
}

export function teamShiftsQueryOptions(params: TeamShiftsParams) {
  return queryOptions({
    queryKey: [...TEAM_SHIFTS_KEY, params] as const,
    queryFn: () => kernel.teamShifts({ query: params }),
    meta: { suppressGlobalError: true },
    // A shift going on moves every minute.
    refetchInterval: 60_000,
    placeholderData: (previous) => previous,
  });
}

export function useTeamShifts(params: TeamShiftsParams) {
  return useQuery(teamShiftsQueryOptions(params));
}

/** Open customs of the pages the viewer reaches (`teamCustoms`). */
export const teamCustomsQueryOptions = queryOptions({
  queryKey: ["team-customs"] as const,
  queryFn: () => kernel.teamCustoms(),
  meta: { suppressGlobalError: true },
  refetchInterval: 5 * 60_000,
});

/** The longest window `teamShiftDisputes` takes. */
const TEAM_SHIFT_DISPUTE_DAYS = 31;

/** Chat Memory week 4: disputed sales of the shift reports (`teamShiftDisputes`), for the count of «Ждут вас». */
export function teamShiftDisputesQueryOptions(days: number = TEAM_SHIFT_DISPUTE_DAYS) {
  return queryOptions({
    queryKey: ["team-shift-disputes", days] as const,
    queryFn: () => kernel.teamShiftDisputes({ query: { days } }),
    meta: { suppressGlobalError: true },
  });
}
