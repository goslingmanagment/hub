/**
 * The dictionary: one word for one thing in every product (ecosystem plan §4
 * «Слова»). A screen, a message or a vendored client that names one of these
 * things takes the word from here; a new word for an old thing is a change of
 * this file, not of one screen.
 *
 * The forms that go with the words (plan §4): money «$1,234.56», dates
 * «12 нояб., 06:27», time is Moscow's and says so where the reader may be in
 * another zone («по Москве», see format.ts), the reader is addressed as «вы»
 * on every screen (Генгар in a chat speaks as he speaks), no long dash and no
 * arrows in what people read.
 */

/** The things of the agency's work, as a person reads them (capitalised; lower-case them inside a sentence). */
export const WORDS = {
  /** Money of the pages after the platform's commission, a Moscow day at a time. */
  income: "Доход",
  /** One operation of a platform (a fan's purchase). */
  sale: "Продажа",
  sales: "Продажи",
  /** Money a fan spent: before the commission, always said so. */
  fanSpend: "Траты фана",
  /** A chatter's work: from 2 h and 50 messages. */
  shift: "Смена",
  shifts: "Смены",
  /** Work shorter than a shift. */
  visit: "Заход",
  /** What a chatter hands in after a shift, and the action of handing it in. */
  shiftReport: "Отчёт смены",
  submitShift: "Сдать смену",
  /** Money of a person. */
  accrued: "Начислено",
  toPay: "К выплате",
  paid: "Выплачено",
  /** A fan's order for a shoot, and who leads it to delivery. */
  custom: "Кастом",
  customs: "Кастомы",
  customsLead: "Ведущий кастомы",
  /** What waits for the person reading (in code: a matter). */
  waitingForYou: "Ждут вас",
  /** Monday to Sunday, Moscow. */
  week: "Неделя",
} as const;

/** The places, by their own names. */
export const PLACES = {
  /** The owner's place. */
  hub: "Hub",
  /** The team's place. */
  workboard: "Workboard",
  /** The extension. */
  chatgoose: "ChatGoose",
  /** The team's agent in Telegram. */
  gengar: "Генгар",
} as const;

/**
 * The name of a failure (a notification incident) by its kind: the console's «Система → Сбои» and the list «Ждут
 * вас» say the same words (design/ia.md §5.2). The console checks that every kind of the contract has one.
 */
export const INCIDENT_KIND_WORDS = {
  auth_blocked: "Вход заблокирован",
  proxy_failed: "Прокси не работает",
  proxy_missing: "Нет прокси",
  stream_failed_threshold: "Сбор падает 3 раза подряд",
  ofapi_auth: "OnlyFans API: доступ отклонён",
  ofapi_binding_conflict: "OnlyFans API: конфликт привязки",
  ofapi_low_credit: "Мало кредитов OnlyFans API",
  ofapi_webhook_silence: "События OnlyFans API замолчали",
  ofapi_burn_rate: "Кредиты сгорают необычно быстро",
  db_disk_usage: "База: мало места",
  observations_partitions: "База: разделы журнала",
  wrong_transactions_writer: "Операции пишет не тот процесс",
  read_gateway_capture: "Сбор: шлюз чтения",
  golden_signal_lag: "Отставание ключевых метрик",
  scheduler_silent: "Планировщик молчит",
  ops_sampler_silent: "Сбор метрик молчит",
  sync_silent: "Сбор Fansly молчит",
  fansly_sync_engine: "Сбор Fansly: сбой",
  ofapi_chargebacks_reconcile_failed: "Сверка возвратов OnlyFans",
  ofapi_link_stats_reconcile_failed: "Сверка статистики ссылок OnlyFans",
  ai_provider_billing: "ИИ: проблема с оплатой",
  ai_provider_failed: "ИИ: поставщик не отвечает",
  capture_payload_parity: "Расхождение сохранённых данных",
  publishing_stopped: "Hub остановил публикацию",
  publication_not_published: "Пост не вышел",
  ofapi_platform_notice: "OnlyFans написал странице",
  chatspace_tab: "Вкладка ChatSpace на сервере",
} as const;

/** A failure's name by its kind; null — a kind the dictionary does not know (say its code, never nothing). */
export function incidentKindWord(kind: string): string | null {
  return (INCIDENT_KIND_WORDS as Readonly<Record<string, string>>)[kind] ?? null;
}

/** The AI buttons: proper names, the same everywhere, never translated. */
export const AI_BUTTONS = ["Reply", "Fix", "Hi", "Ping", "Recap", "Coach"] as const;
export type AiButton = (typeof AI_BUTTONS)[number];
