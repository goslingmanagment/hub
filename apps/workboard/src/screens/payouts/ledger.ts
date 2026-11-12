import { useQuery } from "@tanstack/react-query";
import {
  TEAM_LEDGER_PAYOUTS_MAX_DAYS,
  type TeamLedgerPayoutPerson,
  type TeamLedgerPayoutsResponse,
  type TeamLedgerReportDay,
  type TeamLedgerReportsResponse,
} from "@agency_hub_core/contracts";
import { millsFromInteger, sumMills, type Mills } from "@agency_hub_core/shared";
import { hubErrorStatus } from "@agency_hub_core/ui/hubClient";
import { daysInRange, moscowToday } from "@agency_hub_core/ui/moscow";
import type { ResolvedPeriod } from "@agency_hub_core/ui/period";
import { kernel } from "@/shared/hub";
import { useMe } from "@/shared/useMe";

/**
 * Выплаты from the agency ledger — the screen's whole data (spec §4.7 r5: money
 * comes from ledger). The ledger counts the money: from the payout sheets, then
 * from Hub's facts or the chatters' posted shift reports from the days it
 * switched; Hub passes it on, the owner's only:
 *   - `teamLedgerPayouts` — what each person accrued and was paid in the period,
 *     what the agency owes them now, and the paid days whose report changed;
 *   - `teamLedgerReports` — every chatter's reports of the period: the pay base
 *     by page (posted and drafted), the drafts, the posts it could not use.
 * A team lead never asks. Query keys start with "payouts".
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
  /** «Не занесено»: the sheet's empty days with Hub's money in the person's shift, and their share at the tab's rate (an estimate). */
  unenteredDays: number;
  unenteredMills: Mills;
  strip: StripDay[];
  /** Paid days whose report changed since: each waits for the owner's word. */
  pendingChanges: TeamLedgerPayoutPerson["pendingChanges"];
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
  /** «Не занесено» of everyone, and of how many people. */
  unenteredMills: Mills;
  unenteredPeople: number;
  /** Whose unpaid day is the oldest. */
  oldest: { row: LedgerRow; date: string } | null;
  checks: TeamLedgerPayoutsResponse["checks"];
  /** From these days on the ledger accrues from Hub's facts / from the posted reports; null — not switched. */
  factsFrom: string | null;
  reportsFrom: string | null;
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
      unenteredDays: person.unentered.days,
      unenteredMills: millsFromInteger(person.unentered.shareMills),
      strip: window.map((day) => ({
        day,
        state: day > today ? "future" : !accrued.has(day) ? "none" : owed.has(day) ? "owed" : "paid",
      })),
      pendingChanges: person.pendingChanges,
    };
  })
    // A person with nothing in the period and nothing owed is not on the screen.
    .filter((row) => row.owedMills !== 0n || row.accruedMills !== 0n || row.paidMills !== 0n || row.unenteredDays > 0 || row.pendingChanges.length > 0)
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
    unenteredMills: sumMills(rows.map((row) => row.unenteredMills)),
    unenteredPeople: rows.filter((row) => row.unenteredDays > 0).length,
    oldest: oldest ? { row: oldest, date: oldest.person.oldestUnpaidDate! } : null,
    checks: data.checks,
    factsFrom: data.factsFrom,
    reportsFrom: data.reportsFrom,
  };
}

/** Why the ledger is not asked for this period; null — it is. (Its reports take the same 62 days.) */
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

/**
 * One person's payout brief from the ledger (L5 `payout prepare`), for the open panel only: the transfer, what
 * blocks it, and the chatter's message. Read-only; the owner sends the message himself.
 */
export function usePayoutPrepare(slug: string | null) {
  const { isOwner } = useMe();
  return useQuery({
    queryKey: ["payouts", "ledger-prepare", slug] as const,
    queryFn: () => kernel.teamLedgerPayoutPrepare({ query: { person: slug! } }),
    enabled: isOwner && slug !== null,
    staleTime: 60_000,
  });
}

/**
 * One person's pay in the period (`teamLedgerPayoutPerson`, ledger #80), for the open panel only: each day with its
 * state by the payouts, the adjustments with their memo, the payouts, the last payout. Read-only.
 */
export function usePayoutPerson(slug: string, period: ResolvedPeriod) {
  const { isOwner } = useMe();
  const problem = ledgerWindowProblem(period);
  const window = { person: slug, from: period.from, to: period.to };
  return useQuery({
    queryKey: ["payouts", "ledger-person", window] as const,
    queryFn: () => kernel.teamLedgerPayoutPerson({ query: window }),
    enabled: isOwner && problem === null,
    staleTime: 60_000,
  });
}

/**
 * Every chatter's reports of the period (`teamLedgerReports`): the journal of «Отчёты», and the report a payouts
 * day opens to. Asked only while something shows it (`enabled`).
 */
export function useLedgerReports(period: ResolvedPeriod, enabled = true) {
  const { isOwner } = useMe();
  const problem = ledgerWindowProblem(period);
  const window = { from: period.from, to: period.to };
  const asked = isOwner && problem === null && enabled;
  const query = useQuery({
    queryKey: ["payouts", "reports", window] as const,
    queryFn: () => kernel.teamLedgerReports({ query: window }),
    enabled: asked,
    staleTime: 60_000,
  });
  const current = query.data !== undefined && query.data.from === window.from && query.data.to === window.to;
  return {
    asked,
    problem,
    data: current ? query.data : null,
    query,
    unavailable: query.isError && hubErrorStatus(query.error) === 503,
    loading: asked && !current && (query.isLoading || query.isFetching),
  };
}

/** The report of a person's day, when the ledger has one: by the ledger's code and the report date. */
export function reportOfDay(reports: TeamLedgerReportsResponse | null, slug: string, date: string): TeamLedgerReportDay | null {
  return reports?.reports.find((day) => day.person.slug === slug && day.reportDate === date) ?? null;
}
