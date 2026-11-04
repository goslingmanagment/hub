/**
 * The period of a screen, without React: what the address, the memory and the
 * screen's own values make it (design/ia.md §3.8). The header's control and the
 * screens read the same answer, so a control can never mark what is not shown.
 */
import type { Period } from "@/stores/periodStore";

export type PeriodKey = Period | "24h" | "3d" | "day" | "week" | "month";

export const PERIOD_LABELS: Readonly<Record<PeriodKey, string>> = {
  today: "Сегодня",
  "24h": "Сутки",
  "3d": "3 дня",
  "7d": "7 дней",
  "14d": "14 дней",
  "30d": "30 дней",
  "90d": "90 дней",
  "180d": "180 дней",
  "365d": "Год",
  all: "Всё время",
  day: "День",
  week: "Неделя",
  month: "Месяц",
};

// Shortest first: what "the nearest smaller value" walks along.
const ORDER: readonly PeriodKey[] = ["today", "24h", "day", "3d", "7d", "week", "14d", "30d", "month", "90d", "180d", "365d", "all"];

export function isPeriodKey(value: string | null | undefined): value is PeriodKey {
  return typeof value === "string" && (ORDER as readonly string[]).includes(value);
}

/**
 * The value of `options` closest to `wanted`: the nearest smaller one, the
 * smallest if there is no smaller; `all` gets the largest.
 */
export function nearestPeriod(wanted: PeriodKey, options: readonly PeriodKey[]): PeriodKey {
  if (options.includes(wanted)) return wanted;
  const sorted = [...options].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  if (wanted === "all") return sorted.at(-1) ?? wanted;
  const rank = ORDER.indexOf(wanted);
  const smaller = sorted.filter((key) => ORDER.indexOf(key) < rank).at(-1);
  return smaller ?? sorted[0] ?? wanted;
}

export interface ResolvedPeriod {
  /** What the screen shows: always one of its options. */
  key: PeriodKey;
  /** The value asked for when the screen does not have it: said out loud next to the dates. */
  missing: PeriodKey | null;
}

/** `?period=` wins; else the memory (shared) or the screen's default (own). */
export function resolvePeriod(input: {
  periodClass: "shared" | "own";
  options: readonly PeriodKey[];
  fallback?: PeriodKey | undefined;
  /** The address's value, an old parameter already translated. */
  raw: string | null;
  stored: PeriodKey;
}): ResolvedPeriod {
  const { periodClass, options, fallback, raw, stored } = input;
  const asked: PeriodKey = isPeriodKey(raw) ? raw : periodClass === "shared" ? stored : fallback ?? options[0] ?? stored;
  const key = nearestPeriod(asked, options);
  return { key, missing: key === asked ? null : asked };
}

/** Old names of the same choice on the same address: `?range=1d` on the shifts,
 *  `?days=30` on the sales and on who waited. They keep working by themselves. */
export function periodParam(search: URLSearchParams): string | null {
  const period = search.get("period");
  if (period !== null) return period;
  const range = search.get("range");
  if (range !== null) return range === "1d" ? "24h" : range;
  const days = search.get("days");
  if (days !== null) return days === "1" ? "24h" : `${days}d`;
  return null;
}

/** How many days a period covers: for screens that ask by a number of days. */
export function periodDays(key: PeriodKey): number {
  switch (key) {
    case "today":
    case "24h":
    case "day":
      return 1;
    case "3d":
      return 3;
    case "week":
    case "7d":
      return 7;
    case "14d":
      return 14;
    case "30d":
    case "month":
      return 30;
    case "90d":
      return 90;
    case "180d":
      return 180;
    case "365d":
      return 365;
    case "all":
      return 3650;
  }
}
