/**
 * The words of «Люди» and «Человек»: statuses, a reply's time, shares, the
 * comparison's words, the kinds of a sale. Pure; no React.
 */
import { formatAgo, formatDay, formatDuration, formatPercent, formatTimeOfDay } from "@agency_hub_core/ui/format";
import type { PersonStatus } from "@agency_hub_core/ui";
import type { ResolvedPeriod } from "@agency_hub_core/ui/period";
import type { PersonNow, PersonRole, PersonState, SaleKind } from "./data.js";

export const ROLE_WORD: Readonly<Record<PersonRole, string>> = {
  owner: "Владелец",
  team_lead: "Тимлид",
  chatter: "Чаттер",
};

/** The dot of a person and the words beside it: «на смене с 21:00», «был 2 ч назад», «отключён». */
export function statusOf(person: { state: PersonState | null; disabledAt: string | null; now: PersonNow }, now: number = Date.now()): { status: PersonStatus; words: string } {
  if (person.state === "disabled") {
    return { status: "disabled", words: person.disabledAt ? `отключён ${formatDay(person.disabledAt)}` : "отключён" };
  }
  if (person.state === "invited") return { status: "invited", words: "ждёт регистрации" };
  if (person.now.onShiftSince) return { status: "working", words: `на смене с ${formatTimeOfDay(person.now.onShiftSince)}` };
  if (person.now.lastSeenAt) return { status: "away", words: lastSeen(person.now.lastSeenAt, now) };
  // Without the accounts (a team lead) «never worked» is not known: say nothing.
  return { status: "away", words: person.state === null ? "" : "ещё не работал" };
}

/** «был 2 ч назад», «был 3 дня назад»; a week and older: «был 24 окт.». */
function lastSeen(at: string, now: number): string {
  const days = (now - Date.parse(at)) / 86_400_000;
  return days < 7 ? `был ${formatAgo(at, now)}` : `был ${formatDay(at)}`;
}

/** A reply's median: «45 с», «1 мин 58 с», «1 ч 5 мин». */
export function replyText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole} с`;
  if (whole < 3600) {
    const minutes = Math.floor(whole / 60);
    const rest = whole % 60;
    return rest === 0 ? `${minutes} мин` : `${minutes} мин ${rest} с`;
  }
  return formatDuration(Math.round(whole / 60));
}

/** A share (0…1) as «31 %»; none is «—». */
export function shareText(share: number | null | undefined): string {
  return share === null || share === undefined || !Number.isFinite(share) ? "—" : formatPercent(share * 100);
}

/** `part / whole`, null without a whole. */
export function shareOf(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** What a change is against, short (under a number): «к прошлой неделе». */
export function versusShort(period: ResolvedPeriod): string {
  if (period.spec.kind === "week") return "к прошлой неделе";
  if (period.spec.kind === "days") return `к прошлым ${period.days} дням`;
  return "к прошлому периоду";
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

/** The kinds of a sale: their names and colours (chart series, never a state). */
export const KINDS: ReadonlyArray<{ kind: SaleKind; label: string; one: string; color: string }> = [
  { kind: "ppv", label: "Платные сообщения", one: "Платное сообщение", color: "var(--ui-series-1)" },
  { kind: "tip", label: "Чаевые", one: "Чаевые", color: "var(--ui-series-2)" },
  { kind: "subscription", label: "Подписки", one: "Подписка", color: "var(--ui-series-3)" },
  { kind: "post", label: "Посты", one: "Пост", color: "var(--ui-series-4)" },
];

export const KIND_OF: Readonly<Record<SaleKind, (typeof KINDS)[number]>> = Object.fromEntries(KINDS.map((kind) => [kind.kind, kind])) as Record<SaleKind, (typeof KINDS)[number]>;

export const PRICE_WORDS: Readonly<Record<string, string>> = {
  upTo10: "до $10",
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

/** «сб, 7 нояб.» of a Moscow day. */
export function dayWords(day: string): string {
  const at = new Date(`${day}T12:00:00+03:00`);
  const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "Europe/Moscow" }).format(at);
  return `${weekday}, ${formatDay(at)}`;
}

/** «09:19–18:10», «21:00 – сейчас». */
export function timeRange(shift: { startedAt: string; endedAt: string; ongoing: boolean }): string {
  return shift.ongoing ? `${formatTimeOfDay(shift.startedAt)} – сейчас` : `${formatTimeOfDay(shift.startedAt)}–${formatTimeOfDay(shift.endedAt)}`;
}

/** «за эту неделю» → «За эту неделю». */
export function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
