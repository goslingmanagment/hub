import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { kernel } from "@/shared/hub";
import type { MyShiftsWindow, StatsShift } from "./model.js";

export * from "./model.js";

/**
 * Мои смены — the data layer (a chatter's own part of Workboard, owner 2026-11-10). The screen reads only this file;
 * what it shows is model.ts.
 *
 * Every read is the session's user's own (`any-session`; Hub takes the user from the session, never from the query)
 * and carries sales only — no rates, pay, payouts or debts, nothing of anyone else:
 *   - `accountShifts` { days, until? } — the window's shifts, each with its report, paired by Hub
 *     (services/own-shift-rows.ts): Hub's shift and its sales by the rule, the ledger's report, the report handed in in
 *     Hub; and the window before's reports' sum to compare with;
 *   - `shiftReportNotes` { days, until? } — what stands between the person's own shifts of a day and their reports
 *     (shared/reportNotes.ts), read apart: the journal never waits for it.
 * Query keys start with "my-shifts".
 */

/**
 * The period's shifts and their reports, one read: while another period is read, the old rows stay on screen whole.
 * Hub not answering fails the read (the screen's error state); the ledger not answering is `reportsRead: false`.
 */
export function useMyShifts(window: MyShiftsWindow, current: boolean) {
  return useQuery({
    queryKey: ["my-shifts", "period", window.days, window.until ?? null],
    queryFn: () => kernel.accountShifts({ query: { days: window.days, ...(window.until ? { until: window.until } : {}) } }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    // While a shift goes on, its worked time and sales move: a fresh read every minute (only while the tab is seen).
    refetchInterval: (state) => (current && state.state.data?.stats.shifts.some((shift) => shift.ongoing) ? 60_000 : false),
  });
}

/**
 * What stands between the period's own shifts and their reports (`shiftReportNotes`: the caller's own days, whatever
 * the query), the same days as the shifts' read. For the note under a day's last shift alone: the ledger away (or any
 * other failure) is no line, nothing else. null — not known.
 */
export function useMyShiftNotes(window: MyShiftsWindow) {
  const params = { days: window.days, ...(window.until ? { until: window.until } : {}) };
  const query = useQuery({
    queryKey: ["my-shifts", "report-notes", params.days, params.until ?? null],
    queryFn: () => kernel.shiftReportNotes({ query: params }),
    staleTime: 60_000,
    retry: false,
  });
  return query.data?.notes ?? null;
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

/**
 * The person's own shift numbers and the team's average beside them (`accountShiftNumbers`, package N): the reply
 * median, the fans left without an answer, «ИИ без правки», per shift and for the period. Read apart from the shifts:
 * the numbers take longer, and the journal never waits for them.
 */
export function useMyNumbers(window: MyShiftsWindow, current: boolean) {
  const from = new Date(window.startsAt).toISOString();
  const to = new Date(window.endsAt).toISOString();
  return useQuery({
    queryKey: ["my-shifts", "numbers", from, to],
    queryFn: () => kernel.accountShiftNumbers({ query: { from, to } }),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    refetchInterval: current ? 5 * 60_000 : false,
  });
}
