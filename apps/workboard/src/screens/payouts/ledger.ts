import { useQuery } from "@tanstack/react-query";
import { TEAM_LEDGER_PAYOUTS_MAX_DAYS, type TeamLedgerPayoutPerson, type TeamLedgerPayoutsResponse } from "@agency_hub_core/contracts";
import { millsFromInteger, sumMills, type Mills } from "@agency_hub_core/shared";
import { hubErrorStatus } from "@agency_hub_core/ui/hubClient";
import { daysInRange, moscowToday } from "@agency_hub_core/ui/moscow";
import type { ResolvedPeriod } from "@agency_hub_core/ui/period";
import { kernel } from "@/shared/hub";
import { useMe } from "@/shared/useMe";

/**
 * Выплаты from the agency ledger (ledger release 2, H3): what each person
 * accrued and was paid in the period, and what the agency owes them now. The
 * ledger counts the money (from the payout sheets today, from Hub's facts
 * later); Hub passes it on (`teamLedgerPayouts`, the owner's only). A team lead
 * never asks; a ledger not connected (503) leaves the shift reports alone on
 * the screen.
 */

/** One day of a person's strip: nothing, accrued and paid, accrued and still owed, or not come yet. */
export type StripDay = { day: string; state: "none" | "paid" | "owed" | "future" };

export interface LedgerRow {
  person: TeamLedgerPayoutPerson;
  owedMills: Mills;
  accruedMills: Mills;
  paidMills: Mills;
  /** «К выплате» of the sheet minus the ledger's debt; null — they agree or the sheet's is not known. */
  sheetDiffMills: Mills | null;
  /** Days the oldest unpaid day has waited, today included; null — nothing owed. */
  waitingDays: number | null;
  strip: StripDay[];
}

export interface LedgerView {
  from: string;
  to: string;
  accrualFrom: string;
  rows: LedgerRow[];
  owedMills: Mills;
  owedPeople: number;
  accruedMills: Mills;
  paidMills: Mills;
  /** Whose unpaid day is the oldest. */
  oldest: { row: LedgerRow; date: string } | null;
  checks: TeamLedgerPayoutsResponse["checks"];
}

function daysOfWindow(from: string, to: string): string[] {
  const days: string[] = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); ; at += 86_400_000) {
    const day = new Date(at).toISOString().slice(0, 10);
    if (day > to) break;
    days.push(day);
  }
  return days;
}

export function buildLedger(data: TeamLedgerPayoutsResponse, today: string = moscowToday()): LedgerView {
  const window = daysOfWindow(data.from, data.to);
  const rows = data.people.map((person): LedgerRow => {
    const accrued = new Set(person.days.filter((day) => day.amountMills !== 0).map((day) => day.date));
    const owed = new Set(person.unpaidDays.filter((day) => day.kind === "day").map((day) => day.date));
    const owedMills = millsFromInteger(person.balanceMills);
    const sheetDiff = person.toPayMills === null ? 0n : millsFromInteger(person.toPayMills) - owedMills;
    return {
      person,
      owedMills,
      accruedMills: millsFromInteger(person.accruedMills),
      paidMills: millsFromInteger(person.paidMills),
      sheetDiffMills: sheetDiff === 0n ? null : sheetDiff,
      waitingDays: person.oldestUnpaidDate === null || owedMills <= 0n ? null : daysInRange(person.oldestUnpaidDate, today),
      strip: window.map((day) => ({
        day,
        state: day > today ? "future" : !accrued.has(day) ? "none" : owed.has(day) ? "owed" : "paid",
      })),
    };
  })
    // A person with nothing in the period and nothing owed is not on the screen.
    .filter((row) => row.owedMills !== 0n || row.accruedMills !== 0n || row.paidMills !== 0n)
    .sort((left, right) => (left.owedMills === right.owedMills ? left.person.name.localeCompare(right.person.name) : left.owedMills > right.owedMills ? -1 : 1));

  const owing = rows.filter((row) => row.owedMills > 0n);
  const oldest = owing
    .filter((row) => row.person.oldestUnpaidDate !== null)
    .sort((left, right) => left.person.oldestUnpaidDate!.localeCompare(right.person.oldestUnpaidDate!))[0];
  return {
    from: data.from,
    to: data.to,
    accrualFrom: data.accrualFrom,
    rows,
    owedMills: sumMills(owing.map((row) => row.owedMills)),
    owedPeople: owing.length,
    accruedMills: sumMills(rows.map((row) => row.accruedMills)),
    paidMills: sumMills(rows.map((row) => row.paidMills)),
    oldest: oldest ? { row: oldest, date: oldest.person.oldestUnpaidDate! } : null,
    checks: data.checks,
  };
}

/** Why the ledger is not asked for this period; null — it is. */
export function ledgerWindowProblem(period: ResolvedPeriod): string | null {
  if (period.from > period.to) return "Период ещё не начался.";
  if (daysInRange(period.from, period.to) > TEAM_LEDGER_PAYOUTS_MAX_DAYS) return `Ledger отвечает за период до ${TEAM_LEDGER_PAYOUTS_MAX_DAYS} дней.`;
  return null;
}

export function useLedgerPayouts(period: ResolvedPeriod) {
  const { isOwner } = useMe();
  const problem = ledgerWindowProblem(period);
  const window = { from: period.from, to: period.to };
  const query = useQuery({
    queryKey: ["payouts", "ledger", window] as const,
    queryFn: () => kernel.teamLedgerPayouts({ query: window }),
    enabled: isOwner && problem === null,
    staleTime: 60_000,
  });
  const current = query.data !== undefined && query.data.from === window.from && query.data.to === window.to;
  const status = query.isError ? hubErrorStatus(query.error) : null;
  return {
    /** The owner's: a team lead sees the shift reports only. */
    asked: isOwner && problem === null,
    problem,
    view: current ? buildLedger(query.data) : null,
    query,
    /** The ledger is not connected or did not answer (503). */
    unavailable: status === 503,
    loading: isOwner && problem === null && !current && (query.isLoading || query.isFetching),
  };
}
