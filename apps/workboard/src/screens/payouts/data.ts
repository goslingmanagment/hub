import { useQuery } from "@tanstack/react-query";
import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { millsFromDollars, sumMills, type Mills } from "@agency_hub_core/shared";
import { daysInRange } from "@agency_hub_core/ui/moscow";
import { daysOf, pivotOf, sheetCell, type PivotRow } from "@agency_hub_core/ui/payoutSheet";
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
 * console's format, byte for byte. Every sum on this screen is a sum of the
 * sheet's cells as they paste (В-н1): a Fansly cell to the cent, an OnlyFans
 * cell to the dollar — so a row, its days and «Итого» add up to what the sheet
 * adds up to after the paste. No writes on this screen: the disputes it leaves
 * out are decided on Решения.
 * Query keys start with "payouts" (a dispute's decision refreshes them).
 */

type Export = KernelOperationResponse<"teamShiftExport">;
type ShiftSales = KernelOperationResponse<"teamShiftSales">;

/** The export's longest window (SHIFT_REPORT_EXPORT_MAX_DAYS). */
export const EXPORT_MAX_DAYS = 31;
/** How far back a chatter can still confirm a shift in the cabinet (SHIFT_REPORT_MAX_DAYS). */
export const CONFIRM_MAX_DAYS = 14;

/**
 * One cell of the payout sheet as it pastes, back in mills: «479.94» → 479 940.
 * The cell's own text is the rule (sheetCell), so the screen and the pasted
 * sheet can never part by a cent.
 */
export function pastedMills(platform: string, mills: number): Mills {
  return millsFromDollars(sheetCell(platform, mills));
}

/** The pasted sum of one row of the sheet (a chatter's page): its cells as they paste. */
export function pastedRowMills(row: PivotRow): Mills {
  return sumMills([...row.cells.values()].map((value) => pastedMills(row.platform, value)));
}

export interface UnconfirmedShift {
  startedAt: string;
  endedAt: string;
  ongoing: boolean;
  /** Minutes worked, pauses left out (the same shift of `teamShiftSales`); null — not known. */
  workedMinutes: number | null;
  /** The shift's sales by Hub's shifts (before any chatter's marks); null — the sales read did not answer or has no such shift. */
  salesNetMills: number | null;
  /** Too old to confirm in the cabinet now. */
  tooLate: boolean;
}

/** Future contract (phase 2, `teamPayouts`): one row per chatter of the window. */
export interface PayoutChatter {
  username: string;
  userId: number | null;
  /** Confirmed credits of the window as they paste: the sum of the chatter's sheet cells. */
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
  /** Every chatter's sales at stake; null when some chatter's are not known. */
  atStakeMills: bigint | null;
  /** The sales at stake of the chatters whose are known, and who is left out of it (В-н5). */
  atStakeKnownMills: bigint;
  atStakeUnknown: string[];
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
    const blocks = sheet.filter((row) => row.username === username);
    const unconfirmed = data.unconfirmed
      .filter((shift) => shift.username === username)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .map((shift): UnconfirmedShift => {
        const match = sales?.shifts.find((one) => one.username === username && (one.startedAt === shift.startedAt || overlaps(one, shift)));
        return {
          ...shift,
          workedMinutes: match ? match.workedMinutes : null,
          salesNetMills: match ? match.salesNetMills : null,
          tooLate: !shift.ongoing && now - Date.parse(shift.startedAt) > CONFIRM_MAX_DAYS * DAY_MS,
        };
      });
    const known = unconfirmed.every((shift) => shift.salesNetMills !== null);
    return {
      username,
      userId: ids.get(username) ?? null,
      confirmedMills: sumMills(blocks.map(pastedRowMills)),
      pages: blocks.map((row) => ({ pageLabel: row.pageLabel, platform: row.platform, mills: pastedRowMills(row) })),
      days: new Set(rows.map((row) => row.shiftDate)).size,
      sheet: blocks,
      unconfirmed,
      atStakeMills: known ? sumMills(unconfirmed.map((shift) => shift.salesNetMills ?? 0)) : null,
      ownAmounts: data.ownAmounts.filter((own) => own.username === username),
      lateChanges: data.lateChanges.filter((late) => late.username === username),
    };
  }).sort((left, right) => (left.confirmedMills === right.confirmedMills ? left.username.localeCompare(right.username) : left.confirmedMills > right.confirmedMills ? -1 : 1));

  const allKnown = chatters.every((chatter) => chatter.atStakeMills !== null);
  const atStakeKnownMills = sumMills(chatters.map((chatter) => chatter.atStakeMills ?? 0n));
  return {
    from: data.from,
    to: data.to,
    days,
    chatters,
    sheet,
    confirmedMills: sumMills(chatters.map((chatter) => chatter.confirmedMills)),
    atStakeMills: allKnown ? atStakeKnownMills : null,
    atStakeKnownMills,
    atStakeUnknown: chatters.filter((chatter) => chatter.atStakeMills === null).map((chatter) => chatter.username),
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
