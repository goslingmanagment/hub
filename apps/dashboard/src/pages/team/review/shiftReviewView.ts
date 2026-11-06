import type { ShiftReviewChat, ShiftReviewMessage, TeamShiftReviewResponse } from "@agency_hub_core/contracts";

/**
 * Команда → «Разбор смены»: what the screen derives from `teamShiftReview` —
 * the shift minute by minute for the pulse, the totals, and what each chat
 * shows in the list. Pure; the server sends facts, this file counts them.
 */

const MINUTE_MS = 60_000;
/** The pace is the messages of the last this many minutes. */
export const PACE_WINDOW_MINUTES = 10;
/** The reply time is the median of the replies of the last this many minutes. */
export const REPLY_WINDOW_MINUTES = 30;
/** The norm of the job description: «Ответ в активном диалоге — до 10 минут». */
export const REPLY_NORM_SECONDS = 10 * 60;
/** A click on the pulse picks this many minutes on each side. */
export const PICK_MINUTES = 10;
/** A silence this long inside a chat gets a line of its own in the transcript. */
export const GAP_MINUTES = 15;

export type ActivityState = "input" | "open" | "closed";

export interface PulseMinute {
  /** The start of the minute, ms. */
  at: number;
  /** The chatter's personal messages in this minute. */
  sent: number;
  /** In the last PACE_WINDOW_MINUTES. */
  pace: number;
  /** The median reply of the last REPLY_WINDOW_MINUTES, minutes; null — no reply then. */
  replyMedian: number | null;
  /** Replies in that window. */
  replies: number;
  /** Fans waiting at this minute who got an answer later in the shift: the queue the chatter worked through. */
  waiting: number;
  /** Fans who wrote within the shift and got no answer before its end. */
  waitingOpen: number;
  /** Of both, waiting longer than the norm by now. */
  waitingLong: number;
  /** Fans waiting since before the shift who got no answer in it. */
  waitingInherited: number;
  /** The fans' messages in this minute. */
  fanMessages: number;
  activity: ActivityState;
}

export interface MyMessage {
  chat: ShiftReviewChat;
  message: ShiftReviewMessage & { mine: NonNullable<ShiftReviewMessage["mine"]> };
  at: number;
}

export function myMessages(data: TeamShiftReviewResponse): MyMessage[] {
  const out: MyMessage[] = [];
  for (const chat of data.chats) {
    for (const message of chat.messages) {
      if (message.mine !== null) out.push({ chat, message: message as MyMessage["message"], at: Date.parse(message.at) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The shift minute by minute, from its first minute to its last. */
export function pulseOf(data: TeamShiftReviewResponse): PulseMinute[] {
  const start = Math.floor(Date.parse(data.shift.startedAt) / MINUTE_MS) * MINUTE_MS;
  const end = Date.parse(data.shift.endedAt);
  const count = Math.max(1, Math.ceil((end - start) / MINUTE_MS));
  const index = (at: number) => Math.min(count - 1, Math.max(0, Math.floor((at - start) / MINUTE_MS)));

  const sent = new Array<number>(count).fill(0);
  const fans = new Array<number>(count).fill(0);
  const replyAt: Array<number[]> = Array.from({ length: count }, () => []);
  for (const chat of data.chats) {
    for (const message of chat.messages) {
      if (!message.inShift) continue;
      const at = Date.parse(message.at);
      if (message.side === "fan") fans[index(at)]! += 1;
      if (message.mine === null || message.mass) continue;
      sent[index(at)]! += 1;
      if (message.mine.replySeconds !== null) replyAt[index(at)]!.push(message.mine.replySeconds);
    }
  }

  const activity = new Map(data.activity.map((minute) => [Date.parse(minute.at), minute.input]));
  const shiftStart = Date.parse(data.shift.startedAt);
  const waits = data.waits.map((wait) => ({
    since: Date.parse(wait.since), from: Date.parse(wait.from), to: Date.parse(wait.to),
    kind: wait.by !== null ? "answered" as const : Date.parse(wait.since) < shiftStart ? "inherited" as const : "open" as const,
  }));

  const out: PulseMinute[] = [];
  let pace = 0;
  for (let minute = 0; minute < count; minute += 1) {
    const at = start + minute * MINUTE_MS;
    pace += sent[minute]!;
    if (minute >= PACE_WINDOW_MINUTES) pace -= sent[minute - PACE_WINDOW_MINUTES]!;
    const recent = replyAt.slice(Math.max(0, minute - REPLY_WINDOW_MINUTES + 1), minute + 1).flat();
    const middle = median(recent);
    let waiting = 0;
    let waitingOpen = 0;
    let waitingLong = 0;
    let waitingInherited = 0;
    const probe = at + MINUTE_MS / 2;
    for (const wait of waits) {
      if (wait.from > probe || wait.to <= probe) continue;
      if (wait.kind === "inherited") {
        waitingInherited += 1;
        continue;
      }
      if (wait.kind === "answered") waiting += 1;
      else waitingOpen += 1;
      if (probe - Math.max(wait.since, shiftStart) > REPLY_NORM_SECONDS * 1000) waitingLong += 1;
    }
    const input = activity.get(at);
    out.push({
      at,
      sent: sent[minute]!,
      pace,
      replyMedian: middle === null ? null : Math.round((middle / 60) * 10) / 10,
      replies: recent.length,
      waiting,
      waitingOpen,
      waitingLong,
      waitingInherited,
      fanMessages: fans[minute]!,
      activity: input === undefined ? "closed" : input ? "input" : "open",
    });
  }
  return out;
}

/** Stretches of the same activity, for the strip under the pace. */
export function activityRuns(pulse: readonly PulseMinute[]): Array<{ from: number; to: number; state: ActivityState }> {
  const runs: Array<{ from: number; to: number; state: ActivityState }> = [];
  for (const minute of pulse) {
    const last = runs.at(-1);
    if (last && last.state === minute.activity && last.to === minute.at) last.to = minute.at + MINUTE_MS;
    else runs.push({ from: minute.at, to: minute.at + MINUTE_MS, state: minute.activity });
  }
  return runs;
}

/** The longest stretches without one personal message, at least `minMinutes` long. */
export function silences(pulse: readonly PulseMinute[], minMinutes: number): Array<{ from: number; to: number; minutes: number }> {
  const out: Array<{ from: number; to: number; minutes: number }> = [];
  let since: number | null = null;
  for (const minute of pulse) {
    if (minute.sent === 0) {
      since ??= minute.at;
      continue;
    }
    if (since !== null && (minute.at - since) / MINUTE_MS >= minMinutes) out.push({ from: since, to: minute.at, minutes: Math.round((minute.at - since) / MINUTE_MS) });
    since = null;
  }
  const last = pulse.at(-1);
  if (since !== null && last && (last.at + MINUTE_MS - since) / MINUTE_MS >= minMinutes) {
    out.push({ from: since, to: last.at + MINUTE_MS, minutes: Math.round((last.at + MINUTE_MS - since) / MINUTE_MS) });
  }
  return out;
}

export interface ShiftTotals {
  messages: number;
  massMessages: number;
  chats: number;
  /** Chats where the fan wrote within the shift, and their messages. */
  fansWrote: number;
  fanMessages: number;
  replies: number;
  replyMedianSeconds: number | null;
  repliesWithinNorm: number;
  longestReplySeconds: number | null;
  /** Fans who wrote within the shift and got no answer before its end. */
  unanswered: number;
  /** Fans waiting since before the shift: how many, how many got an answer in it. */
  inherited: number;
  inheritedAnswered: number;
  origin: { ai: number; copied: number; fix: number; own: number; none: number };
  repeated: number;
  marked: number;
  ppvSent: number;
  ppvBought: number;
  shiftNetMills: number;
  perHour: number | null;
}

export function totalsOf(data: TeamShiftReviewResponse, mine: readonly MyMessage[]): ShiftTotals {
  const personal = mine.filter((one) => !one.message.mass);
  const delays = personal.flatMap((one) => (one.message.mine.replySeconds === null ? [] : [one.message.mine.replySeconds]));
  const shiftStart = Date.parse(data.shift.startedAt);
  const inherited = data.waits.filter((wait) => Date.parse(wait.since) < shiftStart);
  const origin = { ai: 0, copied: 0, fix: 0, own: 0, none: 0 };
  for (const one of mine) {
    const facts = one.message.mine;
    if (facts.origin === null) origin.none += 1;
    else origin[facts.origin] += 1;
    if (facts.origin === "ai" && !aiButton(facts.composedWith)) origin.copied += 1;
  }
  const fanMessages = data.chats.flatMap((chat) => chat.messages.filter((message) => message.inShift && message.side === "fan"));
  const minutes = data.shift.workedMinutes;
  return {
    messages: personal.length,
    massMessages: mine.length - personal.length,
    chats: new Set(mine.map((one) => one.chat.key)).size,
    fansWrote: data.chats.filter((chat) => chat.messages.some((message) => message.inShift && message.side === "fan")).length,
    fanMessages: fanMessages.length,
    replies: delays.length,
    replyMedianSeconds: median(delays),
    repliesWithinNorm: delays.filter((delay) => delay <= REPLY_NORM_SECONDS).length,
    longestReplySeconds: delays.length === 0 ? null : Math.max(...delays),
    unanswered: data.waits.filter((wait) => wait.by === null && Date.parse(wait.since) >= shiftStart).length,
    inherited: inherited.length,
    inheritedAnswered: inherited.filter((wait) => wait.by !== null).length,
    origin,
    repeated: mine.filter((one) => one.message.mine.repeats > 0).length,
    marked: mine.filter((one) => one.message.mine.marks.length > 0).length,
    ppvSent: mine.filter((one) => one.message.priceMills !== null).length,
    ppvBought: mine.filter((one) => one.message.bought === true).length,
    shiftNetMills: data.chats.reduce((sum, chat) => sum + chat.shiftNetMills, 0),
    perHour: minutes === 0 ? null : (personal.length * 60) / minutes,
  };
}

const AI_BUTTONS = new Set(["reply", "fix", "hi", "ping", "coach"]);
export function aiButton(composedWith: string | null): boolean {
  return composedWith !== null && AI_BUTTONS.has(composedWith);
}

export interface ChatSummary {
  chat: ShiftReviewChat;
  mine: number;
  fan: number;
  others: number;
  ai: number;
  copied: number;
  fix: number;
  first: number | null;
  last: number | null;
  /** The longest the fan waited within the shift before an answer came, seconds. */
  longestWaitSeconds: number | null;
  waitingAtEnd: boolean;
  waitingSinceBefore: boolean;
  repeated: number;
  marked: number;
  ppv: number;
  bought: number;
  lastFanText: string | null;
}

export function summariesOf(data: TeamShiftReviewResponse): ChatSummary[] {
  const shiftStart = Date.parse(data.shift.startedAt);
  const waitsByChat = new Map<string, TeamShiftReviewResponse["waits"]>();
  for (const wait of data.waits) waitsByChat.set(wait.chat, [...(waitsByChat.get(wait.chat) ?? []), wait]);
  return data.chats.map((chat) => {
    const inShift = chat.messages.filter((message) => message.inShift);
    const mine = inShift.filter((message) => message.mine !== null);
    const waits = waitsByChat.get(chat.key) ?? [];
    const waitSeconds = waits.filter((wait) => wait.by !== null).map((wait) => (Date.parse(wait.to) - Math.max(Date.parse(wait.since), shiftStart)) / 1000);
    const times = inShift.map((message) => Date.parse(message.at));
    const lastFan = [...inShift].reverse().find((message) => message.side === "fan");
    return {
      chat,
      mine: mine.length,
      fan: inShift.filter((message) => message.side === "fan").length,
      others: inShift.filter((message) => message.side === "page" && message.mine === null).length,
      ai: mine.filter((message) => message.mine!.origin === "ai").length,
      copied: mine.filter((message) => message.mine!.origin === "ai" && !aiButton(message.mine!.composedWith)).length,
      fix: mine.filter((message) => message.mine!.origin === "fix").length,
      first: times.length === 0 ? null : Math.min(...times),
      last: times.length === 0 ? null : Math.max(...times),
      longestWaitSeconds: waitSeconds.length === 0 ? null : Math.max(...waitSeconds),
      waitingAtEnd: waits.some((wait) => wait.by === null),
      waitingSinceBefore: waits.some((wait) => wait.by === null && Date.parse(wait.since) < shiftStart),
      repeated: mine.filter((message) => message.mine!.repeats > 0).length,
      marked: mine.filter((message) => message.mine!.marks.length > 0).length,
      ppv: mine.filter((message) => message.priceMills !== null).length,
      bought: mine.filter((message) => message.bought === true).length,
      lastFanText: lastFan?.text ?? null,
    };
  });
}

export const CHAT_FILTERS = ["mine", "ai", "waited", "unanswered", "money"] as const;
export type ChatFilter = (typeof CHAT_FILTERS)[number];

export function chatPasses(summary: ChatSummary, filter: ChatFilter): boolean {
  switch (filter) {
    case "mine": return summary.mine > 0;
    case "ai": return summary.ai > 0;
    case "waited": return summary.longestWaitSeconds !== null && summary.longestWaitSeconds > REPLY_NORM_SECONDS;
    case "unanswered": return summary.waitingAtEnd;
    case "money": return summary.ppv > 0 || summary.chat.shiftNetMills > 0;
  }
}

/**
 * A chat was busy in [from, to): a message of it falls there, or its fan waited
 * then for an answer that came later, or started then a wait no one answered.
 * A wait left unanswered for hours does not make the chat busy all along.
 */
export function chatBusyIn(data: TeamShiftReviewResponse, chat: ShiftReviewChat, from: number, to: number): boolean {
  if (chat.messages.some((message) => message.inShift && Date.parse(message.at) >= from && Date.parse(message.at) < to)) return true;
  return data.waits.some((wait) => wait.chat === chat.key && (wait.by !== null
    ? Date.parse(wait.from) < to && Date.parse(wait.to) > from
    : Date.parse(wait.from) >= from && Date.parse(wait.from) < to));
}

export function chatMatches(chat: ShiftReviewChat, needle: string): boolean {
  const query = needle.trim().toLowerCase();
  if (query === "") return true;
  if ((chat.fanUsername ?? "").toLowerCase().includes(query) || (chat.fanDisplayName ?? "").toLowerCase().includes(query)) return true;
  return chat.messages.some((message) => message.text.toLowerCase().includes(query));
}

export function fanName(chat: ShiftReviewChat): string {
  return chat.fanDisplayName ?? chat.fanUsername ?? (chat.fanRef ? `фан ${chat.fanRef}` : "фан");
}
