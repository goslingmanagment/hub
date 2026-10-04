const BASIC_HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: "\"",
};

/** A numeric reference names a character only inside Unicode's range.
 *  `String.fromCodePoint` THROWS past it (`&#1114112;`, or any long run of
 *  digits), and this runs on every message the hub ingests: one such reference
 *  must not fail the message it is in. Outside the range the reference is not
 *  one, and stays the text it was, like an unknown name. */
function decodeNumericEntity(entity: string, value: number) {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : `&${entity};`;
}

function decodeHtmlEntity(entity: string) {
  if (entity.startsWith("#x") || entity.startsWith("#X")) {
    return decodeNumericEntity(entity, Number.parseInt(entity.slice(2), 16));
  }
  if (entity.startsWith("#")) {
    return decodeNumericEntity(entity, Number.parseInt(entity.slice(1), 10));
  }

  return BASIC_HTML_ENTITIES[entity] ?? `&${entity};`;
}

export function normalizeDmMessageText(input: string | null | undefined) {
  const raw = input ?? "";
  if (!raw) {
    return "";
  }

  return raw
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|li)\s*>\s*<\s*(p|div|li)(?:\s[^>]*)?>/gi, "\n")
    .replace(/<\/\s*(p|div|li)\s*>/gi, "\n")
    .replace(/<\s*(p|div|li)(?:\s[^>]*)?>/gi, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&([a-z]+|#[0-9]+|#x[0-9a-f]+);/gi, (_match, entity: string) => decodeHtmlEntity(entity))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
