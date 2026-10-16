/**
 * The words and number formats of the Analytics page, in one place.
 *
 * Every map below is PRESENTATION ONLY: it names a value the server sends and
 * never decides anything. An unknown value falls back to the value itself
 * (underscores read as spaces), so a new status or plane is shown, not hidden.
 */

import { formatBusinessDateShort } from "@/lib/format";
import { ruPlural } from "@/lib/plural";

const countFormat = new Intl.NumberFormat("ru-RU");
const oneDecimalFormat = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const upToOneDecimalFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

/** 12 345 — a count, grouped the Russian way. */
export function formatCount(value: number): string {
  return countFormat.format(value);
}

const compactFormat = new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 });

/** 9 млн, 120 тыс. — a platform-wide counter, where the exact digits do not
 *  matter (the exact value goes into a tooltip). */
export function formatCompactCount(value: number): string {
  return compactFormat.format(value);
}

/** 37,3 % — a share with one decimal, the Russian way (a no-break space before %). */
export function formatPercent(value: number): string {
  return `${oneDecimalFormat.format(value)} %`;
}

/** A span of milliseconds: "45 с", "12 мин", "3,5 ч". */
export function formatDurationMs(ms: number): string {
  const seconds = ms / 1_000;
  if (Math.abs(seconds) < 60) return `${Math.round(seconds)} с`;
  const minutes = seconds / 60;
  if (Math.abs(minutes) < 60) return `${Math.round(minutes)} мин`;
  return `${upToOneDecimalFormat.format(minutes / 60)} ч`;
}

/** "21 авг" for a bucket's ISO start (its UTC calendar day). */
export function formatBucketDay(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? formatBusinessDateShort(iso.slice(0, 10)) : iso;
}

const MONTHS = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

/** "Август 2026". */
export function formatMonth(year: number, month: number): string {
  const name = MONTHS[month - 1];
  return name === undefined ? `${year}-${String(month).padStart(2, "0")}` : `${name} ${year}`;
}

/** "30 дней". */
export function formatDays(days: number): string {
  return `${days} ${ruPlural(days, "день", "дня", "дней")}`;
}

function rawWords(value: string): string {
  return value.replace(/_/g, " ");
}

/** The capture planes, as the owner reads them. */
const PLANE_LABELS: Readonly<Record<string, string>> = {
  stats_account_daily: "Статистика аккаунта по дням",
  stats_account_hourly: "Статистика аккаунта по часам",
  stats_earnings: "Доходы",
  notifications: "Уведомления",
  post_likes: "Лайки постов",
  catalog: "Каталог медиа",
  catalog_vault_media: "Медиа в хранилище",
  catalog_media_hydration: "Подробности медиа",
  post_replies: "Комментарии к постам",
  payouts: "Выплаты",
  media_stats: "Статистика медиа",
};

export function planeLabel(plane: string): string {
  return PLANE_LABELS[plane] ?? rawWords(plane);
}

/** A capture row's status in a word or two. */
const STATUS_WORDS: Readonly<Record<string, string>> = {
  not_started: "не начат",
  in_progress: "идёт сбор",
  window_captured: "период собран",
  provider_exhausted: "собрано до конца",
  sampled: "выборочно",
  partial_provider_surface: "Fansly отдал часть",
  unsupported_by_observed_surface: "не поддерживается",
  auth_blocked: "нет доступа",
  contract_drift: "формат изменился",
};

export function captureStatusWords(status: string): string {
  return STATUS_WORDS[status] ?? rawWords(status);
}

/** What proves a capture row's claim. */
const PROOF_WORDS: Readonly<Record<string, string>> = {
  none: "нет",
  terminal_response: "конец выдачи",
  complete_count_matched: "счётчик совпал",
  empty_window: "пустой период",
};

export function captureProofWords(proof: string): string {
  return PROOF_WORDS[proof] ?? rawWords(proof);
}

/** What Hub holds for a page, per stored table. */
const PROJECTION_LABELS: Readonly<Record<string, string>> = {
  stats_traffic_buckets: "Трафик",
  stats_top_media: "Рейтинг медиа",
  stats_top_tags: "Рейтинг тегов",
  fansly_media_tag_stats: "Теги медиа",
  platform_tag_daily: "Теги на Fansly",
  creator_media: "Медиа",
  media_orders: "Покупки медиа",
  message_media_offers: "Медиа в сообщениях",
  revenue_mix_daily: "Доход по типам",
  revenue_month_totals: "Доход по месяцам",
  page_promo_links: "Промо-ссылки",
  platform_notifications: "Уведомления",
  post_likes: "Лайки постов",
  post_comments: "Комментарии",
  creator_vault_albums: "Альбомы хранилища",
  page_subscription_tiers: "Уровни подписки",
  page_walls: "Стены",
  page_automated_messages: "Автосообщения",
  page_payout_requests: "Запросы выплат",
  page_payout_methods: "Способы выплат",
};

export function projectionLabel(projection: string): string {
  return PROJECTION_LABELS[projection] ?? rawWords(projection);
}

/** Fansly's revenue types (the server's labels), in the owner's words. */
const REVENUE_TYPE_LABELS: Readonly<Record<string, string>> = {
  media: "Платные медиа",
  media_sets: "Наборы медиа",
  tips: "Чаевые",
  locked_text: "Платный текст",
  stream_tickets: "Билеты на стримы",
  subscriptions: "Подписки",
  referrals: "Рефералы",
  refund: "Возвраты",
  internal_transfer: "Внутренние переводы",
  subscription_payment_credit: "Зачёт оплаты подписки",
  balance_purchase: "Пополнение баланса",
  canceled_payout_refund: "Возврат отменённой выплаты",
  leaderboard_prize_money: "Призы рейтинга",
  gift_code_claim: "Подарочные коды",
  promotional_credit: "Промо-начисления",
  crypto_balance_purchase: "Пополнение криптовалютой",
  product_order: "Заказы товаров",
};

/** A revenue type's name; a code this build cannot name reads "Другой тип". */
export function revenueTypeLabel(typeLabel: string): string {
  if (typeLabel.startsWith("unmapped:")) return "Другой тип";
  return REVENUE_TYPE_LABELS[typeLabel] ?? rawWords(typeLabel);
}
