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

function sanitizeString(text: string): string {
  return text.replace(LONE_SURROGATE_RE, "�");
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
      out[sanitizeString(key)] = sanitizeLoneSurrogatesDeep(item);
    }
    return out as T;
  }
  return value;
}
