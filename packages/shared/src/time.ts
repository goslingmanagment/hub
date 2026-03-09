import type { Platform } from "./types.ts";

export const MOSCOW_TIME_ZONE = "Europe/Moscow";
export const UTC_TIME_ZONE = "UTC";
export const PERIOD_OPTIONS = ["today", "7d", "30d", "all", "custom"] as const;
const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export type Period = (typeof PERIOD_OPTIONS)[number];

export interface PeriodBounds {
  from: Date | null;
  to: Date | null;
}

export interface BusinessDateRange {
  from: string | null;
  toExclusive: string | null;
}

interface TrailingPeriodOffsets {
  "7d": number;
  "30d": number;
}

const DEFAULT_TRAILING_PERIOD_OFFSETS: TrailingPeriodOffsets = {
  "7d": 6,
  "30d": 29,
};

const ONLYFANS_REVENUE_TRAILING_PERIOD_OFFSETS: TrailingPeriodOffsets = {
  "7d": 7,
  "30d": 30,
};

export function isPeriod(value: string): value is Period {
  return (PERIOD_OPTIONS as readonly string[]).includes(value);
}

export function parsePeriod(value: string): Period {
  if (isPeriod(value)) {
    return value;
  }

  throw new Error(
    `Unsupported period "${value}". Valid options: ${PERIOD_OPTIONS.join(", ")}.`,
  );
}

function getDateParts(date: Date, timeZone: string): DateParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    hour: Number(byType.hour),
    minute: Number(byType.minute),
    second: Number(byType.second),
  };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = getDateParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return asUtc - date.getTime();
}

export function zonedDateTimeToUtc(
  parts: Pick<DateParts, "year" | "month" | "day"> &
    Partial<Pick<DateParts, "hour" | "minute" | "second">>,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  const guessDate = new Date(utcGuess);
  const offset = getTimeZoneOffsetMs(guessDate, timeZone);

  return new Date(utcGuess - offset);
}

export function startOfBusinessDay(date: Date, timeZone = MOSCOW_TIME_ZONE): Date {
  const parts = getDateParts(date, timeZone);
  return zonedDateTimeToUtc(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone,
  );
}

export function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function toBusinessDate(date: Date, timeZone = MOSCOW_TIME_ZONE): string {
  const parts = getDateParts(date, timeZone);
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");

  return `${parts.year}-${month}-${day}`;
}

export function isValidBusinessDateString(value: string): boolean {
  if (!BUSINESS_DATE_PATTERN.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export function parseBusinessDate(value: string) {
  if (!isValidBusinessDateString(value)) {
    throw new Error(`Invalid business date "${value}"`);
  }

  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

export function resolveBusinessTimeZone(platform: Platform): string {
  return platform === "onlyfans" ? UTC_TIME_ZONE : MOSCOW_TIME_ZONE;
}

function resolveCustomPeriodBounds(
  custom: { from: string; to: string },
  timeZone: string,
): PeriodBounds {
  const { year: fromYear, month: fromMonth, day: fromDay } = parseBusinessDate(custom.from);
  const { year: toYear, month: toMonth, day: toDay } = parseBusinessDate(custom.to);
  if (custom.from > custom.to) {
    throw new Error(`Custom period requires from <= to, received ${custom.from} > ${custom.to}`);
  }

  const from = zonedDateTimeToUtc(
    { year: fromYear, month: fromMonth, day: fromDay },
    timeZone,
  );
  const to = addUtcDays(
    zonedDateTimeToUtc(
      { year: toYear, month: toMonth, day: toDay },
      timeZone,
    ),
    1,
  );

  return { from, to };
}

function resolvePeriodBoundsWithOffsets(
  period: Period,
  now: Date,
  custom: { from: string; to: string } | undefined,
  timeZone: string,
  trailingOffsets: TrailingPeriodOffsets,
): PeriodBounds {
  const todayStart = startOfBusinessDay(now, timeZone);

  if (period === "all") {
    return { from: null, to: null };
  }

  if (period === "today") {
    return { from: todayStart, to: addUtcDays(todayStart, 1) };
  }

  if (period === "7d") {
    return {
      from: addUtcDays(todayStart, -trailingOffsets["7d"]),
      to: addUtcDays(todayStart, 1),
    };
  }

  if (period === "30d") {
    return {
      from: addUtcDays(todayStart, -trailingOffsets["30d"]),
      to: addUtcDays(todayStart, 1),
    };
  }

  if (!custom) {
    throw new Error("Custom period requires from/to dates");
  }

  return resolveCustomPeriodBounds(custom, timeZone);
}

export function resolvePeriodBounds(
  period: Period,
  now = new Date(),
  custom?: { from: string; to: string },
  timeZone = MOSCOW_TIME_ZONE,
): PeriodBounds {
  return resolvePeriodBoundsWithOffsets(
    period,
    now,
    custom,
    timeZone,
    DEFAULT_TRAILING_PERIOD_OFFSETS,
  );
}

export function resolveRevenuePeriodBoundsForPlatform(
  platform: Platform,
  period: Period,
  now = new Date(),
  custom?: { from: string; to: string },
): PeriodBounds {
  return resolvePeriodBoundsWithOffsets(
    period,
    now,
    custom,
    resolveBusinessTimeZone(platform),
    platform === "onlyfans"
      ? ONLYFANS_REVENUE_TRAILING_PERIOD_OFFSETS
      : DEFAULT_TRAILING_PERIOD_OFFSETS,
  );
}

export function resolveComparisonPeriodBounds(
  period: Period,
  now = new Date(),
  custom?: { from: string; to: string },
  timeZone = MOSCOW_TIME_ZONE,
): PeriodBounds | null {
  const current = resolvePeriodBounds(period, now, custom, timeZone);

  if (period === "all" || !current.from || !current.to) {
    return null;
  }

  const durationMs = current.to.getTime() - current.from.getTime();

  return {
    from: new Date(current.from.getTime() - durationMs),
    to: new Date(current.from.getTime()),
  };
}

export function resolveRevenueComparisonPeriodBoundsForPlatform(
  platform: Platform,
  period: Period,
  now = new Date(),
  custom?: { from: string; to: string },
): PeriodBounds | null {
  const current = resolveRevenuePeriodBoundsForPlatform(platform, period, now, custom);

  if (period === "all" || !current.from || !current.to) {
    return null;
  }

  const durationMs = current.to.getTime() - current.from.getTime();

  return {
    from: new Date(current.from.getTime() - durationMs),
    to: new Date(current.from.getTime()),
  };
}

export function resolveBusinessDateRange(
  period: Period,
  now = new Date(),
  custom?: { from: string; to: string },
  timeZone = MOSCOW_TIME_ZONE,
): BusinessDateRange {
  const bounds = resolvePeriodBounds(period, now, custom, timeZone);

  return {
    from: bounds.from ? toBusinessDate(bounds.from, timeZone) : null,
    toExclusive: bounds.to ? toBusinessDate(bounds.to, timeZone) : null,
  };
}
