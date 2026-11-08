import {
  MASS_SEND_MIN_CHATS,
  SHIFT_REVIEW_AI_LOOKBACK_MINUTES,
  SHIFT_REVIEW_AI_SHARE,
  SHIFT_REVIEW_CONTEXT_MESSAGES,
  SHIFT_REVIEW_LATER_SALES_DAYS,
  SHIFT_REVIEW_NEIGHBOUR_DAYS,
  SHIFT_REVIEW_WAIT_HORIZON_HOURS,
  type ShiftReviewChat,
  type ShiftReviewMessage,
  type ShiftReviewMine,
  type ShiftReviewSale,
  type TeamShiftReviewQuery,
  type TeamShiftReviewResponse,
} from "@agency_hub_core/contracts";
import {
  listAllAutomatedTexts,
  listChatsFanWroteRussian,
  listChatterActivityMinutes,
  listPagesByLabels,
  listSentGenerationLinks,
  listShiftReviewFans,
  listShiftReviewGenerations,
  listShiftReviewMessages,
  listShiftReviewSends,
  listShiftSales,
  listSaleFacts,
  listSaleLastWriters,
  type ShiftReviewGenerationRow,
  type SaleFacts,
  type ShiftReviewMessageRow,
  type ShiftReviewSendRow,
  type ShiftSale,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { requireOwner, type AuthPrincipal } from "./auth.ts";
import {
  SALE_LAST_WRITER_HOURS, lastWriterQuery, readPeopleWork, salesHeldBy, workHoldsSale, type ComputedWork, type PersonWork,
} from "./chatter-shifts.ts";
import { saleKindOf, saleOriginOf, settleSale } from "./chatter-stats.ts";
import { NotFoundError } from "./errors.ts";
import { salesNoShiftHolds, salesOfWork, settleOutsideShifts } from "./team-shift-sales.ts";

/**
 * Команда → «Разбор смены» (`teamShiftReview`, owner, 2026-11-06): one
 * chatter's shift opened up — its minutes, its chats with their transcripts,
 * the waits of its fans, and where the text of each of its messages came from.
 * Facts only; the page reads them. Database only.
 *
 * Where a text came from is the study of 2026-10-29
 * (~/code/8-docs/2026-10-29-chatter-ai-share): a message is the AI's when at
 * least SHIFT_REVIEW_AI_SHARE of its words come straight from an AI text of the
 * same chat made up to SHIFT_REVIEW_AI_LOOKBACK_MINUTES before it — whatever
 * the extension said, since a text copied past «Вставить» is reported as typed.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const TEXT_LIMIT = 2000;
/** The features a chatter sends a text from. */
const SENDABLE_FEATURES = ["fast-reply", "improve-draft", "coach-chat", "ping", "hi-greeting"] as const;
/** What the extension reports for a text put in by one of our AI buttons. */
const AI_BUTTONS = new Set(["reply", "fix", "hi", "ping", "coach"]);
/** A text of this many words or fewer is the chatter's unless an AI button put it there: «haha» is in every AI text. */
const SHORT_WORDS = 3;
/** A text repeated to other fans counts from this many words: «hey babe» is not a template. */
const REPEAT_MIN_WORDS = 4;

const WORD_RE = /[\p{L}\p{N}_']+/gu;
/** The AI's service text sent to a fan (the shift audit's `ai_leak`). */
const LEAK_RE = /\bcop(?:y|ies|ying)\b[^.\n]{0,25}\bsamples?\b|\bsample openers?\b|\bavoid copying\b|\bvary(?: it\b| wording\b|\s*[:.])|\[NEXT\]|```|\bСИТУАЦИЯ:|ЧТО УПУЩЕНО/i;
const DASH_RE = /[—–]/;
const CYRILLIC_RE = /[А-Яа-яЁё]/;
/** A shared run shorter than this is no sign of an AI text in a message that is the chatter's own: «are you», «haha babe». */
const OWN_MATCH_MIN_WORDS = 3;
/** A part of an AI text sent in pieces ([NEXT]) follows the first one within this. */
const PART_WITHIN_MINUTES = 30;

// A Fix draft that is an instruction to the AI, not the chatter's text (the audit of 2026-11-07 on 3,637 Fix drafts).
// Anywhere in it: what to do with the answer («пингани по контексту», «развернуто», «*переформулируй»).
const FIX_ORDER_RE = new RegExp(`(?<!\\p{L})(?:${[
  "по\\s+ко\\p{L}{0,3}ксту", "по\\s+теме", "по\\s+имени",
  "пингани\\p{L}*", "пингуй", "пинг(?!\\p{L})",
  "поблагодари(?:м)?(?!\\p{L})",
  "(?:полу)?ра[зщх]в[её]р(?:нут|ни|нт|тун)",
  "адаптируй", "перефраз", "переформулир", "переделай", "вставь\\s+(?:по|это|этот)(?!\\p{L})",
  "апсейл", "аспейсл", "upsell", "sell(?!\\p{L})",
  "подводк", "продаж", "сочно(?!\\p{L})", "абзац", "поясни", "пояснени",
  "(?:скажи|опиши|ответь|обьясни|объясни|поясни|напиши|спроси|предложи|затизь|перечисли|придумай|пожелай)\\s+(?:ему|его|ей|её|ее|у\\s+него|у\\s+неё|у\\s+нее)(?!\\p{L})",
  "переведи\\s+(?:к|на|плавно)(?!\\p{L})",
].join("|")})`, "iu");
/** The word a draft opens with that orders the AI — unless the draft speaks to the fan: «скажи мне потом как тебе». */
const FIX_ORDER_START_RE = new RegExp(`^[\\s*]*(?:${[
  "напиши", "ответь", "отвечай", "объясни", "обьясни", "скажи", "спроси", "предложи", "придумай", "пошути", "поблагодари",
  "похвали", "извинись", "пожелай", "расскажи", "опиши", "поддержи", "переведи", "уточни", "попрощайся", "поздоровайся",
  "согласись", "перечисли", "учти", "отреагируй", "затизь", "вкинь", "намекни", "обыграй", "игриво", "плавно",
].join("|")})(?!\\p{L})`, "iu");
/** About the answer, not to the fan: an order in a draft with no «я» or «ты» («*короткий поддерживающий ответ»). */
const FIX_ANSWER_WORD_RE = /(?<!\p{L})(?:ответ|answer|тиз|тизинг|доминаци\p{L}*|прощание|извинение|намек|флирт)(?!\p{L})/iu;
/** The model speaking to the fan: I, you. */
const FIX_PERSON_RE = /(?<!\p{L})(?:я|мне|меня|мной|мой|моя|моё|мое|мои|моих|моей|моим|ты|тебе|тебя|тобой|твой|твоя|твоё|твое|твои|твоих|твоей|твоим|вы|вас|вам|ваш|ваша|ваши)(?!\p{L})/iu;
/** The fan spoken of. */
const FIX_FAN_RE = /(?<!\p{L})(?:он|ему|его|него|нему|ним|она|ей|её|ее|ней|неё|нее|фану)(?!\p{L})/iu;

export function wordsOf(text: string): string[] {
  return text.toLowerCase().match(WORD_RE) ?? [];
}

/** The text as a repeat is compared: lower case, words only. */
function normalized(text: string): string {
  return wordsOf(text).join(" ");
}

/**
 * The matching blocks of two word lists, as Python's difflib finds them without
 * junk: the longest common run, then the same on each side of it. Pure.
 */
function matchingBlockSizes(a: readonly string[], b: readonly string[]): number[] {
  const positions = new Map<string, number[]>();
  b.forEach((word, index) => {
    const list = positions.get(word);
    if (list) list.push(index);
    else positions.set(word, [index]);
  });
  const sizes: number[] = [];
  const stack: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]];
  while (stack.length > 0) {
    const [aLow, aHigh, bLow, bHigh] = stack.pop()!;
    let bestI = aLow;
    let bestJ = bLow;
    let best = 0;
    let runs = new Map<number, number>();
    for (let i = aLow; i < aHigh; i += 1) {
      const next = new Map<number, number>();
      for (const j of positions.get(a[i]!) ?? []) {
        if (j < bLow) continue;
        if (j >= bHigh) break;
        const length = (runs.get(j - 1) ?? 0) + 1;
        next.set(j, length);
        if (length > best) {
          bestI = i - length + 1;
          bestJ = j - length + 1;
          best = length;
        }
      }
      runs = next;
    }
    if (best === 0) continue;
    sizes.push(best);
    if (aLow < bestI && bLow < bestJ) stack.push([aLow, bestI, bLow, bestJ]);
    if (bestI + best < aHigh && bestJ + best < bHigh) stack.push([bestI + best, aHigh, bestJ + best, bHigh]);
  }
  return sizes;
}

/** The share of the sent words that come straight from `aiText`: runs of two words or more (one, for a short text). Pure. */
export function aiShareOf(sentWords: readonly string[], aiText: string): number {
  return aiMatchOf(sentWords, aiText).share;
}

/** The share as `aiShareOf` counts it, and the longest run of words the two texts share. Pure. */
function aiMatchOf(sentWords: readonly string[], aiText: string): { share: number; longest: number } {
  const aiWords = wordsOf(aiText);
  if (sentWords.length === 0 || aiWords.length === 0) return { share: 0, longest: 0 };
  const short = sentWords.length <= SHORT_WORDS;
  const sizes = matchingBlockSizes(sentWords, aiWords);
  const taken = sizes.filter((size) => size >= 2 || (short && size >= 1)).reduce((sum, size) => sum + size, 0);
  return { share: taken / sentWords.length, longest: Math.max(0, ...sizes) };
}

/** An order to the AI after an asterisk past the draft's start («yeah sure *разверни»), not «work**» correcting a word. Pure. */
function orderAfterAsterisk(draft: string): boolean {
  const text = draft.trim();
  for (const match of text.matchAll(/\*+/g)) {
    if (match.index === 0 || /[\p{L}\p{N}]/u.test(text[match.index - 1]!)) continue;
    if (/^\s*[а-яё]/iu.test(text.slice(match.index + match[0].length))) return true;
  }
  return false;
}

/**
 * What a Fix's draft was to the text sent from it. `command` — an instruction to the AI («пингани по контексту»,
 * «*развернутый ответ», «скажи ему что…»): the AI wrote the message. `expanded` — the chatter's own draft the AI made far
 * longer. `own` — the chatter's own text, translated or polished. A leading «*» alone orders nothing: some chatters mark
 * every draft with it. Pure.
 */
export function fixDraftKind(draft: string, sent: string): "command" | "expanded" | "own" {
  const person = FIX_PERSON_RE.test(draft);
  if (FIX_ORDER_RE.test(draft) || orderAfterAsterisk(draft)) return "command";
  if (FIX_ORDER_START_RE.test(draft) && (!person || FIX_FAN_RE.test(draft))) return "command";
  if (FIX_ANSWER_WORD_RE.test(draft) && !person) return "command";
  const length = draft.trim().length;
  return sent.length > 2.2 * Math.max(length, 1) && sent.length - length > 60 ? "expanded" : "own";
}

export interface MineInput {
  text: string;
  at: number;
  composedWith: string | null;
  linkedGeneration: string | null;
}

export type MineOrigin = Pick<ShiftReviewMine, "origin" | "aiShare" | "aiFeature" | "aiText" | "draft" | "fixExpanded"> & {
  /** The AI text it was matched to; null — none shown. */
  generationRef: string | null;
};

/**
 * Where a message's text came from among the chat's AI texts. A text that is the chatter's own shows an AI text only
 * when they share a run of OWN_MATCH_MIN_WORDS words, or when the extension linked the message to it (the chatter put
 * it in and replaced it); its share is cut down, not rounded, so it never reads as the threshold. Pure.
 */
export function originOf(message: MineInput, generations: readonly ShiftReviewGenerationRow[]): MineOrigin {
  const none = { aiShare: null, aiFeature: null, aiText: null, draft: null, fixExpanded: false, generationRef: null };
  const words = wordsOf(message.text);
  if (words.length === 0) return { origin: null, ...none };
  type Match = { share: number; longest: number; generation: ShiftReviewGenerationRow };
  let best: Match | null = null;
  let linked: Match | null = null;
  for (const generation of generations) {
    const match = { ...aiMatchOf(words, generation.completion), generation };
    const isLinked = generation.generationRef === message.linkedGeneration;
    if (isLinked) linked = match;
    if (best === null || match.share > best.share || (isLinked && match.share === best.share)) best = match;
  }
  if (best === null) return { origin: "own", ...none };
  const shown = (match: Match, share: number): MineOrigin => ({
    origin: "own",
    aiShare: share,
    aiFeature: match.generation.feature,
    aiText: match.generation.completion.slice(0, TEXT_LIMIT),
    draft: match.generation.feature === "improve-draft" ? match.generation.draft : null,
    fixExpanded: false,
    generationRef: match.generation.generationRef,
  });
  const { share, generation } = best;
  const byButton = message.composedWith !== null && AI_BUTTONS.has(message.composedWith);
  const fromAi = share >= SHIFT_REVIEW_AI_SHARE && (words.length > SHORT_WORDS || byButton || generation.generationRef === message.linkedGeneration);
  if (!fromAi) {
    const cut = (match: Match) => (match.longest < OWN_MATCH_MIN_WORDS ? 0 : Math.floor(match.share * 100) / 100);
    if (linked !== null) return shown(linked, cut(linked));
    if (share > 0 && best.longest >= OWN_MATCH_MIN_WORDS) return shown(best, cut(best));
    return { origin: "own", ...none, aiShare: 0 };
  }
  const kind = generation.feature === "improve-draft" && generation.draft !== null && generation.draft.trim() !== ""
    ? fixDraftKind(generation.draft, message.text) : "command";
  return {
    origin: kind === "command" ? "ai" : "fix",
    aiShare: Math.round(share * 100) / 100,
    aiFeature: generation.feature,
    aiText: generation.completion.slice(0, TEXT_LIMIT),
    draft: generation.feature === "improve-draft" ? generation.draft : null,
    fixExpanded: kind === "expanded",
    generationRef: generation.generationRef,
  };
}

/** The tells in a text. Russian letters count only in a chat whose fan writes no Russian: a Russian fan gets Russian. */
export function marksOf(text: string, fanWritesRussian: boolean): ShiftReviewMine["marks"] {
  const marks: ShiftReviewMine["marks"] = [];
  if (DASH_RE.test(text)) marks.push("dash");
  if (!fanWritesRussian && CYRILLIC_RE.test(text)) marks.push("cyrillic");
  if (LEAK_RE.test(text)) marks.push("leak");
  return marks;
}

export interface ChatMessage extends ShiftReviewMessageRow {
  by: ShiftReviewMessage["by"];
  personal: boolean;
  /** The chatter's reported send that neither the archive nor the page's socket holds yet: it ends a wait, it is not shown. */
  pending: boolean;
}

export interface ChatWait {
  since: number;
  to: number;
  by: "me" | "other" | "none" | null;
  /** The answering message, when it is the chatter's. */
  answerRef: string | null;
  /** Ended by a `pending` send: the answer is still being checked. */
  pending: boolean;
}

/**
 * The waits of one chat, oldest first: from the fan's first message after the
 * page's last personal one (any author's; a mass or automated message answers
 * nobody) to the next personal one, or to `end`. A fan's message older than the
 * horizon is not waited on — before the answer, or, for a wait still open at the
 * end, before the shift's `start` (the window the messages are read in) — and
 * the wait begins at the fan's first message within it: an old unanswered one
 * does not take the fresh ones with it. Pure.
 */
export function waitsOf(messages: readonly ChatMessage[], userId: number, start: number, end: number): ChatWait[] {
  const horizon = SHIFT_REVIEW_WAIT_HORIZON_HOURS * 60 * MINUTE_MS;
  const waits: ChatWait[] = [];
  // The fan's messages since the page's last personal one, oldest first.
  let fanAts: number[] = [];
  const firstAfter = (limit: number) => fanAts.find((at) => at > limit) ?? null;
  for (const message of messages) {
    const at = message.at.getTime();
    if (!message.sent) {
      fanAts.push(at);
      continue;
    }
    if (!message.personal) continue;
    const since = firstAfter(at - horizon);
    if (since !== null) {
      const by = message.by === "me" || message.by === "other" || message.by === "none" ? message.by : "none";
      waits.push({ since, to: at, by, answerRef: message.authorId === userId && !message.pending ? message.ref : null, pending: message.pending });
    }
    fanAts = [];
  }
  const since = firstAfter(start - horizon);
  if (since !== null) waits.push({ since, to: end, by: null, answerRef: null, pending: false });
  return waits;
}

/**
 * The chatter's sends that neither the archive nor the page's socket holds, as
 * the messages that end their fans' waits, by `<page id>:<chat>`. The chat is
 * the reported one: Fansly's group, or on OnlyFans the fan, who is the chat
 * there. Their time is the client's, when the page confirmed the send. Pure.
 */
export function pendingSendsByChat(sends: readonly ShiftReviewSendRow[], userId: number, username: string): Map<string, ChatMessage[]> {
  const out = new Map<string, ChatMessage[]>();
  for (const send of sends) {
    if (send.inArchive || send.inSocket) continue;
    const conv = send.platform === "onlyfans" ? send.fanRef : send.conversationRef;
    if (conv === null) continue;
    const key = `${send.pageId}:${conv}`;
    const message: ChatMessage = {
      pageId: send.pageId, platform: send.platform, conv, ref: send.ref, at: send.observedAt, sent: true, text: "", priceMills: null, tipMills: null,
      media: 0, fanNativeId: null, mass: false, authorId: userId, authorName: username, bought: null, unarchived: true,
      by: "me", personal: true, pending: true,
    };
    out.set(key, [...(out.get(key) ?? []), message]);
  }
  return out;
}

/** The automated-message openings a page message is matched against: the first 40 characters of each, words only. */
function autoOpenings(texts: readonly string[]): string[] {
  return [...new Set(texts.map((text) => normalized(text).slice(0, 40)).filter((opening) => opening.length >= 6))];
}

function chatKey(pageLabel: string, conv: string): string {
  return `${pageLabel}:${conv}`;
}

/** The shift that holds `at` among one person's work, and the shifts around it. Pure. */
export function shiftAround(work: readonly ComputedWork[], at: number): { shift: ComputedWork; previous: ComputedWork | null; next: ComputedWork | null } | null {
  const index = work.findIndex((one) => one.startedAt <= at && at <= one.endedAt);
  if (index === -1) return null;
  const shift = work[index]!;
  const previous = [...work.slice(0, index)].reverse().find((one) => one.kind === "shift") ?? null;
  const next = work.slice(index + 1).find((one) => one.kind === "shift") ?? null;
  return { shift, previous, next };
}

export interface ColleagueWork {
  userId: number;
  username: string;
  work: ComputedWork;
}

export interface SettledSale {
  sale: ShiftSale;
  /** The shift holds it (`salesHeldBy`). */
  held: boolean;
  verdict: ShiftReviewSale["verdict"];
  /** `theirs` — the colleague whose it is; `both` — the colleague it counts for too. */
  holder: string | null;
  /** Who last wrote to the fan in SALE_LAST_WRITER_HOURS before it; null — nobody with an author. */
  lastWriter: number | null;
}

/**
 * Whose each sale on the shift's pages within it is, as «Смены → Заработок»
 * settles it. Of the sales the shift holds (`held`), one another person's
 * overlapping shift holds too is theirs when they were the last to write to the
 * fan, both of theirs when neither was; a look-in's are its own. A sale the
 * shift does not hold is the colleague's whose shift holds it (of several, the
 * one who last wrote), or nobody's. Pure.
 */
export function settleShiftSales(input: {
  userId: number;
  kind: ComputedWork["kind"];
  sales: readonly ShiftSale[];
  held: ReadonlySet<number>;
  colleagues: readonly ColleagueWork[];
  lastWriters: ReadonlyMap<number, number>;
}): SettledSale[] {
  return input.sales.map((sale) => {
    const holders = holdersOfSale(input.colleagues, sale);
    const lastWriter = input.lastWriters.get(sale.transactionId) ?? null;
    const named = (userId: number | null) => holders.find((one) => one.userId === userId) ?? holders[0];
    if (input.held.has(sale.transactionId)) {
      if (input.kind !== "shift") return { sale, held: true, verdict: "mine", holder: null, lastWriter };
      const verdict = settleSale(input.userId, holders.map((one) => one.userId), lastWriter);
      return { sale, held: true, verdict, holder: verdict === "mine" ? null : named(lastWriter)?.username ?? null, lastWriter };
    }
    return holders.length === 0
      ? { sale, held: false, verdict: "none", holder: null, lastWriter }
      : { sale, held: false, verdict: "theirs", holder: named(lastWriter)!.username, lastWriter };
  });
}

/** The shift's sales, net, as «Смены → Заработок» counts them: the ones it holds that are not a colleague's. Pure. */
export function heldNetMills(settled: readonly SettledSale[]): number {
  return settled.reduce((sum, one) => sum + (one.held && one.verdict !== "theirs" ? one.sale.netMills : 0), 0);
}

/** The colleagues whose shifts hold the sale. Pure. */
function holdersOfSale(colleagues: readonly ColleagueWork[], sale: ShiftSale): ColleagueWork[] {
  return colleagues.filter((other) => workHoldsSale(other.work, { pageLabel: sale.pageLabel, at: sale.occurredAt.getTime() }));
}

/**
 * The sales on the shift's pages within it, settled (`settleShiftSales`): the
 * ones it holds as `salesHeldBy` reads them, and the rest of [from, to).
 */
async function shiftSales(
  app: AppContext,
  input: { userId: number; shift: ComputedWork; personPageIds: ReadonlyMap<string, number>; pageIds: readonly number[]; from: Date; to: Date; now: Date },
): Promise<SettledSale[]> {
  const { shift } = input;
  const [held, inWindow] = await Promise.all([
    salesHeldBy(app.db, { userId: input.userId, work: shift, pageIds: input.personPageIds }),
    listShiftSales(app.db, { pageIds: input.pageIds, from: input.from, to: input.to }),
  ]);
  const heldIds = new Set(held.map((sale) => sale.transactionId));
  const read = new Set(inWindow.map((sale) => sale.transactionId));
  const sales = [...inWindow, ...held.filter((sale) => !read.has(sale.transactionId))]
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.transactionId - b.transactionId);
  if (sales.length === 0) return [];
  const people = await readPeopleWork(app.db, {
    from: new Date(shift.startedAt - DAY_MS), to: new Date(Math.min(shift.endedAt + DAY_MS, input.now.getTime())), now: input.now, pages: "all",
  });
  const colleagues = [...people].flatMap(([id, person]) => (id === input.userId ? [] : person.work
    .filter((work) => work.kind === "shift" && work.startedAt < shift.endedAt && work.endedAt > shift.startedAt)
    .map((work) => ({ userId: id, username: person.username, work }))));
  // Who last wrote decides a sale two shifts hold, names the colleague of a sale several hold, and says where each came from.
  const lastWriters = await listSaleLastWriters(app.db, { hours: SALE_LAST_WRITER_HOURS, sales: lastWriterQuery(sales) });
  return settleShiftSales({ userId: input.userId, kind: shift.kind, sales, held: heldIds, colleagues, lastWriters });
}

function piecesOf(people: ReadonlyMap<number, PersonWork>, kind: ComputedWork["kind"]): ColleagueWork[] {
  return [...people].flatMap(([id, person]) => person.work
    .filter((work) => work.kind === kind).map((work) => ({ userId: id, username: person.username, work })));
}

/**
 * Before the shift, no shift's: the sales on its pages from the person's
 * previous shift's end (a day back at most) to its start that no shift or
 * look-in holds (as «Смены» puts them outside shifts), to a fan the person sent
 * the bought PPV to or was the last to write to. With their facts.
 */
async function salesBeforeShift(
  app: AppContext,
  input: { userId: number; start: number; previousEnd: number | null; pageIds: readonly number[]; now: Date },
): Promise<{ sales: SettledSale[]; facts: SaleFacts[] }> {
  const { userId, start, now } = input;
  const from = Math.max(input.previousEnd ?? 0, start - DAY_MS);
  const read = from < start ? await listShiftSales(app.db, { pageIds: input.pageIds, from: new Date(from), to: new Date(start) }) : [];
  if (read.length === 0) return { sales: [], facts: [] };
  const people = await readPeopleWork(app.db, { from: new Date(from - DAY_MS), to: new Date(Math.min(now.getTime(), start + DAY_MS)), now, pages: "all" });
  const shifts = piecesOf(people, "shift").map((one) => ({ ...one, held: salesOfWork(one.work, read) }));
  const unheld = salesNoShiftHolds({ from, to: start, sales: read, shifts });
  const lastWriters = await listSaleLastWriters(app.db, { hours: SALE_LAST_WRITER_HOURS, sales: lastWriterQuery(unheld) });
  const nobodys = settleOutsideShifts(unheld, piecesOf(people, "visit"), lastWriters).filter((one) => one.visit === null).map((one) => one.sale);
  const facts = await listSaleFacts(app.db, { transactionIds: nobodys.map((sale) => sale.transactionId) });
  const sentBy = new Map(facts.map((fact) => [fact.transactionId, fact.ppvSender?.userId ?? null]));
  const lastWriterOf = (sale: ShiftSale) => lastWriters.get(sale.transactionId) ?? null;
  return {
    sales: nobodys
      .filter((sale) => sentBy.get(sale.transactionId) === userId || lastWriterOf(sale) === userId)
      .map((sale) => ({ sale, held: false, verdict: "none", holder: null, lastWriter: lastWriterOf(sale) })),
    facts,
  };
}

/**
 * After the shift: the person's PPVs sent in it that `ppvFans` bought after it,
 * within SHIFT_REVIEW_LATER_SALES_DAYS, and the shift that held each (of
 * several, the one whose person last wrote to the fan). With their facts.
 */
async function salesAfterShift(
  app: AppContext,
  input: { userId: number; start: number; end: number; ppvFans: ReadonlyArray<{ pageId: number; fanId: number }>; now: Date },
): Promise<{ sales: SettledSale[]; facts: SaleFacts[] }> {
  const { userId, start, end, now } = input;
  const to = Math.min(now.getTime(), end + SHIFT_REVIEW_LATER_SALES_DAYS * DAY_MS);
  const ppvFan = new Set(input.ppvFans.map((fan) => `${fan.pageId}:${fan.fanId}`));
  if (ppvFan.size === 0 || end >= to) return { sales: [], facts: [] };
  const bought = (await listShiftSales(app.db, {
    pageIds: [...new Set(input.ppvFans.map((fan) => fan.pageId))], fanIds: [...new Set(input.ppvFans.map((fan) => fan.fanId))], from: new Date(end), to: new Date(to),
  }))
    .filter((sale) => sale.kind === "message_purchase" && ppvFan.has(`${sale.pageId}:${sale.fanId}`));
  const facts = await listSaleFacts(app.db, { transactionIds: bought.map((sale) => sale.transactionId) });
  const factOf = new Map(facts.map((fact) => [fact.transactionId, fact]));
  const mine = bought.filter((sale) => {
    const fact = factOf.get(sale.transactionId);
    const sentAt = fact?.ppvSentAt?.getTime();
    return fact?.ppvSender?.userId === userId && sentAt !== undefined && sentAt >= start && sentAt <= end;
  });
  if (mine.length === 0) return { sales: [], facts };
  const times = mine.map((sale) => sale.occurredAt.getTime());
  const [people, lastWriters] = await Promise.all([
    readPeopleWork(app.db, { from: new Date(Math.min(...times) - DAY_MS), to: new Date(Math.min(now.getTime(), Math.max(...times) + DAY_MS)), now, pages: "all" }),
    listSaleLastWriters(app.db, { hours: SALE_LAST_WRITER_HOURS, sales: lastWriterQuery(mine) }),
  ]);
  const shifts = piecesOf(people, "shift");
  return {
    sales: mine.map((sale) => {
      const lastWriter = lastWriters.get(sale.transactionId) ?? null;
      const holders = holdersOfSale(shifts, sale);
      const holder = holders.find((one) => one.userId === lastWriter) ?? holders[0];
      return { sale, held: false, verdict: holder === undefined ? "none" : "theirs", holder: holder?.username ?? null, lastWriter };
    }),
    facts,
  };
}

export async function readTeamShiftReview(
  app: AppContext,
  principal: AuthPrincipal,
  query: TeamShiftReviewQuery,
): Promise<TeamShiftReviewResponse> {
  requireOwner(principal);
  const now = new Date();
  const at = Date.parse(query.at);
  // The person's work SHIFT_REVIEW_NEIGHBOUR_DAYS around `at`, for the shifts before and after too, and a day more: a shift
  // the window cuts at its start is not whole. One person's fortnight reads as fast as their three days.
  const windowFrom = at - (SHIFT_REVIEW_NEIGHBOUR_DAYS + 1) * DAY_MS;
  const people = await readPeopleWork(app.db, {
    from: new Date(windowFrom),
    to: new Date(Math.min(at + (SHIFT_REVIEW_NEIGHBOUR_DAYS + 1) * DAY_MS, now.getTime())),
    now,
    pages: "all",
    userId: query.userId,
  });
  const person = people.get(query.userId);
  const found = person === undefined ? null : shiftAround(person.work, at);
  if (person === undefined || found === null) throw new NotFoundError("The person has no shift at that time");
  const { shift } = found;
  const previous = found.previous !== null && found.previous.startedAt >= windowFrom + DAY_MS ? found.previous : null;
  const start = shift.startedAt;
  const end = shift.ongoing ? now.getTime() : shift.endedAt;
  const from = new Date(start);
  const to = new Date(end + 1);

  // The pages as «Смены» lists them: most messages first, then most active minutes.
  const labels = [...new Set([...shift.pages.keys(), ...shift.messages.keys()])]
    .sort((a, b) => (shift.messages.get(b) ?? 0) - (shift.messages.get(a) ?? 0) || (shift.pages.get(b) ?? 0) - (shift.pages.get(a) ?? 0) || a.localeCompare(b));
  const known = await listPagesByLabels(app.db, labels);
  const pages = labels.flatMap((label) => known.filter((page) => page.label === label));
  const pageIds = pages.map((page) => page.id);
  // A page the shift works (holds the sales of) brings in all its fans' chats, going on or over alike; a page only looked
  // at, just the chats the person wrote in. A look-in works none.
  const worked = (label: string) => shift.kind === "shift" && shift.salesSince.has(label);
  const workedPageIds = pages.filter((page) => worked(page.label)).map((page) => page.id);
  const labelOf = new Map(pages.map((page) => [page.id, page.label]));

  const [rows, sends, generations, autoTexts, minutes, sales, before] = await Promise.all([
    listShiftReviewMessages(app.db, {
      userId: query.userId, pageIds, workedPageIds, from, to, horizonHours: SHIFT_REVIEW_WAIT_HORIZON_HOURS, burstMinChats: MASS_SEND_MIN_CHATS,
    }),
    listShiftReviewSends(app.db, { userId: query.userId, pageIds, from, to }),
    listShiftReviewGenerations(app.db, {
      userId: query.userId, pageIds, from: new Date(start - SHIFT_REVIEW_AI_LOOKBACK_MINUTES * MINUTE_MS), to, features: SENDABLE_FEATURES,
    }),
    listAllAutomatedTexts(app.db),
    listChatterActivityMinutes(app.db, { from, to, pages: pageIds, userId: query.userId }),
    shiftSales(app, { userId: query.userId, shift, personPageIds: person.pageIds, pageIds, from, to, now }),
    shift.kind === "shift"
      ? salesBeforeShift(app, { userId: query.userId, start, previousEnd: found.previous?.endedAt ?? null, pageIds, now })
      : Promise.resolve({ sales: [], facts: [] }),
  ]);
  const links = await listSentGenerationLinks(app.db, {
    refs: sends.map((send) => send.ref), from: new Date(start - 5 * MINUTE_MS), to: new Date(end + 60 * MINUTE_MS),
  });
  const sendByRef = new Map(sends.map((send) => [`${send.pageId}:${send.ref}`, send]));
  const openings = autoOpenings(autoTexts);

  // The chats, their messages oldest first, each page message's author.
  const chats = new Map<string, { pageId: number; platform: string; conv: string; messages: ChatMessage[] }>();
  for (const row of rows) {
    const key = `${row.pageId}:${row.conv}`;
    const chat = chats.get(key) ?? { pageId: row.pageId, platform: row.platform, conv: row.conv, messages: [] };
    let by: ShiftReviewMessage["by"] = null;
    if (row.sent) {
      if (row.authorId === query.userId) by = "me";
      else if (row.authorId !== null) by = "other";
      else {
        const text = normalized(row.text);
        by = text !== "" && openings.some((opening) => text.startsWith(opening)) ? "auto" : "none";
      }
    }
    chat.messages.push({ ...row, by, personal: row.sent && !row.mass && by !== "auto", pending: false });
    chats.set(key, chat);
  }
  const pendingSends = pendingSendsByChat(sends, query.userId, person.username);

  // A chat where the chatter wrote Russian to a fan with no Russian in the window: the fan's whole history says.
  const russianAsked = [...chats.values()].filter((chat) => !chat.messages.some((message) => !message.sent && CYRILLIC_RE.test(message.text))
    && chat.messages.some((message) => message.by === "me" && message.at.getTime() >= start && CYRILLIC_RE.test(message.text)));
  const [fans, wroteRussian] = await Promise.all([
    listShiftReviewFans(app.db, { chats: [...chats.values()].map((chat) => ({ pageId: chat.pageId, conv: chat.conv })), from, to }),
    listChatsFanWroteRussian(app.db, russianAsked.map((chat) => ({ pageId: chat.pageId, conv: chat.conv }))),
  ]);
  const fanOf = new Map(fans.map((fan) => [`${fan.pageId}:${fan.conv}`, fan]));

  // The chatter's texts of the shift by chat, for repeats. A Hi greeting is the page's A/B set: the same by design.
  const mineText = new Map<string, Set<string>>();
  for (const [key, chat] of chats) {
    for (const message of chat.messages) {
      const atMs = message.at.getTime();
      if (message.by !== "me" || atMs < start || atMs > end) continue;
      if (sendByRef.get(`${message.pageId}:${message.ref}`)?.composedWith === "hi") continue;
      const text = normalized(message.text);
      if (text.split(" ").length < REPEAT_MIN_WORDS) continue;
      const seen = mineText.get(text) ?? new Set<string>();
      seen.add(key);
      mineText.set(text, seen);
    }
  }

  const out: ShiftReviewChat[] = [];
  const waits: TeamShiftReviewResponse["waits"] = [];
  const chatOfFan = new Map<string, string>();
  for (const [key, chat] of chats) {
    const pageLabel = labelOf.get(chat.pageId) ?? String(chat.pageId);
    const fan = fanOf.get(key);
    const fanRef = fan?.fanRef ?? chat.messages.find((message) => !message.sent && message.fanNativeId !== null)?.fanNativeId ?? null;
    const pending = pendingSends.get(key) ?? [];
    const answers = pending.length === 0 ? chat.messages : [...chat.messages, ...pending].sort((a, b) => a.at.getTime() - b.at.getTime());
    const chatWaits = waitsOf(answers, query.userId, start, end).filter((wait) => wait.to > start && wait.since < end);
    // A chat with nothing in the shift is here for a fan waiting at its start; past the wait horizon there is no wait, and no
    // chat. One holding a send of the shift stays, though the archive may date it a few seconds before the start.
    if (chatWaits.length === 0 && !chat.messages.some((message) => (message.at.getTime() >= start && message.at.getTime() <= end)
      || (message.by === "me" && sendByRef.has(`${message.pageId}:${message.ref}`)))) continue;
    const replyByRef = new Map<string, number>();
    for (const wait of chatWaits) {
      waits.push({
        chat: chatKey(pageLabel, chat.conv),
        since: new Date(wait.since).toISOString(),
        from: new Date(Math.max(wait.since, start)).toISOString(),
        to: new Date(Math.min(wait.to, end)).toISOString(),
        by: wait.by,
        pending: wait.pending,
      });
      if (wait.answerRef !== null) replyByRef.set(wait.answerRef, Math.round((wait.to - Math.max(wait.since, start)) / 1000));
    }
    const chatGenerations = generations.filter((generation) => generation.pageId === chat.pageId
      && (generation.conv === chat.conv || (fanRef !== null && generation.fanRef === fanRef)));

    const fanKey = fan === undefined || fan.fanId === null ? null : `${chat.pageId}:${fan.fanId}`;
    if (fanKey !== null && !chatOfFan.has(fanKey)) chatOfFan.set(fanKey, chatKey(pageLabel, chat.conv));
    const fanWritesRussian = wroteRussian.has(key) || chat.messages.some((message) => !message.sent && CYRILLIC_RE.test(message.text));
    // The AI texts this chat's earlier messages of the shift were sent from by a button, for the later parts of one.
    const byButton: Array<{ generationRef: string; composedWith: string; at: number }> = [];
    const before = chat.messages.filter((message) => message.at.getTime() < start);
    const shown = [...before.slice(-SHIFT_REVIEW_CONTEXT_MESSAGES), ...chat.messages.filter((message) => message.at.getTime() >= start)];
    out.push({
      key: chatKey(pageLabel, chat.conv),
      pageLabel,
      platform: chat.platform,
      conversationRef: chat.conv,
      fanRef,
      fanUsername: fan?.username ?? null,
      fanDisplayName: fan?.displayName ?? null,
      fanLifetimeNetMills: fan?.lifetimeNetMills ?? null,
      shiftNetMills: fan?.shiftNetMills ?? 0,
      earlierHidden: Math.max(0, before.length - SHIFT_REVIEW_CONTEXT_MESSAGES),
      messages: shown.map((message): ShiftReviewMessage => {
        const atMs = message.at.getTime();
        const inShift = atMs >= start && atMs <= end;
        let mine: ShiftReviewMine | null = null;
        if (message.by === "me" && inShift) {
          const send = sendByRef.get(`${message.pageId}:${message.ref}`);
          const nearby = chatGenerations.filter((generation) => {
            const made = generation.createdAt.getTime();
            return made >= atMs - SHIFT_REVIEW_AI_LOOKBACK_MINUTES * MINUTE_MS && made <= atMs + MINUTE_MS;
          });
          const linked = links.get(message.ref) ?? null;
          const linkedRow = linked === null ? undefined : generations.find((generation) => generation.generationRef === linked);
          const candidates = linkedRow === undefined || nearby.includes(linkedRow) ? nearby : [...nearby, linkedRow];
          const text = normalized(message.text);
          const composedWith = send?.composedWith ?? null;
          const { generationRef, ...origin } = originOf({ text: message.text, at: atMs, composedWith, linkedGeneration: linked }, candidates);
          // The second part of a Reply ([NEXT]) the extension saw typed: the part of a text a button put in.
          const parts = generationRef === null || origin.origin === "own" || (composedWith !== null && AI_BUTTONS.has(composedWith)) ? []
            : byButton.filter((one) => one.generationRef === generationRef && one.at >= atMs - PART_WITHIN_MINUTES * MINUTE_MS);
          if (generationRef !== null && composedWith !== null && AI_BUTTONS.has(composedWith)) byButton.push({ generationRef, composedWith, at: atMs });
          const hi = composedWith === "hi" || origin.aiFeature === "hi-greeting";
          mine = {
            composedWith: parts[0]?.composedWith ?? composedWith,
            ...(parts.length === 0 ? {} : { part: parts.length + 1 }),
            edited: send?.edited ?? null,
            ...origin,
            replySeconds: replyByRef.get(message.ref) ?? null,
            repeats: hi ? 0 : Math.max(0, (mineText.get(text)?.size ?? 1) - 1),
            marks: marksOf(message.text, fanWritesRussian),
          };
        }
        return {
          ref: message.ref,
          at: message.at.toISOString(),
          side: message.sent ? "page" : "fan",
          text: message.text,
          priceMills: message.priceMills,
          bought: message.bought,
          tipMills: message.tipMills,
          media: message.media,
          inShift,
          by: message.by,
          byName: message.by === "other" ? message.authorName : null,
          mass: message.mass,
          unarchived: message.unarchived,
          mine,
        };
      }),
    });
  }
  out.sort((a, b) => firstInShift(a) - firstInShift(b) || a.key.localeCompare(b.key));
  waits.sort((a, b) => Date.parse(a.from) - Date.parse(b.from));

  // Each sale in its fan's chat: the ones the shift holds, and the rest to the fans of the chats shown; with its facts. And
  // the person's money around the shift: before it, no shift's; after it, their PPVs of the shift bought later.
  const chatOfSale = (one: SettledSale) => (one.sale.fanId === null ? null : chatOfFan.get(`${one.sale.pageId}:${one.sale.fanId}`) ?? null);
  const listed = sales.filter((one) => one.held || chatOfSale(one) !== null);
  const ppvFans = [...chats].flatMap(([key, chat]) => {
    const fanId = fanOf.get(key)?.fanId ?? null;
    const sentPpv = chat.messages.some((message) => message.by === "me" && message.priceMills !== null
      && message.at.getTime() >= start && message.at.getTime() <= end);
    return fanId === null || !sentPpv ? [] : [{ pageId: chat.pageId, fanId }];
  });
  const [listedFacts, after] = await Promise.all([
    listSaleFacts(app.db, { transactionIds: listed.map((one) => one.sale.transactionId) }),
    shift.kind === "shift" ? salesAfterShift(app, { userId: query.userId, start, end, ppvFans, now }) : Promise.resolve({ sales: [], facts: [] }),
  ]);
  const facts = new Map([...listedFacts, ...before.facts, ...after.facts].map((fact) => [fact.transactionId, fact]));
  const rowOf = (one: SettledSale): TeamShiftReviewResponse["sales"][number] => {
    const fact = facts.get(one.sale.transactionId);
    const writers = fact?.writers ?? [];
    return {
      saleRef: String(one.sale.transactionId),
      at: one.sale.occurredAt.toISOString(),
      pageLabel: one.sale.pageLabel,
      fanRef: one.sale.fanRef,
      fanName: one.sale.fanName,
      chatKey: chatOfSale(one),
      kind: saleKindOf(one.sale.kind),
      netMills: one.sale.netMills,
      verdict: one.verdict,
      holderName: one.holder,
      ppvSender: fact?.ppvSender?.username ?? null,
      ppvSentAt: fact?.ppvSentAt?.toISOString() ?? null,
      lastWriter: one.lastWriter === null ? null : writers.find((writer) => writer.userId === one.lastWriter)?.username ?? null,
      writers: writers.map((writer) => ({ name: writer.username, messages: writer.messages })),
      origin: saleOriginOf(query.userId, {
        kind: one.sale.kind,
        ppvSenderId: fact?.ppvSender?.userId ?? null,
        ppvWithoutAuthor: fact?.ppvWithoutAuthor ?? false,
        postTip: fact?.postTip ?? false,
        campaign: fact?.campaign ?? false,
        lastWriter: one.lastWriter,
      }),
    };
  };

  // A minute counts as active when any of the shift's pages had an action in it.
  const activity = new Map<number, boolean>();
  for (const minute of minutes) {
    const ms = minute.minute.getTime();
    activity.set(ms, (activity.get(ms) ?? false) || minute.input);
  }

  return {
    shift: {
      userId: query.userId,
      username: person.username,
      kind: shift.kind,
      startedAt: new Date(start).toISOString(),
      endedAt: new Date(end).toISOString(),
      ongoing: shift.ongoing,
      workedMinutes: shift.workedMinutes,
      pauses: shift.pauses.map((pause) => ({ from: new Date(pause.from).toISOString(), to: new Date(pause.to).toISOString() })),
      lastInputAt: new Date(shift.lastInputAt).toISOString(),
      lastBeatAt: new Date(shift.lastBeatAt).toISOString(),
      pages: pages.map((page) => ({
        pageLabel: page.label, platform: page.platform, messages: shift.messages.get(page.label) ?? 0, worked: worked(page.label),
      })),
      salesNetMills: heldNetMills(sales),
    },
    previousAt: previous === null ? null : new Date(previous.startedAt).toISOString(),
    nextAt: found.next === null ? null : new Date(found.next.startedAt).toISOString(),
    activity: [...activity].sort((a, b) => a[0] - b[0]).map(([ms, input]) => ({ at: new Date(ms).toISOString(), input })),
    chats: out,
    sales: listed.map(rowOf),
    beforeSales: before.sales.map(rowOf),
    laterSales: after.sales.map(rowOf),
    waits,
    unarchived: sends.filter((send) => !send.inArchive && !send.inSocket).length,
    deleted: sends.filter((send) => send.deleted).length,
    serverNow: now.toISOString(),
  };
}

function firstInShift(chat: ShiftReviewChat): number {
  const first = chat.messages.find((message) => message.inShift);
  return first === undefined ? Number.POSITIVE_INFINITY : Date.parse(first.at);
}
