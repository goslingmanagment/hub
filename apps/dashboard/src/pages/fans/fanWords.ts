import { resolveFanLabelForScope } from "@agency_hub_core/shared";
import { daysRemaining, formatDate, formatDateTime, formatDuration, transactionTypeLabel } from "@/lib/format";
import { ruPlural } from "@/lib/plural";

/** The words of a fan, one set for every list of the section (design/screens/fans-page.md §0.4). */

type FanNameInput = Parameters<typeof resolveFanLabelForScope>[0];

export interface FanName {
  label: string;
  handle: string | null;
  deleted: boolean;
}

/** The fan's name in the console's words: the shared package stays as the clients read it. */
export function fanName(fan: FanNameInput, scope: "page" | "global" = "page"): FanName {
  const resolved = resolveFanLabelForScope(fan, scope);
  return {
    label: resolved.isDeletedFallback ? resolved.label.replace(/^Deleted user/, "Удалённый аккаунт") : resolved.label,
    handle: resolved.secondaryPlatformHandle,
    deleted: resolved.isDeletedFallback,
  };
}

/** After the commission, over all time: from $500, $100 and $50. */
export function tierOf(lifetimeNetMills: number): "Кит" | "VIP" | "Постоянный" | null {
  if (lifetimeNetMills >= 500_000) return "Кит";
  if (lifetimeNetMills >= 100_000) return "VIP";
  if (lifetimeNetMills >= 50_000) return "Постоянный";
  return null;
}

const DAY_MS = 86_400_000;

/** A subscription or a follow younger than a day. */
export function isNewWithinDay(at: string | null | undefined, now: number = Date.now()): boolean {
  if (!at) return false;
  const age = now - new Date(at).getTime();
  return age >= 0 && age < DAY_MS;
}

export function goneReason(missAt: string): string {
  return `Страница не видит аккаунт: скорее всего, фан заблокировал страницу или удалил аккаунт. Проверено ${formatDateTime(missAt, { yearUnlessCurrent: true })}.`;
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

interface ChatMoments {
  lastFanMessageAt: string | null;
  lastModelMessageAt: string | null;
}

/** The fan wrote last. A mass message counts as an answer here: «Как это считается» says so. */
export function isAwaitingReply(chat: ChatMoments): boolean {
  const fanAt = timestamp(chat.lastFanMessageAt);
  if (fanAt === null) return false;
  const modelAt = timestamp(chat.lastModelMessageAt);
  return modelAt === null || fanAt > modelAt;
}

/** «Ждёт ответа 6 ч», or null when he does not. How long, whole units. */
export function awaitingWords(chat: ChatMoments, now: number = Date.now()): string | null {
  if (!isAwaitingReply(chat)) return null;
  const minutes = Math.max(0, Math.floor((now - (timestamp(chat.lastFanMessageAt) ?? now)) / 60_000));
  if (minutes < 60) return `Ждёт ответа ${formatDuration(minutes)}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `Ждёт ответа ${hours} ч`;
  const days = Math.floor(hours / 24);
  return `Ждёт ответа ${days} ${ruPlural(days, "день", "дня", "дней")}`;
}

export interface SubscriptionState {
  status: "active" | "expired" | "never";
  expiresAt: string | null;
  autoRenew: boolean | null;
  autoRenewOffDetectedAt?: string | null;
}

export interface SubscriptionWords {
  first: string;
  second: string | null;
}

export function daysLeftWords(days: number): string {
  if (days === 0) return "сегодня последний день";
  return `ещё ${days} ${ruPlural(days, "день", "дня", "дней")}`;
}

/** A subscription in plain words, never a badge: it is not a status. */
export function subscriptionWords(state: SubscriptionState): SubscriptionWords {
  if (state.status === "never") return { first: "—", second: null };
  if (state.status === "expired") {
    return { first: state.expiresAt ? `Подписка кончилась ${formatDate(state.expiresAt)}` : "Подписка кончилась", second: null };
  }
  if (!state.expiresAt) return { first: "Подписан", second: "без даты окончания" };
  const days = daysLeftWords(daysRemaining(state.expiresAt));
  return {
    first: `Подписан до ${formatDate(state.expiresAt)}`,
    second: state.autoRenew === false ? `${days}, без автопродления` : days,
  };
}

/** The same from the fields a page's row carries. */
export function pageSubscriptionState(page: {
  isSubscriber: boolean;
  subscriptionExpiresAt: string | null;
  autoRenew: boolean | null;
  autoRenewOffDetectedAt?: string | null;
}): SubscriptionState {
  return {
    status: page.isSubscriber ? "active" : "never",
    expiresAt: page.subscriptionExpiresAt,
    autoRenew: page.autoRenew,
    autoRenewOffDetectedAt: page.autoRenewOffDetectedAt ?? null,
  };
}

/** «Чаевые · $20.00 · ожидает», without the money for the caller to add it. */
export function lastPurchaseKind(type: string): string {
  return transactionTypeLabel(type);
}

/** «За 7 дней» by the period; `all` has no such column. */
const PERIOD_COLUMN: Readonly<Record<string, string>> = {
  today: "Сегодня",
  "7d": "За 7 дней",
  "30d": "За 30 дней",
  "90d": "За 90 дней",
  "180d": "За 180 дней",
  all: "За всё время",
};

export function periodColumn(key: string): string {
  return PERIOD_COLUMN[key] ?? "За период";
}

/** «за 7 дней», «за всё время», «сегодня»: inside a sentence. */
export function periodPhrase(key: string): string {
  return periodColumn(key).toLowerCase();
}

/** «к прошлым 7 дням». */
const PREVIOUS_PHRASE: Readonly<Record<string, string>> = {
  "7d": "к прошлым 7 дням",
  "30d": "к прошлым 30 дням",
  "90d": "к прошлым 90 дням",
  "180d": "к прошлым 180 дням",
};

export function previousPhrase(key: string): string {
  return PREVIOUS_PHRASE[key] ?? "";
}

/** `?period=all` goes to the hub as `lifetime`. */
export function spenderPeriodOf(key: string): "today" | "7d" | "30d" | "90d" | "180d" | "lifetime" {
  return key === "all" ? "lifetime" : key as "today" | "7d" | "30d" | "90d" | "180d";
}
