/**
 * The arithmetic every chart in the console shares: the time axis a series is
 * drawn on, the ticks of both axes. Pure functions, so a test pins them.
 *
 * WHY NOT RECHARTS' OWN. Its y ticks step by one significant digit (0 · 7 ·
 * 14 · 21 · 28), its x ticks under `preserveStartEnd` land at uneven dates
 * (3 · 6 · 9 · 15 окт), and a category axis built from the rows alone squeezes
 * a day nobody captured out of the timeline — the line then runs straight over
 * the hole as if it were measured.
 */

export interface LinearTicks {
  domain: [number, number];
  ticks: number[];
}

/** A round step at or above `raw`: 1 · 2 · 2.5 · 5 × 10ⁿ (no 2.5 below ten
 *  when the values are whole counts). */
export function niceStep(raw: number, integer = false): number {
  if (!Number.isFinite(raw) || raw <= 0) {
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const residual = raw / magnitude;
  const allowQuarter = !integer || magnitude >= 10;
  const factor = residual <= 1 ? 1
    : residual <= 2 ? 2
      : allowQuarter && residual <= 2.5 ? 2.5
        : residual <= 5 ? 5
          : 10;
  const step = factor * magnitude;
  return integer ? Math.max(1, Math.round(step)) : step;
}

function tidy(value: number): number {
  return Number(value.toPrecision(12));
}

function ticksFor(lo: number, hi: number, step: number): LinearTicks {
  const start = Math.floor(tidy(lo / step)) * step;
  const end = Math.ceil(tidy(hi / step)) * step;
  const ticks: number[] = [];
  for (let index = 0; start + index * step <= end + step / 2; index += 1) {
    ticks.push(tidy(start + index * step));
  }
  return { domain: [tidy(start), tidy(end)], ticks };
}

/**
 * Round ticks for a value axis that always shows zero (a bar or an area grows
 * from it; a refund pulls the domain below it). `target` is how many intervals
 * the axis should have, roughly — the step is rounded up, never down.
 */
export function linearTicks(
  min: number,
  max: number,
  options: { target?: number; integer?: boolean } = {},
): LinearTicks {
  const lo = Math.min(0, Number.isFinite(min) ? min : 0);
  const hi = Math.max(0, Number.isFinite(max) ? max : 0);
  if (lo === hi) {
    return { domain: [0, 1], ticks: [0, 1] };
  }
  const step = niceStep((hi - lo) / (options.target ?? 4), options.integer ?? false);
  return ticksFor(lo, hi, step);
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Steps a reader can add up in their head: 15 мин, 30 мин, 1 ч, 2 ч … */
const DURATION_STEPS_MS = [
  SECOND, 2 * SECOND, 5 * SECOND, 10 * SECOND, 15 * SECOND, 30 * SECOND,
  MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE,
  HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR,
];

/** Ticks for a duration axis in milliseconds, on clock-shaped steps. */
export function durationTicks(maxMs: number, target = 4): LinearTicks {
  const hi = Math.max(0, Number.isFinite(maxMs) ? maxMs : 0);
  if (hi === 0) {
    return { domain: [0, MINUTE], ticks: [0, MINUTE] };
  }
  const raw = hi / target;
  const step = DURATION_STEPS_MS.find((candidate) => candidate >= raw)
    ?? niceStep(raw / (24 * HOUR), true) * 24 * HOUR;
  return ticksFor(0, hi, step);
}

/** Day counts a calendar reader recognises as a rhythm: daily, every other
 *  day, weekly, fortnightly, monthly. */
const INDEX_TICK_STEPS = [1, 2, 3, 5, 7, 14, 28, 30, 60, 90, 180, 365];

/**
 * Which of `count` evenly spaced buckets carry a label: at most `budget` of
 * them, at a constant step, counted back from the LAST bucket so the newest
 * day — the one a reader checks first — is always labelled.
 */
export function evenTickIndices(count: number, budget: number): number[] {
  if (count <= 0) {
    return [];
  }
  const limit = Math.max(2, Math.floor(budget));
  const step = INDEX_TICK_STEPS.find((candidate) => Math.ceil(count / candidate) <= limit)
    ?? Math.ceil(count / limit);
  const indices: number[] = [];
  for (let index = count - 1; index >= 0; index -= step) {
    indices.unshift(index);
  }
  return indices;
}

/** How many date labels fit across `widthPx`, one per ~`spacingPx`. */
export function tickBudget(widthPx: number, spacingPx = 72, max = 10): number {
  if (!(widthPx > 0)) {
    return 6;
  }
  return Math.max(2, Math.min(max, Math.floor(widthPx / spacingPx)));
}

function isoKey(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Above this many buckets the window is not drawn bucket by bucket. */
const MAX_TIMELINE_BUCKETS = 2_000;

/**
 * Every bucket start in `[from, to)` on the `periodMs` grid (daily buckets sit
 * on UTC midnight, as Fansly's datapoints do), merged with every bucket the
 * response actually served — so a served bucket off the grid is never lost.
 *
 * The axis therefore spans the WINDOW ASKED FOR, not the rows that came back:
 * a day nobody captured is a hole the chart shows, at its place in time.
 */
export function bucketTimeline(
  window: { from: string; to: string },
  periodMs: number,
  served: Iterable<string>,
): string[] {
  const keys = new Set<string>();
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (
    Number.isFinite(from)
    && Number.isFinite(to)
    && periodMs > 0
    && (to - from) / periodMs <= MAX_TIMELINE_BUCKETS
  ) {
    for (let at = Math.ceil(from / periodMs) * periodMs; at < to; at += periodMs) {
      keys.add(new Date(at).toISOString());
    }
  }
  for (const start of served) {
    const key = isoKey(start);
    if (key !== null) {
      keys.add(key);
    }
  }
  return [...keys].sort();
}

/** Every business date from `from` to `to`, both inclusive (`YYYY-MM-DD`). */
export function businessDateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return dates;
  }
  for (let at = start; at <= end && dates.length <= MAX_TIMELINE_BUCKETS; at += 86_400_000) {
    dates.push(new Date(at).toISOString().slice(0, 10));
  }
  return dates;
}

/** The key a served bucket is looked up by on a timeline. */
export function bucketKey(bucketStart: string): string {
  return isoKey(bucketStart) ?? bucketStart;
}

/** The largest stacked total (positive side) and the deepest negative one. */
export function stackedExtent(
  rows: readonly Record<string, unknown>[],
  keys: readonly string[],
): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (const row of rows) {
    let positive = 0;
    let negative = 0;
    for (const key of keys) {
      const value = row[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        if (value >= 0) positive += value;
        else negative += value;
      }
    }
    max = Math.max(max, positive);
    min = Math.min(min, negative);
  }
  return { min, max };
}
