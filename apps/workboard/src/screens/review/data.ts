import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ShiftReviewChat, ShiftReviewMessage, TeamShiftReviewResponse } from "@agency_hub_core/contracts";
import { shiftSettling } from "@agency_hub_core/ui/shiftLive";
import { kernel } from "@/shared/hub";
import {
  chatBusyIn,
  chatMatches,
  myMessages,
  pulseOf,
  reviewWaits,
  salesByOrigin,
  salesSplit,
  silences,
  summariesOf,
  totalsOf,
  type ChatKind,
  type PulseMinute,
  type ReviewWait,
  type SalesByOrigin,
  type SalesSplit,
  type ShiftTotals,
  type Silence,
} from "@agency_hub_core/ui/shiftReview";
import { rowOf, selectLook } from "./look.js";

/**
 * Разбор смены — the data layer (spec §4.2). The screen reads only this file.
 *
 * Future contract (phase 2): the shift review split in two —
 *   `teamShiftReviewIndex { userId, at }` → `ReviewIndex`: the shift, its totals, its pulse and the chat index with
 *     the reasons to look (no transcripts);
 *   `teamShiftReviewChat { userId, at, chat }` → `ReviewTranscript`: one chat's messages and waits.
 * The totals, the waits' owner, the reasons (look.ts) and the pulse are then Hub's definitions (`@agency_hub_core/ui/shiftReview`).
 *
 * Phase 1 adapter: one `teamShiftReview { userId, at }` (owner only) carries everything; this file derives the
 * index and the transcripts from it. A shift going on or just ended is read again every 2 min; an older one does not change.
 * Query keys start with "review".
 */

// ------------------------------------------------------------ The future contract

/** The chat lists of the screen: «Стоит посмотреть · Без ответа · Долго ждали · Платные · Все». */
export const REVIEW_FILTERS = ["look", "unanswered", "waited", "paid", "all"] as const;
export type ReviewFilter = (typeof REVIEW_FILTERS)[number];

export type ReasonKind = "unanswered" | "waited" | "paid" | "offer" | "leak" | "repeat" | "ai" | "mark" | "note" | "sample";

/**
 * Why a chat is worth a look, said in words on its card (look.ts). A strong
 * reason (`look`) puts a chat into «Стоит посмотреть»; a weak one only says it
 * and keeps the chat in the other lists; `note` explains (a colleague's chat, a
 * fan waiting since before the shift); `sample` marks an ordinary dialog picked
 * for comparison.
 */
export interface ChatReason {
  kind: ReasonKind;
  text: string;
  /** A strong reason (D8): the chat is in «Стоит посмотреть». */
  look: boolean;
  /** Said in the outlier's colour: a fan left without an answer, the AI's service text. */
  tone?: "mark" | undefined;
  /** The message the reason is about: the chat opens there. */
  focus: string | null;
  /** How strong among reasons of its kind (a longer wait, more money): the selection keeps the strongest. */
  weight?: number;
  /** One text sent to many fans: the text, so the selection keeps one chat of it. */
  group?: string;
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
  /** The fan's sales in the shift that count for the chatter (`mine`, `both`), net. */
  shiftNetMills: number;
  /** The fan's sales in the shift a colleague's shift or no shift holds, net. */
  othersNetMills: number;
  kind: ChatKind;
  /** The chatter's messages and the fan's, within the shift. */
  mine: number;
  fan: number;
  /** Of the fan's, deleted by the fan later. */
  fanDeleted: number;
  colleagues: Array<{ name: string; messages: number }>;
  /** First and last message within the shift; a fan only waiting: since when. */
  firstAt: number | null;
  lastAt: number | null;
  waitingSince: number | null;
  /** Strong first, then weak, then notes. */
  reasons: ChatReason[];
  /** In which lists the chat stands. */
  in: Record<ReviewFilter, boolean>;
  /** Sort keys of the lists: the strongest reason's rank (look.ts). */
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
  /** The start of the last minute with an action, and of the last one the extension beat in (a shift going on: idle, offline). */
  lastInputAt: string;
  lastBeatAt: string;
  pauses: Array<{ from: number; to: number }>;
  pauseMinutes: number;
  pages: TeamShiftReviewResponse["shift"]["pages"];
  salesNetMills: number;
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

/** The shift's money beside its sales: where they came from, and what is near it but not its. */
export interface ReviewMoney {
  origins: SalesByOrigin;
  split: SalesSplit;
  /** Before the shift, no shift's: sales to the chatter's fans from the last shift's end to this one's start. */
  beforeNetMills: number;
  /** The chatter's PPVs of the shift bought after it, by the shift that held each purchase (null — none; `tail` — the rule's line). */
  later: Array<{ holder: string | null; tail?: string; netMills: number }>;
  /** By the one rule (`ruleFrom`): the shift's sales no person's shift has, by their line (the pot, waiting, the owner's decision). */
  notCounted: Array<{ label: string; netMills: number }>;
}

/** The one rule's line of a sale no person's shift has (`home.kind`). */
const HOME_LINES: Partial<Record<string, string>> = { pot: "общак", waiting: "ждёт смены отправителя", decide: "ждёт решения", nobody: "ничья" };

/** `teamShiftReviewIndex` (phase 2). */
export interface ReviewIndex {
  shift: ReviewShift;
  totals: ShiftTotals;
  money: ReviewMoney;
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
export function reviewQuery(userId: number, at: string) {
  return queryOptions({
    queryKey: ["review", "shift", userId, at] as const,
    queryFn: () => kernel.teamShiftReview({ query: { userId, at } }),
    staleTime: 60_000,
    // Going on, or ended under an hour ago (its last messages and sales still coming in): read again every 2 min.
    refetchInterval: (query) => {
      const data = query.state.data;
      return data !== undefined && shiftSettling(data.shift, data.serverNow) ? 120_000 : false;
    },
  });
}

/** Neighbouring shifts are read only when the owner reaches for them (hover, focus), never all at once. */
export function prefetchReview(client: QueryClient, userId: number, at: string | null) {
  if (at !== null) void client.prefetchQuery(reviewQuery(userId, at));
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
    lastInputAt: data.shift.lastInputAt,
    lastBeatAt: data.shift.lastBeatAt,
    pauses,
    pauseMinutes: pauses.reduce((sum, pause) => sum + Math.round((pause.to - pause.from) / MINUTE_MS), 0),
    pages: data.shift.pages,
    salesNetMills: Number(data.shift.salesNetMills),
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
  const waitsByChat = new Map<string, ReviewWait[]>();
  for (const wait of waits) waitsByChat.set(wait.chat, [...(waitsByChat.get(wait.chat) ?? []), wait]);
  const rows = summaries.map((summary) => rowOf(summary, shift, waitsByChat.get(summary.chat.key) ?? []));
  selectLook(rows, data.shift.startedAt);
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
  const later = new Map<string, { holder: string | null; tail?: string; netMills: number }>();
  for (const sale of data.laterSales) {
    const tail = sale.holderName === null && sale.home !== undefined ? HOME_LINES[sale.home.kind] : undefined;
    const key = tail ?? `holder:${sale.holderName ?? ""}`;
    const known = later.get(key) ?? { holder: sale.holderName, ...(tail === undefined ? {} : { tail }), netMills: 0 };
    known.netMills += Number(sale.netMills);
    later.set(key, known);
  }
  const notCounted = new Map<string, number>();
  for (const sale of data.sales) {
    const label = sale.verdict === "none" && sale.home !== undefined ? HOME_LINES[sale.home.kind] : undefined;
    if (label !== undefined) notCounted.set(label, (notCounted.get(label) ?? 0) + Number(sale.netMills));
  }
  const money: ReviewMoney = {
    origins: salesByOrigin(data),
    split: salesSplit(data),
    beforeNetMills: data.beforeSales.reduce((sum, sale) => sum + Number(sale.netMills), 0),
    later: [...later.values()],
    notCounted: [...notCounted].map(([label, netMills]) => ({ label, netMills })),
  };
  return { shift, totals, money, minutes, sales: sales.sort((a, b) => a.at - b.at), silences: silent, chats: rows };
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
  /** Where the words stand in a chat's messages: a short piece around the first match (none when only the fan's name matched). */
  snippet: (key: string, needle: string) => Snippet | null;
}

/** «…said she was <hey> there…»: the words found, with a little on each side. */
export interface Snippet {
  before: string;
  hit: string;
  after: string;
}

const SNIPPET_SIDE = 28;

function snippetIn(chat: ShiftReviewChat, needle: string): Snippet | null {
  const query = needle.trim().toLowerCase();
  if (query === "") return null;
  // The shift's messages first, then the context before it.
  const messages = [...chat.messages.filter((message) => message.inShift), ...chat.messages.filter((message) => !message.inShift)];
  for (const message of messages) {
    const text = message.text.replace(/\s+/g, " ");
    const at = text.toLowerCase().indexOf(query);
    if (at < 0) continue;
    const from = Math.max(0, at - SNIPPET_SIDE);
    const to = Math.min(text.length, at + query.length + SNIPPET_SIDE);
    return {
      before: `${from > 0 ? "…" : ""}${text.slice(from, at)}`,
      hit: text.slice(at, at + query.length),
      after: `${text.slice(at + query.length, to)}${to < text.length ? "…" : ""}`,
    };
  }
  return null;
}

/** The shift, read and derived once per answer. Off (`enabled` false) for anyone but the owner: Hub answers them 403. */
export function useShiftReview(userId: number, at: string, enabled = true) {
  const query = useQuery({ ...reviewQuery(userId, at), enabled });
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
      snippet: (key, needle) => {
        const chat = data.chats.find((one) => one.key === key);
        return chat ? snippetIn(chat, needle) : null;
      },
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
