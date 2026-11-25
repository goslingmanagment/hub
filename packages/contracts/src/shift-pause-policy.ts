/**
 * Shift break policy (10 / 60 / 3, owner, 2026-11-25):
 *
 * - A break is at least `minAwayMinutes` (10) consecutive full empty minutes with zero authored sends inside the shift's
 *   working window (`[max(shiftStart, slotStart), shiftEnd)`, so pre-slot look-in gaps joined to the shift do not
 *   masquerade as a break).
 * - The single longest break >= 10 min is classified as `rest` (norm <= 60 min; minutes past 60 are flagged in
 *   `overrunMinutes` and do NOT count as an extra `away`).
 * - All remaining breaks >= 10 min are classified chronologically: #1..#3 are `away`, #4+ are `away_excess`.
 * - While a shift is ongoing, `preliminary` is true (a longer break later in the shift may still take the `rest` slot).
 * - Pure, constant policy (no `config_settings`, no manual buttons, never subtracts rest from `replySeconds` or alters
 *   Pulse Y-scale).
 */

export const SHIFT_PAUSE_POLICY = {
  /** Minimum full empty minutes with zero sent messages to count as a break. */
  minAwayMinutes: 10,
  /** Maximum normal duration of the single main rest break, minutes. */
  restMaxMinutes: 60,
  /** Maximum normal count of additional away breaks besides the main rest. */
  maxAwayCount: 3,
} as const;

export type ShiftBreakKind = "rest" | "away" | "away_excess";

export interface ShiftSendBreak {
  /** Start of the first full empty minute without sends, ms. */
  from: number;
  /** End of the last full empty minute without sends (start of the next send minute or shift window end), ms. */
  to: number;
  /** Full empty minutes without sends (`(to - from) / 60_000`). */
  minutes: number;
}

export interface ClassifiedShiftBreak extends ShiftSendBreak {
  kind: ShiftBreakKind;
  /** Minutes past `SHIFT_PAUSE_POLICY.restMaxMinutes` for `rest` (0 when within norm or non-rest). */
  overrunMinutes: number;
  /** 1-based ordinal among non-rest breaks (`1..3` for `away`, `4+` for `away_excess`); null for `rest`. */
  awayIndex: number | null;
}

export interface ShiftPauseSummary {
  breaks: ClassifiedShiftBreak[];
  /** Main rest break minutes (0 when there are no breaks >= `minAwayMinutes`). */
  restMinutes: number;
  /** Minutes by which the main rest break exceeded `restMaxMinutes` (0 when within norm). */
  restOverrunMinutes: number;
  /** Total count of non-rest breaks (`away` + `away_excess`). */
  awayCount: number;
  /** Count of non-rest breaks beyond `maxAwayCount`. */
  awayExcessCount: number;
  /** Total empty minutes across all non-rest breaks. */
  awayMinutes: number;
  /** True while the shift is still ongoing (the longest break may still change). */
  preliminary: boolean;
}

const MINUTE_MS = 60_000;

/**
 * Finds all breaks of at least `minAwayMinutes` consecutive full empty minutes with zero authored sends inside
 * `[max(shiftStart, slotStart), shiftEnd)`.
 *
 * Pre-slot look-in gaps (when a look-in before `slotStart` was joined to the shift) are excluded by starting the window
 * at `max(shiftStart, slotStart)`. Normal closed-shift idle tails (<= 9 full empty minutes after the final send minute)
 * stay strictly below `minAwayMinutes` and are never flagged. Pure.
 */
export function shiftSendBreaksOf(input: {
  /** Timestamps (ms) of the person's authored sends across all their pages. */
  sendMinutes: readonly number[];
  shiftStart: number;
  shiftEnd: number;
  /** Earliest start (ms) of the person's schedule slot(s) overlapping this shift, when known. */
  slotStart?: number | null;
  minAwayMinutes?: number;
}): ShiftSendBreak[] {
  const minAway = input.minAwayMinutes ?? SHIFT_PAUSE_POLICY.minAwayMinutes;
  const effectiveStart = input.slotStart != null && input.slotStart > input.shiftStart && input.slotStart < input.shiftEnd
    ? input.slotStart
    : input.shiftStart;
  const windowFrom = Math.floor(effectiveStart / MINUTE_MS) * MINUTE_MS;
  const windowTo = Math.floor(input.shiftEnd / MINUTE_MS) * MINUTE_MS;
  if (windowTo - windowFrom < minAway * MINUTE_MS) return [];

  const unique = new Set<number>();
  for (const at of input.sendMinutes) {
    const minute = Math.floor(at / MINUTE_MS) * MINUTE_MS;
    if (minute >= windowFrom && minute < windowTo) unique.add(minute);
  }
  const sends = [...unique].sort((a, b) => a - b);
  const out: ShiftSendBreak[] = [];

  if (sends.length === 0) {
    const minutes = Math.floor((windowTo - windowFrom) / MINUTE_MS);
    if (minutes >= minAway) out.push({ from: windowFrom, to: windowTo, minutes });
    return out;
  }

  // Leading empty stretch [windowFrom, sends[0]).
  const leadMinutes = Math.floor((sends[0]! - windowFrom) / MINUTE_MS);
  if (leadMinutes >= minAway) {
    out.push({ from: windowFrom, to: sends[0]!, minutes: leadMinutes });
  }

  // Interior gaps: full empty minutes strictly between consecutive send minutes [prev + 1m, next).
  for (let index = 1; index < sends.length; index += 1) {
    const prev = sends[index - 1]!;
    const next = sends[index]!;
    const gapMinutes = Math.floor((next - prev) / MINUTE_MS) - 1;
    if (gapMinutes >= minAway) {
      out.push({ from: prev + MINUTE_MS, to: next, minutes: gapMinutes });
    }
  }

  // Trailing empty stretch [lastSend + 1m, windowTo).
  const trailFrom = sends.at(-1)! + MINUTE_MS;
  const trailMinutes = Math.floor((windowTo - trailFrom) / MINUTE_MS);
  if (trailMinutes >= minAway) {
    out.push({ from: trailFrom, to: windowTo, minutes: trailMinutes });
  }

  return out;
}

/**
 * Classifies no-send breaks under the 10 / 60 / 3 policy:
 * - The single longest break (tie broken by earliest) is `rest` (norm <= 60 min; overrun flagged without counting as an away).
 * - Remaining breaks chronologically: #1..#3 `away`, #4+ `away_excess`.
 * Pure.
 */
export function classifyShiftBreaks(
  breaks: readonly ShiftSendBreak[],
  options: { ongoing: boolean },
): ShiftPauseSummary {
  const ordered = [...breaks].sort((a, b) => a.from - b.from || a.to - b.to);
  if (ordered.length === 0) {
    return {
      breaks: [],
      restMinutes: 0,
      restOverrunMinutes: 0,
      awayCount: 0,
      awayExcessCount: 0,
      awayMinutes: 0,
      preliminary: options.ongoing,
    };
  }

  let restIndex = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.minutes > ordered[restIndex]!.minutes) restIndex = index;
  }

  let awayOrdinal = 0;
  let awayMinutes = 0;
  const classified: ClassifiedShiftBreak[] = ordered.map((one, index) => {
    if (index === restIndex) {
      return {
        ...one,
        kind: "rest",
        overrunMinutes: Math.max(0, one.minutes - SHIFT_PAUSE_POLICY.restMaxMinutes),
        awayIndex: null,
      };
    }
    awayOrdinal += 1;
    awayMinutes += one.minutes;
    return {
      ...one,
      kind: awayOrdinal <= SHIFT_PAUSE_POLICY.maxAwayCount ? "away" : "away_excess",
      overrunMinutes: 0,
      awayIndex: awayOrdinal,
    };
  });

  const rest = classified[restIndex]!;
  return {
    breaks: classified,
    restMinutes: rest.minutes,
    restOverrunMinutes: rest.overrunMinutes,
    awayCount: awayOrdinal,
    awayExcessCount: Math.max(0, awayOrdinal - SHIFT_PAUSE_POLICY.maxAwayCount),
    awayMinutes,
    preliminary: options.ongoing,
  };
}
