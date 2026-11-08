import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TeamShiftResolveBody, TeamWinBackApproachSaveBody } from "@agency_hub_core/contracts";

import { shiftSettling } from "@/lib/shiftLive";
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

const TEAM_SHIFT_SALES_KEY = ["team-shift-sales"] as const;

/** The team's shifts of the window with their money, and the window before (`teamShiftSales`). */
export function useTeamShiftSales(params: { days: number; until?: string; pageLabel?: string }) {
  return useQuery(queryOptions({
    queryKey: [...TEAM_SHIFT_SALES_KEY, params] as const,
    queryFn: () => kernel.teamShiftSales({ query: params }),
    meta: { suppressGlobalError: true },
    // A shift going on earns and moves.
    refetchInterval: 2 * 60_000,
    placeholderData: (previous) => previous,
  }));
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
    meta: { suppressGlobalError: true },
    mutationFn: (body: TeamWinBackApproachSaveBody) => kernel.teamWinBackApproachSave({ body }),
    onSuccess: (data) => {
      qc.setQueryData(WIN_BACK_APPROACHES_KEY, data);
      void qc.invalidateQueries({ queryKey: WIN_BACK_RESULTS_KEY });
    },
  });
}

/** Open customs of the pages the viewer reaches (`teamCustoms`). */
export const teamCustomsQueryOptions = queryOptions({
  queryKey: ["team-customs"] as const,
  queryFn: () => kernel.teamCustoms(),
  meta: { suppressGlobalError: true },
  refetchInterval: 5 * 60_000,
});

export function useTeamCustoms() {
  return useQuery(teamCustomsQueryOptions);
}

/** The longest window `teamShiftDisputes` takes. The screens say «за 31 день». */
export const TEAM_SHIFT_DISPUTE_DAYS = 31;

/**
 * Chat Memory week 4: disputed sales of the shift reports (`teamShiftDisputes`).
 * One key and one window on «Выплаты» and in the menu's count: a resolve there
 * moves the count at once, and neither can show a dispute the other does not.
 */
export function teamShiftDisputesQueryOptions(days: number = TEAM_SHIFT_DISPUTE_DAYS) {
  return queryOptions({
    queryKey: ["team-shift-disputes", days] as const,
    queryFn: () => kernel.teamShiftDisputes({ query: { days } }),
    meta: { suppressGlobalError: true },
  });
}

export function useTeamShiftDisputes(days: number = TEAM_SHIFT_DISPUTE_DAYS) {
  return useQuery(teamShiftDisputesQueryOptions(days));
}

/** The owner's split of a disputed sale (`teamShiftResolve`). */
export function useResolveShiftDispute() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (input: { saleRef: string; body: TeamShiftResolveBody }) =>
      kernel.teamShiftResolve({ params: { saleRef: input.saleRef }, body: input.body }),
    onSettled: () => Promise.all([
      qc.invalidateQueries({ queryKey: ["team-shift-disputes"] }),
      qc.invalidateQueries({ queryKey: ["team-shift-export"] }),
    ]),
  });
}

/**
 * The payout export of confirmed shift reports (`teamShiftExport`); Moscow days,
 * both included. No placeholder, on purpose: the columns of a new window must
 * never carry the sums of the old one.
 */
export function useTeamShiftExport(params: { from: string; to: string }, options: { enabled?: boolean } = {}) {
  return useQuery(queryOptions({
    queryKey: ["team-shift-export", params] as const,
    queryFn: () => kernel.teamShiftExport({ query: params }),
    meta: { suppressGlobalError: true },
    enabled: options.enabled ?? true,
  }));
}

/** Chat Memory week 6, «Покрытие»: empty hours of each page (`teamEmptyHours`). */
export function useTeamEmptyHours(days: number) {
  return useQuery(queryOptions({
    queryKey: ["team-empty-hours", days] as const,
    queryFn: () => kernel.teamEmptyHours({ query: { days } }),
    meta: { suppressGlobalError: true },
    placeholderData: (previous) => previous,
  }));
}

/** Chat Memory week 6, «Покрытие»: greetings of new subscribers and broadcasts (`teamGreetings`). */
export function useTeamGreetings(days: number) {
  return useQuery(queryOptions({
    queryKey: ["team-greetings", days] as const,
    queryFn: () => kernel.teamGreetings({ query: { days } }),
    meta: { suppressGlobalError: true },
    placeholderData: (previous) => previous,
  }));
}

/**
 * One chatter's numbers shift by shift (`teamChatterNumbers` with `userId`):
 * read only when «Подробно по сменам» is opened. `from` is the Moscow midnight
 * the window starts at and `to` is left out, so the key lives the whole day.
 */
export function useTeamChatterNumbers(params: { from: string; userId: number }, options: { enabled: boolean }) {
  return useQuery(queryOptions({
    queryKey: ["team-chatter-numbers", params] as const,
    queryFn: () => kernel.teamChatterNumbers({ query: params }),
    meta: { suppressGlobalError: true },
    enabled: options.enabled,
    staleTime: 5 * 60_000,
  }));
}

/**
 * Who worked in the extension on the viewer's pages in the last month: the
 * `people` of `teamChatterStats` for one day, the cheapest read that has them.
 */
export function useTeamChatterPeople() {
  return useQuery(queryOptions({
    queryKey: ["team-chatter-people"] as const,
    queryFn: () => kernel.teamChatterStats({ query: { days: 1 } }),
    select: (data) => ({ people: data.people, anyone: data.stats !== null }),
    meta: { suppressGlobalError: true },
    staleTime: 5 * 60_000,
  }));
}

export interface TeamChatterStatsParams {
  userId?: number | undefined;
  days: number;
}

/**
 * A chatter's statistics as their cabinet shows them (`teamChatterStats`). The
 * server answers a `userId` it does not know with the FIRST person: whoever reads
 * this checks `stats.user.userId` against what it asked for, and no placeholder
 * here, so a row of `useQueries` cannot show a neighbour's money for a moment.
 */
export function teamChatterStatsQueryOptions(params: TeamChatterStatsParams) {
  return queryOptions({
    queryKey: ["team-chatter-stats", params] as const,
    queryFn: () => kernel.teamChatterStats({ query: params.userId === undefined ? { days: params.days } : { days: params.days, userId: params.userId } }),
    meta: { suppressGlobalError: true },
    staleTime: 60_000,
  });
}

/**
 * The previous numbers stay on screen while a new period loads, but only the
 * same person's: under a new name, never a moment of someone else's money.
 */
export function useTeamChatterStats(params: TeamChatterStatsParams) {
  return useQuery({
    ...teamChatterStatsQueryOptions(params),
    placeholderData: (previous, previousQuery) => {
      const before = previousQuery?.queryKey[1] as TeamChatterStatsParams | undefined;
      return before?.userId === params.userId ? previous : undefined;
    },
  });
}

/**
 * Команда → «Разбор смены»: one shift opened up (`teamShiftReview`, the owner
 * only). One going on, or ended under an hour ago (its last messages and sales
 * still coming in), is read again every two minutes; an older one does not
 * change.
 */
export function teamShiftReviewQueryOptions(params: { userId: number; at: string }) {
  return queryOptions({
    queryKey: ["team-shift-review", params] as const,
    queryFn: () => kernel.teamShiftReview({ query: params }),
    meta: { suppressGlobalError: true },
    staleTime: 60_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data !== undefined && shiftSettling(data.shift, data.serverNow) ? 120_000 : false;
    },
  });
}

export function useTeamShiftReview(params: { userId: number; at: string }) {
  return useQuery(teamShiftReviewQueryOptions(params));
}
