import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { moscowDayEnd, moscowDayStart } from "@agency_hub_core/ui/moscow";
import type { ResolvedPeriod } from "@agency_hub_core/ui/period";
import { kernel } from "@/shared/hub";
import { chatterNumbersQuery, numbersWindow } from "@/shared/reads";
import type { ShiftsWindow } from "@/shared/shiftsWindow";

export * from "./model.js";

/**
 * «Смены → Отчёты» — the data layer. Two reads, both Hub's, both cut to the reader's teams on the server:
 *   - `teamShiftReports` { days, until?, pageLabel?, userId? } — the window's reports, each as Hub counts it for this
 *     reader, the days' and the period's tallies, the people to filter by (the feed waits for it);
 *   - `teamChatterNumbers` { from, to, userId? } — each shift's numbers, the very entry «Журнал» reads for the period
 *     (shared/reads.ts): the cards' numbers row fills in when it answers.
 * Query keys start with "shift-reports", but the shared numbers' own.
 */

const MINUTE = 60_000;

export type ReportsAnswer = KernelOperationResponse<"teamShiftReports">;
export type NumbersAnswer = KernelOperationResponse<"teamChatterNumbers">;

export interface ReportsParams {
  window: ShiftsWindow;
  page: string | null;
  /** A login of the person to show; null — everyone. */
  person: number | null;
  /** The period goes on: its reports move. */
  current: boolean;
}

/** The window's reports: while another window is read, the old cards stay whole. */
export function useTeamShiftReports({ window, page, person, current }: ReportsParams) {
  const query = {
    days: window.days,
    ...(window.until === undefined ? {} : { until: window.until }),
    ...(page === null ? {} : { pageLabel: page }),
    ...(person === null ? {} : { userId: person }),
  };
  return useQuery({
    queryKey: ["shift-reports", query] as const,
    queryFn: () => kernel.teamShiftReports({ query }),
    placeholderData: keepPreviousData,
    staleTime: MINUTE,
    refetchInterval: current ? MINUTE : false,
  });
}

/** The shifts' numbers of the period (the journal's entry when it is the same period and nobody is picked). */
export function useReportNumbers(period: ResolvedPeriod, window: ShiftsWindow, person: number | null, current: boolean) {
  const span = numbersWindow(period) ?? { from: moscowDayStart(window.from), to: moscowDayEnd(window.to) };
  return useQuery({
    ...chatterNumbersQuery({ ...span, ...(person === null ? {} : { userId: person }) }),
    placeholderData: keepPreviousData,
    staleTime: 5 * MINUTE,
    refetchInterval: current ? 5 * MINUTE : false,
  });
}
