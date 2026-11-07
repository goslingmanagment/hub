import type { ShiftReviewChat, ShiftReviewMessage } from "@agency_hub_core/contracts";
import { formatCount, formatMills, formatOf, unbreakable } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { REPLY_NORM_SECONDS, aiUnedited, isHi, waitText, type ChatSummary, type ReviewWait } from "@agency_hub_core/ui/shiftReview";
import type { ChatReason, ReasonKind, ReviewChatRow, ReviewFilter, ReviewShift } from "./data.js";

/**
 * «Стоит посмотреть» (spec §4.2 r2, D8): a selection, not 40 % of the shift.
 * Only a strong reason puts a chat there; a weak one is said on the chat's card
 * and keeps it in the other lists («Без ответа», «Долго ждали», «Платные»).
 * Every threshold is here, in one place: the owner sees them, and they are
 * checked on real shifts in phase 3, when Hub answers the reasons itself.
 */
export const LOOK = {
  /** A fan's wait is a strong reason from twice the reply norm (10 мин) and at least 20 min. */
  waitSeconds: Math.max(2 * REPLY_NORM_SECONDS, 20 * 60),
  /** Money of the chat in the shift (bought paid messages, tips, sales): from $25. */
  paidMills: 25_000,
  /** «ИИ без правки» is strong when it is every text of the chat, and the chat has at least this many… */
  aiAllMinTexts: 2,
  /** …or when this many of the chatter's texts in a row are the AI's sent as they came. */
  aiRunMin: 3,
  /** The same text sent to at least this many fans of the shift (this one included); one chat of it is enough to read. */
  repeatFans: 3,
  /** At most so many of each kind, the strongest: the longest waits, the most money, the most AI. */
  most: { waited: 4, paid: 3, ai: 3 } as Partial<Record<ReasonKind, number>>,
  /** At most so many chats with reasons; the rest of them stay in the other lists. */
  max: 12,
  /** Ordinary dialogs added for comparison: the owner also sees normal work. */
  samples: 2,
} as const;

/** The order of the selection: what to read first. Lower first. */
const TIER: Record<ReasonKind, number> = {
  unanswered: 0,
  leak: 0,
  waited: 1,
  ai: 2,
  repeat: 2,
  paid: 3,
  sample: 8,
  offer: 9,
  mark: 9,
  note: 9,
};

const at = (message: ShiftReviewMessage) => Date.parse(message.at);

/** The fan's message a wait began with (the wait's `since`), else the fan's first in the shift after it. */
function fanMessageAt(chat: ShiftReviewChat, since: number | null): string | null {
  const fan = chat.messages.filter((message) => message.side === "fan");
  const exact = since === null ? undefined : fan.find((message) => at(message) === since);
  return (exact ?? fan.find((message) => message.inShift && (since === null || at(message) >= since)) ?? fan.find((message) => message.inShift))?.ref ?? null;
}

/** The longest run of the chatter's texts in a row that are the AI's sent as they came. */
function longestRun(texts: readonly ShiftReviewMessage[]): { length: number; first: string | null } {
  let best = { length: 0, first: null as string | null };
  let run = 0;
  let first: string | null = null;
  for (const message of texts) {
    if (aiUnedited(message.mine!)) {
      if (run === 0) first = message.ref;
      run += 1;
      if (run > best.length) best = { length: run, first };
    } else run = 0;
  }
  return best;
}

const words = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * One chat of the shift as a row of the index: its reasons — strong ones
 * first — where each of them is in the conversation, and in which lists it
 * stands. `selectLook` then keeps the strongest of the shift.
 */
export function rowOf(summary: ChatSummary, shift: ReviewShift, waits: readonly ReviewWait[]): ReviewChatRow {
  const { chat } = summary;
  const inShift = chat.messages.filter((message) => message.inShift);
  const personal = inShift.filter((message) => message.mine !== null && !message.mass);
  const texts = personal.filter((message) => message.mine!.origin !== null && !isHi(message.mine!));
  const raw = texts.filter((message) => aiUnedited(message.mine!));
  const run = longestRun(texts);
  const bought = inShift.filter((message) => message.mine !== null && message.bought === true);
  const boughtMills = bought.reduce((sum, message) => sum + Number(message.priceMills ?? 0), 0);
  const tips = inShift.filter((message) => message.side === "fan" && Number(message.tipMills ?? 0) > 0);
  const tipMills = tips.reduce((sum, message) => sum + Number(message.tipMills ?? 0), 0);
  const paidMills = Math.max(Number(chat.shiftNetMills), boughtMills + tipMills);
  const firstWith = (test: (message: ShiftReviewMessage) => boolean) => personal.find(test) ?? null;
  const repeated = personal.reduce<ShiftReviewMessage | null>((best, message) => (message.mine!.repeats > (best?.mine!.repeats ?? 0) ? message : best), null);
  const marks = new Set(personal.flatMap((message) => message.mine!.marks));
  const longest = waits.filter((wait) => wait.his && wait.by !== null).reduce<ReviewWait | null>((best, wait) => (best === null || wait.seconds > best.seconds ? wait : best), null);
  const cameBack = summary.longestWaitLastFanSeconds !== null;

  const reasons: ChatReason[] = [];
  const add = (reason: ChatReason) => reasons.push({ ...reason, text: unbreakable(reason.text) });

  if (summary.unansweredInShift && summary.openWaitSeconds !== null) {
    const fromStart = summary.openSince !== null && summary.openSince < shift.start ? " с начала смены" : "";
    const focus = fanMessageAt(chat, summary.openSince);
    const weight = summary.openWaitSeconds;
    if (shift.ongoing) {
      // A shift going on: a fan waiting past the norm right now is the reason; a fresh message is not yet.
      const long = summary.openWaitSeconds > REPLY_NORM_SECONDS;
      add({ kind: "unanswered", look: long, tone: long ? "mark" : undefined, text: `ждёт ответа ${waitText(summary.openWaitSeconds)}${fromStart}`, focus, weight });
    } else if (summary.unansweredLate) {
      // Wrote in the last minutes: still «без ответа к концу», but nothing could be done about it — said quietly.
      add({ kind: "unanswered", look: false, text: `без ответа: написал за ${waitText(summary.openWaitSeconds)} до конца смены`, focus, weight });
    } else {
      add({ kind: "unanswered", look: true, tone: "mark", text: `без ответа ${waitText(summary.openWaitSeconds)}${fromStart}`, focus, weight });
    }
  }
  if (summary.longestWaitSeconds !== null && summary.longestWaitSeconds > REPLY_NORM_SECONDS) {
    add({
      kind: "waited",
      // A fan who went quiet and wrote again just before the answer did not wait all that time.
      look: summary.longestWaitSeconds >= LOOK.waitSeconds && !cameBack,
      text: `ждал ${waitText(summary.longestWaitSeconds)}${summary.longestWaitInherited ? " с начала смены" : ""}${summary.longestWaitAnsweredBy !== null ? `, ответ от ${summary.longestWaitAnsweredBy}` : ""}${cameBack ? ", перед ответом снова написал" : ""}`,
      focus: fanMessageAt(chat, longest?.since ?? null),
      weight: summary.longestWaitSeconds,
    });
  }
  if (marks.has("leak")) {
    add({ kind: "leak", look: true, tone: "mark", text: "служебный текст ИИ", focus: firstWith((message) => message.mine!.marks.includes("leak"))?.ref ?? null });
  }
  if (raw.length > 0) {
    const all = raw.length === texts.length && texts.length >= LOOK.aiAllMinTexts;
    const inRow = run.length >= LOOK.aiRunMin;
    add({
      kind: "ai",
      look: all || inRow,
      text: all ? `ИИ без правки — все ${formatCount(texts.length)} ${ruPlural(texts.length, "текст", "текста", "текстов")}`
        : inRow ? `ИИ без правки ${formatCount(run.length)} подряд`
          : `ИИ без правки ${formatOf(raw.length, texts.length)}`,
      focus: inRow ? run.first : raw[0]!.ref,
      weight: Math.max(run.length, all ? texts.length : 0),
    });
  }
  if (repeated !== null) {
    const others = repeated.mine!.repeats;
    add({
      kind: "repeat",
      look: others + 1 >= LOOK.repeatFans,
      text: `тот же текст ещё ${formatCount(others)} ${ruPlural(others, "фану", "фанам", "фанам")}`,
      focus: repeated.ref,
      weight: others,
      group: words(repeated.text),
    });
  }
  if (summary.ppv > 0 || paidMills > 0) {
    const parts: string[] = [];
    if (summary.ppv === 1) parts.push(summary.bought > 0 ? `платное ${formatMills(boughtMills)} куплено` : "платное не куплено");
    else if (summary.ppv > 1) {
      parts.push(summary.bought > 0 ? `платные: куплено ${formatOf(summary.bought, summary.ppv)}, ${formatMills(boughtMills)}` : `платные: ${formatCount(summary.ppv)}, не куплены`);
    }
    if (tipMills > 0) parts.push(`чаевые ${formatMills(tipMills)}`);
    if (boughtMills + tipMills === 0 && Number(chat.shiftNetMills) > 0) parts.push(`принёс в смену ${formatMills(chat.shiftNetMills)}`);
    // A paid message nobody bought is ordinary work: in «Платные», not a reason to look.
    add({
      kind: paidMills > 0 ? "paid" : "offer",
      look: paidMills >= LOOK.paidMills,
      text: parts.join(", "),
      focus: bought[0]?.ref ?? tips[0]?.ref ?? firstWith((message) => message.priceMills !== null)?.ref ?? null,
      weight: paidMills,
    });
  }
  if (marks.has("dash")) add({ kind: "mark", look: false, text: "длинное тире", focus: firstWith((message) => message.mine!.marks.includes("dash"))?.ref ?? null });
  if (marks.has("cyrillic")) add({ kind: "mark", look: false, text: "кириллица", focus: firstWith((message) => message.mine!.marks.includes("cyrillic"))?.ref ?? null });

  // Honest notes: whose the chat was, and what is not the chatter's.
  const colleagues = summary.colleagues.map((one) => one.name).join(", ");
  if (summary.kind === "colleague") add({ kind: "note", look: false, text: `вела коллега ${colleagues} — не в счёте`, focus: null });
  else if (summary.mine === 0 && summary.colleagues.length > 0) add({ kind: "note", look: false, text: `в чате только сообщения ${colleagues}`, focus: null });
  else if (summary.openHeldBy !== null) add({ kind: "note", look: false, text: `без ответа после сообщения ${summary.openHeldBy} — не в счёте`, focus: null });
  if (summary.waitingSinceBefore) add({ kind: "note", look: false, text: "ждал ещё до смены, в смену не писал", focus: null });

  const waitSeconds = Math.max(summary.longestWaitSeconds ?? -1, summary.unansweredInShift ? summary.openWaitSeconds ?? -1 : -1);
  const row: ReviewChatRow = {
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
      look: false,
      unanswered: summary.unansweredInShift,
      // Long waits answered in the shift and those still open at its end: both waited past the norm.
      waited: waitSeconds > REPLY_NORM_SECONDS,
      paid: summary.ppv > 0 || paidMills > 0,
      all: true,
    },
    tier: 9,
    waitSeconds,
    paidMills,
  };
  settle(row);
  return row;
}

/** The row's place in the selection after its reasons changed: in or out, its rank, the strong reasons first. */
function settle(row: ReviewChatRow): void {
  row.reasons.sort((a, b) => Number(b.look) - Number(a.look) || TIER[a.kind] - TIER[b.kind]);
  const strong = row.reasons.filter((reason) => reason.look);
  row.in.look = strong.length > 0;
  row.tier = strong.length > 0 ? Math.min(...strong.map((reason) => TIER[reason.kind])) : 9;
}

/** The strongest first: by rank, then by the weight of the reason that gave the rank. */
function strength(a: ReviewChatRow, b: ReviewChatRow): number {
  const weight = (row: ReviewChatRow) => Math.max(0, ...row.reasons.filter((reason) => reason.look && TIER[reason.kind] === row.tier).map((reason) => reason.weight ?? 0));
  return a.tier - b.tier || weight(b) - weight(a) || (a.firstAt ?? Number.MAX_SAFE_INTEGER) - (b.firstAt ?? Number.MAX_SAFE_INTEGER);
}

/**
 * The selection's reading order: the chats the chatter wrote in first — a chat
 * with a colleague's words only is not where reading this chatter's work
 * starts — then the strongest.
 */
function rank(a: ReviewChatRow, b: ReviewChatRow): number {
  return Number(b.mine > 0) - Number(a.mine > 0) || strength(a, b);
}

/**
 * The shift's selection (D8): one chat per text sent to many fans; at most
 * `LOOK.most` of a kind, the strongest; at most `LOOK.max` chats; then two
 * ordinary dialogs, the same two every time this shift opens. A reason left
 * out stays on its card, said as a weak one.
 */
export function selectLook(rows: ReviewChatRow[], seed: string): void {
  const byTime = [...rows].sort((a, b) => (a.firstAt ?? Number.MAX_SAFE_INTEGER) - (b.firstAt ?? Number.MAX_SAFE_INTEGER));
  const texts = new Set<string>();
  for (const row of byTime) {
    for (const reason of row.reasons) {
      if (reason.kind !== "repeat" || !reason.look || reason.group === undefined) continue;
      if (texts.has(reason.group)) reason.look = false;
      else texts.add(reason.group);
    }
  }
  for (const [kind, most] of Object.entries(LOOK.most) as Array<[ReasonKind, number]>) {
    rows.flatMap((row) => row.reasons.filter((reason) => reason.kind === kind && reason.look))
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .slice(most)
      .forEach((reason) => {
        reason.look = false;
      });
  }
  for (const row of rows) settle(row);
  rows.filter((row) => row.in.look).sort(strength).slice(LOOK.max).forEach((row) => {
    for (const reason of row.reasons) reason.look = false;
    settle(row);
  });

  const hash = (text: string) => {
    let value = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 16777619);
    }
    return value >>> 0;
  };
  const ordinary = rows.filter((row) => row.kind === "dialog" && !row.in.look && row.mine > 0)
    .sort((a, b) => Number(a.reasons.length > 0) - Number(b.reasons.length > 0) || hash(`${seed}|${a.key}`) - hash(`${seed}|${b.key}`))
    .slice(0, LOOK.samples);
  for (const row of ordinary) {
    row.in.look = true;
    row.tier = TIER.sample;
    row.reasons.push({ kind: "sample", look: false, text: "обычный диалог — для сравнения", focus: null });
  }
}

/** The order of each list: what to read first. */
export function ordered(rows: readonly ReviewChatRow[], filter: ReviewFilter): ReviewChatRow[] {
  // A chat with nothing in the shift (a fan only waiting since before it) goes last.
  const when = (row: ReviewChatRow) => row.firstAt ?? Number.MAX_SAFE_INTEGER - (row.waitingSince === null ? 0 : 1e12 - row.waitingSince / 1e3);
  const list = [...rows];
  switch (filter) {
    case "look": return list.sort(rank);
    case "unanswered":
    case "waited": return list.sort((a, b) => Number(b.mine > 0) - Number(a.mine > 0) || b.waitSeconds - a.waitSeconds || when(a) - when(b));
    case "paid": return list.sort((a, b) => b.paidMills - a.paidMills || when(a) - when(b));
    case "all": return list.sort((a, b) => when(a) - when(b));
  }
}

/** Where the open chat starts reading: the place of the list's reason; «Все» — the shift's start. */
export function focusOf(row: ReviewChatRow, list: ReviewFilter): string | null {
  const pick = (kinds: readonly ReasonKind[]) => row.reasons.find((reason) => kinds.includes(reason.kind) && reason.focus !== null)?.focus ?? null;
  switch (list) {
    case "look": return row.reasons.find((reason) => (reason.look || reason.kind === "sample") && reason.focus !== null)?.focus ?? null;
    case "unanswered": return pick(["unanswered"]);
    case "waited": return pick(["unanswered", "waited"]);
    case "paid": return pick(["paid", "offer"]);
    case "all": return null;
  }
}
