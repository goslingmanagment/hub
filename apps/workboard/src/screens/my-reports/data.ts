import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { hubErrorStatus } from "@agency_hub_core/ui/hubClient";
import { reportDates } from "@agency_hub_core/ui/shiftReports";
import { kernel } from "@/shared/hub";

/**
 * Мои отчёты — the data layer. The screen reads only this file.
 *
 * One read: `accountReports` { from, to } — the signed-in chatter's own shift
 * reports as the agency ledger keeps them (the cabinet's «Отчёт смены» reads
 * the same). Hub takes the person from the session, never from the query, and
 * passes sales only: no rates, pay, payouts or debts. 503 — the ledger is not
 * connected or did not answer: not an error of the screen, a calm «later».
 */
export function useMyReports(days: number) {
  const query = useQuery({
    queryKey: ["my-reports", days],
    queryFn: () => kernel.accountReports({ query: reportDates(days) }),
    // 14 → 30 keeps the list on screen while the longer window is read.
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  return {
    ...query,
    /** The ledger is not there right now (503): «попробуй позже», not «Hub не ответил». */
    unavailable: query.isError && hubErrorStatus(query.error) === 503,
  };
}
