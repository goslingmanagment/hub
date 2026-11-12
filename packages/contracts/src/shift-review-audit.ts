import type { ChatterSaleKind } from "./chatter-stats.ts";
import type { TeamShiftReviewResponse } from "./routes-shift-review.ts";
import {
  shiftReviewFansMessage,
  shiftReviewMedian,
  shiftReviewMine,
  shiftReviewSeen,
  shiftReviewWaits,
} from "./shift-review-rules.ts";

/**
 * The «Обучалка» shift audit's numbers (`shift_audit.py collect`, /OS), counted
 * from «Разбор смены» — the one computation the owner's screen and the agents'
 * door (`agentShiftReview`) both read — instead of a second reading of the
 * database in Python. Pure.
 *
 * Each number keeps the audit's meaning; where Hub's own rule differs (whose a
 * message is, what a wait is), Hub's holds and the difference is the audit's
 * to adopt: a page message is the chatter's by its author (`by: "me"`) on every
 * page, a message deleted before the fan could see it counts for nothing, and
 * a mass message is the one of «Смены». A page's own facts — its new
 * followers and its money within the shift — count on the pages the shift
 * worked (`shift.pages[].worked`: its sales are the shift's), as the audit
 * counts them on the chatter's own pages; a page only looked at brings in
 * none.
 */

/** A reply this slow counts in `repliesOver15` (the audit's WAIT_MIN). */
export const SHIFT_AUDIT_SLOW_REPLY_SECONDS = 15 * 60;
/** A new follower written to within this counts in `followsWrittenSoon` (the audit's «w30»). */
export const SHIFT_AUDIT_FOLLOW_SOON_SECONDS = 30 * 60;
/** A personal message within this before the follow counts as written after it (the audit's 60 s). */
export const SHIFT_AUDIT_FOLLOW_SLACK_SECONDS = 60;
/** A fan quiet this long (no message, no follow) whom the chatter wrote to first was reactivated (the audit's 72 h). */
export const SHIFT_AUDIT_SILENT_HOURS = 72;

export interface ShiftAuditNumbers {
  /** Chats the chatter sent a personal message in (the audit's `chats`). */
  chats: number;
  /** The chatter's personal messages the fans could see (`out`). */
  messages: number;
  /** Fans' messages within the shift in the review's chats (`fan`). */
  fanMessages: number;
  /** The chatter's mass messages (Hub's rule: «Смены»). */
  massMessages: number;
  /** Personal page messages in the shift with no author (`unauthored`). */
  unauthored: number;
  /** Personal page messages of colleagues in the shift, by name, most first (`others`). */
  others: Array<{ name: string; messages: number }>;
  /** The chatter's priced messages, and of them bought (`ppv_sent`; Hub's `ppvBought` is the chatter's, not the page's). */
  ppvSent: number;
  ppvBought: number;
  /** Personal messages that answered a waiting fan, the median wait, how many waited over 15 minutes, the longest (`replies`, `median`, `over15`, `longest`). */
  replies: number;
  replyMedianSeconds: number | null;
  repliesOver15: number;
  longestReplySeconds: number | null;
  /** The chat of the longest reply (`longest_fan`). */
  longestReplyChat: string | null;
  /** Chats whose fan waited at the shift's start, and of them the ones the chatter wrote in (`wait_start`, `ans_start`). */
  waitingAtStart: number;
  waitingAtStartWritten: number;
  /** Chats whose fan was still waiting at the shift's end (`wait_end`). */
  waitingAtEnd: number;
  /** Fans' messages within the shift in chats the chatter sent nothing personal in (`fan_unattended`). */
  fanUnattended: number;
  /** New followers within the shift, of them written to personally by the chatter, and within 30 minutes (`follows`, `wrote`, `w30`). */
  follows: number;
  followsWritten: number;
  followsWrittenSoon: number;
  /** Fans quiet 72 hours whom the chatter wrote to first, and of them who answered within the shift (`react`, `react_ans`). */
  reactivations: number;
  reactivationsAnswered: number;
  /** Every sale on the page(s) within the shift, net, whoever's (`sales`), and of it tips, subscriptions and PPV purchases (`tips`, `subs_money`, the page's PPV count). */
  salesNetMills: number;
  tipsNetMills: number;
  subscriptionsNetMills: number;
  ppvPurchases: number;
  /** The chatter's AI events by feature (`ai`). */
  ai: Record<string, number>;
}

export interface ShiftAuditReport {
  /** By page, in the order of `shift.pages`. */
  pages: Array<{ pageLabel: string } & ShiftAuditNumbers>;
  total: ShiftAuditNumbers;
}

type Review = Pick<TeamShiftReviewResponse, "shift" | "chats" | "waits" | "follows" | "aiUse">;
type Message = TeamShiftReviewResponse["chats"][number]["messages"][number];

function empty(): ShiftAuditNumbers {
  return {
    chats: 0, messages: 0, fanMessages: 0, massMessages: 0, unauthored: 0, others: [], ppvSent: 0, ppvBought: 0,
    replies: 0, replyMedianSeconds: null, repliesOver15: 0, longestReplySeconds: null, longestReplyChat: null,
    waitingAtStart: 0, waitingAtStartWritten: 0, waitingAtEnd: 0, fanUnattended: 0,
    follows: 0, followsWritten: 0, followsWrittenSoon: 0, reactivations: 0, reactivationsAnswered: 0,
    salesNetMills: 0, tipsNetMills: 0, subscriptionsNetMills: 0, ppvPurchases: 0, ai: {},
  };
}

/** A page message that answers a fan: not a mass or an automated one, seen. */
function personal(message: Message): boolean {
  return message.side === "page" && !message.mass && message.by !== "auto" && shiftReviewSeen(message);
}

/** The chatter's personal message of the shift. */
function minePersonal(message: Message): boolean {
  return shiftReviewMine(message) && !message.mass;
}

function addOthers(into: Array<{ name: string; messages: number }>, name: string, messages: number) {
  const known = into.find((one) => one.name === name);
  if (known) known.messages += messages;
  else into.push({ name, messages });
}

/** The shift audit's numbers of one shift, by page and in total. Pure. */
export function shiftAuditNumbers(review: Review): ShiftAuditReport {
  const start = Date.parse(review.shift.startedAt);
  const end = Date.parse(review.shift.endedAt);
  const labels = review.shift.pages.map((page) => page.pageLabel);
  const byPage = new Map<string, ShiftAuditNumbers>(labels.map((label) => [label, empty()]));
  const of = (label: string) => {
    let numbers = byPage.get(label);
    if (numbers === undefined) {
      numbers = empty();
      byPage.set(label, numbers);
    }
    return numbers;
  };
  const delays = new Map<string, number[]>();
  const chatPage = new Map(review.chats.map((chat) => [chat.key, chat.pageLabel]));
  const minesOf = new Map<string, number[]>();

  for (const chat of review.chats) {
    const page = of(chat.pageLabel);
    const inShift = chat.messages.filter((message) => message.inShift);
    const mine = inShift.filter(minePersonal);
    minesOf.set(chat.key, mine.map((message) => Date.parse(message.at)));
    const fans = inShift.filter((message) => shiftReviewFansMessage(message));
    page.fanMessages += fans.length;
    page.messages += mine.length;
    if (mine.length > 0) page.chats += 1;
    else page.fanUnattended += fans.length;
    for (const message of inShift) {
      if (shiftReviewMine(message)) {
        if (message.mass) page.massMessages += 1;
        if (message.priceMills !== null) page.ppvSent += 1;
        if (message.bought === true) page.ppvBought += 1;
      }
      if (!personal(message)) continue;
      if (message.by === "none") page.unauthored += 1;
      if (message.by === "other") addOthers(page.others, message.byName ?? "коллега", 1);
    }
    for (const message of mine) {
      const seconds = message.mine?.replySeconds ?? null;
      if (seconds === null) continue;
      delays.set(chat.pageLabel, [...(delays.get(chat.pageLabel) ?? []), seconds]);
      if (seconds > SHIFT_AUDIT_SLOW_REPLY_SECONDS) page.repliesOver15 += 1;
      if (page.longestReplySeconds === null || seconds > page.longestReplySeconds) {
        page.longestReplySeconds = seconds;
        page.longestReplyChat = chat.key;
      }
    }
    // Reactivation: the chat's first fan or personal message of the shift is the chatter's, to a fan quiet 72 hours.
    const first = inShift.find((message) => shiftReviewFansMessage(message) || personal(message));
    if (first !== undefined && first.by === "me" && minePersonal(first)) {
      const at = Date.parse(first.at);
      const followed = chat.followedAt ? Date.parse(chat.followedAt) : 0;
      const activity = Math.max(chat.fanLastBefore ? Date.parse(chat.fanLastBefore) : 0, followed);
      const silent = activity === 0 || at - activity >= SHIFT_AUDIT_SILENT_HOURS * 3_600_000;
      if (silent && !(followed !== 0 && followed >= start)) {
        page.reactivations += 1;
        if (fans.some((message) => Date.parse(message.at) > at)) page.reactivationsAnswered += 1;
      }
    }
  }

  const waits = shiftReviewWaits({ shift: review.shift, chats: review.chats, waits: review.waits });
  const atStart = new Set<string>();
  const atEnd = new Set<string>();
  for (const wait of waits) {
    if (wait.since < start) atStart.add(wait.chat);
    if (wait.by === null) atEnd.add(wait.chat);
  }
  for (const key of atStart) {
    const page = of(chatPage.get(key) ?? "");
    page.waitingAtStart += 1;
    if ((minesOf.get(key) ?? []).length > 0) page.waitingAtStartWritten += 1;
  }
  for (const key of atEnd) of(chatPage.get(key) ?? "").waitingAtEnd += 1;

  const worked = new Set(review.shift.pages.filter((page) => page.worked).map((page) => page.pageLabel));
  for (const follow of review.follows ?? []) {
    const at = Date.parse(follow.at);
    if (at < start || at > end || !worked.has(follow.pageLabel)) continue;
    const page = of(follow.pageLabel);
    page.follows += 1;
    const written = (follow.chatKey === null ? [] : minesOf.get(follow.chatKey) ?? [])
      .filter((one) => one >= at - SHIFT_AUDIT_FOLLOW_SLACK_SECONDS * 1000);
    if (written.length > 0) {
      page.followsWritten += 1;
      if (Math.min(...written) - at <= SHIFT_AUDIT_FOLLOW_SOON_SECONDS * 1000) page.followsWrittenSoon += 1;
    }
  }

  for (const page of review.shift.pages) {
    const numbers = of(page.pageLabel);
    if (!page.worked) continue;
    const kinds = new Map<ChatterSaleKind, { count: number; netMills: number }>((page.sales?.byKind ?? []).map((one) => [one.kind, one]));
    numbers.salesNetMills = page.sales?.netMills ?? 0;
    numbers.tipsNetMills = kinds.get("tip")?.netMills ?? 0;
    numbers.subscriptionsNetMills = kinds.get("subscription")?.netMills ?? 0;
    numbers.ppvPurchases = kinds.get("ppv")?.count ?? 0;
  }
  for (const use of review.aiUse ?? []) {
    const numbers = of(use.pageLabel);
    numbers.ai[use.feature] = (numbers.ai[use.feature] ?? 0) + use.count;
  }

  for (const [label, numbers] of byPage) {
    const list = delays.get(label) ?? [];
    numbers.replies = list.length;
    numbers.replyMedianSeconds = shiftReviewMedian(list);
    numbers.others.sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name));
  }

  const total = empty();
  const allDelays = [...delays.values()].flat();
  for (const numbers of byPage.values()) {
    for (const key of [
      "chats", "messages", "fanMessages", "massMessages", "unauthored", "ppvSent", "ppvBought", "repliesOver15",
      "waitingAtStart", "waitingAtStartWritten", "waitingAtEnd", "fanUnattended", "follows", "followsWritten",
      "followsWrittenSoon", "reactivations", "reactivationsAnswered", "salesNetMills", "tipsNetMills",
      "subscriptionsNetMills", "ppvPurchases",
    ] as const) {
      total[key] += numbers[key];
    }
    for (const other of numbers.others) addOthers(total.others, other.name, other.messages);
    for (const [feature, count] of Object.entries(numbers.ai)) total.ai[feature] = (total.ai[feature] ?? 0) + count;
    if (numbers.longestReplySeconds !== null && (total.longestReplySeconds === null || numbers.longestReplySeconds > total.longestReplySeconds)) {
      total.longestReplySeconds = numbers.longestReplySeconds;
      total.longestReplyChat = numbers.longestReplyChat;
    }
  }
  total.replies = allDelays.length;
  total.replyMedianSeconds = shiftReviewMedian(allDelays);
  total.others.sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name));
  return {
    pages: [...byPage].filter(([label]) => label !== "").map(([pageLabel, numbers]) => ({ pageLabel, ...numbers })),
    total,
  };
}
