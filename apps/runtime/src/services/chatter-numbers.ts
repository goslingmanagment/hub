import {
  CHATTER_NUMBERS_MAX_DAYS,
  MASS_SEND_MIN_CHATS,
  SHIFT_REVIEW_BROADCAST_OWN_WORDS,
  SHIFT_REVIEW_DELETED_UNSEEN_SECONDS,
  SHIFT_REVIEW_WAIT_HORIZON_HOURS,
  shiftReviewCounts,
  shiftReviewMedian,
  shiftReviewMine,
  shiftReviewWaits,
  type ChatterNumbers,
  type TeamChatterNumbersResponse,
} from "@agency_hub_core/contracts";
import {
  listAllAutomatedTexts,
  listConfirmedShiftCredits,
  listPagesByLabels,
  listShiftReviewMessages,
  listShiftReviewSends,
  readShiftFans,
  type ShiftFansRow,
  type ShiftReviewMessageRow,
  type ShiftReviewSendRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { requireDashboardUser, type AuthPrincipal } from "./auth.ts";
import { middleOfWork, readPeopleWork } from "./chatter-shifts.ts";
import { BadRequestError } from "./errors.ts";
import { autoOpenings, pagesWithAllFans, piecesOf, shiftChatsOf, shiftNeedsColleagues, shiftPageLabels, shiftRuleDataOf } from "./shift-review.ts";

/**
 * Chat Memory week 5 (docs/plans/2026-10-24-chat-memory/week-5.md §1): the
 * eight numbers of each chatter's shifts and week (`teamChatterNumbers`).
 *
 * A shift is services/chatter-shifts.ts's, of the window when the day it belongs
 * to is. Its messages, replies, their median and the fans left without an
 * answer at its end are «Разбор смены»'s, to the one: the review's reads of the
 * shift (its pages, the pages whose every fan it answers for, `shiftChatsOf`)
 * counted by the review's rules (`shiftReviewWaits`, `shiftReviewCounts` in
 * packages/contracts). Only messages with the chatter as their author are the
 * chatter's — a message without an author is nobody's; revenue only from the
 * confirmed shift report (week 4), and for a team lead only its lines on the
 * lead's pages. The same for Fansly and OnlyFans. A guide, not a basis for pay.
 * Database only.
 */

const DAY_MS = 86_400_000;
const HOUR_SECONDS = 3600;
/** Shifts read at once, one query at a time each: the API's pool holds ten connections for every request. */
const SHIFT_READS_AT_ONCE = 6;

export interface ShiftNumbersRow {
  /** The chatter's personal messages of the shift the fans could see. */
  messages: number;
  /** The chatter's mass messages of the shift: in the shares of PPV and of how the messages were written, not in `messages`. */
  massMessages: number;
  ppvSent: number;
  ppvBought: number;
  /** The archive's price of each bought PPV, mills. */
  boughtPrices: number[];
  writtenFans: string[];
  paidFans: string[];
  /** How long the fan had waited for each of the chatter's replies (from the shift's start at most), seconds. */
  replyDelays: number[];
  /** How the chatter's messages of the shift, mass ones too, were written: the extension's word on each. */
  composed: { hand: number; reply: number; fix: number; other: number };
  /** The chatter's fans who wrote in the shift (or began waiting in it) and got no answer before its end. */
  waitingAtEnd: number;
}

interface ShiftInput {
  workedMinutes: number;
  revenueMills: number | null;
  row: ShiftNumbersRow;
}

/**
 * The numbers of a shift from the review's reads of it, by the review's rules: the same chats, waits and counts as
 * «Разбор смены» shows, and how each of the chatter's messages was written. `end` — the shift's end, now for one going
 * on. Pure.
 */
export function shiftNumbersOf(input: {
  rows: readonly ShiftReviewMessageRow[];
  sends: readonly ShiftReviewSendRow[];
  fans: ShiftFansRow;
  userId: number;
  username: string;
  labelOf: ReadonlyMap<number, string>;
  openings: readonly string[];
  start: number;
  end: number;
}): ShiftNumbersRow {
  const { start, end } = input;
  const chats = shiftChatsOf({ rows: input.rows, sends: input.sends, userId: input.userId, username: input.username, openings: input.openings, start, end });
  const data = shiftRuleDataOf(chats, input.labelOf, start, end);
  const counts = shiftReviewCounts(data, shiftReviewWaits(data));
  const composedWith = new Map(input.sends.map((send) => [`${send.pageId}:${send.ref}`, send.composedWith]));
  const composed = { hand: 0, reply: 0, fix: 0, other: 0 };
  chats.forEach((chat, index) => data.chats[index]!.messages.forEach((message, at) => {
    if (!shiftReviewMine(message)) return;
    const shown = chat.shown[at]!;
    const how = composedWith.get(`${shown.pageId}:${shown.ref}`);
    if (how === "hand" || how === "reply" || how === "fix") composed[how] += 1;
    else composed.other += 1;
  }));
  return {
    messages: counts.messages,
    massMessages: counts.massMessages,
    ppvSent: counts.ppvSent,
    ppvBought: counts.ppvBought,
    boughtPrices: counts.boughtPrices,
    writtenFans: input.fans.writtenFans,
    paidFans: input.fans.paidFans,
    replyDelays: counts.replyDelays,
    composed,
    waitingAtEnd: counts.unanswered,
  };
}

/**
 * The numbers of one shift, read as «Разбор смены» reads it: the chats of its pages it wrote in, and every fan's of
 * `allFansPageIds` (`pagesWithAllFans`), from the wait horizon before `start` to `end`.
 */
export async function readShiftNumbers(
  app: AppContext,
  input: {
    userId: number; username: string; pages: ReadonlyArray<{ id: number; label: string }>; allFansPageIds: readonly number[];
    start: number; end: number; openings: readonly string[];
  },
): Promise<ShiftNumbersRow> {
  const { userId, start, end } = input;
  const pageIds = input.pages.map((page) => page.id);
  const from = new Date(start);
  const to = new Date(end + 1);
  // One query after another: the shifts are read side by side instead.
  const rows = await listShiftReviewMessages(app.db, {
    userId, pageIds, workedPageIds: input.allFansPageIds, from, to, horizonHours: SHIFT_REVIEW_WAIT_HORIZON_HOURS, burstMinChats: MASS_SEND_MIN_CHATS,
    deletedUnseenSeconds: SHIFT_REVIEW_DELETED_UNSEEN_SECONDS, broadcastOwnWords: SHIFT_REVIEW_BROADCAST_OWN_WORDS, texts: "authorless",
  });
  const sends = await listShiftReviewSends(app.db, { userId, pageIds, from, to });
  const fans = await readShiftFans(app.db, { userId, pageIds, from, to, deletedUnseenSeconds: SHIFT_REVIEW_DELETED_UNSEEN_SECONDS });
  const labelOf = new Map(input.pages.map((page) => [page.id, page.label]));
  return shiftNumbersOf({ rows, sends, fans, userId, username: input.username, labelOf, openings: input.openings, start, end });
}

function averagePrice(prices: readonly number[]): number | null {
  if (prices.length === 0) return null;
  const total = prices.reduce((sum, price) => sum + BigInt(price), 0n);
  return Number(total / BigInt(prices.length));
}

/**
 * Each shift's confirmed report and the revenue it shows: the report is the one
 * that started with the shift, else one it lies in (a report older than the
 * shift's present bounds), and it credits the first of its shifts only — the
 * rest are confirmed with no revenue of their own. Pure.
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

/**
 * The numbers of one or more shifts together: a fan written to in several counts once; `waitingAtEnd` of several is
 * their average; the median reply is the review's, to the second. Pure.
 */
export function numbersOf(shifts: readonly ShiftInput[]): ChatterNumbers {
  const rows = shifts.map((shift) => shift.row);
  const sum = (pick: (row: ShiftNumbersRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const confirmed = shifts.filter((shift) => shift.revenueMills !== null);
  const revenue = confirmed.length === 0 ? null : confirmed.reduce((total, shift) => total + shift.revenueMills!, 0);
  const confirmedMinutes = confirmed.reduce((total, shift) => total + shift.workedMinutes, 0);
  const allMessages = sum((row) => row.messages + row.massMessages);
  const ppvSent = sum((row) => row.ppvSent);
  const delays = rows.flatMap((row) => row.replyDelays);
  const middle = shiftReviewMedian(delays);
  return {
    workedMinutes: shifts.reduce((total, shift) => total + shift.workedMinutes, 0),
    revenueMills: revenue,
    revenuePerHourMills: revenue === null || confirmedMinutes === 0 ? null : Number((BigInt(revenue) * 60n) / BigInt(confirmedMinutes)),
    fansWritten: new Set(rows.flatMap((row) => row.writtenFans)).size,
    fansPaid: new Set(rows.flatMap((row) => row.paidFans)).size,
    messages: sum((row) => row.messages),
    ppvSent,
    ppvBought: sum((row) => row.ppvBought),
    ppvAveragePriceMills: averagePrice(rows.flatMap((row) => row.boughtPrices)),
    ppvShare: allMessages === 0 ? null : ppvSent / allMessages,
    replies: delays.length,
    replyMedianSeconds: middle === null ? null : Math.round(middle),
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

/** `run` over `items`, at most `limit` at once; the results in the items' order. */
async function eachAtMost<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function readTeamChatterNumbers(
  app: AppContext,
  principal: AuthPrincipal,
  input: { from?: string | undefined; to?: string | undefined; userId?: number | undefined; pageScope: readonly number[] | undefined },
): Promise<TeamChatterNumbersResponse> {
  requireDashboardUser(principal);
  const now = new Date();
  const to = input.to === undefined ? now : new Date(input.to);
  const from = input.from === undefined ? new Date(to.getTime() - 7 * DAY_MS) : new Date(input.from);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw new BadRequestError("`from` must be before `to`");
  if (to.getTime() - from.getTime() > CHATTER_NUMBERS_MAX_DAYS * DAY_MS) {
    throw new BadRequestError(`The window is at most ${CHATTER_NUMBERS_MAX_DAYS} days`);
  }

  // A day more on each side, so the shifts of the window are whole.
  const around = { from: new Date(from.getTime() - DAY_MS), to: new Date(Math.min(to.getTime() + DAY_MS, now.getTime())), now };
  const scope = input.pageScope ?? "all";
  // Whether a page with fewer of the person's messages shows all its fans is a question of the colleagues' shifts on every
  // page (`pagesWithAllFans`), so everyone's work, read beside the people asked when it is not theirs already.
  const whole = scope === "all" && input.userId === undefined;
  const [people, others] = await Promise.all([
    readPeopleWork(app.db, { ...around, pages: scope, ...(input.userId === undefined ? {} : { userId: input.userId }) }),
    whole ? null : readPeopleWork(app.db, { ...around, pages: "all" }),
  ]);
  const jobs = [...people].flatMap(([userId, person]) => person.work
    .filter((shift) => shift.kind === "shift" && middleOfWork(shift) >= from.getTime() && middleOfWork(shift) < to.getTime())
    .map((shift) => ({ userId, username: person.username, shift })));
  if (jobs.length === 0) return { from: from.toISOString(), to: to.toISOString(), chatters: [], serverNow: now.toISOString() };

  // As the review reads a shift: its pages, the automated texts, the colleagues' shifts.
  const chatterIds = [...new Set(jobs.map((job) => job.userId))];
  const [known, autoTexts, reports] = await Promise.all([
    listPagesByLabels(app.db, [...new Set(jobs.flatMap(({ shift }) => shiftPageLabels(shift)))]),
    listAllAutomatedTexts(app.db),
    Promise.all(chatterIds.map((userId) => listConfirmedShiftCredits(app.db, { userId, since: new Date(from.getTime() - DAY_MS), pageIds: scope }))),
  ]);
  const shiftsOfAll = jobs.some(({ shift }) => shiftNeedsColleagues(shift)) ? piecesOf(others ?? people, "shift") : [];
  const openings = autoOpenings(autoTexts);
  const rows = await eachAtMost(jobs, SHIFT_READS_AT_ONCE, ({ userId, username, shift }) => {
    const end = shift.ongoing ? now.getTime() : shift.endedAt;
    const pages = shiftPageLabels(shift).flatMap((label) => known.filter((page) => page.label === label));
    const allFans = pagesWithAllFans(shift, shiftsOfAll.filter((one) => one.userId !== userId), shift.startedAt, end);
    return readShiftNumbers(app, {
      userId, username, pages, allFansPageIds: pages.filter((page) => allFans.has(page.label)).map((page) => page.id), start: shift.startedAt, end, openings,
    });
  });

  const chatters: TeamChatterNumbersResponse["chatters"] = chatterIds.map((userId, chatter) => {
    const mine = jobs.flatMap((job, index) => (job.userId === userId ? [{ shift: job.shift, row: rows[index]! }] : []));
    const revenue = revenueOfShifts(mine.map((one) => one.shift), reports[chatter]!);
    const computed = mine.map((one, index) => ({ ...one, workedMinutes: one.shift.workedMinutes, ...revenue[index]! }));
    return {
      userId,
      username: people.get(userId)!.username,
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
    };
  });
  chatters.sort((a, b) => a.username.localeCompare(b.username));
  return { from: from.toISOString(), to: to.toISOString(), chatters, serverNow: now.toISOString() };
}
