import {
  CHATTER_NUMBERS_MAX_DAYS,
  MASS_SEND_MIN_CHATS,
  type ChatterNumbers,
  type TeamChatterNumbersResponse,
} from "@agency_hub_core/contracts";
import { listChatterActivityMinutes, listConfirmedShiftCredits, readShiftNumbers, type ShiftNumbersRow } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { requireDashboardUser, type AuthPrincipal } from "./auth.ts";
import { shiftsOfMinutes, type ActivityMinute } from "./chatter-shifts.ts";
import { BadRequestError } from "./errors.ts";

/**
 * Chat Memory week 5 (docs/plans/2026-10-24-chat-memory/week-5.md §1): the
 * eight numbers of each chatter's shifts and week (`teamChatterNumbers`).
 *
 * A shift is week 1's actual shift; its pages are those the chatter was active
 * on. Only messages with the chatter as their author count — a message without
 * an author is nobody's; revenue only from the confirmed shift report (week 4),
 * and for a team lead only its lines on the lead's pages. The same for Fansly
 * and OnlyFans. A guide, not a basis for pay. Database only.
 */

const DAY_MS = 86_400_000;
const HOUR_SECONDS = 3600;
/** Shifts read at once: one query each. */
const SHIFT_READS_AT_ONCE = 4;

interface ShiftInput {
  workedMinutes: number;
  revenueMills: number | null;
  row: ShiftNumbersRow;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.floor((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function averagePrice(prices: readonly number[]): number | null {
  if (prices.length === 0) return null;
  const total = prices.reduce((sum, price) => sum + BigInt(price), 0n);
  return Number(total / BigInt(prices.length));
}

/**
 * Each shift's confirmed report and the revenue it shows. A lead's view sees a
 * chatter's shift only on its pages, so one confirmed shift can show as two
 * (A → B → A, B not the lead's): the report is the one that started with the
 * shift, else one it lies in, and it credits the first of its shifts only —
 * the rest are confirmed with no revenue of their own. Pure.
 */
export function revenueOfShifts(
  shifts: ReadonlyArray<{ startedAt: number }>,
  reports: ReadonlyArray<{ startedAt: Date; endedAt: Date; creditedMills: number }>,
): Array<{ confirmed: boolean; revenueMills: number | null }> {
  const credited = new Set<number>();
  const out: Array<{ confirmed: boolean; revenueMills: number | null }> = shifts.map(() => ({ confirmed: false, revenueMills: null }));
  const order = shifts.map((shift, index) => ({ startedAt: shift.startedAt, index })).sort((a, b) => a.startedAt - b.startedAt);
  for (const { startedAt, index } of order) {
    const report = reports.find((one) => one.startedAt.getTime() === startedAt)
      ?? reports.find((one) => one.startedAt.getTime() <= startedAt && one.endedAt.getTime() > startedAt);
    if (report === undefined) continue;
    const key = report.startedAt.getTime();
    out[index] = { confirmed: true, revenueMills: credited.has(key) ? 0 : report.creditedMills };
    credited.add(key);
  }
  return out;
}

/** The numbers of one or more shifts together: a fan written to in several counts once; `waitingAtEnd` of several is their average. Pure. */
export function numbersOf(shifts: readonly ShiftInput[]): ChatterNumbers {
  const rows = shifts.map((shift) => shift.row);
  const sum = (pick: (row: ShiftNumbersRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const confirmed = shifts.filter((shift) => shift.revenueMills !== null);
  const revenue = confirmed.length === 0 ? null : confirmed.reduce((total, shift) => total + shift.revenueMills!, 0);
  const confirmedMinutes = confirmed.reduce((total, shift) => total + shift.workedMinutes, 0);
  const messages = sum((row) => row.messages);
  const ppvSent = sum((row) => row.ppvSent);
  const delays = rows.flatMap((row) => row.replyDelays);
  return {
    workedMinutes: shifts.reduce((total, shift) => total + shift.workedMinutes, 0),
    revenueMills: revenue,
    revenuePerHourMills: revenue === null || confirmedMinutes === 0 ? null : Number((BigInt(revenue) * 60n) / BigInt(confirmedMinutes)),
    fansWritten: new Set(rows.flatMap((row) => row.writtenFans)).size,
    fansPaid: new Set(rows.flatMap((row) => row.paidFans)).size,
    messages,
    ppvSent,
    ppvBought: sum((row) => row.ppvBought),
    ppvAveragePriceMills: averagePrice(rows.flatMap((row) => row.boughtPrices)),
    ppvShare: messages === 0 ? null : ppvSent / messages,
    replies: delays.length,
    replyMedianSeconds: median(delays),
    repliesWithinHour: delays.filter((delay) => delay <= HOUR_SECONDS).length,
    waitingAtEnd: rows.length === 0 ? 0 : Math.round(sum((row) => row.waitingAtEnd) / rows.length),
    composed: {
      hand: sum((row) => row.composed.hand),
      reply: sum((row) => row.composed.reply),
      fix: sum((row) => row.composed.fix),
      other: sum((row) => row.composed.other),
    },
  };
}

export async function readTeamChatterNumbers(
  app: AppContext,
  principal: AuthPrincipal,
  input: { from?: string | undefined; to?: string | undefined; pageScope: readonly number[] | undefined },
): Promise<TeamChatterNumbersResponse> {
  requireDashboardUser(principal);
  const now = new Date();
  const to = input.to === undefined ? now : new Date(input.to);
  const from = input.from === undefined ? new Date(to.getTime() - 7 * DAY_MS) : new Date(input.from);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw new BadRequestError("`from` must be before `to`");
  if (to.getTime() - from.getTime() > CHATTER_NUMBERS_MAX_DAYS * DAY_MS) {
    throw new BadRequestError(`The window is at most ${CHATTER_NUMBERS_MAX_DAYS} days`);
  }

  // A day more on each side, so the shifts that started in the window are whole.
  const minutes = await listChatterActivityMinutes(app.db, {
    from: new Date(from.getTime() - DAY_MS), to: new Date(Math.min(to.getTime() + DAY_MS, now.getTime())), pages: input.pageScope ?? "all",
  });
  const people = new Map<number, { username: string; minutes: ActivityMinute[]; pageIds: Map<string, number> }>();
  for (const minute of minutes) {
    const person = people.get(minute.userId) ?? { username: minute.username, minutes: [] as ActivityMinute[], pageIds: new Map<string, number>() };
    person.minutes.push({ at: minute.minute.getTime(), pageLabel: minute.pageLabel, input: minute.input });
    person.pageIds.set(minute.pageLabel, minute.pageId);
    people.set(minute.userId, person);
  }

  const chatters: TeamChatterNumbersResponse["chatters"] = [];
  for (const [userId, person] of people) {
    const shifts = shiftsOfMinutes(person.minutes, now.getTime())
      .filter((shift) => shift.startedAt >= from.getTime() && shift.startedAt < to.getTime());
    if (shifts.length === 0) continue;
    const reports = await listConfirmedShiftCredits(app.db, { userId, since: new Date(from.getTime() - DAY_MS), pageIds: input.pageScope ?? "all" });
    const revenue = revenueOfShifts(shifts, reports);
    const computed: Array<ShiftInput & { shift: (typeof shifts)[number]; confirmed: boolean }> = [];
    for (let index = 0; index < shifts.length; index += SHIFT_READS_AT_ONCE) {
      computed.push(...await Promise.all(shifts.slice(index, index + SHIFT_READS_AT_ONCE).map(async (shift, offset) => {
        const labels = [...shift.pages.keys()].sort();
        const row = await readShiftNumbers(app.db, {
          userId, pageIds: labels.map((label) => person.pageIds.get(label)!), from: new Date(shift.startedAt), to: new Date(shift.endedAt),
          burstMinChats: MASS_SEND_MIN_CHATS,
        });
        const { confirmed, revenueMills } = revenue[index + offset]!;
        return { shift, row, workedMinutes: shift.workedMinutes, revenueMills, confirmed };
      })));
    }
    chatters.push({
      userId,
      username: person.username,
      week: { ...numbersOf(computed), shifts: computed.length, unconfirmedShifts: computed.filter((one) => !one.confirmed).length },
      shifts: computed
        .sort((a, b) => b.shift.startedAt - a.shift.startedAt)
        .map((one) => ({
          startedAt: new Date(one.shift.startedAt).toISOString(),
          endedAt: new Date(one.shift.endedAt).toISOString(),
          ongoing: one.shift.ongoing,
          pages: [...one.shift.pages.keys()].sort(),
          confirmed: one.confirmed,
          numbers: numbersOf([one]),
        })),
    });
  }
  chatters.sort((a, b) => a.username.localeCompare(b.username));
  return { from: from.toISOString(), to: to.toISOString(), chatters, serverNow: now.toISOString() };
}
