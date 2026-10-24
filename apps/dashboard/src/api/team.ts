import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TeamShiftResolveBody, TeamWinBackApproachSaveBody } from "@agency_hub_core/contracts";

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

const WIN_BACK_RESULTS_KEY = ["team-win-back-results"] as const;
const WIN_BACK_APPROACHES_KEY = ["team-win-back-approaches"] as const;

/** Win-back results by approach and chatter (`teamWinBackResults`). */
export function useTeamWinBackResults(days: number) {
  return useQuery(queryOptions({
    queryKey: [...WIN_BACK_RESULTS_KEY, days] as const,
    queryFn: () => kernel.teamWinBackResults({ query: { days } }),
    meta: { suppressGlobalError: true },
    placeholderData: (previous) => previous,
  }));
}

/** The owner's approaches, retired ones included (`teamWinBackApproaches`); the owner only. */
export function useTeamWinBackApproaches(enabled: boolean) {
  return useQuery(queryOptions({
    queryKey: WIN_BACK_APPROACHES_KEY,
    queryFn: () => kernel.teamWinBackApproaches(),
    enabled,
    meta: { suppressGlobalError: true },
  }));
}

export function useSaveWinBackApproach() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TeamWinBackApproachSaveBody) => kernel.teamWinBackApproachSave({ body }),
    onSuccess: (data) => {
      qc.setQueryData(WIN_BACK_APPROACHES_KEY, data);
      void qc.invalidateQueries({ queryKey: WIN_BACK_RESULTS_KEY });
    },
  });
}

/** Open customs of the pages the viewer reaches (`teamCustoms`). */
export function useTeamCustoms() {
  return useQuery(queryOptions({
    queryKey: ["team-customs"] as const,
    queryFn: () => kernel.teamCustoms(),
    meta: { suppressGlobalError: true },
    refetchInterval: 5 * 60_000,
  }));
}

/** Chat Memory week 4: disputed sales of the shift reports (`teamShiftDisputes`). */
export function useTeamShiftDisputes() {
  return useQuery(queryOptions({
    queryKey: ["team-shift-disputes"] as const,
    queryFn: () => kernel.teamShiftDisputes({ query: { days: 14 } }),
    meta: { suppressGlobalError: true },
  }));
}

/** The owner's split of a disputed sale (`teamShiftResolve`). */
export function useResolveShiftDispute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { saleRef: string; body: TeamShiftResolveBody }) =>
      kernel.teamShiftResolve({ params: { saleRef: input.saleRef }, body: input.body }),
    onSettled: () => Promise.all([
      qc.invalidateQueries({ queryKey: ["team-shift-disputes"] }),
      qc.invalidateQueries({ queryKey: ["team-shift-export"] }),
    ]),
  });
}

/** The payout export of confirmed shift reports (`teamShiftExport`); Moscow days, both included. */
export function useTeamShiftExport(params: { from: string; to: string }) {
  return useQuery(queryOptions({
    queryKey: ["team-shift-export", params] as const,
    queryFn: () => kernel.teamShiftExport({ query: params }),
    meta: { suppressGlobalError: true },
  }));
}

/** The eight numbers of each chatter's shifts and week (`teamChatterNumbers`). */
export function useTeamChatterNumbers(params: { from?: string; to?: string } = {}) {
  return useQuery(queryOptions({
    queryKey: ["team-chatter-numbers", params] as const,
    queryFn: () => kernel.teamChatterNumbers({ query: params }),
    meta: { suppressGlobalError: true },
  }));
}
