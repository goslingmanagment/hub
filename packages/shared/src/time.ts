import type { Platform } from "./types.ts";

export const MOSCOW_TIME_ZONE = "Europe/Moscow";
export const UTC_TIME_ZONE = "UTC";
export const PERIOD_OPTIONS = ["today", "7d", "30d", "all", "custom"] as const;
export const SPENDER_PERIOD_OPTIONS = [
  "today",
  "7d",
  "30d",
  "90d",
  "180d",
  "mtd",
  "custom",
  "lifetime",
] as const;
export const SPENDER_SERIES_GRANULARITIES = ["day", "week", "month", "auto"] as const;
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
export type SpenderPeriod = (typeof SPENDER_PERIOD_OPTIONS)[number];
export type SpenderSeriesGranularity = (typeof SPENDER_SERIES_GRANULARITIES)[number];

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

interface SpenderTrailingPeriodOffsets extends TrailingPeriodOffsets {
  "90d": number;
  "180d": number;
}

const DEFAULT_TRAILING_PERIOD_OFFSETS: TrailingPeriodOffsets = {
  "7d": 6,
  "30d": 29,
};

const DEFAULT_SPENDER_TRAILING_PERIOD_OFFSETS: SpenderTrailingPeriodOffsets = {
  "7d": 6,
  "30d": 29,
  "90d": 89,
  "180d": 179,
};

// OnlyFans trailing revenue windows deliberately run one calendar day longer
// than the defaults above (7d spans 8 days, 30d spans 31). Introduced by
// 153bc96 ("Fix OnlyFans revenue rollups and resync recovery", 2026-03-09)
// without a recorded rationale — presumably to absorb vendor data lag. The
// numbers are intentionally left as-is (decision #51): mixed-platform reports
// disclose the per-platform windows via `platformWindows` instead of aligning
// them (audit B2).
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

export function isSpenderPeriod(value: string): value is SpenderPeriod {
  return (SPENDER_PERIOD_OPTIONS as readonly string[]).includes(value);
}

export function parseSpenderPeriod(value: string): SpenderPeriod {
  if (isSpenderPeriod(value)) {
    return value;
  }

  throw new Error(
    `Unsupported period "${value}". Valid options: ${SPENDER_PERIOD_OPTIONS.join(", ")}.`,
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

function formatBusinessDate(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function shiftBusinessDate(value: string, days: number) {
  const { year, month, day } = parseBusinessDate(value);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return formatBusinessDate(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function resolveBusinessTimeZone(platform: Platform): string {
  switch (platform) {
    case "fansly":
    case "onlyfans":
      return UTC_TIME_ZONE;
  }
}

export function businessDateToUtcStart(value: string, timeZone = MOSCOW_TIME_ZONE) {
  const { year, month, day } = parseBusinessDate(value);
  return zonedDateTimeToUtc({ year, month, day }, timeZone);
}

function nextBusinessDateParts(value: string) {
  const { year, month, day } = parseBusinessDate(value);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
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
  const exclusiveToParts = custom.from === custom.to
    ? nextBusinessDateParts(custom.to)
    : { year: toYear, month: toMonth, day: toDay };
  // Custom ranges use an exclusive upper bound: [from, to). Same-day ranges
  // advance the upper bound to cover that single calendar day.
  const to = zonedDateTimeToUtc(
    exclusiveToParts,
    timeZone,
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

export function resolveBusinessDateRangeForPlatform(
  platform: Platform,
  period: Period,
  now = new Date(),
  custom?: { from: string; to: string },
): BusinessDateRange {
  return resolveBusinessDateRange(
    period,
    now,
    custom,
    resolveBusinessTimeZone(platform),
  );
}

export function resolveRevenueBusinessDateRangeForPlatform(
  platform: Platform,
  period: Period,
  now = new Date(),
  custom?: { from: string; to: string },
): BusinessDateRange {
  const timeZone = resolveBusinessTimeZone(platform);
  const bounds = resolveRevenuePeriodBoundsForPlatform(platform, period, now, custom);

  return {
    from: bounds.from ? toBusinessDate(bounds.from, timeZone) : null,
    toExclusive: bounds.to ? toBusinessDate(bounds.to, timeZone) : null,
  };
}

function resolveSpenderPeriodBounds(
  period: SpenderPeriod,
  now: Date,
  custom: { from: string; to: string } | undefined,
  timeZone: string,
): PeriodBounds {
  const todayStart = startOfBusinessDay(now, timeZone);

  if (period === "lifetime") {
    return { from: null, to: null };
  }

  if (period === "today") {
    return { from: todayStart, to: addUtcDays(todayStart, 1) };
  }

  if (period === "7d" || period === "30d" || period === "90d" || period === "180d") {
    return {
      from: addUtcDays(todayStart, -DEFAULT_SPENDER_TRAILING_PERIOD_OFFSETS[period]),
      to: addUtcDays(todayStart, 1),
    };
  }

  if (period === "mtd") {
    const parts = getDateParts(now, timeZone);
    const from = zonedDateTimeToUtc(
      { year: parts.year, month: parts.month, day: 1 },
      timeZone,
    );
    return {
      from,
      to: addUtcDays(todayStart, 1),
    };
  }

  if (!custom) {
    throw new Error("Custom period requires from/to dates");
  }

  return resolveCustomPeriodBounds(custom, timeZone);
}

export function resolveSpenderPeriodBoundsForPlatform(
  platform: Platform,
  period: SpenderPeriod,
  now = new Date(),
  custom?: { from: string; to: string },
): PeriodBounds {
  return resolveSpenderPeriodBounds(
    period,
    now,
    custom,
    resolveBusinessTimeZone(platform),
  );
}

export function resolveSpenderComparisonPeriodBoundsForPlatform(
  platform: Platform,
  period: SpenderPeriod,
  now = new Date(),
  custom?: { from: string; to: string },
): PeriodBounds | null {
  const timeZone = resolveBusinessTimeZone(platform);
  const current = resolveSpenderPeriodBounds(period, now, custom, timeZone);

  if (period === "lifetime" || !current.from || !current.to) {
    return null;
  }

  if (period === "mtd") {
    const todayBusinessDate = toBusinessDate(now, timeZone);
    const { year, month, day } = parseBusinessDate(todayBusinessDate);
    const previousMonth = month === 1
      ? { year: year - 1, month: 12 }
      : { year, month: month - 1 };
    const previousMonthLastDay = daysInMonth(previousMonth.year, previousMonth.month);
    const previousToDay = Math.min(day, previousMonthLastDay);
    const from = zonedDateTimeToUtc(
      { year: previousMonth.year, month: previousMonth.month, day: 1 },
      timeZone,
    );
    const to = addUtcDays(
      zonedDateTimeToUtc(
        { year: previousMonth.year, month: previousMonth.month, day: previousToDay },
        timeZone,
      ),
      1,
    );

    return { from, to };
  }

  const durationMs = current.to.getTime() - current.from.getTime();
  return {
    from: new Date(current.from.getTime() - durationMs),
    to: new Date(current.from.getTime()),
  };
}

export function resolveSpenderBusinessDateRangeForPlatform(
  platform: Platform,
  period: SpenderPeriod,
  now = new Date(),
  custom?: { from: string; to: string },
) {
  const timeZone = resolveBusinessTimeZone(platform);
  const bounds = resolveSpenderPeriodBounds(period, now, custom, timeZone);

  return {
    timeZone,
    fromBusinessDate: bounds.from ? toBusinessDate(bounds.from, timeZone) : null,
    toBusinessDateInclusive: bounds.to
      ? shiftBusinessDate(toBusinessDate(bounds.to, timeZone), -1)
      : null,
    bounds,
  };
}

export function diffBusinessDays(fromBusinessDate: string, toBusinessDateInclusive: string) {
  const { year: fromYear, month: fromMonth, day: fromDay } = parseBusinessDate(fromBusinessDate);
  const { year: toYear, month: toMonth, day: toDay } = parseBusinessDate(toBusinessDateInclusive);
  const fromDate = Date.UTC(fromYear, fromMonth - 1, fromDay);
  const toDate = Date.UTC(toYear, toMonth - 1, toDay);
  return Math.floor((toDate - fromDate) / (24 * 60 * 60 * 1000)) + 1;
}

export function resolveAutoSpenderSeriesGranularity(
  fromBusinessDate: string,
  toBusinessDateInclusive: string,
): Exclude<SpenderSeriesGranularity, "auto"> {
  const dayCount = diffBusinessDays(fromBusinessDate, toBusinessDateInclusive);

  if (dayCount <= 90) {
    return "day";
  }
  if (dayCount <= 365) {
    return "week";
  }

  return "month";
}

export function nextBusinessDate(value: string) {
  return shiftBusinessDate(value, 1);
}

export function previousBusinessDate(value: string) {
  return shiftBusinessDate(value, -1);
}
