import { formatAgo, formatDay } from "@agency_hub_core/ui/format";

const DAY_MS = 86_400_000;

/**
 * One rule for the moments of Доступ (Д8): what happened within a day — «24 мин
 * назад», «5 ч назад»; anything older, or still to come — the date, «26 окт.».
 */
export function whenWords(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  return at <= now && now - at < DAY_MS ? formatAgo(at, now) : formatDay(iso);
}
