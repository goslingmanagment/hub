/**
 * The words and number formats of the Analytics page, in one place.
 *
 * Every map below is PRESENTATION ONLY: it names a value the server sends and
 * never decides anything. An unknown value falls back to the value itself
 * (underscores read as spaces), so a new status or plane is shown, not hidden.
 */

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

