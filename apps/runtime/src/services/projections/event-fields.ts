// The projectors' event field readers, one copy (W4-05, A07-07). Each body is
// the one the six projector files (fansly-catalog, fansly-comments,
// fansly-engagement, fansly-payouts, fansly-stats, media-plane) each carried
// verbatim. `creator-posts.ts` (`eventData`) and `ai-media-candidates.ts`
// (`asText`) keep their own, different variants.

import { millsFromInteger, type Mills } from "@agency_hub_core/shared";

export function eventData(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

export function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** Event mills travel as decimal STRINGS (JSON cannot carry a bigint, and a
 *  float would re-open the 1000x footgun). Anything else is not money.
 *
 *  Constructed through `millsFromInteger` — the named already-mills constructor,
 *  never a hand-rolled `BigInt(...)`. The shape guards stay in
 *  FRONT of it and are not decoration: the constructor THROWS on a non-digit
 *  string (SyntaxError) and on a non-finite number (RangeError), and a
 *  projector must skip a malformed money field, never crash the sweep. Digits
 *  only ⇒ no sign, no fraction, no exponent; safe non-negative integers only on
 *  the number path, so the constructor's truncation can never silently move a
 *  value. */
export function millsOrNull(value: unknown): Mills | null {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return millsFromInteger(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return millsFromInteger(value);
  }
  return null;
}

export function isoDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}
