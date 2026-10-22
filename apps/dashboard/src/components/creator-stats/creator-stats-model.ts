import type { CreatorStatsOverviewResponse } from "@agency_hub_core/contracts";

import { businessDateRange } from "@/components/charts/scale";

// The shapes the "Статистика" page draws, built from one answer of
// `GET /pages/:label/stats/creator`. Fansly sends a row only for a day with
// activity: inside the span Hub has read, a day without a row is a zero; before
// it, the day is unknown (null, drawn as a gap) — never a zero nobody measured.

export type CreatorStats = CreatorStatsOverviewResponse;

/** The surfaces as Fansly names them (map §5: 0 For You, 1 Timeline, 2
 *  Suggestions, 3 Search, 4 Other). */
export const SOURCE_LABELS: Readonly<Record<number, string>> = {
  0: "FYP",
  1: "Лента",
  2: "Рекомендации",
  3: "Поиск",
  4: "Другое",
};

export const SOURCE_COLORS: Readonly<Record<number, string>> = {
  0: "var(--color-chart-green)",
  1: "var(--color-chart-blue)",
  2: "var(--color-chart-violet)",
  3: "var(--color-chart-orange)",
  4: "var(--color-chart-magenta)",
};

export function sourceLabel(source: number): string {
  return SOURCE_LABELS[source] ?? `Источник ${source}`;
}

export function sourceColor(source: number): string {
  return SOURCE_COLORS[source] ?? "var(--color-text-muted)";
}

/** Every UTC day of the answer's window. */
export function windowDays(stats: CreatorStats): string[] {
  return businessDateRange(stats.window.fromDay, stats.window.toDay);
}

/**
 * The first day Hub has read for a series (`series:<family>:day`, steady or
 * history), from the plane's coverage; null: never read.
 */
export function coveredFrom(stats: CreatorStats, scope: string): string | null {
  let oldest: string | null = null;
  for (const row of stats.coverage) {
    if (!row.scopeRef.endsWith(scope) || row.oldestCapturedAt === null) continue;
    const day = row.oldestCapturedAt.slice(0, 10);
    if (oldest === null || day < oldest) oldest = day;
  }
  return oldest;
}

export type DayPoint = { bucketStart: string } & Record<string, number | null | string>;

/**
 * One point a day with one key per series: the sum of `value` over the rows of
 * that day and key; 0 for a read day without rows, null before `from`.
 */
export function pivotDays<R extends { day: string }>(
  days: readonly string[],
  rows: readonly R[],
  keyOf: (row: R) => string,
  valueOf: (row: R) => number | null,
  keys: readonly string[],
  from: string | null,
): DayPoint[] {
  const sums = new Map<string, number>();
  for (const row of rows) {
    const value = valueOf(row);
    if (value === null) continue;
    const at = `${row.day}|${keyOf(row)}`;
    sums.set(at, (sums.get(at) ?? 0) + value);
  }
  return days.map((day) => {
    const point: DayPoint = { bucketStart: day };
    const read = from !== null && day >= from;
    for (const key of keys) point[key] = read ? sums.get(`${day}|${key}`) ?? 0 : null;
    return point;
  });
}

/** The distinct keys of `rows`, ordered by their total, largest first. */
export function keysByTotal<R>(rows: readonly R[], keyOf: (row: R) => string, valueOf: (row: R) => number | null): string[] {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(keyOf(row), (totals.get(keyOf(row)) ?? 0) + Math.abs(valueOf(row) ?? 0));
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
}

// ── the window's totals ─────────────────────────────────────────────────────

export interface Kpi {
  value: number | null;
  previous: number | null;
}

function total(stats: CreatorStats, scope: string, metric: string, ref = ""): Kpi | null {
  const row = stats.totals.find((entry) => entry.scope === scope && entry.ref === ref && entry.metric === metric);
  return row === undefined ? null : { value: row.value, previous: row.previous };
}

/** A metric summed over every row of a scope (views per source add up). */
function totalOverRefs(stats: CreatorStats, scope: string, metric: string): Kpi | null {
  const rows = stats.totals.filter((entry) => entry.scope === scope && entry.ref !== "" && entry.metric === metric);
  if (rows.length === 0) return null;
  const sum = (pick: (row: (typeof rows)[number]) => number | null) =>
    rows.every((row) => pick(row) === null) ? null : rows.reduce((acc, row) => acc + (pick(row) ?? 0), 0);
  return { value: sum((row) => row.value), previous: sum((row) => row.previous) };
}

function sumRows<R>(rows: readonly R[], valueOf: (row: R) => number | null): number | null {
  let sum: number | null = null;
  for (const row of rows) {
    const value = valueOf(row);
    if (value !== null) sum = (sum ?? 0) + value;
  }
  return sum;
}

/**
 * The page's headline figures. Fansly's own window totals when Hub holds the
 * summary of exactly this period (they carry the previous period too); the
 * daily rows' sums otherwise (no comparison then).
 */
export function headline(stats: CreatorStats) {
  const lastLevel = [...stats.levels].reverse().find((row) => row.subscriberCount !== null || row.followerCount !== null);
  const firstLevel = stats.levels.find((row) => row.subscriberCount !== null || row.followerCount !== null);
  return {
    fromSummary: stats.totalsWindow !== null,
    views: totalOverRefs(stats, "views", "views") ?? { value: sumRows(stats.views, (r) => r.views), previous: null },
    watchMs: totalOverRefs(stats, "views", "watchMs") ?? { value: sumRows(stats.views, (r) => r.watchMs), previous: null },
    profileVisits: total(stats, "profile", "profileVisits")
      ?? { value: sumRows(stats.profile, (r) => r.profileVisits), previous: null },
    netFollows: total(stats, "follows", "netFollows")
      ?? { value: sumRows(stats.follows, (r) => r.follows === null && r.unfollows === null ? null : (r.follows ?? 0) - (r.unfollows ?? 0)), previous: null },
    followers: total(stats, "account", "followerCount")
      ?? { value: lastLevel?.followerCount ?? null, previous: firstLevel?.followerCount ?? null },
    subscribers: total(stats, "account", "subscriberCount")
      ?? { value: lastLevel?.subscriberCount ?? null, previous: firstLevel?.subscriberCount ?? null },
    netMills: total(stats, "revenue", "netMills") ?? { value: sumRows(stats.revenue, (r) => r.netMills), previous: null },
    payingFans: total(stats, "revenue", "payingFans"),
    newPayingFans: total(stats, "revenue", "newPayingFans"),
    uniqueViewers: (source: number) => total(stats, "views", "uniqueViewers", String(source)),
  };
}

/** The change from `previous` to `value` in percent; null without both. */
export function changePercent(kpi: Kpi | null): number | null {
  if (kpi === null || kpi.value === null || kpi.previous === null || kpi.previous === 0) return null;
  return ((kpi.value - kpi.previous) / Math.abs(kpi.previous)) * 100;
}
