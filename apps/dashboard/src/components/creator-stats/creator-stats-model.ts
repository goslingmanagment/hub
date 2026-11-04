import type { CreatorStatsOverviewResponse } from "@agency_hub_core/contracts";

import { businessDateRange } from "@/components/charts/scale";
import { formatBusinessDateShort, formatDuration, formatSeconds } from "@/lib/format";

// The shapes «Статистика» draws, built from Fansly's own answers. Fansly sends a
// row only for a day with activity: inside the span Hub has read, a day without a
// row is a zero; before it, the day is unknown (null, drawn as a gap) — never a
// zero nobody measured.

export type CreatorStats = CreatorStatsOverviewResponse;

/** The surfaces as the owner reads them (map §5: 0 For You, 1 Timeline, 2
 *  Suggestions, 3 Search, 4 Other). A code this build cannot name is shown, so a
 *  change on Fansly's side never looks like a drop. */
export const SOURCE_LABELS: Readonly<Record<number, string>> = {
  0: "For You",
  1: "Лента подписок",
  2: "Рекомендации",
  3: "Поиск",
  4: "Другое",
};

/** The colour belongs to the source, never to its place in a list (DL §8). */
export const SOURCE_COLORS: Readonly<Record<number, string>> = {
  0: "var(--color-chart-aqua)",
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

/** Fansly's revenue types (the server's labels), in the owner's words. */
const REVENUE_TYPE_LABELS: Readonly<Record<string, string>> = {
  media: "Платные медиа",
  media_sets: "Наборы медиа",
  tips: "Чаевые",
  locked_text: "Платный текст",
  stream_tickets: "Билеты на стримы",
  subscriptions: "Подписки",
  referrals: "Рефералы",
  refund: "Возвраты",
  internal_transfer: "Внутренние переводы",
  subscription_payment_credit: "Зачёт оплаты подписки",
  balance_purchase: "Пополнение баланса",
  canceled_payout_refund: "Возврат отменённой выплаты",
  leaderboard_prize_money: "Призы рейтинга",
  gift_code_claim: "Подарочные коды",
  promotional_credit: "Промо-начисления",
  crypto_balance_purchase: "Пополнение криптовалютой",
  product_order: "Заказы товаров",
};

/** A revenue type's name; a code this build cannot name reads «Другой вид». */
export function revenueTypeLabel(typeLabel: string): string {
  return REVENUE_TYPE_LABELS[typeLabel] ?? "Другой вид";
}

/* A type's colour belongs to the TYPE, never to its place in this window's list:
 * a period without tips must not repaint subscriptions. Refunds are muted; the
 * rest share «Прочее». */
const TYPE_COLORS: Readonly<Record<string, string>> = {
  subscriptions: "var(--color-chart-blue)",
  tips: "var(--color-chart-orange)",
  media: "var(--color-chart-aqua)",
  media_sets: "var(--color-chart-violet)",
  locked_text: "var(--color-chart-magenta)",
  stream_tickets: "var(--color-chart-lime)",
  refund: "var(--color-text-muted)",
};
export const OTHER_TYPE_COLOR = "var(--color-border-strong)";

export function revenueTypeColor(typeLabel: string): string {
  return TYPE_COLORS[typeLabel] ?? OTHER_TYPE_COLOR;
}

const MONTHS = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

/** «Октябрь 2026». */
export function formatMonth(year: number, month: number): string {
  const name = MONTHS[month - 1];
  return name === undefined ? `${year}-${String(month).padStart(2, "0")}` : `${name} ${year}`;
}

/** Watch time: «669 ч 30 мин», «47 мин», under a minute «40 с». Never «669,5 ч». */
export function formatWatchTime(ms: number): string {
  const seconds = Math.abs(ms) / 1_000;
  const sign = ms < 0 ? "−" : "";
  if (seconds < 60) return `${sign}${formatSeconds(seconds)}`;
  const minutes = Math.round(seconds / 60);
  // «4 559 ч 7 мин»: the hours grouped like every other count.
  if (minutes < 60 * 1000) return `${sign}${formatDuration(minutes)}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${sign}${hours.toLocaleString("ru-RU")} ч${rest > 0 ? ` ${rest} мин` : ""}`;
}

/** A UTC day of Fansly as a date: «3 нояб.». */
export function formatStatsDay(day: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(day) ? formatBusinessDateShort(day.slice(0, 10)) : day;
}

/** «5 окт. – 3 нояб.», «21–27 окт.»; with the years when the span leaves the current year. */
export function formatStatsRange(fromDay: string, toDay: string, now = new Date()): string {
  const year = String(now.getUTCFullYear());
  const from = formatStatsDay(fromDay);
  const to = formatStatsDay(toDay);
  if (!fromDay.startsWith(year) || !toDay.startsWith(year)) {
    return `${from} ${fromDay.slice(0, 4)} – ${to} ${toDay.slice(0, 4)}`;
  }
  if (fromDay === toDay) return to;
  if (fromDay.slice(0, 7) === toDay.slice(0, 7)) return `${from.split(" ")[0]}–${to}`;
  return `${from} – ${to}`;
}

/** An hour of Fansly on the Moscow clock: «3 нояб., 15:00». */
const HOUR_FORMAT = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });
const HOUR_DAY_FORMAT = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "Europe/Moscow" });

export function formatStatsHour(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${HOUR_DAY_FORMAT.format(at)}, ${HOUR_FORMAT.format(at)}`;
}

/** The day or hour that has not ended yet: its number will still grow. */
export function bucketInProgress(bucketStart: string, periodMs: number, now = Date.now()): boolean {
  const start = Date.parse(bucketStart.length === 10 ? `${bucketStart}T00:00:00Z` : bucketStart);
  return Number.isFinite(start) && start + periodMs > now;
}

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const IN_PROGRESS_NOTE = "День ещё идёт, число вырастет.";
export const HOUR_IN_PROGRESS_NOTE = "Час ещё идёт, число вырастет.";

/** Every UTC day of the answer's window. */
export function windowDays(stats: { window: { fromDay: string; toDay: string } }): string[] {
  return businessDateRange(stats.window.fromDay, stats.window.toDay);
}

/** The UTC day `days` before or after `day`. */
export function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export interface StatsWindow {
  fromDay: string;
  toDay: string;
  days: number;
}

/** The window a period of `days` will show, before the server says it: the last
 *  `days` UTC days up to today. */
export function expectedWindow(days: number, now = new Date()): StatsWindow {
  const toDay = now.toISOString().slice(0, 10);
  return { fromDay: shiftDay(toDay, -(days - 1)), toDay, days };
}

/** The window just before, of the same length. */
export function previousWindow(window: StatsWindow): { fromDay: string; toDay: string } {
  return { fromDay: shiftDay(window.fromDay, -window.days), toDay: shiftDay(window.fromDay, -1) };
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

/** The newest `updatedAt` of coverage rows; null when there are none. */
export function newestUpdate(rows: ReadonlyArray<{ updatedAt: string }>): string | null {
  let newest: string | null = null;
  for (const row of rows) if (newest === null || row.updatedAt > newest) newest = row.updatedAt;
  return newest;
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

/** Bars want numbers: a day Hub has not read keeps no keys and is drawn as no
 *  bar that says «нет данных» on hover, never as a zero. */
export function barRows(rows: readonly DayPoint[]): Array<Record<string, string | number>> {
  return rows.map((row) => {
    const out: Record<string, string | number> = { bucketStart: row.bucketStart };
    for (const [key, value] of Object.entries(row)) if (key !== "bucketStart" && typeof value === "number") out[key] = value;
    return out;
  });
}

/** The distinct keys of `rows`, ordered by their total, largest first. */
export function keysByTotal<R>(rows: readonly R[], keyOf: (row: R) => string, valueOf: (row: R) => number | null): string[] {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(keyOf(row), (totals.get(keyOf(row)) ?? 0) + Math.abs(valueOf(row) ?? 0));
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
}

/** The sum of a series over the rows; null when no row carries it. */
export function seriesTotal(rows: ReadonlyArray<Record<string, unknown>>, key: string): number | null {
  let sum: number | null = null;
  for (const row of rows) {
    const value = row[key];
    if (typeof value === "number") sum = (sum ?? 0) + value;
  }
  return sum;
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

/** Share of For You in the window's views, 0–100: from Fansly's totals, else the days. */
export function forYouShare(stats: CreatorStats): number | null {
  const fromTotals = stats.totals.filter((entry) => entry.scope === "views" && entry.metric === "views" && entry.ref !== "");
  const pairs = fromTotals.length > 0
    ? fromTotals.map((entry) => ({ source: Number(entry.ref), views: entry.value }))
    : stats.views.map((row) => ({ source: row.source, views: row.views }));
  let all = 0;
  let forYou = 0;
  for (const pair of pairs) {
    all += pair.views ?? 0;
    if (pair.source === 0) forYou += pair.views ?? 0;
  }
  return all > 0 ? (forYou / all) * 100 : null;
}

/** Average share of the video watched, 0–100: the sum of watched shares in
 *  hundredths of a percent over the video views (map §4). */
export function averageWatchPercent(watchPctSum: number | null, videoViews: number | null): number | null {
  if (watchPctSum === null || videoViews === null || videoViews === 0) return null;
  return watchPctSum / videoViews / 100;
}

/** The window's average watch over every source and day. */
export function averageWatch(stats: CreatorStats): number | null {
  let sum = 0;
  let videos = 0;
  for (const row of stats.views) {
    if (row.watchPctSum === null || row.videoViews === null) continue;
    sum += row.watchPctSum;
    videos += row.videoViews;
  }
  return averageWatchPercent(sum, videos);
}

/** A part of a whole in percent; null without a whole. */
export function share(part: number | null, whole: number | null): number | null {
  return part === null || whole === null || whole === 0 ? null : (part / whole) * 100;
}

/** A sentence ends once: «… 4 нояб.» takes no second dot. */
export function sentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}
