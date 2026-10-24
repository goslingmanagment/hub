import { queryOptions, useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

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

const TEAM_AUTHORSHIP_KEY = ["team-authorship"] as const;

/** How many of each page's outgoing messages have an author, per day (`teamAuthorship`). */
export function teamAuthorshipQueryOptions(days: number) {
  return queryOptions({
    queryKey: [...TEAM_AUTHORSHIP_KEY, days] as const,
    queryFn: () => kernel.teamAuthorship({ query: { days } }),
    meta: { suppressGlobalError: true },
    refetchInterval: 5 * 60_000,
    placeholderData: (previous) => previous,
  });
}

export function useTeamAuthorship(days: number) {
  return useQuery(teamAuthorshipQueryOptions(days));
}
