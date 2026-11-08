import { SHIFT_REVIEW_DELETED_UNSEEN_SECONDS, type ShiftReviewMessage, type ShiftReviewMine, type TeamShiftReviewResponse } from "./routes-shift-review.ts";

/**
 * The one definition of a shift's quality numbers: «Разбор смены» counts them
 * on its screen (apps/dashboard …/review/shiftReviewView.ts) and «Смены»
 * (`teamChatterNumbers`) on the server, both from the same facts — the
 * chatter's messages, the replies and their median, the fans left without an
 * answer at the end. Pure; over the facts `teamShiftReview` sends, or the same
 * facts the server builds for «Смены» (`ShiftReviewRuleData`).
 *
 * Whose a wait is (2026-11-07): a page can be worked by two people at once, or
 * handed over within a shift. A fan's wait is the reviewed chatter's when the
 * chatter answered it or wrote last before it began. It is a colleague's when
 * the colleague wrote last before it, within the shift or in the
 * SHIFT_REVIEW_REPLY_NORM_SECONDS before it, and was still writing on that page
 * when it ended; or when a colleague answered it who was writing on that page
 * as it began. «Writing on that page» counts the colleague's messages before
 * the shift too: a fan waiting from the last shift, answered by a colleague who
 * sat on the page as this one began, is not the chatter's. Anything else on the
 * chatter's watch is theirs.
 *
 * A deleted message (owner, 2026-11-08) counts as sent once the other side
 * could see it — deleted SHIFT_REVIEW_DELETED_UNSEEN_SECONDS after it was sent
 * or later (`shiftReviewSeen`). One deleted sooner is only shown: a fan's starts
 * no wait, the chatter's answers none and is not among the shift's messages.
 */

/**
 * The reply norm is a band, not a line: the owner put it at «5-10 минут»
 * (2026-11-07); the job description says «до 10 минут». Past the upper end a
 * wait counts as long.
 */
export const SHIFT_REVIEW_REPLY_NORM_SECONDS = 10 * 60;
/** A fan quiet this long inside a wait, who then wrote again, came back. */
export const SHIFT_REVIEW_FAN_QUIET_SECONDS = 15 * 60;

/** What the rules read of a message: `teamShiftReview`'s, or the same facts the server builds for «Смены». */
export type ShiftReviewRuleMessage = Pick<ShiftReviewMessage, "at" | "side" | "by" | "byName" | "mass" | "inShift" | "deletedAt" | "priceMills" | "bought"> & {
  mine: Pick<ShiftReviewMine, "replySeconds"> | null;
};

export interface ShiftReviewRuleChat {
  key: string;
  pageLabel: string;
  messages: readonly ShiftReviewRuleMessage[];
}

export interface ShiftReviewRuleData {
  shift: Pick<TeamShiftReviewResponse["shift"], "startedAt" | "endedAt">;
  chats: readonly ShiftReviewRuleChat[];
  waits: TeamShiftReviewResponse["waits"];
}

/** The other side could see the message: not deleted, or deleted SHIFT_REVIEW_DELETED_UNSEEN_SECONDS after it was sent or later. */
export function shiftReviewSeen(message: Pick<ShiftReviewMessage, "at" | "deletedAt">): boolean {
  return message.deletedAt === undefined || Date.parse(message.deletedAt) - Date.parse(message.at) >= SHIFT_REVIEW_DELETED_UNSEEN_SECONDS * 1000;
}

/** The chatter's message of the shift that the fan could see, a mass one too. */
export function shiftReviewMine(message: Pick<ShiftReviewRuleMessage, "at" | "deletedAt" | "mine">): boolean {
  return message.mine !== null && shiftReviewSeen(message);
}

/** A page message that answers a fan: not a mass message, not an automated one, not deleted before the fan saw it. */
function answersFan(message: Pick<ShiftReviewRuleMessage, "at" | "side" | "mass" | "by" | "deletedAt">): boolean {
  return message.side === "page" && !message.mass && message.by !== "auto" && shiftReviewSeen(message);
}

/** A fan's message the chatter could see. */
export function shiftReviewFansMessage(message: Pick<ShiftReviewRuleMessage, "at" | "side" | "deletedAt">): boolean {
  return message.side === "fan" && shiftReviewSeen(message);
}

export function shiftReviewMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export interface ShiftReviewWait {
  chat: string;
  /** When the fan began waiting, ms; `from` — the same, cut to the shift's start. */
  since: number;
  from: number;
  to: number;
  by: "me" | "other" | "none" | null;
  /** The colleague who ended it. */
  byName: string | null;
  /** The colleague whose wait it is: who wrote last before it, in the shift or just before it, and was still writing on the page at its end. */
  heldBy: string | null;
  /** The fan began waiting before the shift. */
  inherited: boolean;
  /** The fan wrote within the shift while waiting. */
  fanWrote: boolean;
  /**
   * The fan came back: their first message in the counted part of the wait (from the shift's start for a wait from
   * before it) that broke a silence of SHIFT_REVIEW_FAN_QUIET_SECONDS, when, and how long they had been quiet, seconds.
   */
  fanBack: { at: number; quietSeconds: number } | null;
  /** How long, seconds: a wait from before the shift counts from its start (the approved definition). */
  seconds: number;
  /** The reviewed chatter's (see the file's head). */
  his: boolean;
}

/** The shift's waits, each with whose it is (see the file's head). */
export function shiftReviewWaits(data: ShiftReviewRuleData): ShiftReviewWait[] {
  const start = Date.parse(data.shift.startedAt);
  const norm = SHIFT_REVIEW_REPLY_NORM_SECONDS * 1000;
  const chats = new Map(data.chats.map((chat) => [chat.key, chat]));
  // When each colleague wrote on each page: within the shift, and in the messages shown before it.
  const colleagueAt = new Map<string, number[]>();
  for (const chat of data.chats) {
    for (const message of chat.messages) {
      if (message.by !== "other" || message.mass) continue;
      const key = `${chat.pageLabel}|${message.byName ?? ""}`;
      colleagueAt.set(key, [...(colleagueAt.get(key) ?? []), Date.parse(message.at)]);
    }
  }
  const writingOn = (page: string, name: string | null, at: number) => (colleagueAt.get(`${page}|${name ?? ""}`) ?? [])
    .some((one) => one <= at && one >= at - norm);
  return data.waits.map((wait) => {
    const since = Date.parse(wait.since);
    const from = Date.parse(wait.from);
    const to = Date.parse(wait.to);
    const chat = chats.get(wait.chat);
    const page = chat?.pageLabel ?? "";
    const timed = (chat?.messages ?? []).map((message) => ({ message, at: Date.parse(message.at) }));
    const before = timed.filter((one) => answersFan(one.message) && one.at < since).at(-1);
    const heldByMe = before?.message.by === "me";
    const holder = before && before.at >= start - norm && before.message.by === "other" ? before.message.byName : undefined;
    const heldBy = holder !== undefined && (wait.by === "other" || writingOn(page, holder, to)) ? holder ?? "коллега" : null;
    const answer = wait.by === "other" ? timed.find((one) => one.at === to && one.message.by === "other") : undefined;
    const answeredOnTheirWatch = answer !== undefined && writingOn(page, answer.message.byName, from);
    const fanAts = timed.filter((one) => shiftReviewFansMessage(one.message) && one.at >= since && one.at <= to).map((one) => one.at);
    return {
      chat: wait.chat,
      since,
      from,
      to,
      by: wait.by,
      byName: answer?.message.byName ?? null,
      heldBy,
      inherited: since < start,
      fanWrote: timed.some((one) => shiftReviewFansMessage(one.message) && one.message.inShift && one.at >= since && one.at <= to),
      fanBack: fanBackOf(fanAts, Math.max(since, start)),
      seconds: (to - Math.max(since, start)) / 1000,
      his: wait.by === "me" || heldByMe || (heldBy === null && !answeredOnTheirWatch),
    };
  });
}

/**
 * The fan's first message from `counted` on that broke a silence of
 * SHIFT_REVIEW_FAN_QUIET_SECONDS. The first, not the longest silence's or the
 * last: a fan who came back, got nothing and wrote again an hour later waited
 * that hour, and the line must not say otherwise.
 */
function fanBackOf(fanAts: readonly number[], counted: number): ShiftReviewWait["fanBack"] {
  const index = fanAts.findIndex((one, at) => at > 0 && one >= counted && one - fanAts[at - 1]! >= SHIFT_REVIEW_FAN_QUIET_SECONDS * 1000);
  return index < 0 ? null : { at: fanAts[index]!, quietSeconds: (fanAts[index]! - fanAts[index - 1]!) / 1000 };
}

/** A wait the chatter left without an answer at the end: the fan wrote in the shift, or began waiting in it. */
export function shiftReviewUnanswered(wait: ShiftReviewWait): boolean {
  return wait.his && wait.by === null && (!wait.inherited || wait.fanWrote);
}

/** A fan waiting since before the shift who did not write in it, and got no answer in it. */
export function shiftReviewWaitingSilently(wait: ShiftReviewWait): boolean {
  return wait.his && wait.by === null && wait.inherited && !wait.fanWrote;
}

export interface ShiftReviewCounts {
  /** The chatter's personal messages of the shift the fans could see: «Сообщения». */
  messages: number;
  /** The chatter's mass messages of the shift. */
  massMessages: number;
  /** How long the fan had waited for each personal message that answered one, seconds: the replies. */
  replyDelays: number[];
  /** The chatter's fans who wrote in the shift (or began waiting in it) and got no answer before its end: «Без ответа к концу смены». */
  unanswered: number;
  /** Fans waiting since before the shift who did not write in it and got no answer in it. */
  waitingSilently: number;
  /** Of all the chatter's messages, the priced ones, the bought ones, and the prices of those, mills. */
  ppvSent: number;
  ppvBought: number;
  boughtPrices: number[];
}

/** The shift's numbers, as «Разбор смены» shows them and «Смены» counts them. */
export function shiftReviewCounts(data: Pick<ShiftReviewRuleData, "chats">, waits: readonly ShiftReviewWait[]): ShiftReviewCounts {
  const mine = data.chats.flatMap((chat) => chat.messages.filter(shiftReviewMine));
  const personal = mine.filter((message) => !message.mass);
  const bought = mine.filter((message) => message.bought === true);
  return {
    messages: personal.length,
    massMessages: mine.length - personal.length,
    replyDelays: personal.flatMap((message) => (message.mine!.replySeconds === null ? [] : [message.mine!.replySeconds])),
    unanswered: waits.filter(shiftReviewUnanswered).length,
    waitingSilently: waits.filter(shiftReviewWaitingSilently).length,
    ppvSent: mine.filter((message) => message.priceMills !== null).length,
    ppvBought: bought.length,
    boughtPrices: bought.flatMap((message) => (message.priceMills === null ? [] : [message.priceMills])),
  };
}
