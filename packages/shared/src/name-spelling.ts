// How a fan's name is typed in what the model writes to him (owner, 2026-11-01,
// a chatter's ask): in plain Latin letters, as a phone's English keyboard gives
// them. A name copied from a profile with its marks (Çağlar, kauê, paweł) or in
// a fancy font (𝓜𝓲𝓴𝓮, ᴊᴏʜɴ) shows the text was pasted, never typed: the model
// had copied «Çağlar Akmaz» from his Fansly profile into «so what brought you
// to me today, Çağlar?».
//
// Only Latin letters change. Cyrillic, Greek and every other script keep their
// letters, «й» and «ё» included: a Russian chat names «Коля» as he is.

/** Latin letters that carry their mark in the letter itself, so taking the
 * marks off leaves them as they were; and the small capitals fancy-font names
 * are made of. */
const PLAIN_LETTERS: Readonly<Record<string, string>> = {
  ı: "i", ł: "l", Ł: "L", ø: "o", Ø: "O", đ: "d", Đ: "D", ð: "d", Ð: "D",
  þ: "th", Þ: "Th", ß: "ss", ẞ: "SS", æ: "ae", Æ: "Ae", œ: "oe", Œ: "Oe",
  ħ: "h", Ħ: "H", ŧ: "t", Ŧ: "T", ŋ: "ng", Ŋ: "Ng", ƒ: "f",
  ᴀ: "a", ʙ: "b", ᴄ: "c", ᴅ: "d", ᴇ: "e", ꜰ: "f", ɢ: "g", ʜ: "h", ɪ: "i", ᴊ: "j",
  ᴋ: "k", ʟ: "l", ᴍ: "m", ɴ: "n", ᴏ: "o", ᴘ: "p", ʀ: "r", ꜱ: "s", ᴛ: "t", ᴜ: "u",
  ᴠ: "v", ᴡ: "w", ʏ: "y", ᴢ: "z",
};
const PLAIN_LETTER = new RegExp(`[${Object.keys(PLAIN_LETTERS).join("")}]`, "gu");
/** A Latin letter and the marks on it, once the text is decomposed. */
const MARKED_LATIN = /(\p{Script=Latin})\p{M}+/gu;
/** A word as names are read: letters and the marks on them. */
const WORD = /[\p{L}\p{M}]+/gu;

/**
 * The text with every Latin letter typed plain: compatibility forms folded
 * (𝓜𝓲𝓴𝓮 → Mike, Ｍｉｋｅ → Mike), the marks taken off (Çağlar → Caglar,
 * kauê → kaue), the letters that hold their mark spelled out (paweł → pawel,
 * Bjørn → Bjorn, Strauß → Strauss). Other scripts, digits, emoji and spacing
 * stay as they were.
 */
export function plainLatinSpelling(text: string): string {
  return text
    .normalize("NFKC")
    .replace(PLAIN_LETTER, (letter) => PLAIN_LETTERS[letter] ?? letter)
    .normalize("NFD")
    .replace(MARKED_LATIN, "$1")
    .normalize("NFC");
}

/** How a word is looked up: composed and lower-case, so «ÇAĞLAR», «çağlar»
 * and a decomposed «Çağlar» are one word. */
export function nameWordKey(word: string): string {
  return word.normalize("NFC").toLowerCase();
}

/**
 * The words of a fan's names that the plain spelling changes, by nameWordKey:
 * {çağlar} for «Çağlar Akmaz», nothing for «John». A word of one letter is
 * left out: it is an initial, never a name the model writes back.
 */
export function respelledNameWords(names: Iterable<string | null | undefined>): ReadonlySet<string> {
  const words = new Set<string>();
  for (const name of names) {
    for (const word of name?.match(WORD) ?? []) {
      if ([...word.normalize("NFC")].length > 1 && plainLatinSpelling(word) !== word) {
        words.add(nameWordKey(word));
      }
    }
  }
  return words;
}

/** A rewrite of one whole word: the word typed plain when it is one of the
 * fan's names, else the word as it is. */
export function nameWordRespeller(words: ReadonlySet<string>): (word: string) => string {
  return (word) => (words.has(nameWordKey(word)) ? plainLatinSpelling(word) : word);
}

/** Every whole word of the text passed through the rewrite; the rest of the
 * text (spaces, punctuation, emoji, digits) as it is. */
export function rewriteWords(text: string, rewrite: (word: string) => string): string {
  return text.replace(WORD, rewrite);
}

const OPEN_WORD = /[\p{L}\p{M}]+$/u;
const NOT_LATIN = /[^\p{Script=Latin}\p{M}]/u;

/** Where the text's last word starts when the text ends inside a word of
 * Latin letters, else the text's length: a stream holds that tail back until
 * the word ends. Only a Latin word can be a name typed plain, and a script
 * written without spaces (Chinese, Thai) would otherwise be held whole. A text
 * cut between the two halves of a character outside the BMP holds the first
 * half back too. */
export function openWordStart(text: string): number {
  const end = /[\uD800-\uDBFF]$/.test(text) ? text.length - 1 : text.length;
  const match = OPEN_WORD.exec(text.slice(0, end));
  return match === null || NOT_LATIN.test(match[0]) ? end : match.index;
}
