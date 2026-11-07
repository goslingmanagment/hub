import { useQuery } from "@tanstack/react-query";
import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { sumMills } from "@agency_hub_core/shared";
import { daysInRange } from "@agency_hub_core/ui/moscow";
import { daysOf, pivotOf, type PivotRow } from "@agency_hub_core/ui/payoutSheet";
import type { ResolvedPeriod } from "@agency_hub_core/ui/period";
import { kernel } from "@/shared/hub";

/**
 * Выплаты — the data layer (spec §4.7). The screen reads only this file.
 *
 * Phase 1 adapter over two reads of today:
 *   - `teamShiftExport` { from, to } — confirmed shift reports, chatter × page ×
 *     day (Moscow days, both included: the global period's `from`/`to`; at most
 *     31 days). No placeholder across windows: the columns of a new window must
 *     never carry the sums of the old one (apps/dashboard/src/api/team.ts:147-159).
 *   - `teamShiftSales` { days, until } — the same days' shifts with their sales,
 *     only for «sales at stake» of the shifts nobody confirmed and for the people's
 *     ids; joined here in the browser (phase 2: one `teamPayouts` read).
 * The copy for the payout sheet is packages/ui/src/payoutSheet.ts — the
 * console's format, byte for byte. No writes on this screen: the disputes it
 * leaves out are decided on Решения.
 * Query keys start with "payouts" (a dispute's decision refreshes them).
 */

type Export = KernelOperationResponse<"teamShiftExport">;
type ShiftSales = KernelOperationResponse<"teamShiftSales">;

/** The export's longest window (SHIFT_REPORT_EXPORT_MAX_DAYS). */
export const EXPORT_MAX_DAYS = 31;
/** How far back a chatter can still confirm a shift in the cabinet (SHIFT_REPORT_MAX_DAYS). */
export const CONFIRM_MAX_DAYS = 14;

export interface UnconfirmedShift {
  startedAt: string;
  endedAt: string;
  ongoing: boolean;
  /** The shift's sales by Hub's shifts (before any chatter's marks); null — the sales read did not answer or has no such shift. */
  salesNetMills: number | null;
  /** Too old to confirm in the cabinet now. */
  tooLate: boolean;
}

/** Future contract (phase 2, `teamPayouts`): one row per chatter of the window. */
export interface PayoutChatter {
  username: string;
  userId: number | null;
  /** Confirmed credits of the window: what goes into the payout sheet. */
  confirmedMills: bigint;
  pages: Array<{ pageLabel: string; platform: string; mills: bigint }>;
  /** Days with a confirmed credit. */
  days: number;
  /** The chatter's rows of the sheet, as they will be copied. */
  sheet: PivotRow[];
  unconfirmed: UnconfirmedShift[];
  /** Sales of those shifts; null when not known for every one of them. */
  atStakeMills: bigint | null;
  ownAmounts: Export["ownAmounts"];
  lateChanges: Export["lateChanges"];
}

export interface PayoutsView {
  from: string;
  to: string;
  days: string[];
  chatters: PayoutChatter[];
  /** The whole sheet, every chatter (what «Скопировать всё» copies). */
  sheet: PivotRow[];
  confirmedMills: bigint;
  atStakeMills: bigint | null;
  disputedOpen: number;
  lateChanges: Export["lateChanges"];
  serverNow: string;
}

/** The window's problem in words, before any request; null when it can be asked. */
export function windowProblem(period: ResolvedPeriod): string | null {
  if (period.from > period.to) return "Период ещё не начался.";
  if (daysInRange(period.from, period.to) > EXPORT_MAX_DAYS) return `Период длиннее ${EXPORT_MAX_DAYS} дня`;
  return null;
}

const DAY_MS = 86_400_000;

function overlaps(left: { startedAt: string; endedAt: string }, right: { startedAt: string; endedAt: string }): boolean {
  return Date.parse(left.startedAt) < Date.parse(right.endedAt) && Date.parse(right.startedAt) < Date.parse(left.endedAt);
}

export function buildPayouts(data: Export, sales: ShiftSales | undefined): PayoutsView {
  const now = Date.parse(data.serverNow);
  const sheet = pivotOf(data.rows);
  const days = daysOf(data.from, data.to);
  const ids = new Map<string, number>();
  for (const chatter of sales?.chatters ?? []) ids.set(chatter.username, chatter.userId);
  for (const shift of sales?.shifts ?? []) ids.set(shift.username, shift.userId);

  const names = [...new Set([...data.rows.map((row) => row.username), ...data.unconfirmed.map((shift) => shift.username)])];
  const chatters = names.map((username): PayoutChatter => {
    const rows = data.rows.filter((row) => row.username === username);
    const byPage = new Map<string, { pageLabel: string; platform: string; values: number[] }>();
    for (const row of rows) {
      const entry = byPage.get(row.pageLabel) ?? { pageLabel: row.pageLabel, platform: row.platform, values: [] };
      entry.values.push(row.creditedMills);
      byPage.set(row.pageLabel, entry);
    }
    const unconfirmed = data.unconfirmed
      .filter((shift) => shift.username === username)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .map((shift): UnconfirmedShift => {
        const match = sales?.shifts.find((one) => one.username === username && (one.startedAt === shift.startedAt || overlaps(one, shift)));
        return {
          ...shift,
          salesNetMills: match ? match.salesNetMills : null,
          tooLate: !shift.ongoing && now - Date.parse(shift.startedAt) > CONFIRM_MAX_DAYS * DAY_MS,
        };
      });
    const known = unconfirmed.every((shift) => shift.salesNetMills !== null);
    return {
      username,
      userId: ids.get(username) ?? null,
      confirmedMills: sumMills(rows.map((row) => row.creditedMills)),
      pages: [...byPage.values()].map((page) => ({ pageLabel: page.pageLabel, platform: page.platform, mills: sumMills(page.values) })),
      days: new Set(rows.map((row) => row.shiftDate)).size,
      sheet: sheet.filter((row) => row.username === username),
      unconfirmed,
      atStakeMills: known ? sumMills(unconfirmed.map((shift) => shift.salesNetMills ?? 0)) : null,
      ownAmounts: data.ownAmounts.filter((own) => own.username === username),
      lateChanges: data.lateChanges.filter((late) => late.username === username),
    };
  }).sort((left, right) => (left.confirmedMills === right.confirmedMills ? left.username.localeCompare(right.username) : left.confirmedMills > right.confirmedMills ? -1 : 1));

  const allKnown = chatters.every((chatter) => chatter.atStakeMills !== null);
  return {
    from: data.from,
    to: data.to,
    days,
    chatters,
    sheet,
    confirmedMills: sumMills(chatters.map((chatter) => chatter.confirmedMills)),
    atStakeMills: allKnown ? sumMills(chatters.map((chatter) => chatter.atStakeMills ?? 0n)) : null,
    disputedOpen: data.disputedOpen,
    lateChanges: data.lateChanges,
    serverNow: data.serverNow,
  };
}

export function usePayouts(period: ResolvedPeriod) {
  const problem = windowProblem(period);
  const window = { from: period.from, to: period.to };
  const exported = useQuery({
    queryKey: ["payouts", "export", window] as const,
    queryFn: () => kernel.teamShiftExport({ query: window }),
    enabled: problem === null,
  });
  const span = problem === null ? daysInRange(period.from, period.to) : 0;
  const sales = useQuery({
    queryKey: ["payouts", "shift-sales", { days: span, until: period.to }] as const,
    queryFn: () => kernel.teamShiftSales({ query: { days: span, until: period.to } }),
    enabled: problem === null,
    staleTime: 2 * 60_000,
  });
  const current = exported.data !== undefined && exported.data.from === window.from && exported.data.to === window.to;
  const view = current ? buildPayouts(exported.data, sales.data) : null;
  return {
    problem,
    view,
    exported,
    sales,
    /** The first load of this window. */
    loading: problem === null && !current && (exported.isLoading || exported.isFetching),
    refetch: () => {
      void exported.refetch();
      void sales.refetch();
    },
  };
}
