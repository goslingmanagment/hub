import { useQuery } from "@tanstack/react-query";
import { kernel } from "@/shared/hub";

/**
 * «Сегодня» (products package W) — its reads, each the session person's own (Hub takes the person from the session):
 *   - `accountShifts` { days: 7 } — the last seven days' shifts with their reports, paired by Hub: «Моя смена» is the one
 *     going on or the last, «Неделя» their sums (the sales by the rule; the reports' sums stay the reports');
 *   - `accountShiftNumbers` — the same days' quality numbers beside the team's average (package N);
 *   - `workboardToday` — the previous shift's comment, the customs to give; the teams the person leads.
 * Query keys start with "today".
 */

const MINUTE = 60_000;

export const WEEK_DAYS = 7;

export function useTodayShifts() {
  return useQuery({
    queryKey: ["today", "shifts"],
    queryFn: () => kernel.accountShifts({ query: { days: WEEK_DAYS } }),
    staleTime: MINUTE,
    refetchInterval: MINUTE,
  });
}

export function useTodayNumbers() {
  return useQuery({
    queryKey: ["today", "numbers"],
    queryFn: () => kernel.accountShiftNumbers({ query: {} }),
    staleTime: 5 * MINUTE,
    refetchInterval: 5 * MINUTE,
  });
}

export function useToday() {
  return useQuery({
    queryKey: ["today", "day"],
    queryFn: () => kernel.workboardToday(),
    staleTime: MINUTE,
    refetchInterval: MINUTE,
  });
}
