import { queryOptions, useQuery } from "@tanstack/react-query";
import { pendingChangesOf, reportQuestionsWindow, unparsedPostsToDecide } from "@agency_hub_core/ui/shiftReports";

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

/**
 * What waits for the owner about the shift reports (Workboard Решения → «Отчёты»): the posts the ledger could not
 * use of the days it accrues from the posts (none while the payout sheets pay: `unparsedPostsToDecide`) and the paid
 * days whose report changed, of the last month — the same reads, window and rule as Workboard's count.
 * The owner's only; the ledger not answering is «не удалось проверить», never a zero.
 */
export function reportQuestionsQueryOptions(today: string) {
  const window = reportQuestionsWindow(today);
  return queryOptions({
    queryKey: ["report-questions", window] as const,
    queryFn: async () => {
      const [reports, payouts] = await Promise.all([
        kernel.teamLedgerReports({ query: window }),
        kernel.teamLedgerPayouts({ query: window }),
      ]);
      return unparsedPostsToDecide(reports, payouts).length + pendingChangesOf(payouts).length;
    },
    meta: { suppressGlobalError: true },
  });
}
