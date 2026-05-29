// Closing-message detector, Layer 1 (hard, multilingual, exact-match).
// Deterministic and free; runs on every fan-last thread. Layer 2 (Haiku 4.5 on
// the >24h tail) is a separate, flag-gated subsystem (see the design doc, §6).
//
// A message is "closing" only if the WHOLE message equals a closing phrase (or a
// short combination of them), or is emoji/punctuation-only. Openers like "hi",
// "you up?", "when?" are intentionally NOT closing — they need a reply.

const CLOSING_PHRASES: ReadonlySet<string> = new Set([
  // English
  "ok", "okay", "k", "kk", "kay",
  "thanks", "thank you", "thx", "ty", "tysm", "tnx", "thanx",
  "np", "yw", "no problem",
  "gn", "good night", "goodnight", "night", "nite",
  "gm", "good morning",
  "bye", "goodbye", "cya", "see ya", "ttyl", "later",
  "lol", "lmao", "haha", "haha", "hehe", "hahaha",
  "cool", "nice", "great", "awesome", "sweet", "perfect",
  "yup", "yep", "yeah", "yes", "sure", "alright", "aight",
  "gotcha", "got it", "ok thanks", "okay thanks", "ok ty", "k thanks",
  // Russian
  "спасибо", "спс", "пасиб", "пасибо", "благодарю",
  "пока", "покеда", "до встречи",
  "ок", "окей", "оке", "окок",
  "ладно", "давай", "хорошо", "хор",
  "споки", "спокойной ночи", "доброй ночи",
  "ага", "угу", "да",
  "понятно", "понял", "поняла", "ясно", "ясненько",
]);

const MAX_EMOJI_ONLY_GLYPHS = 6;
const MAX_COMBO_TOKENS = 3;

const ALNUM = /[\p{L}\p{N}]/u;
const NON_WORD = /[^\p{L}\p{N}\s]/gu;
const WHITESPACE = /\s+/g;

/**
 * @returns true if the tail message is a closing message (does NOT need a reply).
 * Empty / unknown content returns false (we never suppress on missing data).
 */
export function isClosingMessage(rawContent: string | null | undefined): boolean {
  if (rawContent == null) {
    return false;
  }

  const trimmed = rawContent.trim();
  if (trimmed.length === 0) {
    return false;
  }

  // Emoji / punctuation-only (no letters or digits) → closing if short.
  if (!ALNUM.test(trimmed)) {
    const glyphs = [...trimmed.replace(WHITESPACE, "")];
    return glyphs.length > 0 && glyphs.length <= MAX_EMOJI_ONLY_GLYPHS;
  }

  // Normalize: lowercase, drop emoji/punctuation to spaces, collapse whitespace.
  const normalized = trimmed
    .toLowerCase()
    .replace(NON_WORD, " ")
    .replace(WHITESPACE, " ")
    .trim();

  if (normalized.length === 0) {
    return false;
  }

  if (CLOSING_PHRASES.has(normalized)) {
    return true;
  }

  // Short combination where every token is itself a closing token ("ok thanks").
  const tokens = normalized.split(" ").filter(Boolean);
  return (
    tokens.length > 0 &&
    tokens.length <= MAX_COMBO_TOKENS &&
    tokens.every((token) => CLOSING_PHRASES.has(token))
  );
}
