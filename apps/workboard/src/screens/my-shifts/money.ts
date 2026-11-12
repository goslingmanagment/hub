import { useQuery } from "@tanstack/react-query";
import type { AccountPay, AccountPayResponse } from "@agency_hub_core/contracts";
import { hubErrorStatus } from "@agency_hub_core/ui/hubClient";
import { shiftReportDay, type MoscowDay } from "@agency_hub_core/ui/moscow";
import { kernel } from "@/shared/hub";
import type { MyShiftRow, MyShiftsWindow } from "./model.js";

/**
 * «Мои деньги» on «Мои смены» (ecosystem package H1) — the data and what it shows, apart from the screen's own reads
 * (data.ts) so the two never wait on each other. One read, `accountPay` { from, to }: the session user's own pay as the
 * agency ledger keeps it, behind the person's switch «видит свои деньги». Off, the answer says so and the screen stays
 * exactly as it was: nothing is drawn while it loads, when it is off, or when it fails for any reason but the ledger
 * being away. Sums only, never a rate. Query keys start with "my-shifts".
 */

export type MoneyDay = AccountPay["days"][number];

export interface MyMoneyRead {
  /** The switch is on and the sums came. */
  pay: AccountPay | null;
  /** The switch is on, the ledger did not answer (503): the block says so; no column. */
  away: boolean;
  /** The ledger has no payouts of the person yet (the switch on). */
  none: boolean;
  retry: () => void;
  retrying: boolean;
}

export function useMyMoney(window: Pick<MyShiftsWindow, "from" | "to">): MyMoneyRead {
  // The period's days; Hub also sends the day before (a night begun that evening is dated by it).
  const days = { from: window.from, to: window.to };
  const query = useQuery({
    queryKey: ["my-shifts", "money", days.from, days.to],
    queryFn: (): Promise<AccountPayResponse> => kernel.accountPay({ query: days }),
    staleTime: 60_000,
    retry: false,
  });
  const answer = query.data !== undefined && query.data.from === days.from && query.data.to === days.to ? query.data : null;
  return {
    pay: answer?.enabled ? answer.pay : null,
    away: query.isError && hubErrorStatus(query.error) === 503,
    none: answer !== null && answer.enabled && answer.pay === null,
    retry: () => void query.refetch(),
    retrying: query.isFetching,
  };
}

/**
 * Which row shows which day's accrual: the row holding that date's report first (Hub's handed-in report, else the
 * ledger's), else the first row of the day as the screen lists them; a day shows on one row only (two shifts of a
 * day are one report, one accrual). A shift going on shows none. Pure.
 */
export function accrualOfRows(rows: readonly MyShiftRow[], days: readonly MoneyDay[]): Map<string, MoneyDay> {
  const byDate = new Map(days.filter((day) => day.amountMills !== 0).map((day) => [day.date, day]));
  const out = new Map<string, MoneyDay>();
  const taken = new Set<string>();
  const reported = (row: MyShiftRow) => row.hub !== null || row.report !== null;
  const dateOf = (row: MyShiftRow): MoscowDay | null => {
    if (row.shift?.ongoing) return null;
    if (row.hub !== null) return row.hub.reportDate;
    if (row.report !== null) return row.report.reportDate;
    // The day the ledger accrues the shift on: the one report day of a shift (`shiftReportDay`).
    return row.shift === null ? null : shiftReportDay(row.shift.startedAt, row.shift.endedAt);
  };
  // The rows with a report of the date first, then the rest in the screen's order.
  const ordered = [...rows.filter(reported), ...rows.filter((row) => !reported(row))];
  for (const row of ordered) {
    const date = dateOf(row);
    if (date === null || taken.has(date)) continue;
    const day = byDate.get(date);
    if (!day) continue;
    out.set(row.key, day);
    taken.add(date);
  }
  return out;
}
