import {
  listPersonDayLineRows,
  listPersonLoginRows,
  listPersonScheduleSlotRows,
  listPersonWorkingPageRows,
  type Database,
  type PersonLoginRow,
  type PersonScheduleSlotRow,
} from "@agency_hub_core/db";
import { moscowDayOfMs as moscowDayOf } from "@agency_hub_core/shared";

import type { RuleSlot } from "./sale-rule.ts";

/**
 * The people's schedule as Hub reads it: the people registry's standing lines (0384 `person_schedule_slots`) and the
 * approved swaps' one-day lines (0422). Here are the lines by login as the «whose sale» rule reads them (`ruleSlotsOf`,
 * `registrySlots`) and where a person's lines run (`slotOccurrencesOf`): the report's window (shift-handin-rules.ts
 * `slotWindowOf`) and the cut of a shift (chatter-shifts.ts: a break inside the person's own slot is a pause,
 * `registryScheduleSpans`) read the same runs.
 *
 * A leaf: the rule (sale-rule.ts), the homes (sale-homes.ts) and the shift (chatter-shifts.ts) import it, and it
 * imports none of them but the rule's types — the rule imports the shift.
 */

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const MINUTES_OF_DAY = 1440;

/** The days of the week a slot runs on, as the people registry writes them (0384 `person_schedule_slots.weekdays`). */
export const RULE_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type RuleWeekday = (typeof RULE_WEEKDAYS)[number];

/** The day of the week of a Moscow day (YYYY-MM-DD). Pure. */
export function weekdayOfDay(day: string): RuleWeekday {
  return RULE_WEEKDAYS[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7]!;
}

/**
 * Where the people's schedule slots come from (sale-rule.ts `RuleSlot`): the people registry (`registrySlots`), or
 * none — then a junction nobody wrote to waits for the owner, as ledger's Go. A registry with no slot gives none.
 */
export interface SaleSlotProvider {
  slotsFor(input: { from: Date; to: Date }): Promise<readonly RuleSlot[]>;
}

export const NO_SLOTS: SaleSlotProvider = { slotsFor: async () => [] };

const WEEKDAYS: ReadonlySet<string> = new Set(RULE_WEEKDAYS);

/**
 * The registry's slots (0384 `person_schedule_slots`) as the rule reads them: a person's slot holds for every Hub login
 * of theirs (`person_logins`), so it is given once per login; a person with no login has none. Only the slots valid on
 * some day of [from − 1 day, to] (Moscow; a slot that began the day before still runs past midnight). Pure.
 */
export function ruleSlotsOf(input: {
  slots: readonly PersonScheduleSlotRow[];
  logins: ReadonlyArray<Pick<PersonLoginRow, "personId" | "userId">>;
  from: Date;
  to: Date;
}): RuleSlot[] {
  const first = moscowDayOf(input.from.getTime() - DAY_MS);
  const last = moscowDayOf(input.to.getTime());
  const loginsOf = new Map<number, number[]>();
  for (const login of input.logins) loginsOf.set(login.personId, [...(loginsOf.get(login.personId) ?? []), login.userId]);
  return input.slots
    .filter((slot) => (slot.validFrom === null || slot.validFrom <= last) && (slot.validTo === null || first <= slot.validTo))
    .flatMap((slot) => (loginsOf.get(slot.personId) ?? []).map((userId): RuleSlot => ({
      personId: userId,
      pageId: slot.pageId,
      startMinute: slot.startMinute,
      endMinute: slot.endMinute,
      weekdays: slot.weekdays === null ? null : slot.weekdays.filter((day): day is RuleWeekday => WEEKDAYS.has(day)),
      validFrom: slot.validFrom,
      validTo: slot.validTo,
      ...(slot.kind === null ? {} : { day: slot.kind }),
    })));
}

/** The standing lines and the swaps' one-day lines of [from − 1 day, to] (Moscow days), read in turn. */
async function registryLines(db: Database, { from, to }: { from: Date; to: Date }): Promise<PersonScheduleSlotRow[]> {
  const standing = await listPersonScheduleSlotRows(db);
  const days = await listPersonDayLineRows(db, { from: moscowDayOf(from.getTime() - DAY_MS), to: moscowDayOf(to.getTime()) });
  return [...standing, ...days];
}

/**
 * The people registry's schedule slots, read through `db` in turn: the standing lines and the swaps' one-day lines of the
 * window (0422) — who is scheduled on a day is both.
 */
export function registrySlots(db: Database): SaleSlotProvider {
  return {
    slotsFor: async ({ from, to }) => {
      const slots = await registryLines(db, { from, to });
      if (slots.length === 0) return [];
      return ruleSlotsOf({ slots, logins: await listPersonLoginRows(db), from, to });
    },
  };
}

/** One run of a schedule line: [start, end), ms, on a page (null — every page of the person). */
export interface SlotOccurrence {
  start: number;
  end: number;
  pageId: number | null;
}

/**
 * The runs of a person's lines that overlap [from, to): each line on the Moscow days of its start from the day before
 * `from` (a slot begun then runs past midnight) to the day of `to`, on its weekdays and within its validity, for as
 * long as it is (a slot whose end is not after its start crosses midnight; one ending 24:00 runs to midnight; one of no
 * length runs never). A swap's `off` line runs nowhere: it takes its own hours out of the person's lines of its page
 * (as the rule's `slotRuns`); a `cover` line runs as a line of its own, whatever is off. `slots` name the person by
 * login (`personId`), as the rule reads them. `pagesOfAll` — the person's working pages, which a line of every page
 * stands for: given, such a line runs page by page, each cut by that page's `off` (a page's swap does not take the
 * person off the other pages); not given, it stays a line of every page. In the order of the days, then of the lines.
 * Pure.
 */
export function slotOccurrencesOf(
  slots: readonly RuleSlot[],
  input: { userIds: ReadonlySet<number>; from: number; to: number; pagesOfAll?: readonly number[] | undefined },
): SlotOccurrence[] {
  const own = slots.filter((slot) => input.userIds.has(slot.personId));
  if (own.length === 0) return [];
  const runs: Array<{ slot: RuleSlot; start: number; end: number }> = [];
  const first = moscowDayOf(input.from - DAY_MS);
  for (let day = first; Date.parse(`${day}T00:00:00+03:00`) <= input.to; day = moscowDayOf(Date.parse(`${day}T12:00:00+03:00`) + DAY_MS)) {
    const midnight = Date.parse(`${day}T00:00:00+03:00`);
    const weekday = weekdayOfDay(day);
    for (const slot of own) {
      if ((slot.validFrom !== null && day < slot.validFrom) || (slot.validTo !== null && day > slot.validTo)) continue;
      if (slot.weekdays !== null && !slot.weekdays.includes(weekday)) continue;
      const minutes = (slot.endMinute - slot.startMinute + MINUTES_OF_DAY) % MINUTES_OF_DAY || (slot.endMinute === MINUTES_OF_DAY ? MINUTES_OF_DAY - slot.startMinute : 0);
      if (minutes <= 0) continue;
      const start = midnight + slot.startMinute * MINUTE_MS;
      runs.push({ slot, start, end: start + minutes * MINUTE_MS });
    }
  }
  const offs = runs.filter((run) => run.slot.day === "off");
  const pagesOfAll = input.pagesOfAll !== undefined && input.pagesOfAll.length > 0 ? input.pagesOfAll : null;
  const out: SlotOccurrence[] = [];
  for (const run of runs) {
    if (run.slot.day === "off") continue;
    const onPages: Array<number | null> = run.slot.pageId === null && run.slot.day === undefined && pagesOfAll !== null ? [...pagesOfAll] : [run.slot.pageId];
    for (const pageId of onPages) {
      const pieces = run.slot.day === "cover" ? [{ start: run.start, end: run.end }]
        : withoutHours({ start: run.start, end: run.end }, offs.filter((off) => off.slot.pageId === pageId));
      for (const piece of pieces) {
        if (piece.end <= input.from || piece.start >= input.to) continue;
        out.push({ start: piece.start, end: piece.end, pageId });
      }
    }
  }
  return out;
}

/** An interval with the hours of others taken out: what is left of it, in order. Pure. */
function withoutHours(run: { start: number; end: number }, out: ReadonlyArray<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  let left = [run];
  for (const cut of out) {
    left = left.flatMap((piece) => {
      if (cut.end <= piece.start || cut.start >= piece.end) return [piece];
      return [
        ...(cut.start > piece.start ? [{ start: piece.start, end: cut.start }] : []),
        ...(cut.end < piece.end ? [{ start: cut.end, end: piece.end }] : []),
      ];
    });
  }
  return left;
}

/** A stretch of a person's schedule: [start, end), ms. */
export interface ScheduleSpan {
  start: number;
  end: number;
}

/** Runs as one schedule: their union as disjoint intervals in order, the runs that overlap or touch one. Pure. */
export function scheduleSpansOf(runs: ReadonlyArray<{ start: number; end: number }>): ScheduleSpan[] {
  const out: ScheduleSpan[] = [];
  for (const run of [...runs].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last !== undefined && run.start <= last.end) last.end = Math.max(last.end, run.end);
    else out.push({ start: run.start, end: run.end });
  }
  return out;
}

/**
 * Each login's schedule over [from, to), as the cut of a shift reads it (chatter-shifts.ts `workOfMinutes`): the runs of
 * the person's lines on any page of theirs (`slotOccurrencesOf` over their working pages: a page's line and a line of
 * every page both count, a swap's `off` takes its hours off its page, a `cover` adds its own), joined into one
 * (`scheduleSpansOf`). A login with no line has none. Read through `db` in turn.
 */
export async function registryScheduleSpans(db: Database, input: { from: Date; to: Date }): Promise<Map<number, ScheduleSpan[]>> {
  const lines = await registryLines(db, input);
  if (lines.length === 0) return new Map();
  const logins = await listPersonLoginRows(db);
  const working = await listPersonWorkingPageRows(db);
  const slots = ruleSlotsOf({ slots: lines, logins, from: input.from, to: input.to });
  const pagesOf = new Map<number, number[]>();
  for (const row of working) pagesOf.set(row.personId, [...(pagesOf.get(row.personId) ?? []), row.pageId]);
  const out = new Map<number, ScheduleSpan[]>();
  for (const login of logins) {
    const runs = slotOccurrencesOf(slots, { userIds: new Set([login.userId]), from: input.from.getTime(), to: input.to.getTime(), pagesOfAll: pagesOf.get(login.personId) });
    if (runs.length > 0) out.set(login.userId, scheduleSpansOf(runs));
  }
  return out;
}
