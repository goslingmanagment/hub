import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ShiftReviewChat, ShiftReviewMessage, TeamShiftReviewResponse } from "@agency_hub_core/contracts";
import { formatMills } from "@agency_hub_core/ui/format";
import { kernel } from "@/shared/hub";
import {
  REPLY_NORM_SECONDS,
  chatBusyIn,
  chatMatches,
  isHi,
  myMessages,
  pulseOf,
  reviewWaits,
  silences,
  summariesOf,
  totalsOf,
  waitText,
  type ChatKind,
  type ChatSummary,
  type PulseMinute,
  type ReviewWait,
  type ShiftTotals,
  type Silence,
} from "./rules.js";

/**
 * Разбор смены — the data layer (spec §4.2). The screen reads only this file.
 *
 * Future contract (phase 2): the shift review split in two —
 *   `teamShiftReviewIndex { userId, at }` → `ReviewIndex`: the shift, its totals, its pulse and the chat index with
 *     the reasons to look (no transcripts);
 *   `teamShiftReviewChat { userId, at, chat }` → `ReviewTranscript`: one chat's messages and waits.
 * The totals, the waits' owner, the reasons and the pulse are then Hub's definitions (rules.ts moves there).
 *
 * Phase 1 adapter: one `teamShiftReview { userId, at }` (owner only) carries everything; this file derives the
 * index and the transcripts from it. A finished shift does not change; one going on is read again every 2 min.
 * Query keys start with "review".
 */

// ------------------------------------------------------------ The future contract

/** The chat lists of the screen: «Стоит посмотреть · Без ответа · Долго ждали · Платные · Все». */
export const REVIEW_FILTERS = ["look", "unanswered", "waited", "paid", "all"] as const;
export type ReviewFilter = (typeof REVIEW_FILTERS)[number];

/**
 * Why a chat is worth a look, said in words on its card. `look` reasons put a
 * chat into «Стоит посмотреть»; `note` ones only explain it (a colleague's chat,
 * a fan waiting since before the shift); `sample` marks an ordinary dialog
 * picked for comparison.
 */
export interface ChatReason {
  kind: "unanswered" | "waited" | "paid" | "offer" | "leak" | "repeat" | "ai" | "mark" | "note" | "sample";
  text: string;
  /** Said in the outlier's colour: a fan left without an answer, the AI's service text. */
  strong?: boolean;
}

/** One row of the shift's chat index. */
export interface ReviewChatRow {
  key: string;
  pageLabel: string;
  platform: string;
  fanRef: string | null;
  fanUsername: string | null;
  fanDisplayName: string | null;
  /** The fan's net on this page, all time; null — Hub knows none. */
  lifetimeNetMills: number | null;
  /** The fan's net on this page within the shift (any author's sale). */
  shiftNetMills: number;
  kind: ChatKind;
  /** The chatter's messages and the fan's, within the shift. */
  mine: number;
  fan: number;
  colleagues: Array<{ name: string; messages: number }>;
  /** First and last message within the shift; a fan only waiting: since when. */
  firstAt: number | null;
  lastAt: number | null;
  waitingSince: number | null;
  /** Strongest first. */
  reasons: ChatReason[];
  /** In which lists the chat stands. */
  in: Record<ReviewFilter, boolean>;
  /** Sort keys of the lists. */
  tier: number;
  waitSeconds: number;
  paidMills: number;
}

export interface ReviewShift {
  userId: number;
  username: string;
  kind: "shift" | "visit";
  startedAt: string;
  endedAt: string;
  start: number;
  end: number;
  ongoing: boolean;
  workedMinutes: number;
  pauses: Array<{ from: number; to: number }>;
  pauseMinutes: number;
  pages: TeamShiftReviewResponse["shift"]["pages"];
  salesNetMills: number;
  /** The same sales in the chats below (a sale to a fan without a chat here is in the first only). */
  chatsNetMills: number;
  previousAt: string | null;
  nextAt: string | null;
  /** The chatter's messages the archive does not hold yet, and those deleted after sending: not on the screen. */
  unarchived: number;
  deleted: number;
  serverNow: string;
}

/** A money event of the shift for the pulse: a paid message bought, a tip. */
export interface ReviewSale {
  at: number;
  chat: string;
  mills: number;
  kind: "bought" | "tip";
}

/** `teamShiftReviewIndex` (phase 2). */
export interface ReviewIndex {
  shift: ReviewShift;
  totals: ShiftTotals;
  minutes: PulseMinute[];
  sales: ReviewSale[];
  silences: Silence[];
  chats: ReviewChatRow[];
}

/** `teamShiftReviewChat` (phase 2): one chat as it went. */
export interface ReviewTranscript {
  chat: ShiftReviewChat;
  /** Its waits, with whose they are. */
  waits: ReviewWait[];
}

export type ReviewMessage = ShiftReviewMessage;
export type { ChatKind, PulseMinute, ReviewWait, ShiftTotals, Silence };

// ------------------------------------------------------------------- The adapter

const MINUTE_MS = 60_000;
/** A stretch without one message this long, pauses aside, is offered over the pulse. */
export const SILENCE_MINUTES = 20;
/** Ordinary dialogs «Стоит посмотреть» adds for comparison (Astra: against a biased picture). */
const SAMPLES = 2;
/** «ИИ без правки» is a reason when at least this many of the chatter's texts in a chat, and at least half, are AI texts sent as they came. */
const AI_RAW_MIN = 2;

export function reviewQuery(userId: number, at: string) {
  return queryOptions({
    queryKey: ["review", "shift", userId, at] as const,
    queryFn: () => kernel.teamShiftReview({ query: { userId, at } }),
    staleTime: 60_000,
    refetchInterval: (query) => (query.state.data?.shift.ongoing ? 120_000 : false),
  });
}

/** Neighbouring shifts are read only when the owner reaches for them (hover, focus), never all at once. */
export function prefetchReview(client: QueryClient, userId: number, at: string | null) {
  if (at !== null) void client.prefetchQuery(reviewQuery(userId, at));
}

/** An AI text sent as it came: not a greeting, nearly every word the AI's, not changed in the composer. */
export function aiUnedited(mine: NonNullable<ShiftReviewMessage["mine"]>): boolean {
  return mine.origin === "ai" && !isHi(mine) && (mine.aiShare ?? 0) >= 0.98 && mine.edited !== true;
}

function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function shortMoney(mills: number): string {
  return formatMills(mills).replace(/\.00$/, "");
}

function rowOf(summary: ChatSummary, shift: ReviewShift): ReviewChatRow {
  const { chat } = summary;
  const inShift = chat.messages.filter((message) => message.inShift);
  const personal = inShift.filter((message) => message.mine !== null && !message.mass);
  const withText = personal.filter((message) => message.mine!.origin !== null && !isHi(message.mine!));
  const raw = withText.filter((message) => aiUnedited(message.mine!)).length;
  const boughtMills = inShift.reduce((sum, message) => sum + (message.mine !== null && message.bought === true ? Number(message.priceMills ?? 0) : 0), 0);
  const tipMills = inShift.reduce((sum, message) => sum + (message.side === "fan" ? Number(message.tipMills ?? 0) : 0), 0);
  const marks = new Set(inShift.flatMap((message) => message.mine?.marks ?? []));

  const reasons: ChatReason[] = [];
  if (summary.unansweredInShift && summary.openWaitSeconds !== null) {
    const fromStart = summary.openSince !== null && summary.openSince < shift.start ? " с начала смены" : "";
    reasons.push({
      kind: "unanswered",
      strong: true,
      text: shift.ongoing
        ? `ждёт ответа ${waitText(summary.openWaitSeconds)}${fromStart}`
        : summary.unansweredLate
          ? `без ответа: написал за ${waitText(summary.openWaitSeconds)} до конца`
          : `без ответа ${waitText(summary.openWaitSeconds)}${fromStart}`,
    });
  }
  if (summary.longestWaitSeconds !== null && summary.longestWaitSeconds > REPLY_NORM_SECONDS) {
    reasons.push({
      kind: "waited",
      text: `ждал ${waitText(summary.longestWaitSeconds)}${summary.longestWaitInherited ? " с начала смены" : ""}${summary.longestWaitAnsweredBy !== null ? `, ответ от ${summary.longestWaitAnsweredBy}` : ""}`,
    });
  }
  if (summary.ppv > 0) {
    reasons.push({
      // A paid message nobody bought is ordinary work: it is in «Платные», not a reason to look.
      kind: summary.bought > 0 ? "paid" : "offer",
      text: summary.bought > 0
        ? summary.ppv === 1 ? `платное ${shortMoney(boughtMills)} куплено` : `платные: куплено ${summary.bought} из ${summary.ppv}, ${shortMoney(boughtMills)}`
        : summary.ppv === 1 ? "платное не куплено" : `платные: ${summary.ppv}, не куплены`,
    });
  } else if (chat.shiftNetMills > 0) {
    reasons.push({ kind: "paid", text: `принёс в смену ${shortMoney(chat.shiftNetMills)}` });
  }
  if (tipMills > 0) reasons.push({ kind: "paid", text: `чаевые ${shortMoney(tipMills)}` });
  if (marks.has("leak")) reasons.push({ kind: "leak", strong: true, text: "служебный текст ИИ" });
  if (summary.repeated > 0) reasons.push({ kind: "repeat", text: "тот же текст другим фанам" });
  if (raw >= AI_RAW_MIN && raw * 2 >= withText.length) reasons.push({ kind: "ai", text: `ИИ без правки ${raw} из ${withText.length}` });
  if (marks.has("dash")) reasons.push({ kind: "mark", text: "длинное тире" });
  if (marks.has("cyrillic")) reasons.push({ kind: "mark", text: "кириллица" });
  // Honest notes: not the chatter's, or not a reason by itself.
  if (summary.kind === "colleague") {
    reasons.push({ kind: "note", text: `вела коллега ${summary.colleagues.map((one) => one.name).join(", ")} — не в счёте` });
  } else if (summary.openHeldBy !== null) {
    reasons.push({ kind: "note", text: `без ответа после сообщения ${summary.openHeldBy} — не в счёте` });
  }
  if (summary.waitingSinceBefore) reasons.push({ kind: "note", text: "ждал ещё до смены, в смену не писал" });

  // A number stays with its unit and «2 из 3» with itself when a card's line wraps.
  for (const reason of reasons) reason.text = reason.text.replace(/ из /g, "\u00a0из\u00a0").replace(/(\d) (?=\S)/g, "$1\u00a0");
  const look = reasons.some((reason) => reason.kind !== "note" && reason.kind !== "sample" && reason.kind !== "offer");
  const tier = reasons.some((reason) => reason.kind === "unanswered") ? 0
    : reasons.some((reason) => reason.kind === "waited") ? 1
      : reasons.some((reason) => reason.kind === "paid" || reason.kind === "leak") ? 2
        : look ? 3 : 4;
  const waitSeconds = Math.max(summary.longestWaitSeconds ?? -1, summary.unansweredInShift ? summary.openWaitSeconds ?? -1 : -1);
  return {
    key: chat.key,
    pageLabel: chat.pageLabel,
    platform: chat.platform,
    fanRef: chat.fanRef,
    fanUsername: chat.fanUsername,
    fanDisplayName: chat.fanDisplayName,
    lifetimeNetMills: chat.fanLifetimeNetMills === null ? null : Number(chat.fanLifetimeNetMills),
    shiftNetMills: Number(chat.shiftNetMills),
    kind: summary.kind,
    mine: summary.mine,
    fan: summary.fan,
    colleagues: summary.colleagues,
    firstAt: summary.first,
    lastAt: summary.last,
    waitingSince: summary.openSince,
    reasons,
    in: {
      look,
      unanswered: summary.unansweredInShift,
      // Long waits answered in the shift and those still open at its end: both waited past the norm.
      waited: waitSeconds > REPLY_NORM_SECONDS,
      paid: summary.ppv > 0 || chat.shiftNetMills > 0 || tipMills > 0,
      all: true,
    },
    tier,
    waitSeconds,
    paidMills: Math.max(Number(chat.shiftNetMills), boughtMills + tipMills),
  };
}

/** The whole index of one shift, from today's one answer. */
export function indexOf(data: TeamShiftReviewResponse, waits: readonly ReviewWait[]): ReviewIndex {
  const start = Date.parse(data.shift.startedAt);
  const end = Date.parse(data.shift.endedAt);
  const pauses = data.shift.pauses.map((pause) => ({ from: Date.parse(pause.from), to: Date.parse(pause.to) }));
  const shift: ReviewShift = {
    userId: data.shift.userId,
    username: data.shift.username,
    kind: data.shift.kind,
    startedAt: data.shift.startedAt,
    endedAt: data.shift.endedAt,
    start,
    end,
    ongoing: data.shift.ongoing,
    workedMinutes: data.shift.workedMinutes,
    pauses,
    pauseMinutes: pauses.reduce((sum, pause) => sum + Math.round((pause.to - pause.from) / MINUTE_MS), 0),
    pages: data.shift.pages,
    salesNetMills: Number(data.shift.salesNetMills),
    chatsNetMills: data.chats.reduce((sum, chat) => sum + Number(chat.shiftNetMills), 0),
    previousAt: data.previousAt,
    nextAt: data.nextAt,
    unarchived: data.unarchived,
    deleted: data.deleted,
    serverNow: data.serverNow,
  };
  const mine = myMessages(data);
  const minutes = pulseOf(data, waits);
  const summaries = summariesOf(data, waits);
  const totals = totalsOf(data, mine, summaries, waits);
  const rows = summaries.map((summary) => rowOf(summary, shift));
  // Two ordinary dialogs for comparison: the same two every time this shift opens.
  const ordinary = rows.filter((row) => row.kind === "dialog" && !row.in.look)
    .sort((a, b) => hash(`${data.shift.startedAt}|${a.key}`) - hash(`${data.shift.startedAt}|${b.key}`))
    .slice(0, SAMPLES);
  for (const row of ordinary) {
    row.in.look = true;
    row.reasons.push({ kind: "sample", text: "обычный диалог — для сравнения" });
  }
  const sales: ReviewSale[] = [];
  for (const chat of data.chats) {
    for (const message of chat.messages) {
      if (!message.inShift) continue;
      if (message.mine !== null && message.bought === true && message.priceMills !== null) {
        sales.push({ at: Date.parse(message.at), chat: chat.key, mills: Number(message.priceMills), kind: "bought" });
      }
      if (message.side === "fan" && message.tipMills !== null && Number(message.tipMills) > 0) {
        sales.push({ at: Date.parse(message.at), chat: chat.key, mills: Number(message.tipMills), kind: "tip" });
      }
    }
  }
  const silent = silences(minutes, pauses, SILENCE_MINUTES)
    .sort((a, b) => (b.minutes - b.pauseMinutes) - (a.minutes - a.pauseMinutes))
    .slice(0, 3)
    .sort((a, b) => a.from - b.from);
  return { shift, totals, minutes, sales: sales.sort((a, b) => a.at - b.at), silences: silent, chats: rows };
}

/** One chat as it went, with its waits (phase 2: its own request). */
export function transcriptOf(data: TeamShiftReviewResponse, waits: readonly ReviewWait[], key: string): ReviewTranscript | null {
  const chat = data.chats.find((one) => one.key === key);
  return chat ? { chat, waits: waits.filter((wait) => wait.chat === key) } : null;
}

export interface ReviewModel {
  index: ReviewIndex;
  /** Every wait of the shift with its owner: the transcript's and the span's. */
  waits: ReviewWait[];
  transcript: (key: string) => ReviewTranscript | null;
  /** The chats busy in [from, to): a message there, or a fan of the queue waiting then. */
  busyIn: (from: number, to: number) => Set<string>;
  /** The chats whose fan or text matches the words. */
  matching: (needle: string) => Set<string> | null;
}

/** The shift, read and derived once per answer. */
export function useShiftReview(userId: number, at: string) {
  const query = useQuery(reviewQuery(userId, at));
  const data = query.data;
  const model = useMemo<ReviewModel | null>(() => {
    if (!data) return null;
    const waits = reviewWaits(data);
    const index = indexOf(data, waits);
    return {
      index,
      waits,
      transcript: (key) => transcriptOf(data, waits, key),
      busyIn: (from, to) => new Set(data.chats.filter((chat) => chatBusyIn(chat, waits, from, to)).map((chat) => chat.key)),
      matching: (needle) => (needle.trim() === "" ? null : new Set(data.chats.filter((chat) => chatMatches(chat, needle)).map((chat) => chat.key))),
    };
  }, [data]);
  return { query, model };
}

/**
 * Shifts around this one, for «Другая смена»: the chatter's own and the others
 * that overlapped it. `teamShifts` reads at most a week: six days before the
 * shift and one after. Read only once the picker is opened or hovered.
 */
export function useShiftsAround(startedAt: string, enabled: boolean) {
  const start = Date.parse(startedAt);
  const from = new Date(start - 6 * 24 * 3_600_000).toISOString();
  const to = new Date(Math.min(Date.now(), start + 24 * 3_600_000)).toISOString();
  return useQuery({
    queryKey: ["review", "around", startedAt] as const,
    queryFn: () => kernel.teamShifts({ query: { from, to } }),
    enabled,
    staleTime: 60_000,
  });
}
