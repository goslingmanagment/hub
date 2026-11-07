import { normalizeDmMessageText } from "@agency_hub_core/shared";
import { SHIFT_REVIEW_AI_LOOKBACK_MINUTES, SHIFT_REVIEW_AI_SHARE } from "@agency_hub_core/contracts";
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
 * The origin of the chatter's text. Only «ИИ без правки» colours the bubble's
 * left edge; every other origin is said in words under the bubble.
 *
 * `own` is what Hub could NOT tie to an AI text of the chat — not proof that the
 * chatter wrote it (the AI may have been outside Hub): its word is the neutral
 * «ИИ не найден» everywhere (spec r3, E2), and the evidence says on what basis.
 */
export type OriginKey = "ai-raw" | "ai-edited" | "ai-hi" | "ai-command" | "fix" | "own" | "none";

export interface Origin {
  key: OriginKey;
  /** One quiet line under the bubble: «ИИ без правки, вставлен вручную». */
  label: string;
  /** The same without how it got into the composer, for a narrow list: «ИИ без правки». */
  short: string;
}

/** The one word for a text Hub found no AI text for: under the bubble, in the evidence, in the facts' hint (M9). */
export const OWN_WORDS = "ИИ не найден";

/** Texts of this many words or fewer are not the AI's unless an AI button put them there (the server's rule). */
const SHORT_WORDS = 3;

export function originOf(message: ReviewMessage): Origin | null {
  const mine = message.mine;
  if (mine === null) return null;
  const one = (key: OriginKey, label: string): Origin => ({ key, label, short: label });
  if (mine.origin === null) return one("none", message.text.trim() !== "" ? "без слов" : "без текста");
  if (mine.origin === "own") return one("own", OWN_WORDS);
  if (mine.origin === "fix") return one("fix", "свой черновик, ИИ поправил");
  if (isHi(mine)) return one("ai-hi", "приветствие ИИ");
  if (mine.aiFeature === "improve-draft") return one("ai-command", "ИИ по команде");
  const byHand = mine.composedWith === "hand" ? ", вставлен вручную" : "";
  // The same rule as the shift's «ИИ без правки» share (D1).
  return aiUnedited(mine)
    ? { key: "ai-raw", label: `ИИ без правки${byHand}`, short: "ИИ без правки" }
    : { key: "ai-edited", label: `ИИ с правкой${byHand}`, short: "ИИ с правкой" };
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

const LOOKBACK = `${SHIFT_REVIEW_AI_LOOKBACK_MINUTES} мин`;
const THRESHOLD = `${Math.round(SHIFT_REVIEW_AI_SHARE * 100)} %`;

/**
 * The verdict in one sentence, for the evidence panel: what Hub compared and
 * what came out. For a text without an AI match it says the basis and never
 * «своё»: Hub did not see where the words came from (`OWN_CAVEAT` says so).
 */
export function originSentence(message: ReviewMessage): string {
  const mine = message.mine!;
  const share = mine.aiShare;
  const percent = `${Math.round((share ?? 0) * 100)} %`;
  switch (mine.origin) {
    case null:
      return "В сообщении нет слов (файл, смайл): сравнивать с ИИ не с чем.";
    case "own": {
      if (share === null || mine.aiText === null) return `В Hub нет текстов ИИ этого чата за ${LOOKBACK} до сообщения — сравнивать не с чем.`;
      if (aiButton(mine.composedWith) && share === 0) return `Нажата кнопка ИИ, но ни один текст ИИ этого чата за ${LOOKBACK} с отправленным не совпал.`;
      const short = message.text.trim().split(/\s+/).length <= SHORT_WORDS;
      return short
        ? `Совпало ${percent} слов, но текст короткий (до ${SHORT_WORDS} слов): такие Hub относит к ИИ, только если их вставила кнопка ИИ.`
        : `С ближайшим текстом ИИ совпало ${percent} слов — меньше порога ${THRESHOLD}.`;
    }
    case "fix":
      return "Черновик набрал чаттер (обычно по-русски), кнопка Fix перевела и поправила его — черновик ниже.";
    case "ai":
      if (isHi(mine)) return "Приветствие новому подписчику, написанное ИИ по кнопке Hi.";
      if (mine.aiFeature === "improve-draft") return "Черновик был командой («скажи…», «спроси…»), текст написал ИИ.";
      return aiUnedited(mine)
        ? `Текст ИИ (${featureWord(mine.aiFeature)}) ушёл фану как есть, слово в слово.`
        : `Текст ИИ (${featureWord(mine.aiFeature)}), чаттер его поправил: совпало ${percent} слов.`;
  }
}

/** Under the verdict of «ИИ не найден»: what it does not prove (E2). */
export const OWN_CAVEAT = "Это не доказывает, что текст свой: его могли взять у ИИ вне Hub.";

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
