/**
 * The words of «Люди» and «Человек»: statuses, shares, the comparison's words,
 * the kinds of a sale. Pure; no React. The three quality numbers of a shift
 * have their words in `@/shared/metrics` (D1), not here.
 */
import { formatDay, formatPercent, formatTimeOfDay, formatWeekdayDay } from "@agency_hub_core/ui/format";
import type { PersonStatus } from "@agency_hub_core/ui";
import { addDays, moscowDayOf } from "@agency_hub_core/ui/moscow";
import { ruPlural } from "@agency_hub_core/ui/plural";
import type { ResolvedPeriod } from "@agency_hub_core/ui/period";
import type { PersonNow, PersonRole, PersonState, SaleKind } from "./data.js";

export const ROLE_WORD: Readonly<Record<PersonRole, string>> = {
  owner: "Владелец",
  team_lead: "Тимлид",
  chatter: "Чаттер",
};

/**
 * The dot of a person and the words beside it — from the shifts only, never
 * from the extension being open (that is «Доступ → Устройства»): «на смене с
 * 21:00», «смена сегодня до 18:10», «смена вчера до 07:31»,
 * «за 7 дней смен не было» (Hub looks only that far back), «доступ отключён 26 окт.».
 * No «был/была»: the words have no gender.
 */
export function statusOf(person: { state: PersonState | null; disabledAt: string | null; now: PersonNow; role?: PersonRole | null }, now: number = Date.now()): { status: PersonStatus; words: string } {
  if (person.state === "disabled") {
    return { status: "disabled", words: person.disabledAt ? `доступ отключён ${formatDay(person.disabledAt)}` : "доступ отключён" };
  }
  if (person.state === "invited") return { status: "invited", words: "ждёт регистрации" };
  if (person.now.onShiftSince) return { status: "working", words: `на смене с ${formatTimeOfDay(person.now.onShiftSince)}` };
  if (person.now.lastShiftEnd) return { status: "away", words: lastShiftWords(person.now.lastShiftEnd, now) };
  // Nothing is said of the owner, who does not work shifts, nor when the shifts were not read. A team lead does not
  // read the accounts (state null), but the shifts are read for everyone: «за 7 дней смен не было» holds for them too.
  if (person.now.quietDays === 0 || person.role === "owner") return { status: "away", words: "" };
  return { status: "away", words: `за ${person.now.quietDays} ${ruPlural(person.now.quietDays, "день", "дня", "дней")} смен не было` };
}

/** «смена сегодня до 18:10», «смена вчера до 07:31», «последняя смена 4 нояб.». */
function lastShiftWords(endedAt: string, now: number): string {
  const today = moscowDayOf(now);
  const day = moscowDayOf(endedAt);
  if (day === today) return `смена сегодня до ${formatTimeOfDay(endedAt)}`;
  if (day === addDays(today, -1)) return `смена вчера до ${formatTimeOfDay(endedAt)}`;
  return `последняя смена ${formatDay(endedAt)}`;
}

/** A share (0…1) as «31 %»; none is «—». */
export function shareText(share: number | null | undefined): string {
  return share === null || share === undefined || !Number.isFinite(share) ? "—" : formatPercent(share * 100);
}

/** `part / whole`, null without a whole. */
export function shareOf(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** What a change is against, exact (on hover): «к 26 окт. – 1 нояб., на то же время». */
export function versusTitle(period: ResolvedPeriod): string {
  return period.current ? `к ${period.previousLabel}, на то же время` : `к ${period.previousLabel}`;
}

/** «за эту неделю», «за 2–8 нояб.», «за 14 дней». */
export function periodWords(period: ResolvedPeriod): string {
  if (period.spec.kind === "week" && period.current) return "за эту неделю";
  if (period.spec.kind === "days") return `за ${period.days} дней`;
  return `за ${period.label}`;
}

/** «за неделю», «за 14 дней», «за 2–8 нояб.»: the short form in a header line. */
export function periodShort(period: ResolvedPeriod): string {
  if (period.spec.kind === "week" && period.current) return "за неделю";
  return periodWords(period);
}

/** The kinds of a sale: their names and colours (chart series, never a state). */
export const KINDS: ReadonlyArray<{ kind: SaleKind; label: string; one: string; color: string }> = [
  { kind: "ppv", label: "Платные сообщения", one: "Платное сообщение", color: "var(--ui-series-1)" },
  { kind: "tip", label: "Чаевые", one: "Чаевые", color: "var(--ui-series-2)" },
  { kind: "subscription", label: "Подписки", one: "Подписка", color: "var(--ui-series-3)" },
  { kind: "post", label: "Посты", one: "Пост", color: "var(--ui-series-4)" },
];

export const KIND_OF: Readonly<Record<SaleKind, (typeof KINDS)[number]>> = Object.fromEntries(KINDS.map((kind) => [kind.kind, kind])) as Record<SaleKind, (typeof KINDS)[number]>;

/** The same words as «Что продаёт → Цена» («Дешевле $10», С10). */
export const PRICE_WORDS: Readonly<Record<string, string>> = {
  upTo10: "дешевле $10",
  "10to25": "$10–25",
  "25to50": "$25–50",
  "50to100": "$50–100",
  over100: "от $100",
};

export const DELAY_WORDS: Readonly<Record<string, string>> = {
  under5m: "до 5 мин",
  "5to15m": "5–15 мин",
  "15to60m": "15–60 мин",
  "1to6h": "1–6 ч",
  over6h: "больше 6 ч",
};

/** «сб, 7 нояб.» of a Moscow day. A shift is said by `shiftWhen` (D12), never by its day and clock glued together. */
export function dayWords(day: string): string {
  return formatWeekdayDay(day);
}

/** «за эту неделю» → «За эту неделю». */
export function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
