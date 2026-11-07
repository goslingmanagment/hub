// The monthly API credit of each Anthropic account (`aiAccountCredits`,
// 2026-11-07): the owner's subscriptions renew on a fixed day of the month and
// put a fixed credit into the account a day or two later. Hub counts it in
// the account's balance by itself (ai-account-balance.ts), so the balance no
// longer waits for the owner's console reading. JSON keyed by the account's
// label in ANTHROPIC_API_KEYS, e.g. {"main": {"day": 3, "usd": 200}}; an
// account it does not name gets no credit counted. Checked on write
// (config-registry `format`), so a stored value always parses.

import { microUsdFromDollars, type MicroUsd } from "./money.ts";

export interface AiAccountCredit {
  /** The subscription's renewal day of the month, Moscow time (1–31; a short
   *  month renews on its last day). */
  day: number;
  /** The credit each renewal adds, micro-USD. */
  microUsd: MicroUsd;
}

export type AiAccountCredits = Record<string, AiAccountCredit>;

const LABEL = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const EXAMPLE = `{"main": {"day": 3, "usd": 200}}`;
const MAX_USD = 100_000;

type Parse = { ok: true; value: AiAccountCredits } | { ok: false; error: string };

export function parseAiAccountCredits(text: string): Parse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `is not JSON: an object keyed by account label, e.g. ${EXAMPLE}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `is an object keyed by account label, e.g. ${EXAMPLE}` };
  }
  const value: AiAccountCredits = {};
  for (const [label, raw] of Object.entries(parsed)) {
    if (!LABEL.test(label)) {
      return { ok: false, error: `"${label}" is not an account label (lowercase latin, digits, _ or -)` };
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, error: `"${label}" must be {"day": <1–31>, "usd": <credit>}` };
    }
    const { day, usd, ...rest } = raw as Record<string, unknown>;
    if (Object.keys(rest).length > 0) {
      return { ok: false, error: `"${label}" has unknown fields ${Object.keys(rest).join(", ")}; only day and usd` };
    }
    if (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 31) {
      return { ok: false, error: `"${label}".day must be the renewal day of the month, 1 to 31` };
    }
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0 || usd > MAX_USD) {
      return { ok: false, error: `"${label}".usd must be the monthly credit in dollars, above 0 and up to ${MAX_USD}` };
    }
    value[label] = { day, microUsd: microUsdFromDollars(usd) };
  }
  return { ok: true, value };
}

/** The stored value, parsed; an unset or unparsable one names no account. */
export function aiAccountCreditsOf(text: string | undefined): AiAccountCredits {
  if (text === undefined) return {};
  const parsed = parseAiAccountCredits(text);
  return parsed.ok ? parsed.value : {};
}
