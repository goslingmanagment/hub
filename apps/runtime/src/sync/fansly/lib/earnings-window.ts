// Fansly earnings/stats caps aggregate rows but ignores offset. Split on UTC
// business-day boundaries; every type belonging to one day stays together.
const DAY_MS = 86_400_000;
export const FANSLY_EARNINGS_ROW_LIMIT = 100;

export interface EarningsWindow {
  afterMs: number;
  beforeMs: number;
}

export interface EarningsWindowWalk {
  afterMs: number;
  beforeMs: number;
  /** Depth-first, newest window last. Persisted before yielding to another chunk. */
  pending: EarningsWindow[];
  hasRows: boolean;
}

export function startEarningsWindow(afterMs: number, beforeMs: number): EarningsWindowWalk {
  // Ask from UTC midnight, never an intraday instant: Fansly sums a day's
  // bucket over only the part of that day inside the window, so a lower bound
  // inside a day serves the day TRUNCATED, and as the newer look it would win
  // the day's head (the walks before 2026-09-18 left such rows on prod). The
  // split seams below are midnights too; only the open day at `beforeMs` is
  // partial, and the next capture replaces it.
  const window = { afterMs: Math.floor(afterMs / DAY_MS) * DAY_MS, beforeMs };
  return { ...window, pending: [window], hasRows: false };
}

export function parseEarningsWindow(value: unknown): EarningsWindowWalk | null {
  if (!value || typeof value !== "object") return null;
  const walk = value as EarningsWindowWalk;
  const valid = (window: EarningsWindow): boolean => window !== null
    && typeof window === "object" && Number.isSafeInteger(window.afterMs)
    && Number.isSafeInteger(window.beforeMs) && window.afterMs <= window.beforeMs;
  if (!valid(walk) || !Array.isArray(walk.pending) || walk.pending.length > 32
    || !walk.pending.every((window) => valid(window)
      && window.afterMs >= walk.afterMs && window.beforeMs <= walk.beforeMs)) return null;
  return { afterMs: walk.afterMs, beforeMs: walk.beforeMs,
    pending: walk.pending.map((window) => ({ ...window })), hasRows: walk.hasRows === true };
}

export type EarningsWindowResult = "continue" | "complete" | "saturated_day"
  | "window_not_honoured" | "invalid";

/** Called only AFTER journaling. An incomplete parent remains pending until
 * both children complete; a short child never proves the whole root empty. */
export function advanceEarningsWindow(
  walk: EarningsWindowWalk,
  body: unknown,
): EarningsWindowResult {
  const window = walk.pending.at(-1);
  if (!window || !Array.isArray(body) || body.some((row: unknown) => !row
    || typeof row !== "object" || !Number.isSafeInteger((row as { timestamp?: unknown }).timestamp))) {
    return "invalid";
  }
  if (body.some((row: { timestamp: number }) => row.timestamp < window.afterMs
    || row.timestamp > window.beforeMs)) return "window_not_honoured";
  walk.hasRows ||= body.length > 0;
  if (body.length >= FANSLY_EARNINGS_ROW_LIMIT) {
    const firstDay = Math.floor(window.afterMs / DAY_MS);
    const lastDay = Math.floor(window.beforeMs / DAY_MS);
    if (firstDay >= lastDay) return "saturated_day";
    const seam = (firstDay + Math.ceil((lastDay - firstDay) / 2)) * DAY_MS;
    walk.pending.pop();
    walk.pending.push({ afterMs: window.afterMs, beforeMs: seam - 1 },
      { afterMs: seam, beforeMs: window.beforeMs });
    return "continue";
  }
  walk.pending.pop();
  return walk.pending.length === 0 ? "complete" : "continue";
}
