// Fansly's one-off CloudFront signing tokens, cut out of a body before it is
// journaled — Hub's own rule for the bodies it journals (owner decision
// 2026-09-29), as apps/runtime/src/sync/fansly/lib/cdn-tokens.ts
// (`stripFanslySignedCdnTokens`) applies it. The image carries only
// apps/page-browser, so this is that function's copy, word for word in what
// it does; tests/page-browser-publish-capture.test.ts holds the two equal.
//
// WHERE — by position: a `locations[].location` string that is entirely one
// https URL on a Fansly CDN host whose query carries `Signature` or
// `Key-Pair-Id` loses the params `Policy`, `Signature`, `Key-Pair-Id` and
// `Expires`; a `locations[].metadata` object with a string `Signature` or
// `Key-Pair-Id` loses the same four keys. Nothing else is rewritten here.
// Pure, idempotent, copy-on-write: its input is never changed.

const SIGNING_NAMES: ReadonlySet<string> = new Set(["Policy", "Signature", "Key-Pair-Id", "Expires"]);
const LONE_HTTPS_URL = /^https:\/\/[!-~]+$/;
const FANSLY_CDN_ORIGIN = /^https:\/\/cdn\d*\.fansly\.com(?=[/?#]|$)/;

function stripSignedUrl(value: string): string {
  if (!LONE_HTTPS_URL.test(value) || !FANSLY_CDN_ORIGIN.test(value)) return value;
  const queryStart = value.indexOf("?");
  if (queryStart < 0) return value;
  const fragmentStart = value.indexOf("#", queryStart);
  const queryEnd = fragmentStart < 0 ? value.length : fragmentStart;
  const pairs = value.slice(queryStart + 1, queryEnd).split("&");
  const names = pairs.map((pair) => pair.split("=", 1)[0] ?? "");
  if (!names.includes("Signature") && !names.includes("Key-Pair-Id")) return value;
  const kept = pairs.filter((_pair, index) => !SIGNING_NAMES.has(names[index]!));
  return `${value.slice(0, queryStart)}${kept.length > 0 ? `?${kept.join("&")}` : ""}${value.slice(queryEnd)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapEntries(value: unknown[], next: (entry: unknown) => unknown): unknown[] {
  let copy: unknown[] | null = null;
  value.forEach((entry, index) => {
    const mapped = next(entry);
    if (mapped !== entry) {
      copy ??= value.slice();
      copy[index] = mapped;
    }
  });
  return copy ?? value;
}

const DROP: unique symbol = Symbol("drop");

function mapFields(value: Record<string, unknown>, next: (key: string, entry: unknown) => unknown): Record<string, unknown> {
  let changed = false;
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const mapped = next(key, entry);
    if (mapped === DROP) {
      changed = true;
      continue;
    }
    changed ||= mapped !== entry;
    // A served `__proto__` key is data: plain assignment would set the
    // prototype instead.
    Object.defineProperty(copy, key, { value: mapped, enumerable: true, writable: true, configurable: true });
  }
  return changed ? copy : value;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return mapEntries(value, strip);
  if (!isRecord(value)) return value;
  return mapFields(value, (key, entry) => (key === "locations" && Array.isArray(entry) ? mapEntries(entry, stripLocation) : strip(entry)));
}

function stripLocation(value: unknown): unknown {
  if (!isRecord(value)) return strip(value);
  return mapFields(value, (key, entry) => {
    if (key === "location" && typeof entry === "string") return stripSignedUrl(entry);
    if (key === "metadata" && isRecord(entry)) {
      const signing = typeof entry.Signature === "string" || typeof entry["Key-Pair-Id"] === "string";
      return mapFields(entry, (name, field) => (signing && SIGNING_NAMES.has(name) ? DROP : strip(field)));
    }
    return strip(entry);
  });
}

/** Hub's strip of Fansly's signed CDN tokens, over any JSON value. */
export function stripFanslySignedCdnTokens<T>(value: T): T {
  return strip(value) as T;
}
