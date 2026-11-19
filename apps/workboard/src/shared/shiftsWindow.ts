import { CHATTER_STATS_MAX_DAYS } from "@agency_hub_core/contracts";
import { addDays, daysInRange, type MoscowDay } from "@agency_hub_core/ui/moscow";
import type { ResolvedPeriod } from "@agency_hub_core/ui/period";

/**
 * The window of the shift reads — `teamShiftSales` (Смены, Команда) and `accountShifts` (Мои смены) — for a period of
 * the app: what Hub is asked for and the days shown. Pure, apart from src/shared/reads.ts and its Hub client:
 * my-shifts/model.ts and its tests import it.
 */

/** The longest window the shift reads take (Moscow days): Hub's `CHATTER_STATS_MAX_DAYS`. */
export const SHIFT_READS_MAX_DAYS = CHATTER_STATS_MAX_DAYS;

export interface ShiftsWindow {
  /** What Hub is asked for. */
  days: number;
  until: MoscowDay | undefined;
  /** Shown days, both included (a week's days to come are listed empty). */
  from: MoscowDay;
  to: MoscowDay;
  /** The period is longer than Hub reads: its last SHIFT_READS_MAX_DAYS days are shown. */
  clipped: boolean;
}

/** What Hub is asked for, for a period of the app. */
export function shiftsWindow(period: ResolvedPeriod): ShiftsWindow {
  const { spec } = period;
  if (spec.kind === "week") {
    // The whole calendar week: Hub lists the days to come empty.
    return { days: 7, until: addDays(spec.monday, 6), from: spec.monday, to: addDays(spec.monday, 6), clipped: false };
  }
  if (spec.kind === "days") {
    return { days: spec.days, until: undefined, from: period.from, to: period.to, clipped: false };
  }
  const full = daysInRange(period.from, period.to);
  const days = Math.min(full, SHIFT_READS_MAX_DAYS);
  return { days, until: period.to, from: addDays(period.to, -(days - 1)), to: period.to, clipped: full > days };
}
