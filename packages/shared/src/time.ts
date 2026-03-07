export const MOSCOW_TIME_ZONE = "Europe/Moscow";

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export type Period = "today" | "7d" | "30d" | "all" | "custom";

export interface PeriodBounds {
  from: Date | null;
  to: Date | null;
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

export function resolvePeriodBounds(
  period: Period,
  now = new Date(),
  custom?: { from: string; to: string },
): PeriodBounds {
  const todayStart = startOfBusinessDay(now);

  if (period === "all") {
    return { from: null, to: null };
  }

  if (period === "today") {
    return { from: todayStart, to: addUtcDays(todayStart, 1) };
  }

  if (period === "7d") {
    return { from: addUtcDays(todayStart, -6), to: addUtcDays(todayStart, 1) };
  }

  if (period === "30d") {
    return { from: addUtcDays(todayStart, -29), to: addUtcDays(todayStart, 1) };
  }

  if (!custom) {
    throw new Error("Custom period requires from/to dates");
  }

  const [fromYear, fromMonth, fromDay] = custom.from.split("-").map(Number);
  const [toYear, toMonth, toDay] = custom.to.split("-").map(Number);
  const from = zonedDateTimeToUtc(
    { year: fromYear, month: fromMonth, day: fromDay },
    MOSCOW_TIME_ZONE,
  );
  const to = addUtcDays(
    zonedDateTimeToUtc(
      { year: toYear, month: toMonth, day: toDay },
      MOSCOW_TIME_ZONE,
    ),
    1,
  );

  return { from, to };
}
