import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { AccountReportsResponse, ChatterStats } from "@agency_hub_core/contracts";
import { kernel } from "@/shared/hub";
import type { MyShiftsWindow, StatsShift } from "./model.js";

export * from "./model.js";

/**
 * Мои смены — the data layer (a chatter's own part of Workboard, owner
 * 2026-11-10). The screen reads only this file; what it shows is model.ts.
 *
 * Both reads are the session's user's own (`any-session`; Hub takes the user
 * from the session, never from the query) and carry sales only — no rates, pay,
 * payouts or debts, nothing of anyone else:
 *   - `accountChatterStats` { days, until? } — the shifts of the period's window;
 *   - `accountReports` { from, to } — the ledger's reports of those days.
 * Query keys start with "my-shifts".
 */

export interface MyShiftsData {
  stats: ChatterStats;
  /** null — the reports did not come (the ledger is away: 503, or another failure). The shifts still show. */
  reports: AccountReportsResponse | null;
}

/**
 * The period's shifts and their reports, read together so a shift and its
 * report always come from the same window: while another period is read, the
 * old pair stays on screen whole (never this week's shifts beside last week's
 * reports). Hub not answering fails the read (the screen's error state); the
 * ledger not answering leaves `reports` null.
 */
export function useMyShifts(window: MyShiftsWindow, current: boolean) {
  const query = useQuery({
    queryKey: ["my-shifts", "period", window.days, window.until ?? null, window.reportsFrom, window.reportsTo],
    queryFn: async (): Promise<MyShiftsData> => {
      const [stats, reports] = await Promise.allSettled([
        kernel.accountChatterStats({ query: { days: window.days, ...(window.until ? { until: window.until } : {}) } }),
        kernel.accountReports({ query: { from: window.reportsFrom, to: window.reportsTo } }),
      ]);
      if (stats.status === "rejected") throw stats.reason;
      return { stats: stats.value, reports: reports.status === "fulfilled" ? reports.value : null };
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    // While a shift goes on, its worked time and sales move: a fresh read every minute (only while the tab is seen).
    refetchInterval: (state) => (current && state.state.data?.stats.shifts.some((shift) => shift.ongoing) ? 60_000 : false),
  });
  return query;
}

/** The reports of the window before, for the change; any failure is no change, never a zero. */
export function usePreviousReports(window: MyShiftsWindow) {
  return useQuery({
    queryKey: ["my-shifts", "previous", window.previous.reportsFrom, window.previous.reportsTo],
    queryFn: () => kernel.accountReports({ query: { from: window.previous.reportsFrom, to: window.previous.reportsTo } }),
    staleTime: 10 * 60_000,
  });
}

/**
 * «Сейчас на смене» when the period's read does not hold it (a past period, or
 * a night begun before the period's first day): the last two days, so a night
 * still before its middle is in. Polled every minute while the tab is seen.
 */
export function useShiftNow(enabled: boolean) {
  return useQuery({
    queryKey: ["my-shifts", "now"],
    queryFn: async (): Promise<StatsShift | null> => {
      const stats = await kernel.accountChatterStats({ query: { days: 2 } });
      return stats.shifts.find((shift) => shift.ongoing) ?? null;
    },
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
