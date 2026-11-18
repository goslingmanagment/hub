// OnlyFans traffic sources: which source a link without one probably is, by
// its name. The link's name is read against each source's title, the channel
// part of its key and the names of the links it already has. One answer or
// none: a tie or a weak match proposes nothing (a wrong proposal is worse
// than none — the owner would confirm it without reading).

export interface TrafficSourceCandidate {
  /** `<model>.<channel>`: only the channel part is read. */
  key: string;
  title: string;
  /** Names of the links bound to the source (at any time). */
  linkNames: readonly string[];
}

const CYRILLIC: Readonly<Record<string, string>> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "i", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "",
  ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/**
 * One spelling for the ways a source's name is written: Latin letters without
 * marks, Cyrillic transliterated, the letters that sound alike folded (w/v,
 * c/k, ph/f, y/i…) and doubled letters single — «Твиттер» and «Twitter» are
 * one word, so are «Реддит» and «Reddit».
 */
function soundOf(word: string): string {
  const latin = [...word].map((letter) => CYRILLIC[letter] ?? letter).join("");
  return latin
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/[cq]/g, "k")
    .replace(/w/g, "v")
    .replace(/x/g, "ks")
    .replace(/[yj]/g, "i")
    .replace(/(.)\1+/g, "$1");
}

/** Words that say what a link is, not where it is posted. */
const GENERIC = new Set([
  "ссылка", "ссылки", "link", "links", "trial", "trials", "пробная", "пробные", "пробный", "free", "бесплатно",
  "бесплатная", "day", "days", "дней", "дня", "день", "bio", "био", "post", "posts", "пост", "посты", "promo", "промо",
  "new", "новая", "новый", "main", "основная", "основной", "test", "тест", "of", "onlyfans", "page", "страница", "vip",
  "акция", "the", "and", "for", "from", "и", "в", "на", "с", "по", "для", "из",
].map(soundOf));

/** The words of a name as they are compared: lower case, no punctuation, no digits at a word's end, no generic words. */
export function trafficNameWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const raw of text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const stem = raw.replace(/\p{N}+$/u, "");
    if (stem === "" || /^\p{N}+$/u.test(stem)) continue;
    const word = soundOf(stem);
    if (word !== "" && !GENERIC.has(word)) words.add(word);
  }
  return words;
}

/** The weight of a word the source's own name or key shares with the link's name, against one only its links share. */
const OWN_NAME_WEIGHT = 2;
/** The least score a proposal needs: one word of the source's own name, or two of its links' names. */
const ENOUGH = 2;

/**
 * The source a link without one probably is: its key, or null. Only a word
 * that belongs to one source counts (a word several sources share — the
 * model's name, a common word — tells nothing). A word of the source's title
 * or key weighs two, a word of its links' names one. The best source needs a
 * score of two, and every other source less than two: a tie or a second
 * plausible source proposes nothing.
 */
export function proposeTrafficSource(linkName: string | null, sources: readonly TrafficSourceCandidate[]): string | null {
  if (linkName === null || linkName.trim() === "") return null;
  const linkWords = trafficNameWords(linkName);
  if (linkWords.size === 0) return null;
  const vocabularies = sources.map((source) => {
    const own = new Set([...trafficNameWords(source.title), ...trafficNameWords(source.key.split(".").slice(1).join(".") || source.key)]);
    const named = new Set(source.linkNames.flatMap((name) => [...trafficNameWords(name)]).filter((word) => !own.has(word)));
    return { key: source.key, own, named };
  });
  const owners = new Map<string, number>();
  for (const vocabulary of vocabularies) {
    for (const word of new Set([...vocabulary.own, ...vocabulary.named])) owners.set(word, (owners.get(word) ?? 0) + 1);
  }
  const scores = vocabularies.map((vocabulary) => {
    let score = 0;
    for (const word of linkWords) {
      if (owners.get(word) !== 1) continue;
      if (vocabulary.own.has(word)) score += OWN_NAME_WEIGHT;
      else if (vocabulary.named.has(word)) score += 1;
    }
    return { key: vocabulary.key, score };
  }).sort((left, right) => right.score - left.score);
  const [best, second] = scores;
  if (best === undefined || best.score < ENOUGH) return null;
  if (second !== undefined && second.score >= ENOUGH) return null;
  return best.key;
}
