import { normalizeDmMessageText } from "@agency_hub_core/shared";
import { formatDateTime, formatTimeOfDay } from "@agency_hub_core/ui/format";
import type { ReviewMessage } from "./data.js";
import { aiButton, aiUnedited, isHi } from "@agency_hub_core/ui/shiftReview";

/**
 * The screen's words for a message: where its text came from, who wrote it,
 * and the word-by-word difference between what was sent and the AI's text. Plain
 * Russian, no button jargon in the first words; the button's name is in the
 * evidence panel, where it is a fact.
 */

type Mine = NonNullable<ReviewMessage["mine"]>;

/**
 * The origin of the chatter's text. `edge` is the bubble's quiet left edge:
 * the AI's texts one colour (fainter once edited), the chatter's own draft run
 * through the AI another, the chatter's own words none.
 */
export type OriginKey = "ai-raw" | "ai-edited" | "ai-hi" | "ai-command" | "fix" | "own" | "none";

export interface Origin {
  key: OriginKey;
  /** One quiet line under the bubble: «ИИ без правки». */
  label: string;
}

/** Texts of this many words or fewer are the chatter's unless a button put them there (the server's rule). */
const SHORT_WORDS = 3;

export function originOf(message: ReviewMessage): Origin | null {
  const mine = message.mine;
  if (mine === null) return null;
  if (mine.origin === null) return { key: "none", label: message.text.trim() !== "" ? "без слов" : "без текста" };
  if (mine.origin === "own") return { key: "own", label: "сам" };
  if (mine.origin === "fix") return { key: "fix", label: "свой черновик, ИИ поправил" };
  if (isHi(mine)) return { key: "ai-hi", label: "приветствие ИИ" };
  if (mine.aiFeature === "improve-draft") return { key: "ai-command", label: "ИИ по команде" };
  const byHand = mine.composedWith === "hand" ? ", вставлен вручную" : "";
  // The same rule as the shift's «ИИ без правки» share (D1).
  return aiUnedited(mine) ? { key: "ai-raw", label: `ИИ без правки${byHand}` } : { key: "ai-edited", label: `ИИ с правкой${byHand}` };
}

const FEATURE_WORDS: Record<string, string> = {
  "fast-reply": "Reply",
  "improve-draft": "Fix",
  "coach-chat": "Coach",
  ping: "Ping",
  "hi-greeting": "Hi",
};

export function featureWord(feature: string | null): string {
  return FEATURE_WORDS[feature ?? ""] ?? feature ?? "ИИ";
}

const COMPOSED_WORDS: Record<string, string> = {
  reply: "кнопка Reply",
  fix: "кнопка Fix",
  hi: "кнопка Hi",
  ping: "кнопка Ping",
  coach: "кнопка Coach",
  hand: "без кнопки — набрано или вставлено вручную",
  unknown: "кнопка неизвестна",
};

/** What the extension said about how the text got into the composer. */
export function composedWords(mine: Mine): string {
  const how = COMPOSED_WORDS[mine.composedWith ?? ""] ?? mine.composedWith ?? "кнопка неизвестна: старое расширение";
  if (mine.edited === true) return `${how}, после вставки текст правили`;
  if (mine.edited === false && aiButton(mine.composedWith)) return `${how}, без правки`;
  return how;
}

/** The verdict in one sentence, for the evidence panel. */
export function originSentence(message: ReviewMessage): string {
  const mine = message.mine!;
  const share = mine.aiShare ?? 0;
  const percent = `${Math.round(share * 100)} %`;
  switch (mine.origin) {
    case null:
      return "В сообщении нет слов (файл, смайл): сравнивать с ИИ не с чем.";
    case "own": {
      if (aiButton(mine.composedWith) && share === 0) return "Нажата кнопка ИИ, но среди текстов ИИ этого чата такого текста нет: чаттер написал своё.";
      if (share === 0) return "Среди текстов ИИ этого чата за полтора часа до сообщения такого текста нет. Это не доказывает, что текст свой: ИИ мог быть вне Hub.";
      const short = message.text.trim().split(/\s+/).length <= SHORT_WORDS;
      return short
        ? `Совпало с ИИ ${percent} слов, но текст короткий (до ${SHORT_WORDS} слов): такой считается своим.`
        : `С ближайшим текстом ИИ совпало ${percent} слов — меньше 70 %, текст считается своим.`;
    }
    case "fix":
      return "Чаттер написал черновик сам (обычно по-русски), ИИ перевёл и поправил его. Мысль — чаттера.";
    case "ai":
      if (isHi(mine)) return "Приветствие новому подписчику, написанное ИИ по кнопке Hi.";
      if (mine.aiFeature === "improve-draft") return "Черновик был командой («скажи…», «спроси…»), текст написал ИИ.";
      return aiUnedited(mine)
        ? `Текст ИИ (${featureWord(mine.aiFeature)}) ушёл фану как есть, слово в слово.`
        : `Текст ИИ (${featureWord(mine.aiFeature)}), чаттер его поправил: совпало ${percent} слов.`;
  }
}

/** Who wrote a page message that is not the reviewed chatter's own in the shift. */
export function authorOf(message: ReviewMessage, username: string): string | null {
  if (message.side === "fan") return null;
  if (message.mass) return "рассылка";
  if (message.by === "other") return `коллега ${message.byName ?? ""}`.trim();
  if (message.by === "none") return "автор не записан";
  if (message.by === "auto") return "автосообщение";
  if (message.by === "me" && !message.inShift) return `${username}, до смены`;
  return null;
}

export function plainText(text: string): string {
  return normalizeDmMessageText(text);
}

/** A moment near the shift: the time alone on the shift's first day, the date too on another. */
export function momentText(at: number, shiftStart: number): string {
  const day = (value: number) => new Date(value + 3 * 3_600_000).toISOString().slice(0, 10);
  return day(at) === day(shiftStart) ? formatTimeOfDay(at) : formatDateTime(new Date(at).toISOString());
}

export const MARK_WORDS = { dash: "длинное тире", cyrillic: "кириллица", leak: "служебный текст ИИ" } as const;

// ------------------------------------------------------------- Word difference

export interface DiffPart {
  text: string;
  /** In this text only: the chatter added it (in the sent text) or dropped it (in the AI's). */
  changed: boolean;
}

function tokens(text: string): string[] {
  return text.split(/(\s+)/).filter((part) => part !== "");
}

function key(token: string): string {
  return token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * The sent text and the AI's text side by side, word by word (the longest
 * common run of words): what the chatter added, what they dropped. Spaces stay
 * as they were; punctuation alone does not count as a change.
 */
export function wordDiff(sent: string, ai: string): { sent: DiffPart[]; ai: DiffPart[] } {
  const a = tokens(sent);
  const b = tokens(ai);
  const words = (list: string[]) => list.map((token, index) => ({ token, index, key: key(token) })).filter((one) => one.key !== "");
  const x = words(a);
  const y = words(b);
  // Too long to compare word by word: show both plain.
  if (x.length * y.length > 250_000) {
    return { sent: [{ text: sent, changed: false }], ai: [{ text: ai, changed: false }] };
  }
  const table: Uint16Array[] = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i -= 1) {
    for (let j = y.length - 1; j >= 0; j -= 1) {
      table[i]![j] = x[i]!.key === y[j]!.key ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const keptA = new Set<number>();
  const keptB = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i]!.key === y[j]!.key) {
      keptA.add(x[i]!.index);
      keptB.add(y[j]!.index);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i += 1;
    else j += 1;
  }
  const parts = (list: string[], kept: Set<number>): DiffPart[] => {
    const isWord = list.map((token) => key(token) !== "");
    const wordChanged = list.map((_, index) => isWord[index]! && !kept.has(index));
    const neighbour = (index: number, step: 1 | -1): boolean => {
      for (let at = index + step; at >= 0 && at < list.length; at += step) if (isWord[at]) return wordChanged[at]!;
      return false;
    };
    const out: DiffPart[] = [];
    list.forEach((token, index) => {
      // A space or a comma between two changed words belongs to the same mark.
      const changed = isWord[index] ? wordChanged[index]! : neighbour(index, -1) && neighbour(index, 1);
      const last = out.at(-1);
      if (last && last.changed === changed) last.text += token;
      else out.push({ text: token, changed });
    });
    return out;
  };
  return { sent: parts(a, keptA), ai: parts(b, keptB) };
}
