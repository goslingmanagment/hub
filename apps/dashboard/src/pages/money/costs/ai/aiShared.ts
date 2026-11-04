import { MOSCOW_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";
import type { UsagePeriod } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { featureLabel } from "@/pages/account/accountView";

/** Hub's own lanes, no chatter asked for them. */
const LANE_LABELS: Readonly<Record<string, string>> = {
  "media-describe": "Описание картинок из чатов",
  "fan-facts": "Факты из переписки",
};

export function anyFeatureLabel(feature: string): string {
  return LANE_LABELS[feature] ?? featureLabel(feature);
}

export const ROLE_WORD: Readonly<Record<string, string>> = { owner: "владелец", team_lead: "тимлид", chatter: "чаттер" };

export function todayMoscow(): string {
  return toBusinessDate(new Date(), MOSCOW_TIME_ZONE);
}

/** `?period=` of this screen: an unknown value is a week. */
export function usagePeriodOf(value: string | null): UsagePeriod {
  return value === "day" || value === "month" ? value : "week";
}

/** `?at=`: a day not in the future, else today. */
export function anchorOf(value: string | null, today: string): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && value <= today ? value : today;
}

/** A share of a whole, whole percent: «26 %». Only for display. */
export function sharePct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)} %` : "—";
}

/** «12 тыс.», «1,2 млн»: token counts. */
export function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(".", ",")} млн`;
  if (value >= 10_000) return `${Math.round(value / 1_000)} тыс.`;
  return value.toLocaleString("ru-RU");
}

export function callsWord(value: number): string {
  return `${value.toLocaleString("ru-RU")} ${ruPlural(value, "вызов", "вызова", "вызовов")}`;
}

/** «~6 дней», «~1,5 дня»: whole days from two on, one decimal below. */
export function daysLeftLabel(value: number): string {
  if (value >= 2) {
    const days = Math.round(value);
    return `~${days} ${ruPlural(days, "день", "дня", "дней")}`;
  }
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `~${rounded} ${ruPlural(rounded, "день", "дня", "дней")}` : `~${String(rounded).replace(".", ",")} дня`;
}
