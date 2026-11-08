import type { ShiftReviewChat, ShiftReviewMessage, TeamShiftReviewResponse } from "@agency_hub_core/contracts";
import { formatDuration } from "@/lib/format";

/**
 * Команда → «Разбор смены»: what the screen derives from `teamShiftReview` —
 * the waits and whose they are, the shift minute by minute for the pulse, the
 * totals, and what each chat shows in the list. Pure; the server sends facts,
 * this file counts them.
 *
 * Whose a wait is (2026-11-07): a page can be worked by two people at once, or
 * handed over within a shift. A fan's wait is the reviewed chatter's when the
 * chatter answered it or wrote last before it began. It is a colleague's when
 * the colleague wrote last before it, within the shift or in the
 * REPLY_NORM_SECONDS before it, and was still writing on that page when it
 * ended; or when a colleague answered it who was writing on that page as it
 * began. «Writing on that page» counts the colleague's messages before the
 * shift too: a fan waiting from the last shift, answered by a colleague who sat
 * on the page as this one began, is not the chatter's. Anything else on the
 * chatter's watch is theirs. A chat with only colleagues' waits, where the
 * chatter wrote nothing, is under «Вели другие»; its waits are counted apart.
 */

const MINUTE_MS = 60_000;
/** The pace is the messages of the last this many minutes. */
export const PACE_WINDOW_MINUTES = 10;
/** The reply time is the median of the replies of the last this many minutes. */
export const REPLY_WINDOW_MINUTES = 30;
/**
 * The reply norm is a band, not a line: the owner put it at «5-10 минут»
 * (2026-11-07); the job description says «до 10 минут». Past the upper end a
 * wait counts as long.
 */
export const REPLY_FAST_SECONDS = 5 * 60;
export const REPLY_NORM_SECONDS = 10 * 60;
/** A click on the pulse picks this many minutes on each side. */
export const PICK_MINUTES = 10;
/** A silence this long inside a chat gets a line of its own in the transcript. */
export const GAP_MINUTES = 15;
/** A fan quiet this long inside a wait, who then wrote again, came back (see `cameBack`). */
export const FAN_QUIET_SECONDS = 15 * 60;

/**
 * A wait as the screen writes it. Under 20 minutes to the second, so 9 мин 49 с
 * and 10 мин 21 с fall on their own sides of the norm; then minutes and hours.
 */
export function waitText(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} с`;
  if (total < 20 * 60) {
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return rest === 0 ? `${minutes} мин` : `${minutes} мин ${rest} с`;
  }
  return formatDuration(Math.round(total / 60));
}

export type ActivityState = "input" | "open" | "closed";

export interface PulseMinute {
  /** The start of the minute, ms. */
  at: number;
  /** The chatter's personal messages in this minute. */
  sent: number;
  /** In the last PACE_WINDOW_MINUTES. */
  pace: number;
  /** The median reply of the last REPLY_WINDOW_MINUTES, seconds; null — no reply then. */
  replyMedianSeconds: number | null;
  /** The same in minutes, for the chart. */
  replyMedian: number | null;
  /** Replies in that window. */
  replies: number;
  /** The chatter's fans waiting at this minute who got an answer later in the shift: the queue the chatter worked through. */
  waiting: number;
  /** The chatter's fans waiting at this minute who got no answer before the shift's end. */
  waitingOpen: number;
  /** Of both, waiting longer than the norm by now. */
  waitingLong: number;
  /** Fans waiting since before the shift who did not write in it and got no answer in it. */
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

/** A page message that answers a fan: not a mass message, not an automated one. */
function isPersonal(message: ShiftReviewMessage): boolean {
  return message.side === "page" && !message.mass && message.by !== "auto";
}

/** Who else wrote in the chat within the shift, by name, most first. */
function colleaguesIn(chat: ShiftReviewChat): Array<{ name: string; messages: number }> {
  const count = new Map<string, number>();
  for (const message of chat.messages) {
    if (!message.inShift || message.by !== "other" || message.mass) continue;
    const name = message.byName ?? "коллега";
    count.set(name, (count.get(name) ?? 0) + 1);
  }
  return [...count].map(([name, messages]) => ({ name, messages })).sort((a, b) => b.messages - a.messages);
}


export interface ReviewWait {
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
  /** The fan's latest message before the wait ended, ms. */
  lastFanAt: number;
  /** The fan's longest silence between two of their messages inside the wait, seconds; 0 — one message. */
  fanQuietSeconds: number;
  /** How long, seconds: a wait from before the shift counts from its start (the approved definition). */
  seconds: number;
  /** The reviewed chatter's (see the file's head). */
  his: boolean;
}

export function reviewWaits(data: TeamShiftReviewResponse): ReviewWait[] {
  const start = Date.parse(data.shift.startedAt);
  const norm = REPLY_NORM_SECONDS * 1000;
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
    const before = timed.filter((one) => isPersonal(one.message) && one.at < since).at(-1);
    const heldByMe = before?.message.by === "me";
    const holder = before && before.at >= start - norm && before.message.by === "other" ? before.message.byName : undefined;
    const heldBy = holder !== undefined && (wait.by === "other" || writingOn(page, holder, to)) ? holder ?? "коллега" : null;
    const answer = wait.by === "other" ? timed.find((one) => one.at === to && one.message.by === "other") : undefined;
    const answeredOnTheirWatch = answer !== undefined && writingOn(page, answer.message.byName, from);
    const fanAts = timed.filter((one) => one.message.side === "fan" && one.at >= since && one.at <= to).map((one) => one.at);
    return {
      chat: wait.chat,
      since,
      from,
      to,
      by: wait.by,
      byName: answer?.message.byName ?? null,
      heldBy,
      inherited: since < start,
      fanWrote: timed.some((one) => one.message.side === "fan" && one.message.inShift && one.at >= since && one.at <= to),
      lastFanAt: fanAts.at(-1) ?? since,
      fanQuietSeconds: fanAts.reduce((longest, one, index) => (index === 0 ? 0 : Math.max(longest, one - fanAts[index - 1]!)), 0) / 1000,
      seconds: (to - Math.max(since, start)) / 1000,
      his: wait.by === "me" || heldByMe || (heldBy === null && !answeredOnTheirWatch),
    };
  });
}

/**
 * A long wait whose fan went quiet and wrote again just before the answer: a
 * «goodnight», then a «good morning» answered in minutes. Worth saying beside
 * the wait, which still counts from its start. A fan who kept writing all the
 * while did not come back: they waited.
 */
export function cameBack(waitSeconds: number, lastFanGapSeconds: number, fanQuietSeconds: number): boolean {
  return waitSeconds > REPLY_NORM_SECONDS && lastFanGapSeconds <= REPLY_NORM_SECONDS && waitSeconds - lastFanGapSeconds >= 15 * 60
    && fanQuietSeconds >= FAN_QUIET_SECONDS;
}

/** A wait the chatter left without an answer at the end: the fan wrote in the shift, or began waiting in it. */
function unansweredInShift(wait: ReviewWait): boolean {
  return wait.his && wait.by === null && (!wait.inherited || wait.fanWrote);
}

/** A fan waiting since before the shift who did not write in it, and got no answer in it. */
function waitingSilently(wait: ReviewWait): boolean {
  return wait.his && wait.by === null && wait.inherited && !wait.fanWrote;
}

/** The shift minute by minute, from its first minute to its last. */
export function pulseOf(data: TeamShiftReviewResponse, waits: readonly ReviewWait[]): PulseMinute[] {
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
  const queue = waits.filter((wait) => wait.his).map((wait) => ({
    ...wait,
    kind: wait.by !== null ? "answered" as const : waitingSilently(wait) ? "inherited" as const : "open" as const,
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
    // The middle of the minute; the last minute of a shift going on ends at `end`, mid-minute.
    const probe = Math.min(at + MINUTE_MS / 2, end - 1);
    for (const wait of queue) {
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
      replyMedianSeconds: middle,
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

export interface Silence {
  from: number;
  to: number;
  minutes: number;
  /** Of them, inside a pause of the shift. */
  pauseMinutes: number;
}

/**
 * The stretches without one personal message, in time order, that are at least
 * `minMinutes` long outside the shift's pauses: a pause is already on the chart.
 */
export function silences(pulse: readonly PulseMinute[], pauses: ReadonlyArray<{ from: number; to: number }>, minMinutes: number): Silence[] {
  const stretches: Array<{ from: number; to: number }> = [];
  let since: number | null = null;
  for (const minute of pulse) {
    if (minute.sent === 0) {
      since ??= minute.at;
      continue;
    }
    if (since !== null) stretches.push({ from: since, to: minute.at });
    since = null;
  }
  const last = pulse.at(-1);
  if (since !== null && last) stretches.push({ from: since, to: last.at + MINUTE_MS });
  return stretches.flatMap((stretch) => {
    const overlap = pauses.reduce((sum, pause) => sum + Math.max(0, Math.min(stretch.to, pause.to) - Math.max(stretch.from, pause.from)), 0);
    const minutes = Math.round((stretch.to - stretch.from) / MINUTE_MS);
    const pauseMinutes = Math.round(overlap / MINUTE_MS);
    return minutes - pauseMinutes >= minMinutes ? [{ ...stretch, minutes, pauseMinutes }] : [];
  });
}

export interface ShiftTotals {
  messages: number;
  massMessages: number;
  /** Chats the chatter wrote in, and of them where the fan did not write in the shift. */
  chats: number;
  chatsFanSilent: number;
  replies: number;
  replyMedianSeconds: number | null;
  repliesWithinFast: number;
  repliesWithinNorm: number;
  /** Replies to fans who had been waiting since before the shift; their wait counts from its start. */
  repliesToInherited: number;
  /** The chatter's fans who wrote in the shift (or began waiting in it) and got no answer before its end. */
  unanswered: number;
  /** Of them, waiting since before the shift too; and who began waiting in the last REPLY_NORM_SECONDS of it. */
  unansweredInherited: number;
  unansweredLate: number;
  /** Fans waiting since before the shift who did not write in it and got no answer in it. */
  waitingSilently: number;
  /** Chats colleagues kept, who, and their fans left without an answer. */
  colleagueChats: number;
  colleagues: string[];
  colleagueUnanswered: number;
  /** Fans left without an answer in the chatter's own chats after a colleague's message: the colleague's. */
  handedOverUnanswered: number;
  /** Of the personal messages: Hi greetings apart from the other AI texts; copied — an AI text put in without a button. */
  origin: { ai: number; hi: number; copied: number; fix: number; own: number; none: number };
  dialogs: number;
  touches: number;
  ppvSent: number;
  ppvBought: number;
  perHour: number | null;
}

export function totalsOf(data: TeamShiftReviewResponse, mine: readonly MyMessage[], summaries: readonly ChatSummary[], waits: readonly ReviewWait[]): ShiftTotals {
  const personal = mine.filter((one) => !one.message.mass);
  const delays = personal.flatMap((one) => (one.message.mine.replySeconds === null ? [] : [one.message.mine.replySeconds]));
  const end = Date.parse(data.shift.endedAt);
  const inheritedAnswers = new Set(waits.filter((wait) => wait.inherited && wait.by === "me").map((wait) => `${wait.chat}|${wait.to}`));
  const origin = { ai: 0, hi: 0, copied: 0, fix: 0, own: 0, none: 0 };
  for (const one of personal) {
    const facts = one.message.mine;
    if (facts.origin === null) origin.none += 1;
    else if (facts.origin === "ai" && isHi(facts)) origin.hi += 1;
    else origin[facts.origin] += 1;
    if (facts.origin === "ai" && !isHi(facts) && facts.composedWith === "hand") origin.copied += 1;
  }
  const unanswered = waits.filter(unansweredInShift);
  const colleagueSummaries = summaries.filter((summary) => summary.kind === "colleague");
  const colleagueKeys = new Set(colleagueSummaries.map((summary) => summary.chat.key));
  const theirOpen = waits.filter((wait) => !wait.his && wait.by === null && (!wait.inherited || wait.fanWrote));
  const minutes = data.shift.workedMinutes;
  return {
    messages: personal.length,
    massMessages: mine.length - personal.length,
    chats: summaries.filter((summary) => summary.mine > 0).length,
    chatsFanSilent: summaries.filter((summary) => summary.mine > 0 && summary.fan === 0).length,
    replies: delays.length,
    replyMedianSeconds: median(delays),
    repliesWithinFast: delays.filter((delay) => delay <= REPLY_FAST_SECONDS).length,
    repliesWithinNorm: delays.filter((delay) => delay <= REPLY_NORM_SECONDS).length,
    repliesToInherited: personal.filter((one) => one.message.mine.replySeconds !== null && inheritedAnswers.has(`${one.chat.key}|${one.at}`)).length,
    unanswered: unanswered.length,
    unansweredInherited: unanswered.filter((wait) => wait.inherited).length,
    unansweredLate: unanswered.filter((wait) => wait.since >= end - REPLY_NORM_SECONDS * 1000).length,
    waitingSilently: waits.filter(waitingSilently).length,
    colleagueChats: colleagueSummaries.length,
    colleagues: [...new Set(colleagueSummaries.flatMap((summary) => summary.colleagues.map((one) => one.name)))],
    colleagueUnanswered: theirOpen.filter((wait) => colleagueKeys.has(wait.chat)).length,
    handedOverUnanswered: theirOpen.filter((wait) => !colleagueKeys.has(wait.chat)).length,
    origin,
    dialogs: summaries.filter((summary) => summary.kind === "dialog").length,
    touches: summaries.filter((summary) => summary.kind === "touch").length,
    ppvSent: mine.filter((one) => one.message.priceMills !== null).length,
    ppvBought: mine.filter((one) => one.message.bought === true).length,
    perHour: minutes === 0 ? null : (personal.length * 60) / minutes,
  };
}

const AI_BUTTONS = new Set(["reply", "fix", "hi", "ping", "coach"]);
export function aiButton(composedWith: string | null): boolean {
  return composedWith !== null && AI_BUTTONS.has(composedWith);
}

type MineFacts = NonNullable<ShiftReviewMessage["mine"]>;

/** A greeting to a new follower by the Hi button: an AI text, but not a reply in a conversation. */
export function isHi(mine: Pick<MineFacts, "composedWith" | "aiFeature">): boolean {
  return mine.composedWith === "hi" || mine.aiFeature === "hi-greeting";
}

function isPing(mine: Pick<MineFacts, "composedWith" | "aiFeature">): boolean {
  return mine.composedWith === "ping" || mine.aiFeature === "ping";
}

/**
 * dialog — the fan wrote within the shift, or the chatter answered a fan who
 * waited; touch — the chatter wrote first and the fan did not answer in the
 * shift (Hi, Ping); colleague — a colleague kept it, the chatter wrote nothing;
 * waiting — nothing in the shift, a fan waiting since before it.
 */
export type ChatKind = "dialog" | "touch" | "colleague" | "waiting";

export interface ChatSummary {
  chat: ShiftReviewChat;
  kind: ChatKind;
  mine: number;
  fan: number;
  /** Colleagues who wrote in the chat within the shift. */
  colleagues: Array<{ name: string; messages: number }>;
  ai: number;
  hi: number;
  ping: number;
  copied: number;
  fix: number;
  own: number;
  first: number | null;
  last: number | null;
  /** The longest the fan waited within the shift for the chatter's answer (or one without an author), seconds. */
  longestWaitSeconds: number | null;
  /** That longest wait began before the shift: it counts from the shift's start. */
  longestWaitInherited: boolean;
  /** A colleague ended it. */
  longestWaitAnsweredBy: string | null;
  /** The fan wrote again this long before the answer, when that is well inside the wait, seconds. */
  longestWaitLastFanSeconds: number | null;
  /** The chatter's fan without an answer at the end: how long (from the shift's start for a wait from before it), since when. */
  openWaitSeconds: number | null;
  openSince: number | null;
  /** The fan wrote within the shift and got no answer from the chatter before its end. */
  unansweredInShift: boolean;
  /** …and began waiting in its last REPLY_NORM_SECONDS. */
  unansweredLate: boolean;
  /** A fan waiting since before the shift did not write in it and got no answer in it. */
  waitingSinceBefore: boolean;
  /** The colleague whose wait the fan left without an answer at the end is. */
  openHeldBy: string | null;
  repeated: number;
  marked: number;
  ppv: number;
  bought: number;
  firstFanText: string | null;
  lastFanText: string | null;
  /** The chatter's first text in the shift: what a first touch said. */
  firstMineText: string | null;
  /** The fan's last text before the shift, when the fan wrote nothing in it: what a waiting fan said. */
  lastFanBeforeText: string | null;
}

export function summariesOf(data: TeamShiftReviewResponse, allWaits: readonly ReviewWait[]): ChatSummary[] {
  const end = Date.parse(data.shift.endedAt);
  const waitsByChat = new Map<string, ReviewWait[]>();
  for (const wait of allWaits) waitsByChat.set(wait.chat, [...(waitsByChat.get(wait.chat) ?? []), wait]);
  return data.chats.map((chat) => {
    const inShift = chat.messages.filter((message) => message.inShift);
    const mine = inShift.filter((message) => message.mine !== null);
    const fan = inShift.filter((message) => message.side === "fan");
    const colleagues = colleaguesIn(chat);
    const waits = waitsByChat.get(chat.key) ?? [];
    const answered = waits.filter((wait) => wait.his && wait.by !== null);
    const longest = answered.reduce<ReviewWait | null>((best, wait) => (best === null || wait.seconds > best.seconds ? wait : best), null);
    const open = waits.find((wait) => wait.by === null) ?? null;
    const openHis = open !== null && open.his ? open : null;
    const times = inShift.map((message) => Date.parse(message.at));
    const textOf = (message: ShiftReviewMessage | undefined) => (message === undefined || message.text.trim() === "" ? null : message.text);
    const firstFan = fan.find((message) => message.text.trim() !== "");
    const lastFan = [...fan].reverse().find((message) => message.text.trim() !== "");
    const isAi = (message: ShiftReviewMessage) => message.mine!.origin === "ai";
    const kind: ChatKind = mine.length === 0 && colleagues.length > 0 && !waits.some((wait) => wait.his) ? "colleague"
      : fan.length > 0 || answered.length > 0 || mine.some((message) => message.mine!.replySeconds !== null) ? "dialog"
        : mine.length > 0 ? "touch"
          : "waiting";
    const lastFanGap = longest === null ? null : (longest.to - longest.lastFanAt) / 1000;
    return {
      chat,
      kind,
      mine: mine.length,
      fan: fan.length,
      colleagues,
      ai: mine.filter((message) => isAi(message) && !isHi(message.mine!)).length,
      hi: mine.filter((message) => isAi(message) && isHi(message.mine!)).length,
      ping: mine.filter((message) => isPing(message.mine!)).length,
      copied: mine.filter((message) => isAi(message) && !isHi(message.mine!) && message.mine!.composedWith === "hand").length,
      fix: mine.filter((message) => message.mine!.origin === "fix").length,
      own: mine.filter((message) => message.mine!.origin === "own").length,
      first: times.length === 0 ? null : Math.min(...times),
      last: times.length === 0 ? null : Math.max(...times),
      longestWaitSeconds: longest?.seconds ?? null,
      longestWaitInherited: longest?.inherited ?? false,
      longestWaitAnsweredBy: longest?.by === "other" ? longest.byName ?? "коллега" : null,
      longestWaitLastFanSeconds: longest !== null && lastFanGap !== null && cameBack(longest.seconds, lastFanGap, longest.fanQuietSeconds) ? lastFanGap : null,
      openWaitSeconds: openHis?.seconds ?? null,
      openSince: openHis?.since ?? null,
      unansweredInShift: openHis !== null && unansweredInShift(openHis),
      unansweredLate: openHis !== null && unansweredInShift(openHis) && openHis.since >= end - REPLY_NORM_SECONDS * 1000,
      waitingSinceBefore: openHis !== null && waitingSilently(openHis),
      openHeldBy: open !== null && !open.his ? open.heldBy ?? colleagues[0]?.name ?? "коллега" : null,
      repeated: mine.filter((message) => message.mine!.repeats > 0).length,
      marked: mine.filter((message) => message.mine!.marks.length > 0).length,
      ppv: mine.filter((message) => message.priceMills !== null).length,
      bought: mine.filter((message) => message.bought === true).length,
      firstFanText: textOf(firstFan),
      lastFanText: lastFan === firstFan ? null : textOf(lastFan),
      firstMineText: textOf(mine.find((message) => message.text.trim() !== "")),
      lastFanBeforeText: fan.length > 0 ? null : textOf([...chat.messages].reverse().find((message) => !message.inShift && message.side === "fan" && message.text.trim() !== "")),
    };
  });
}

export const CHAT_KINDS = ["dialog", "touch", "colleague", "waiting", "all"] as const;
export type ChatKindFilter = (typeof CHAT_KINDS)[number];
export const CHAT_SHOWS = ["all", "waited", "unanswered", "money"] as const;
export type ChatShow = (typeof CHAT_SHOWS)[number];
export const CHAT_SORTS = ["messages", "time", "wait", "money"] as const;
export type ChatSort = (typeof CHAT_SORTS)[number];

export function kindPasses(summary: ChatSummary, kind: ChatKindFilter): boolean {
  return kind === "all" || summary.kind === kind;
}

export function showPasses(summary: ChatSummary, show: ChatShow): boolean {
  switch (show) {
    case "all": return true;
    case "waited": return summary.longestWaitSeconds !== null && summary.longestWaitSeconds > REPLY_NORM_SECONDS;
    case "unanswered": return summary.unansweredInShift;
    case "money": return summary.ppv > 0 || summary.chat.shiftNetMills > 0;
  }
}

/** The list in the chosen order; ties keep the server's order (by the first message in the shift). */
export function sortSummaries(list: readonly ChatSummary[], sort: ChatSort): ChatSummary[] {
  const key = (summary: ChatSummary): [number, number] => {
    switch (sort) {
      case "messages": return [-(summary.mine + summary.fan), summary.openSince ?? Number.MAX_SAFE_INTEGER];
      case "time": return [summary.first ?? summary.openSince ?? Number.MAX_SAFE_INTEGER, 0];
      case "wait": return [-Math.max(summary.longestWaitSeconds ?? -1, summary.openWaitSeconds ?? -1), summary.openSince ?? Number.MAX_SAFE_INTEGER];
      case "money": return [-summary.chat.shiftNetMills, -summary.ppv];
    }
  };
  return list.map((summary, index) => ({ summary, index, key: key(summary) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.index - b.index)
    .map((one) => one.summary);
}

/**
 * A chat was busy in [from, to): a message of it falls there, or its fan waited
 * then as the pulse's queue shows it — for an answer that came later, or for
 * one that did not come. A fan who waited from before the shift and did not
 * write in it is not on the queue, and does not make the chat busy.
 */
export function chatBusyIn(chat: ShiftReviewChat, waits: readonly ReviewWait[], from: number, to: number): boolean {
  if (chat.messages.some((message) => message.inShift && Date.parse(message.at) >= from && Date.parse(message.at) < to)) return true;
  return waits.some((wait) => wait.chat === chat.key && (wait.by !== null || (!wait.inherited || wait.fanWrote))
    && wait.from < to && wait.to > from);
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

/** A Coach answer as plain text: its markdown marks off, a ```draft block as quoted text. */
export function plainAiText(text: string): string {
  return text
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^#+\s*/gm, "")
    .trim();
}
