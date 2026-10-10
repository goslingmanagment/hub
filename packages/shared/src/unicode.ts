// W5 deploy-night find (2026-07-11, decision #132 addendum): webhook event
// 152584 sat unprocessed for 7 DAYS because its derived sync_event carried a
// LONE UTF-16 HIGH SURROGATE — our reply-preview truncation sliced an emoji
// in half, and Postgres rejects unpaired surrogates in json/jsonb
// ("Unicode low surrogate must follow a high surrogate"), so the settle
// UPDATE failed on every minutely retry, silently. Two layers:
// surrogate-safe truncation at the slice sites, and a deep sanitizer belt
// for anything derived that lands in a json column (vendor data can carry
// its own unpaired surrogates — we must never wedge on them).

/** Truncate to at most `max` UTF-16 code units without splitting a
 * surrogate pair (drops the dangling high surrogate at the boundary). */
export function truncateUtf16Safe(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  let end = max;
  const boundary = text.charCodeAt(end - 1);
  if (boundary >= 0xd800 && boundary <= 0xdbff) {
    end -= 1;
  }
  return text.slice(0, end);
}

// A high surrogate not followed by a low one, or a low surrogate not
// preceded by a high one (lookbehind is fine on Node 22).
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// The same pattern without the global flag, for `test`: a global regex keeps
// `lastIndex` between calls. The plain class is the cheap precheck: a string
// with no surrogate code unit at all, the ordinary case, skips the lookarounds.
const HAS_LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const HAS_SURROGATE_RE = /[\uD800-\uDFFF]/;

function sanitizeString(text: string): string {
  return text.replace(LONE_SURROGATE_RE, "�");
}

function countInString(text: string): number {
  return HAS_SURROGATE_RE.test(text) && HAS_LONE_SURROGATE_RE.test(text)
    ? text.match(LONE_SURROGATE_RE)!.length
    : 0;
}

/** Deep-copy `value` with every unpaired surrogate in every string replaced
 * by U+FFFD, so the result always survives Postgres json/jsonb input. */
export function sanitizeLoneSurrogatesDeep<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeString(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLoneSurrogatesDeep(item)) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      // A parsed `__proto__` key is data; plain assignment would set the
      // copy's prototype instead and drop the key from the body.
      Object.defineProperty(out, sanitizeString(key), {
        value: sanitizeLoneSurrogatesDeep(item),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out as T;
  }
  return value;
}

/** `text` as a value Postgres takes both in a `text` column and inside
 * `json`/`jsonb`: every unpaired surrogate (jsonb refuses its `\uXXXX`
 * escape) and every U+0000 (`text` refuses the byte, jsonb the `\u0000`
 * escape) becomes U+FFFD. Whole surrogate pairs and every other character are
 * kept, so vendor text (a fan's broken emoji, a stray NUL) never wedges a
 * writer that stores it in both. */
export function sanitizePostgresText(text: string): string {
  return sanitizeString(text).replaceAll("\u0000", "�");
}

/** Deep-copy `value` with every string and every object key passed through
 * `sanitizePostgresText` (unpaired surrogates and U+0000 become U+FFFD), so
 * the result survives Postgres json/jsonb input and every text column a
 * writer copies it into (bug hunt Д3). A parsed `__proto__` key is kept as
 * data, as `sanitizeLoneSurrogatesDeep` keeps it. */
export function sanitizePostgresTextDeep<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizePostgresText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePostgresTextDeep(item)) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(out, sanitizePostgresText(key), {
        value: sanitizePostgresTextDeep(item),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out as T;
  }
  return value;
}

/** What `sanitizePostgresTextDeep` would replace in `value` (object keys
 * included): unpaired surrogates and U+0000 characters. The same walk without
 * a copy, so a caller can keep the value itself when both are 0. */
export function countPostgresUnstorableDeep(value: unknown): { loneSurrogates: number; nul: number } {
  const count = { loneSurrogates: 0, nul: 0 };
  const visitString = (text: string): void => {
    count.loneSurrogates += countInString(text);
    if (text.includes("\u0000")) count.nul += text.split("\u0000").length - 1;
  };
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      visitString(item);
    } else if (Array.isArray(item)) {
      for (const entry of item) visit(entry);
    } else if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        visitString(key);
        visit(record[key]);
      }
    }
  };
  visit(value);
  return count;
}

/** How many unpaired surrogates `sanitizeLoneSurrogatesDeep` would replace in
 * `value` (object keys included). Walks the same tree and copies nothing, so a
 * caller can keep the value itself when the answer is 0. */
export function countLoneSurrogatesDeep(value: unknown): number {
  if (typeof value === "string") {
    return countInString(value);
  }
  let count = 0;
  if (Array.isArray(value)) {
    for (const item of value) {
      count += countLoneSurrogatesDeep(item);
    }
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      count += countInString(key) + countLoneSurrogatesDeep(record[key]);
    }
  }
  return count;
}
