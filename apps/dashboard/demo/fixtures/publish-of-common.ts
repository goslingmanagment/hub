/**
 * Shared helpers of the «publish-of» area: deterministic ids, Moscow days, and
 * the moment OnlyFans collection through the vendor stopped.
 */
import { hashString } from "../core.ts";
import { DEMO_PAGES, type DemoPage } from "../world.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
const MSK_OFFSET_MS = 3 * HOUR_MS;

/** A stable RFC 4122 v4-shaped UUID from a seed. */
export function demoUuid(seed: string): string {
  const hex = [0, 1, 2, 3].map((index) => hashString(`${seed}:${index}`).toString(16).padStart(8, "0")).join("");
  const variant = "89ab"[parseInt(hex[16] ?? "0", 16) % 4];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A stable 64-hex "SHA-256" from a seed. */
export function demoSha(seed: string): string {
  return Array.from({ length: 8 }, (_, index) => hashString(`${seed}#${index}`).toString(16).padStart(8, "0")).join("");
}

/** A stable decimal id of `length` digits (no leading zero). */
export function demoDigits(seed: string, length: number): string {
  let out = String(1 + (hashString(seed) % 9));
  let round = 0;
  while (out.length < length) {
    out += String(hashString(`${seed}/${round}`)).padStart(10, "0");
    round += 1;
  }
  return out.slice(0, length);
}

/** The UTC instant (ms) of Moscow midnight `days` days from today's Moscow day. */
export function mskDayStart(now: Date, days: number): number {
  const local = now.getTime() + MSK_OFFSET_MS;
  return Math.floor(local / DAY_MS) * DAY_MS - MSK_OFFSET_MS + days * DAY_MS;
}

/** A Moscow hour (fractional) on the day `days` from today, as a Date. */
export function mskAt(now: Date, days: number, hour: number): Date {
  return new Date(mskDayStart(now, days) + hour * HOUR_MS);
}

/** "YYYY-MM-DD" of an instant in Moscow. */
export function mskDayKey(at: Date | number): string {
  const time = typeof at === "number" ? at : at.getTime();
  return new Date(time + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * When OnlyFans collection through the vendor stopped (2026-11-01 in reality):
 * the start of the UTC day two days before the request, so the OnlyFans data
 * on screen is always "a few days old".
 */
export function ofStop(now: Date): Date {
  const date = new Date(now.getTime() - 2 * DAY_MS);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

export const OF_PAGES: readonly DemoPage[] = DEMO_PAGES.filter((page) => page.platform === "onlyfans");

export function ofPageById(id: number): DemoPage | undefined {
  return OF_PAGES.find((page) => page.id === id);
}

/** The vendor account id a page is bound to (OnlyFans API "acct_…"). */
export function ofAccountId(page: DemoPage): string {
  return `acct_${demoDigits(`acct:${page.label}`, 8)}`;
}
