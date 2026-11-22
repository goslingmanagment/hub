import type { CustomBoardOrder, CustomFact, CustomOrderFacts, CustomSelfChange } from "@agency_hub_core/contracts";
import { millsFromDollars } from "@agency_hub_core/shared";
import { formatMills } from "@agency_hub_core/ui/format";
import { moscowDayOf, weekdayIndex } from "@agency_hub_core/ui/moscow";
import { ruPlural } from "@agency_hub_core/ui/plural";

/**
 * The facts screen of «Кастомы» (customs facts spec §13) in words: an order's deadline, its tone, its group in «Сроки»,
 * whose move it is, its price — what the rows, the calendar and the order's panel say alike. Everything is read from
 * what Hub answers (the facts, `burning`, `move`, `dueLeftDays`); nothing here decides a fact.
 */

export const WEEKDAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"] as const;
export const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"] as const;
export const MONTHS_OF = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"] as const;

export const daysWord = (days: number) => `${Math.abs(days)} ${ruPlural(Math.abs(days), "день", "дня", "дней")}`;
/** `YYYY-MM-DD` → «23.11». */
export const dotted = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
export const weekdayOf = (day: string) => WEEKDAYS[weekdayIndex(day)]!;

/** The order's Moscow «today», from the server's clock. */
export const todayOf = (serverNow: string) => moscowDayOf(serverNow);

/** The days from today to a Moscow day (negative — past). */
export function daysFrom(today: string, day: string): number {
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export type Tone = "danger" | "warn" | "calm";

/** An order as the screen reads it: a board's (without its card) or the order's own. */
export type FactsOrder = Omit<CustomBoardOrder, "card" | "volume">;

/** Red: it burns (or the card waits at the lead past 48 h); amber: its day is today or tomorrow, or the card waits past 24 h. */
export function toneOf(order: FactsOrder): Tone {
  if (order.holdReason !== null) return "calm";
  if (order.burning || order.timer?.level === "red") return "danger";
  if ((order.dueLeftDays !== null && order.dueLeftDays <= 1) || order.timer?.level === "amber") return "warn";
  return "calm";
}

/** The deadline in two lines: «2 дня» / «до 23.11, пн»; «−2 дня» / «срок был 19.11»; «на паузе» / its reason. */
export function dueWords(order: FactsOrder): { big: string; small: string; tone: Tone } {
  if (order.state === "given") return { big: "отдан", small: order.givenAt ? `фану ${dotted(moscowDayOf(order.givenAt))}` : "", tone: "calm" };
  if (order.state === "closed") return { big: "закрыт", small: order.givenAt ? `отдан ${dotted(moscowDayOf(order.givenAt))}` : "", tone: "calm" };
  if (order.holdReason !== null) return { big: "на паузе", small: order.holdReason, tone: "calm" };
  const left = order.dueLeftDays;
  if (left === null || order.deadlineOn === null) return { big: "срок не назван", small: `заказ от ${dotted(moscowDayOf(order.createdAt))}`, tone: "calm" };
  const about = order.deadlineDefault ? "примерно " : "";
  const day = dotted(order.deadlineOn);
  // Red only more than a full day past it (C2: the burn's own threshold); the day after is amber.
  if (left < 0) return { big: `−${daysWord(left)}`, small: `${about}срок был ${day}`, tone: left <= -2 ? "danger" : "warn" };
  if (left === 0) return { big: "сегодня", small: `${about}до конца ${day}`, tone: "warn" };
  if (left === 1) return { big: "завтра", small: `${about}до ${day}, ${weekdayOf(order.deadlineOn)}`, tone: "warn" };
  return { big: daysWord(left), small: `${about}до ${day}, ${weekdayOf(order.deadlineOn)}`, tone: "calm" };
}

export type GroupId = "burn" | "soon" | "week" | "later";
export const GROUPS: ReadonlyArray<{ id: GroupId; title: string; hint?: string; dot?: "danger" | "warn" }> = [
  { id: "burn", title: "Горит", hint: "срок прошёл, фан ждёт готовое или источники расходятся", dot: "danger" },
  { id: "soon", title: "Сегодня и завтра", dot: "warn" },
  { id: "week", title: "На неделе" },
  { id: "later", title: "Позже и на паузе" },
];

/** The order's group in «Сроки»: it burns; its day is near; this week; later, no deadline or on hold. */
export function groupOf(order: FactsOrder): GroupId {
  if (order.burning) return "burn";
  if (order.holdReason !== null || order.dueLeftDays === null) return "later";
  if (order.dueLeftDays <= 1) return "soon";
  if (order.dueLeftDays <= 7) return "week";
  return "later";
}

/** In a group: the nearest deadline first (none last), then the dearest. */
export function byDue(left: CustomBoardOrder, right: CustomBoardOrder): number {
  return (left.dueLeftDays ?? 9_999) - (right.dueLeftDays ?? 9_999) || priceOf(right) - priceOf(left) || left.id - right.id;
}

/** What the order is worth on the screen: the agreed total, else what came, else nothing. */
export function priceOf(order: Pick<CustomBoardOrder, "priceMills" | "paidGrossMills">): number {
  return order.priceMills ?? order.paidGrossMills;
}

export const sumOf = (orders: readonly CustomBoardOrder[]) => orders.reduce((sum, order) => sum + priceOf(order), 0);

/** The fan as the screen names him: the nick, else the card's buyer. */
export function fanName(order: Pick<CustomBoardOrder, "fan" | "buyer" | "fanErased">): string {
  if (order.fanErased) return "фан стёрт";
  return order.fan?.username ?? order.fan?.displayName ?? order.buyer ?? "фан не назван";
}

/** Two letters of a nick for the circle: «NightOwl77» → «NO», «sea_breeze» → «SB». */
export function initialsOf(name: string): string {
  const parts = name.replace(/[^\p{L}_.\s-]+/gu, " ").split(/[_.\s-]+|(?<=\p{Ll})(?=\p{Lu})/u).filter(Boolean);
  const two = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : (parts[0] ?? "").slice(0, 2);
  return two.toUpperCase();
}

/** Whose move, «имя: что сделать» (Hub's `move`); an ended order says what it waits for instead. */
export function moveWords(order: FactsOrder): { who: string | null; what: string | null } {
  const move = order.move;
  if (move === null && order.state === "given") return { who: null, what: "закроется само" };
  if (move === null && order.state === "closed") return { who: null, what: "закрыт" };
  if (move === null || move.whoKind === "none") return { who: null, what: move?.what || null };
  const who = move.who ?? { person: "Кто-то", shift: "Смена", model: order.model ?? "Модель", fan: "Фан", owner: "Владелец" }[move.whoKind];
  return { who, what: move.what || null };
}

/**
 * «Только мой ход»: the move is the viewer's — a person's or the shift's by the viewer's name (never a fan's or a model's
 * that happens to be the same), or the owner's to the owner.
 */
export function isMine(order: FactsOrder, viewer: { name: string | null; owner: boolean }): boolean {
  const move = order.move;
  if (move === null) return false;
  if (move.whoKind === "owner") return viewer.owner;
  if (move.whoKind !== "person" && move.whoKind !== "shift") return false;
  return viewer.name !== null && move.who === viewer.name;
}

/** A sum in dollars as a person types it («120», «49.50», «1 200», «$75») in mills; null — empty; undefined — no sum. */
export function millsOfDollars(text: string): number | null | undefined {
  const value = text.replace(/[\s$]/gu, "").replace(",", ".");
  if (value === "") return null;
  if (!/^\d{1,7}(?:\.\d{1,3})?$/u.test(value)) return undefined;
  const mills = Number(millsFromDollars(value));
  return mills > 0 ? mills : undefined;
}

/** Mills as dollars to type into a field, exact: 49 500 → «49.5», 120 000 → «120». */
export const dollarsOf = (mills: number) => String(mills / 1000);

/** The search: a fan's nick or name, or the order's code («K-12», «к12», «12»). */
export function matchesSearch(order: FactsOrder, text: string): boolean {
  const query = text.trim().toLowerCase();
  if (query === "") return true;
  const digits = /^#?\s*[kк]?\s*-?\s*(\d+)$/u.exec(query)?.[1];
  if (digits !== undefined && String(order.id).startsWith(digits)) return true;
  return [order.fan?.username, order.fan?.displayName, order.buyer, order.code].some((value) => value?.toLowerCase().includes(query));
}

// ── The four facts ──────────────────────────────────────────────────────────

export const FACT_STEPS: ReadonlyArray<{ key: keyof CustomOrderFacts; label: string; short: string }> = [
  { key: "paid", label: "Оплачен", short: "оплачен" },
  { key: "atModel", label: "У модели", short: "у модели" },
  { key: "shot", label: "Снят", short: "снят" },
  { key: "given", label: "Отдан фану", short: "отдан" },
];

const VALUE_WORDS: Record<CustomFact["value"], string> = {
  yes: "да", part: "частично", no: "нет", wait: "ждём", conflict: "расхождение", unknown: "не проверить",
};

/** A fact in words: its note, the money that came, or its value. */
export function factWords(key: keyof CustomOrderFacts, fact: CustomFact, order: Pick<CustomBoardOrder, "paidGrossMills" | "priceMills" | "payments">): string {
  if (key === "paid" && order.payments > 0 && fact.value !== "conflict") {
    const came = `получено ${formatMills(order.paidGrossMills)}`;
    const of = order.priceMills !== null ? ` из ${formatMills(order.priceMills)}` : "";
    // Paid by the owner's word: the word says it. Else the money that came, of the price; no price — said so.
    if (fact.value === "yes" && fact.note) return fact.note;
    return order.priceMills === null && fact.note ? `${came}, ${fact.note}` : `${came}${of}`;
  }
  return fact.note ?? VALUE_WORDS[fact.value];
}

// ── «Изменилось само» ───────────────────────────────────────────────────────

const text = (changes: Record<string, unknown>, key: string) => {
  const value = changes[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
};
const dayWords = (value: unknown) => (typeof value === "string" ? dotted(value) : "без срока");

/** What a step of the system or an agent did, in a few words: «модель сдала: «6-12 кастом.mov»». */
export function changeWords(change: Pick<CustomSelfChange, "event" | "changes">): string {
  const changes = change.changes;
  switch (change.event) {
    case "custom_order.recorded": return "записан";
    case "custom_order.payment": return "привязана оплата";
    case "custom_order.at_model": return "карточка у модели";
    case "custom_order.delivery": return text(changes, "excerpt") ? `модель сдала: «${text(changes, "excerpt")}»` : "модель сдала";
    case "custom_order.partly": return "сдан частично";
    case "custom_order.shot": return "снят";
    case "custom_order.revision": return text(changes, "note") ? `правка: «${text(changes, "note")}»` : "правка";
    case "custom_order.revision_done": return "правка исправлена";
    case "custom_order.refused": return "отказ модели";
    case "custom_order.given": return "отдан фану";
    case "custom_order.closed": return "закрыт: 72 часа без жалобы";
    case "custom_order.deadline":
      return changes.approximate === true ? `срок примерно до ${dayWords(changes.to)}` : `срок ${dayWords(changes.from)} → ${dayWords(changes.to)}`;
    case "custom_order.fan_asked": return "фан спросил, где заказ";
    case "custom_order.fan_asked_cleared": return "фану ответили";
    case "custom_order.issue": return text(changes, "text") ? `расхождение: ${text(changes, "text")}` : "источники расходятся";
    case "custom_order.issue_cleared": return "расхождение снято";
    case "custom_order.fan_confirmed": return "найден фан";
    case "custom_order.card": return "привязана карточка из Telegram";
    case "custom_order.edited": return "карточка изменена";
    case "custom_order.retracted": return "сдача отозвана";
    case "custom_order.sent": return changes.cleared === true ? "отметка «отправлен» снята" : "отправлен фану, не открыт";
    case "custom_order.message": return "сообщение в группе модели";
    case "custom_order.settled": return "шаг пересчитан по сообщениям";
    case "custom_order.hold": return "на паузе";
    case "custom_order.unhold": return "снят с паузы";
    default: return change.event.replace(/^custom_order\./u, "");
  }
}

/** Who did it: the agent's key by name, or Hub itself. */
export function changeActor(change: Pick<CustomSelfChange, "door" | "actor">): string {
  return change.door === "system" ? "Hub сам" : change.actor ?? "агент";
}

// ── The calendar ────────────────────────────────────────────────────────────

/** «Ноябрь 2026». */
export function monthTitle(day: string): string {
  return `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
}

/** «23 ноября». */
export function dayOfMonthWords(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTHS_OF[Number(day.slice(5, 7)) - 1]}`;
}

export const moneyWords = (mills: number) => formatMills(mills);
