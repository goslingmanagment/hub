import {
  MASS_SEND_MIN_CHATS,
  SHIFT_REVIEW_AI_LOOKBACK_MINUTES,
  SHIFT_REVIEW_AI_SHARE,
  SHIFT_REVIEW_CONTEXT_MESSAGES,
  SHIFT_REVIEW_WAIT_HORIZON_HOURS,
  type ShiftReviewChat,
  type ShiftReviewMessage,
  type ShiftReviewMine,
  type TeamShiftReviewQuery,
  type TeamShiftReviewResponse,
} from "@agency_hub_core/contracts";
import {
  listAllAutomatedTexts,
  listChatterActivityMinutes,
  listPagesByLabels,
  listSentGenerationLinks,
  listShiftReviewFans,
  listShiftReviewGenerations,
  listShiftReviewMessages,
  listShiftReviewSends,
  listSaleLastWriters,
  type ShiftReviewGenerationRow,
  type ShiftReviewMessageRow,
  type ShiftSale,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { requireOwner, type AuthPrincipal } from "./auth.ts";
import { SALE_LAST_WRITER_HOURS, lastWriterQuery, readPeopleWork, salesHeldBy, workHoldsSale, type ComputedWork } from "./chatter-shifts.ts";
import { settleSale } from "./chatter-stats.ts";
import { NotFoundError } from "./errors.ts";

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
/** Shifts this far around `at` are read, so the neighbours are found too. */
const NEIGHBOUR_DAYS = 3;
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
const LEAK_RE = /\bcop(?:y|ies|ying)\b[^.\n]{0,25}\bsamples?\b|\bsample openers?\b|\bavoid copying\b|\bvary(?: it\b| wording\b|\s*[:.])|\bit'?s fine though\b|\bthat could read as\b|\[NEXT\]|```|\bСИТУАЦИЯ:|ЧТО УПУЩЕНО/i;
const DASH_RE = /[—–]/;
const CYRILLIC_RE = /[А-Яа-яЁё]/;
/** A Fix draft that is an instruction, not a text: the AI wrote the message (the study's rule). */
const FIX_COMMAND_RE = /^\s*(\*|напиши|ответь|объясни|обьясни|скажи|спроси|предложи|придумай|сделай|пошути|поблагодари|похвали|извинись|пожелай|расскажи|опиши|поддержи|переведи|уточни|можно|нужно|надо|типо|типа|короче)/i;

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
  const aiWords = wordsOf(aiText);
  if (sentWords.length === 0 || aiWords.length === 0) return 0;
  const short = sentWords.length <= SHORT_WORDS;
  const taken = matchingBlockSizes(sentWords, aiWords).filter((size) => size >= 2 || (short && size >= 1)).reduce((sum, size) => sum + size, 0);
  return taken / sentWords.length;
}

/** A Fix whose draft is an instruction («*развёрнутый ответ», «скажи что…») or far shorter than what came back. Pure. */
export function isFixCommand(draft: string, completion: string): boolean {
  return FIX_COMMAND_RE.test(draft) || (completion.length > 2.2 * Math.max(draft.length, 1) && completion.length - draft.length > 60);
}

export interface MineInput {
  text: string;
  at: number;
  composedWith: string | null;
  linkedGeneration: string | null;
}

/** Where a message's text came from among the chat's AI texts. Pure. */
export function originOf(
  message: MineInput,
  generations: readonly ShiftReviewGenerationRow[],
): Pick<ShiftReviewMine, "origin" | "aiShare" | "aiFeature" | "aiText" | "draft"> {
  const words = wordsOf(message.text);
  if (words.length === 0) return { origin: null, aiShare: null, aiFeature: null, aiText: null, draft: null };
  let best: { share: number; generation: ShiftReviewGenerationRow } | null = null;
  for (const generation of generations) {
    const share = aiShareOf(words, generation.completion);
    const linked = generation.generationRef === message.linkedGeneration;
    if (best === null || share > best.share || (linked && share === best.share)) best = { share, generation };
  }
  if (best === null) return { origin: "own", aiShare: null, aiFeature: null, aiText: null, draft: null };
  const { share, generation } = best;
  const byButton = message.composedWith !== null && AI_BUTTONS.has(message.composedWith);
  const fromAi = share >= SHIFT_REVIEW_AI_SHARE && (words.length > SHORT_WORDS || byButton || generation.generationRef === message.linkedGeneration);
  const ownDraft = generation.feature === "improve-draft" && generation.draft !== null && generation.draft.trim() !== ""
    && !isFixCommand(generation.draft, generation.completion);
  return {
    origin: !fromAi ? "own" : ownDraft ? "fix" : "ai",
    aiShare: Math.round(share * 100) / 100,
    aiFeature: share > 0 ? generation.feature : null,
    aiText: share > 0 ? generation.completion.slice(0, TEXT_LIMIT) : null,
    draft: share > 0 && generation.feature === "improve-draft" ? generation.draft : null,
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

interface ChatMessage extends ShiftReviewMessageRow {
  by: ShiftReviewMessage["by"];
  personal: boolean;
}

export interface ChatWait {
  since: number;
  to: number;
  by: "me" | "other" | "none" | null;
  /** The answering message, when it is the chatter's. */
  answerRef: string | null;
}

/**
 * The waits of one chat, oldest first: from the fan's first message after the
 * page's last personal one (any author's; a mass or automated message answers
 * nobody) to the next personal one, or to `end`. A fan's message older than the
 * horizon before the answer is not waited on. Pure.
 */
export function waitsOf(messages: readonly ChatMessage[], userId: number, end: number): ChatWait[] {
  const horizon = SHIFT_REVIEW_WAIT_HORIZON_HOURS * 60 * MINUTE_MS;
  const waits: ChatWait[] = [];
  let since: number | null = null;
  for (const message of messages) {
    const at = message.at.getTime();
    if (!message.sent) {
      since ??= at;
      continue;
    }
    if (!message.personal) continue;
    if (since !== null && since > at - horizon) {
      const by = message.by === "me" || message.by === "other" || message.by === "none" ? message.by : "none";
      waits.push({ since, to: at, by, answerRef: message.authorId === userId ? message.ref : null });
    }
    since = null;
  }
  if (since !== null && since > end - horizon) waits.push({ since, to: end, by: null, answerRef: null });
  return waits;
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

/**
 * The shift's sales as «Смены → Заработок» settles them: of the sales it holds
 * (`salesHeldBy`), one another person's overlapping shift holds too is theirs
 * when they were the last to write to the fan.
 */
async function settledSales(app: AppContext, userId: number, shift: ComputedWork, pageIds: ReadonlyMap<string, number>, now: Date): Promise<ShiftSale[]> {
  const held = await salesHeldBy(app.db, { userId, work: shift, pageIds });
  if (shift.kind !== "shift" || held.length === 0) return held;
  const people = await readPeopleWork(app.db, {
    from: new Date(shift.startedAt - DAY_MS), to: new Date(Math.min(shift.endedAt + DAY_MS, now.getTime())), now, pages: "all",
  });
  const others = [...people].flatMap(([id, person]) => (id === userId ? [] : person.work
    .filter((work) => work.kind === "shift" && work.startedAt < shift.endedAt && work.endedAt > shift.startedAt)
    .map((work) => ({ userId: id, work }))));
  const holdersOf = (sale: ShiftSale) => others
    .filter((other) => workHoldsSale(other.work, { pageLabel: sale.pageLabel, at: sale.occurredAt.getTime() }))
    .map((other) => other.userId);
  const contested = held.filter((sale) => holdersOf(sale).length > 0);
  if (contested.length === 0) return held;
  const lastWriters = await listSaleLastWriters(app.db, { hours: SALE_LAST_WRITER_HOURS, sales: lastWriterQuery(contested) });
  return held.filter((sale) => settleSale(userId, holdersOf(sale), lastWriters.get(sale.transactionId) ?? null) !== "theirs");
}

export async function readTeamShiftReview(
  app: AppContext,
  principal: AuthPrincipal,
  query: TeamShiftReviewQuery,
): Promise<TeamShiftReviewResponse> {
  requireOwner(principal);
  const now = new Date();
  const at = Date.parse(query.at);
  const people = await readPeopleWork(app.db, {
    from: new Date(at - NEIGHBOUR_DAYS * DAY_MS),
    to: new Date(Math.min(at + NEIGHBOUR_DAYS * DAY_MS, now.getTime())),
    now,
    pages: "all",
    userId: query.userId,
  });
  const person = people.get(query.userId);
  const found = person === undefined ? null : shiftAround(person.work, at);
  if (person === undefined || found === null) throw new NotFoundError("The person has no shift at that time");
  const { shift } = found;
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

  const [rows, sends, generations, autoTexts, minutes, sales] = await Promise.all([
    listShiftReviewMessages(app.db, {
      userId: query.userId, pageIds, workedPageIds, from, to, horizonHours: SHIFT_REVIEW_WAIT_HORIZON_HOURS, burstMinChats: MASS_SEND_MIN_CHATS,
    }),
    listShiftReviewSends(app.db, { userId: query.userId, pageIds, from, to }),
    listShiftReviewGenerations(app.db, {
      userId: query.userId, pageIds, from: new Date(start - SHIFT_REVIEW_AI_LOOKBACK_MINUTES * MINUTE_MS), to, features: SENDABLE_FEATURES,
    }),
    listAllAutomatedTexts(app.db),
    listChatterActivityMinutes(app.db, { from, to, pages: pageIds, userId: query.userId }),
    settledSales(app, query.userId, shift, person.pageIds, now),
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
    chat.messages.push({ ...row, by, personal: row.sent && !row.mass && by !== "auto" });
    chats.set(key, chat);
  }

  const fans = await listShiftReviewFans(app.db, { chats: [...chats.values()].map((chat) => ({ pageId: chat.pageId, conv: chat.conv })), from, to });
  const fanOf = new Map(fans.map((fan) => [`${fan.pageId}:${fan.conv}`, fan]));

  // The chatter's texts of the shift by chat, for repeats.
  const mineText = new Map<string, Set<string>>();
  for (const [key, chat] of chats) {
    for (const message of chat.messages) {
      const atMs = message.at.getTime();
      if (message.by !== "me" || atMs < start || atMs > end) continue;
      const text = normalized(message.text);
      if (text.split(" ").length < REPEAT_MIN_WORDS) continue;
      const seen = mineText.get(text) ?? new Set<string>();
      seen.add(key);
      mineText.set(text, seen);
    }
  }

  const out: ShiftReviewChat[] = [];
  const waits: TeamShiftReviewResponse["waits"] = [];
  for (const [key, chat] of chats) {
    const pageLabel = labelOf.get(chat.pageId) ?? String(chat.pageId);
    const fan = fanOf.get(key);
    const fanRef = fan?.fanRef ?? chat.messages.find((message) => !message.sent && message.fanNativeId !== null)?.fanNativeId ?? null;
    const chatWaits = waitsOf(chat.messages, query.userId, end).filter((wait) => wait.to > start && wait.since < end);
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
      });
      if (wait.answerRef !== null) replyByRef.set(wait.answerRef, Math.round((wait.to - Math.max(wait.since, start)) / 1000));
    }
    const chatGenerations = generations.filter((generation) => generation.pageId === chat.pageId
      && (generation.conv === chat.conv || (fanRef !== null && generation.fanRef === fanRef)));

    const fanWritesRussian = chat.messages.some((message) => !message.sent && CYRILLIC_RE.test(message.text));
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
          mine = {
            composedWith: send?.composedWith ?? null,
            edited: send?.edited ?? null,
            ...originOf({ text: message.text, at: atMs, composedWith: send?.composedWith ?? null, linkedGeneration: linked }, candidates),
            replySeconds: replyByRef.get(message.ref) ?? null,
            repeats: Math.max(0, (mineText.get(text)?.size ?? 1) - 1),
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
          mine,
        };
      }),
    });
  }
  out.sort((a, b) => firstInShift(a) - firstInShift(b) || a.key.localeCompare(b.key));
  waits.sort((a, b) => Date.parse(a.from) - Date.parse(b.from));

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
      salesNetMills: sales.reduce((sum, sale) => sum + sale.netMills, 0),
    },
    previousAt: found.previous === null ? null : new Date(found.previous.startedAt).toISOString(),
    nextAt: found.next === null ? null : new Date(found.next.startedAt).toISOString(),
    activity: [...activity].sort((a, b) => a[0] - b[0]).map(([ms, input]) => ({ at: new Date(ms).toISOString(), input })),
    chats: out,
    waits,
    unarchived: sends.filter((send) => !send.inArchive).length,
    deleted: sends.filter((send) => send.deleted).length,
    serverNow: now.toISOString(),
  };
}

function firstInShift(chat: ShiftReviewChat): number {
  const first = chat.messages.find((message) => message.inShift);
  return first === undefined ? Number.POSITIVE_INFINITY : Date.parse(first.at);
}
