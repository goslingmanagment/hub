const BASIC_HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: "\"",
};

function decodeHtmlEntity(entity: string) {
  if (entity.startsWith("#x") || entity.startsWith("#X")) {
    const value = Number.parseInt(entity.slice(2), 16);
    return Number.isFinite(value) ? String.fromCodePoint(value) : `&${entity};`;
  }
  if (entity.startsWith("#")) {
    const value = Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(value) ? String.fromCodePoint(value) : `&${entity};`;
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
