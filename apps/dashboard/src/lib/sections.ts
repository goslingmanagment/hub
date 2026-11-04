/**
 * The console's map in one table (design/ia.md §1.3): every screen with its
 * address, its words, who sees it, what the page filter and the period do on
 * it. The menu, the tabs, the crumbs, the search and the browser tab all read
 * these tables, so a screen is named the same everywhere and a new one has one
 * place to go.
 */
import { matchPath } from "react-router";
import type { Platform } from "@agency_hub_core/shared";
import { decodedPath, pathSegment } from "./path.js";
import type { PeriodKey } from "./period.js";
import { UNTIL_REBUILT_FANS_PAGE } from "./sections/untilRebuilt/fans-page.js";
import { UNTIL_REBUILT_HOME_MONEY } from "./sections/untilRebuilt/home-money.js";
import { UNTIL_REBUILT_PUBLICATIONS } from "./sections/untilRebuilt/publications.js";
import { UNTIL_REBUILT_SETTINGS } from "./sections/untilRebuilt/settings.js";
import { UNTIL_REBUILT_STATS } from "./sections/untilRebuilt/stats.js";
import { UNTIL_REBUILT_SYSTEM } from "./sections/untilRebuilt/system.js";
import { UNTIL_REBUILT_TEAM } from "./sections/untilRebuilt/team.js";
import type { ScreenGap } from "./sections/untilRebuilt/types.js";

export type Role = "owner" | "team_lead" | string;

/**
 * What the page filter does on a screen:
 * - `any`: every page or one;
 * - `one`: exactly one page is needed;
 * - `all`: the screen is always about every page the viewer reaches, and says so;
 * - `none`: no pages here, or the page is in the path. No filter at all.
 */
export type PageFilterMode = "any" | "one" | "all" | "none";

/** With `one` and no page chosen: a table to choose from, or the last page. */
export type OnePageWay = "picker" | "substitute";

/** A filter of the screen that looks at a period of its own, whatever is chosen:
 *  the control shows it and offers nothing else, the memory is left alone. */
export interface ForcedPeriod {
  key: PeriodKey;
  /** Why the other values are off, on each of them. */
  title: string;
  /** Beside the dates. */
  note: string;
}

export interface ScreenPeriod {
  /** `shared` reads and writes the one remembered period; `own` lives in the
   *  address only and has a default of its own. The control looks the same. */
  class: "shared" | "own";
  options: readonly PeriodKey[];
  /** The value of an `own` period when the address has none. */
  default?: PeriodKey;
}

export type SectionId = "home" | "money" | "fans" | "stats" | "publications" | "team" | "settings" | "system" | "page";

export interface Crumb {
  label: string;
  to?: string;
}

export interface Screen {
  id: string;
  /** A route pattern. */
  path: string;
  /** The word in a menu, a tab or a list. */
  label: string;
  /** The browser tab's title; on a deep screen also its header until it has a name. */
  title: string;
  /** One sentence, up to 90 characters: what question the screen answers. */
  why: string;
  section: SectionId;
  ownerOnly?: boolean;
  pageFilter: PageFilterMode;
  onePageWay?: OnePageWay;
  /** The platforms whose pages have this kind of data. Absent: all of them. */
  platforms?: readonly Platform[];
  /** Said instead of the screen when the chosen page has no such data. */
  platformsNote?: string;
  /** The same, short, beside a grey row of the chip's list. */
  platformsShort?: string;
  /** Said instead of «Hub не собирает данные Telegram» where that is not the point. */
  telegramNote?: { title: string; text: string };
  period?: ScreenPeriod;
  /** Old names: the search finds a screen by the word a habit remembers. */
  keywords?: string;
  /** The header is the object itself, under crumbs; no section tabs. */
  deep?: boolean;
  crumbs?: (params: Readonly<Record<string, string | undefined>>) => Crumb[];
  /** Not offered by the search on its own (a parameter is in its path). */
  notSearched?: boolean;
  /** The address's filters can make the period not the screen's to choose. */
  forcedPeriod?: (search: URLSearchParams) => ForcedPeriod | null;
}

/**
 * Where a not-yet-rebuilt screen falls short of the table below, by screen id. The
 * table says where the screen is going; these say what the old component can do
 * today, so the chip and the period never promise what it does not do. One file
 * per group: a rebuild deletes its screen's row there and touches nothing else.
 */
const UNTIL_REBUILT: Readonly<Record<string, ScreenGap>> = {
  ...UNTIL_REBUILT_HOME_MONEY,
  ...UNTIL_REBUILT_FANS_PAGE,
  ...UNTIL_REBUILT_STATS,
  ...UNTIL_REBUILT_PUBLICATIONS,
  ...UNTIL_REBUILT_TEAM,
  ...UNTIL_REBUILT_SETTINGS,
  ...UNTIL_REBUILT_SYSTEM,
};

const COMMON_PERIODS: readonly PeriodKey[] = ["today", "7d", "30d", "all"];
const SPENDER_PERIODS: readonly PeriodKey[] = ["today", "7d", "30d", "90d", "180d", "all"];
const STATS_PERIODS: readonly PeriodKey[] = ["7d", "30d", "90d", "180d", "365d"];
const CHATTER_PERIODS: readonly PeriodKey[] = ["7d", "14d", "30d"];

const REPORTED: readonly Platform[] = ["fansly", "onlyfans"];
const FANSLY: readonly Platform[] = ["fansly"];

const fansCrumbs = (page?: string): Crumb[] => [
  { label: "Фаны", to: "/fans" },
  ...(page ? [{ label: page, to: `/fans?page=${encodeURIComponent(page)}` }] : []),
];

/** Who stopped buying can only be seen over the whole history: a short window of
 *  money has none of them (design/screens/fans-page.md §2). */
const SILENT_FAN_FILTERS: ReadonlySet<string> = new Set(["cooling", "inactive", "needs_reactivation"]);
function fansForcedPeriod(search: URLSearchParams): ForcedPeriod | null {
  if (!SILENT_FAN_FILTERS.has(search.get("filter") ?? "") && search.get("awaiting") !== "1") return null;
  return { key: "all", title: "Этот фильтр смотрит на всю историю", note: "За всё время: этот фильтр смотрит на всю историю" };
}

/** Every screen of the console. The order inside a section is the order of its tabs. */
export const SCREENS: readonly Screen[] = [
  {
    id: "home", path: "/", label: "Главная", title: "Главная", section: "home",
    why: "Сколько заработали, что выросло и упало, что ждёт вас и кто на смене.",
    pageFilter: "any", platforms: REPORTED,
    platformsNote: "Hub не собирает данные Telegram.",
    period: { class: "shared", options: COMMON_PERIODS },
    keywords: "обзор старт сводка доход выручка деньги заработок тренды",
  },

  // ── Деньги ─────────────────────────────────────────────────────────────
  {
    id: "transactions", path: "/money/transactions", label: "Операции", title: "Операции", section: "money",
    why: "Из каких операций сложилась сумма.",
    pageFilter: "any", platforms: REPORTED,
    platformsNote: "Hub не собирает данные Telegram.",
    period: { class: "shared", options: COMMON_PERIODS },
    keywords: "транзакции продажи платежи",
  },
  {
    id: "costs-ai", path: "/money/costs/ai", label: "ИИ", title: "Траты на ИИ", section: "money", ownerOnly: true,
    why: "Сколько денег на ИИ осталось, сколько ушло, на что и кем.",
    pageFilter: "all",
    keywords: "расходы траты ai anthropic",
  },
  {
    id: "costs-anthropic", path: "/money/costs/anthropic", label: "Сверка с Anthropic", title: "Сверка с Anthropic", section: "money", ownerOnly: true,
    why: "Сходится ли учёт Hub со счётом Anthropic.",
    pageFilter: "all",
    keywords: "расходы счёт csv выгрузка",
  },
  {
    id: "costs-onlyfans-api", path: "/money/costs/onlyfans-api", label: "OnlyFans API", title: "OnlyFans API: по 1 ноября", section: "money", ownerOnly: true,
    why: "Сколько кредитов осталось и на что они ушли, по 1 ноября.",
    pageFilter: "all",
    keywords: "кредиты расходы ofapi",
  },

  // ── Фаны ───────────────────────────────────────────────────────────────
  {
    id: "fans", path: "/fans", label: "Платящие", title: "Платящие", section: "fans",
    why: "Кто приносит деньги, кто реже покупает, кого вернуть.",
    pageFilter: "any", platforms: REPORTED,
    platformsNote: "Hub не собирает данные Telegram.",
    period: { class: "shared", options: SPENDER_PERIODS },
    forcedPeriod: fansForcedPeriod,
    keywords: "топ фанов спендеры",
  },
  {
    id: "fans-subscribers", path: "/fans/subscribers", label: "Подписчики", title: "Подписчики", section: "fans",
    why: "Кто подписан сейчас, у кого кончается, кто без автопродления.",
    pageFilter: "one", onePageWay: "picker", platforms: REPORTED,
    platformsNote: "Hub не собирает данные Telegram.",
    keywords: "подписки",
  },
  {
    id: "fans-followers", path: "/fans/followers", label: "Фолловеры", title: "Фолловеры", section: "fans",
    why: "Кто фолловит страницу Fansly.",
    pageFilter: "one", onePageWay: "picker", platforms: FANSLY,
    platformsNote: "У страниц OnlyFans нет фолловеров.", platformsShort: "нет фолловеров",
    keywords: "фоллоу",
  },
  {
    id: "fans-gone", path: "/fans/gone", label: "Ушли", title: "Ушли", section: "fans",
    why: "Кто удалил аккаунт или перестал быть виден.",
    pageFilter: "one", onePageWay: "picker", platforms: REPORTED,
    platformsNote: "Hub не собирает данные Telegram.",
    keywords: "удалённые фаны",
  },
  {
    id: "fans-by-spend", path: "/fans/by-spend", label: "По сумме трат", title: "По сумме трат", section: "fans",
    why: "Списки фанов по сумме трат: имена для списков на площадке.",
    pageFilter: "one", onePageWay: "picker", platforms: REPORTED,
    platformsNote: "Hub не собирает данные Telegram.",
    period: { class: "own", options: SPENDER_PERIODS, default: "all" },
    keywords: "спендеры автосписки",
  },
  {
    id: "fans-by-spend-list", path: "/fans/by-spend/:bucketKey", label: "Список по сумме трат", title: "Список по сумме трат", section: "fans",
    why: "Фаны одной корзины.",
    pageFilter: "one", onePageWay: "picker", platforms: REPORTED,
    platformsNote: "Hub не собирает данные Telegram.",
    period: { class: "own", options: SPENDER_PERIODS, default: "all" },
    deep: true, notSearched: true,
    crumbs: () => [...fansCrumbs(), { label: "По сумме трат", to: "/fans/by-spend" }],
  },
  {
    id: "fan", path: "/fans/:pageLabel/:platform/:platformUserId", label: "Карточка фана", title: "Карточка фана", section: "fans",
    why: "Кто этот фан для этой страницы и на других страницах.",
    pageFilter: "none",
    period: { class: "shared", options: SPENDER_PERIODS },
    deep: true, notSearched: true,
    crumbs: (params) => fansCrumbs(params.pageLabel),
  },
  {
    id: "fan-any-page", path: "/fans/:platform/:platformUserId", label: "Карточка фана", title: "Карточка фана", section: "fans",
    why: "Открывает страницу, на которой этот фан потратил больше всего.",
    pageFilter: "none",
    deep: true, notSearched: true,
    crumbs: () => fansCrumbs(),
  },

  // ── Статистика ─────────────────────────────────────────────────────────
  {
    id: "stats", path: "/stats", label: "Главное", title: "Статистика Fansly", section: "stats", ownerOnly: true,
    why: "Как сам Fansly видит страницу: охват, деньги, подписчики.",
    pageFilter: "one", onePageWay: "substitute", platforms: FANSLY,
    platformsNote: "Статистику Hub собирает только для Fansly.", platformsShort: "только Fansly",
    period: { class: "shared", options: STATS_PERIODS },
    keywords: "аналитика обзор",
  },
  {
    id: "stats-content", path: "/stats/content", label: "Контент", title: "Статистика Fansly: контент", section: "stats", ownerOnly: true,
    why: "Какие медиа смотрят, покупают и комментируют.",
    pageFilter: "one", onePageWay: "substitute", platforms: FANSLY,
    platformsNote: "Статистику Hub собирает только для Fansly.", platformsShort: "только Fansly",
    period: { class: "shared", options: STATS_PERIODS },
    keywords: "аналитика медиа посты",
  },
  {
    id: "stats-audience", path: "/stats/audience", label: "Аудитория", title: "Статистика Fansly: аудитория", section: "stats", ownerOnly: true,
    why: "Откуда и когда смотрят, по каким тегам находят.",
    pageFilter: "one", onePageWay: "substitute", platforms: FANSLY,
    platformsNote: "Статистику Hub собирает только для Fansly.", platformsShort: "только Fansly",
    period: { class: "shared", options: STATS_PERIODS },
    keywords: "аналитика теги страны",
  },
  {
    id: "stats-income", path: "/stats/income", label: "Доход Fansly", title: "Статистика Fansly: доход", section: "stats", ownerOnly: true,
    why: "Доход по данным Fansly: по дням, по месяцам, сверка с Hub.",
    pageFilter: "one", onePageWay: "substitute", platforms: FANSLY,
    platformsNote: "Статистику Hub собирает только для Fansly.", platformsShort: "только Fansly",
    period: { class: "shared", options: STATS_PERIODS },
    keywords: "аналитика трафик",
  },

  // ── Публикации ─────────────────────────────────────────────────────────
  {
    id: "publications", path: "/publications", label: "Публикации", title: "Публикации", section: "publications", ownerOnly: true,
    why: "Что и когда выйдет на стенах страниц.",
    pageFilter: "any", platforms: REPORTED,
    platformsNote: "Hub не публикует в Telegram.",
    telegramNote: { title: "Hub не публикует в Telegram", text: "У страниц Telegram публикаций нет." },
    keywords: "посты стена расписание утвердить настройки публикации",
  },

  // ── Команда ────────────────────────────────────────────────────────────
  {
    id: "team-shifts", path: "/team/shifts", label: "Заработок", title: "Смены", section: "team",
    why: "Кто сколько заработал за смены по дням недели, рост и падение, кто на смене сейчас.",
    pageFilter: "any", platforms: REPORTED,
    platformsNote: "Hub не собирает данные Telegram.",
    // Its own: a calendar week with arrows, or 14 / 30 days (the screen's header).
    keywords: "команда смены кто работал заработок продажи графики неделя на смене без автора",
  },
  {
    id: "team-coverage", path: "/team/coverage", label: "Кто ждал", title: "Кто ждал", section: "team",
    why: "Когда фаны писали, а никого не было; кого не поприветствовали.",
    pageFilter: "any", platforms: REPORTED,
    period: { class: "shared", options: ["7d", "30d"] },
    keywords: "покрытие пустые часы приветствия рассылки",
  },
  {
    id: "team-held-sends", path: "/team/held-sends", label: "Проверить отправки", title: "Проверить отправки", section: "team",
    why: "Ушло ли сообщение, о котором расширение не отчиталось.",
    pageFilter: "any", platforms: ["onlyfans"],
    platformsNote: "Проверка отправок есть только у страниц OnlyFans.", platformsShort: "только OnlyFans",
    keywords: "зависшие отправки разбор",
  },
  {
    id: "team-chatters", path: "/team/chatters", label: "Чаттеры", title: "Чаттеры", section: "team",
    why: "Сравнение чаттеров за период. Это ориентир, а не основание для оплаты.",
    pageFilter: "all",
    period: { class: "shared", options: CHATTER_PERIODS },
    keywords: "числа кабинет чаттера выручка",
  },
  {
    id: "team-chatter", path: "/team/chatters/:userId", label: "Чаттер", title: "Чаттер", section: "team",
    why: "Всё о работе одного человека.",
    pageFilter: "all",
    period: { class: "shared", options: CHATTER_PERIODS },
    deep: true, notSearched: true,
    crumbs: () => [{ label: "Команда", to: "/team/shifts" }, { label: "Чаттеры", to: "/team/chatters" }],
  },
  {
    id: "team-payouts", path: "/team/payouts", label: "Выплаты", title: "Выплаты", section: "team",
    why: "Споры, кто не подтвердил смену, выгрузка в таблицу выплат.",
    pageFilter: "all",
    keywords: "отчёты смен споры выгрузка таблица выплат",
  },
  {
    id: "team-sales", path: "/team/sales", label: "Цена и скорость", title: "Цена и скорость", section: "team",
    why: "Какая цена платных сообщений и какая скорость ответа дают покупки.",
    pageFilter: "any", platforms: REPORTED,
    period: { class: "shared", options: ["7d", "30d"] },
    keywords: "продажи ppv платные сообщения конверсия скорость ответа",
  },
  {
    id: "team-win-back", path: "/team/win-back", label: "Возврат фанов", title: "Возврат фанов", section: "team",
    why: "Какие подходы возвращают фанов и у кого.",
    pageFilter: "all",
    // Its results ripen over 72 h, 7 and 30 days: its own period, a month by default.
    period: { class: "own", options: ["7d", "30d", "90d"], default: "30d" },
    keywords: "подходы продажи вернуть",
  },
  {
    id: "team-customs", path: "/team/customs", label: "Кастомы", title: "Кастомы", section: "team",
    why: "Какие кастомы заказаны или оплачены и не отданы.",
    pageFilter: "any", platforms: REPORTED,
    keywords: "заказы продажи",
  },
  {
    id: "team-people", path: "/team/people", label: "Сотрудники", title: "Сотрудники и доступ", section: "team", ownerOnly: true,
    why: "Кто в команде, у кого какой доступ, кого пригласить.",
    pageFilter: "none",
    keywords: "команда доступ приглашение пользователи устройства логины",
  },
  {
    id: "team-person", path: "/team/people/:userId", label: "Карточка сотрудника", title: "Карточка сотрудника", section: "team", ownerOnly: true,
    why: "Страницы, входы и устройства человека.",
    pageFilter: "none",
    deep: true, notSearched: true,
    crumbs: () => [{ label: "Команда", to: "/team/shifts" }, { label: "Сотрудники", to: "/team/people" }],
  },

  // ── Настройки ──────────────────────────────────────────────────────────
  {
    id: "settings-pages", path: "/settings/pages", label: "Модели и страницы", title: "Модели и страницы", section: "settings", ownerOnly: true,
    why: "Из чего состоит агентство: модели, их страницы и кто на них работает.",
    pageFilter: "none",
    keywords: "агентство модели страницы каталог добавить страницу отключить браузеры страниц",
  },
  {
    id: "settings-connect", path: "/settings/pages/connect", label: "Подключить страницу Fansly", title: "Подключить страницу Fansly", section: "settings", ownerOnly: true,
    why: "Прокси и черновик браузера новой страницы.",
    pageFilter: "none",
    deep: true,
    keywords: "новый браузер страницы подключение",
    crumbs: () => [{ label: "Настройки", to: "/settings/pages" }, { label: "Модели и страницы", to: "/settings/pages" }],
  },
  {
    id: "settings-connect-profile", path: "/settings/pages/connect/:profileId", label: "Подключить страницу Fansly", title: "Подключить страницу Fansly", section: "settings", ownerOnly: true,
    why: "Браузер на сервере, выходной IP, вход, создать страницу.",
    pageFilter: "none",
    deep: true, notSearched: true,
    crumbs: () => [{ label: "Настройки", to: "/settings/pages" }, { label: "Модели и страницы", to: "/settings/pages" }],
  },
  {
    id: "settings-personas", path: "/settings/ai/personas", label: "Персоны", title: "Персоны ИИ", section: "settings", ownerOnly: true,
    why: "Образы для ответов ИИ: их пишет владелец, выбирают чаттеры.",
    pageFilter: "none",
    keywords: "ai персоны ии инструкция промпт образ первые сообщения hi",
  },
  {
    id: "settings-persona", path: "/settings/ai/personas/:key", label: "Персона", title: "Персона", section: "settings", ownerOnly: true,
    why: "Образ для ответов ИИ: его выбирают чаттеры.",
    pageFilter: "none",
    deep: true, notSearched: true,
    crumbs: () => [{ label: "Настройки", to: "/settings/pages" }, { label: "ИИ", to: "/settings/ai/personas" }, { label: "Персоны", to: "/settings/ai/personas" }],
  },
  {
    id: "settings-new-persona", path: "/settings/ai/new-persona", label: "Новая персона", title: "Новая персона", section: "settings", ownerOnly: true,
    why: "Новый образ для ответов ИИ.",
    pageFilter: "none",
    deep: true, notSearched: true,
    crumbs: () => [{ label: "Настройки", to: "/settings/pages" }, { label: "ИИ", to: "/settings/ai/personas" }, { label: "Персоны", to: "/settings/ai/personas" }],
  },
  {
    id: "settings-features", path: "/settings/ai/features", label: "Функции ИИ", title: "Функции ИИ", section: "settings", ownerOnly: true,
    why: "Что из ИИ включено и какая модель, усилие и окно у каждой функции.",
    pageFilter: "none",
    keywords: "возможности функции ai модель усилие effort окно голосовые досье факты",
  },
  {
    id: "settings-feature", path: "/settings/ai/features/:featureId", label: "Параметры функции", title: "Параметры функции", section: "settings", ownerOnly: true,
    why: "Все параметры одной функции и что будет, если её отключить.",
    pageFilter: "none",
    deep: true, notSearched: true,
    crumbs: () => [{ label: "Настройки", to: "/settings/pages" }, { label: "ИИ", to: "/settings/ai/personas" }, { label: "Функции ИИ", to: "/settings/ai/features" }],
  },
  {
    id: "settings-limits", path: "/settings/ai/limits", label: "Лимиты", title: "Лимиты ИИ на день", section: "settings", ownerOnly: true,
    why: "Сколько ИИ может стоить человеку за день по Москве.",
    pageFilter: "none",
    keywords: "ai лимиты личный лимит котёл общий запас",
  },
  {
    id: "settings-notifications", path: "/settings/notifications", label: "Оповещения", title: "Оповещения в Telegram", section: "settings", ownerOnly: true,
    why: "Куда и что присылает Hub в Telegram, и ежедневный отчёт о доходе.",
    pageFilter: "none",
    keywords: "уведомления telegram телеграм бот отчёт сбои оповещения",
  },

  // ── Система ────────────────────────────────────────────────────────────
  {
    id: "system-collection", path: "/system/collection", label: "Сбор данных", title: "Сбор данных", section: "system", ownerOnly: true,
    why: "Все страницы: собирается ли и что нажать.",
    pageFilter: "any",
    keywords: "синк синхронизация fansly onlyfans",
  },
  {
    id: "system-collection-page", path: "/system/collection/:pageLabel", label: "Сбор данных страницы", title: "Сбор данных страницы", section: "system", ownerOnly: true,
    why: "Что у этой страницы не собирается и как исправить.",
    pageFilter: "none",
    deep: true, notSearched: true,
    crumbs: () => [{ label: "Система", to: "/system/collection" }, { label: "Сбор данных", to: "/system/collection" }],
  },
  {
    id: "system-failures", path: "/system/failures", label: "Сбои", title: "Сбои", section: "system", ownerOnly: true,
    why: "Что сломалось, что делать и где чинить.",
    pageFilter: "any",
    keywords: "инциденты аномалии",
  },
  {
    id: "system-history-requests", path: "/system/history-requests", label: "Заявки на историю", title: "Заявки на историю", section: "system", ownerOnly: true,
    why: "Заявки агентов на старую переписку: что ждёт решения и что уже было.",
    pageFilter: "any",
    keywords: "дозагрузка истории",
  },
  {
    id: "system-agent-keys", path: "/system/agent-keys", label: "Доступ ИИ-агентов", title: "Доступ ИИ-агентов", section: "system", ownerOnly: true,
    why: "Ключи агентов, их права; привязка сбора к устройству.",
    pageFilter: "none",
    keywords: "ключи агентов устройство",
  },
  {
    id: "system-onlyfans-api", path: "/system/onlyfans-api", label: "Состояние", title: "OnlyFans API", section: "system", ownerOnly: true,
    why: "Выключено с 1 ноября: что это значит и где что лежит.",
    pageFilter: "none",
    keywords: "ofapi вебхук",
  },
  {
    id: "system-onlyfans-collection", path: "/system/onlyfans-api/collection", label: "Правила сбора", title: "Правила сбора OnlyFans API", section: "system", ownerOnly: true,
    why: "Что и как часто собирал Hub и сколько кредитов это стоило.",
    pageFilter: "none",
    keywords: "сбор onlyfans ofapi",
  },
  {
    id: "system-onlyfans-tools", path: "/system/onlyfans-api/tools", label: "События и ключ", title: "События и ключ", section: "system", ownerOnly: true,
    why: "События и восстановление, сохранённые ответы, права ключа, словарь слов.",
    pageFilter: "none",
    keywords: "ofapi вебхук запрещённые слова",
  },
  {
    id: "system-onlyfans-media", path: "/system/onlyfans-api/media", label: "Медиа", title: "Медиатека OnlyFans", section: "system",
    why: "Каталог и загрузки медиатеки OnlyFans.",
    pageFilter: "none",
    keywords: "ofapi файлы волт",
  },
  {
    id: "system-onlyfans-exports", path: "/system/onlyfans-api/exports", label: "Выгрузки", title: "Выгрузки", section: "system",
    why: "Выгрузки OnlyFans API и посетители профиля по дням.",
    pageFilter: "none",
    keywords: "ofapi посетители",
  },
  {
    id: "system-onlyfans-actions", path: "/system/onlyfans-api/actions", label: "Действия с аккаунтом", title: "Действия с аккаунтом", section: "system", ownerOnly: true,
    why: "Сырые действия OnlyFans API и их история. Без ключа не выполняются.",
    pageFilter: "none",
    keywords: "управление аккаунтом ofapi",
  },
  {
    id: "system-dev-log", path: "/system/dev/log", label: "Журнал сбора", title: "Журнал сбора OnlyFans", section: "system", ownerOnly: true,
    why: "События старого сбора OnlyFans: последние 100 записей.",
    pageFilter: "none",
    keywords: "журнал аномалии синка наблюдение",
  },
  {
    id: "system-dev-run", path: "/system/dev/log/:runId", label: "Запуск сбора", title: "Запуск сбора", section: "system", ownerOnly: true,
    why: "Один запуск сбора: события и обращения к площадке.",
    pageFilter: "none",
    deep: true, notSearched: true,
    crumbs: () => [{ label: "Система", to: "/system/collection" }, { label: "Для разработчика", to: "/system/dev/log" }, { label: "Журнал сбора", to: "/system/dev/log" }],
  },
  {
    id: "system-dev-queue", path: "/system/dev/queue", label: "Очередь задач", title: "Очередь задач", section: "system", ownerOnly: true,
    why: "Фоновые задачи сервера: последние 100 записей.",
    pageFilter: "none",
    keywords: "наблюдение",
  },
  {
    id: "system-dev-database", path: "/system/dev/database", label: "База данных", title: "База данных", section: "system", ownerOnly: true,
    why: "Размер таблиц и миграции.",
    pageFilter: "none",
    keywords: "наблюдение db",
  },
  {
    id: "system-dev-extension", path: "/system/dev/extension", label: "Расширение: замеры", title: "Расширение: замеры", section: "system", ownerOnly: true,
    why: "Скорость, версии и счётчики расширения. Без имён людей, страниц и фанов.",
    pageFilter: "none",
    period: { class: "own", options: ["today", "7d", "30d"], default: "7d" },
    keywords: "client health наблюдение",
  },
  {
    id: "system-dev-config", path: "/system/dev/config", label: "Все параметры", title: "Все параметры", section: "system", ownerOnly: true,
    why: "Полный список параметров сервера. Меняйте, только если понимаете последствия.",
    pageFilter: "none",
    keywords: "конфигурация настройки сервера",
  },

  // ── Карточка страницы: объект, а не ветка меню ─────────────────────────
  {
    id: "page", path: "/pages/:pageLabel", label: "Сводка", title: "Страница", section: "page",
    why: "Сводка страницы.",
    pageFilter: "none",
    period: { class: "shared", options: COMMON_PERIODS },
    notSearched: true,
  },
  {
    id: "page-account", path: "/pages/:pageLabel/account", label: "Аккаунт на Fansly", title: "Аккаунт на Fansly", section: "page", ownerOnly: true,
    why: "Как страница выглядит и как настроена на самом Fansly.",
    pageFilter: "none", platforms: FANSLY,
    platformsNote: "Этот экран есть только у страниц Fansly.",
    notSearched: true,
  },
  {
    id: "page-promo", path: "/pages/:pageLabel/promo", label: "Продвижение", title: "Продвижение", section: "page", ownerOnly: true,
    why: "Ссылки и промо страницы.",
    pageFilter: "none", platforms: REPORTED,
    platformsNote: "Hub не собирает данные Telegram.",
    notSearched: true,
  },
  {
    id: "page-mass-messages", path: "/pages/:pageLabel/mass-messages", label: "Рассылки", title: "Рассылки", section: "page", ownerOnly: true,
    why: "Массовые рассылки страницы.",
    pageFilter: "none", platforms: FANSLY,
    platformsNote: "Этот экран есть только у страниц Fansly.",
    notSearched: true,
  },
  {
    id: "page-browser-login", path: "/pages/:pageLabel/browser-login", label: "Вход в Fansly", title: "Вход в Fansly", section: "page", ownerOnly: true,
    why: "Браузер страницы входит в Fansly со своего устройства и IP.",
    pageFilter: "none", platforms: FANSLY,
    platformsNote: "Этот экран есть только у страниц Fansly.",
    notSearched: true,
  },
];

const SCREEN_BY_ID: ReadonlyMap<string, Screen> = new Map(SCREENS.map((screen) => [screen.id, screen]));

export function screenById(id: string): Screen {
  const screen = SCREEN_BY_ID.get(id);
  if (!screen) throw new Error(`No screen "${id}" in lib/sections.ts`);
  return screen;
}

// More literal paths first: /fans/by-spend/:bucketKey before /fans/:platform/:id.
const BY_SPECIFICITY = [...SCREENS].sort((a, b) => {
  const literal = (path: string) => path.split("/").filter((part) => part && !part.startsWith(":")).length;
  return literal(b.path) - literal(a.path);
});

export interface ScreenMatch {
  screen: Screen;
  params: Readonly<Record<string, string | undefined>>;
}

/** The screen an address opens, or null for an old address and an unknown one. */
export function matchScreen(pathname: string): ScreenMatch | null {
  const path = decodedPath(pathname);
  for (const screen of BY_SPECIFICITY) {
    const match = matchPath({ path: screen.path, end: true }, path);
    if (match) return { screen, params: match.params };
  }
  return null;
}

/** What the page filter does on this screen today. */
export function pageFilterOf(screen: Screen): { mode: PageFilterMode; onePageWay: OnePageWay | null } {
  const gap = UNTIL_REBUILT[screen.id];
  const mode = gap?.pageFilter ?? screen.pageFilter;
  return { mode, onePageWay: mode === "one" ? gap?.onePageWay ?? screen.onePageWay ?? "picker" : null };
}

/** The period the header draws today; null when there is none or the old screen draws its own. */
export function headerPeriodOf(screen: Screen): ScreenPeriod | null {
  return screen.period && !UNTIL_REBUILT[screen.id]?.periodInBody ? screen.period : null;
}

/** The period the address's filters force on this screen today, if any. */
export function forcedPeriodOf(screen: Screen, search: URLSearchParams): ForcedPeriod | null {
  return UNTIL_REBUILT[screen.id]?.noForcedPeriod ? null : screen.forcedPeriod?.(search) ?? null;
}

export function screenVisible(screen: Screen, role: Role): boolean {
  return !screen.ownerOnly || role === "owner";
}

// ── The tree: tabs and the menu ──────────────────────────────────────────

export interface SectionTab {
  id: string;
  label: string;
  /** The screens of this tab, the first is where it opens. A deep screen marks
   *  its tab current but is not listed in the row. */
  screens: readonly string[];
  /** A word beside the label in a side menu. */
  note?: string;
  /** The tab's screens are listed in the side menu, not in a row above the screen. */
  listedInSideMenu?: boolean;
}

export interface Section {
  id: SectionId;
  label: string;
  /** The screen header's title: the section, not the tab. */
  title: string;
  icon: "House" | "Wallet" | "Heart" | "ChartColumn" | "CalendarClock" | "Users" | "Settings" | "Wrench";
  ownerOnly?: boolean;
  /** Under the rule at the bottom of the menu. */
  lower?: boolean;
  nav: "tabs" | "side" | "none";
  tabs: readonly SectionTab[];
}

const tab = (id: string, label: string, ...screens: string[]): SectionTab => ({ id, label, screens });

export const SECTIONS: readonly Section[] = [
  {
    id: "home", label: "Главная", title: "Главная", icon: "House", nav: "none",
    tabs: [tab("home", "Главная", "home")],
  },
  {
    id: "money", label: "Деньги", title: "Деньги", icon: "Wallet", nav: "tabs",
    tabs: [
      tab("costs", "Расходы", "costs-ai", "costs-anthropic", "costs-onlyfans-api"),
      tab("transactions", "Операции", "transactions"),
    ],
  },
  {
    id: "fans", label: "Фаны", title: "Фаны", icon: "Heart", nav: "tabs",
    tabs: [
      tab("fans", "Платящие", "fans", "fan", "fan-any-page"),
      tab("subscribers", "Подписчики", "fans-subscribers"),
      tab("followers", "Фолловеры", "fans-followers"),
      tab("gone", "Ушли", "fans-gone"),
      tab("by-spend", "По сумме трат", "fans-by-spend", "fans-by-spend-list"),
    ],
  },
  {
    id: "stats", label: "Статистика", title: "Статистика Fansly", icon: "ChartColumn", ownerOnly: true, nav: "tabs",
    tabs: [
      tab("stats", "Главное", "stats"),
      tab("content", "Контент", "stats-content"),
      tab("audience", "Аудитория", "stats-audience"),
      tab("income", "Доход Fansly", "stats-income"),
    ],
  },
  {
    id: "publications", label: "Публикации", title: "Публикации", icon: "CalendarClock", ownerOnly: true, nav: "none",
    tabs: [tab("publications", "Публикации", "publications")],
  },
  {
    id: "team", label: "Команда", title: "Команда", icon: "Users", nav: "tabs",
    tabs: [
      tab("shifts", "Смены", "team-shifts", "team-coverage", "team-held-sends"),
      tab("chatters", "Чаттеры", "team-chatters", "team-chatter"),
      tab("payouts", "Выплаты", "team-payouts"),
      tab("sales", "Продажи", "team-sales", "team-win-back", "team-customs"),
      tab("people", "Сотрудники", "team-people", "team-person"),
    ],
  },
  {
    id: "settings", label: "Настройки", title: "Настройки", icon: "Settings", ownerOnly: true, lower: true, nav: "side",
    tabs: [
      tab("pages", "Модели и страницы", "settings-pages", "settings-connect", "settings-connect-profile"),
      tab("ai", "ИИ", "settings-personas", "settings-persona", "settings-new-persona", "settings-features", "settings-feature", "settings-limits"),
      tab("notifications", "Оповещения", "settings-notifications"),
    ],
  },
  {
    id: "system", label: "Система", title: "Система", icon: "Wrench", ownerOnly: true, lower: true, nav: "side",
    tabs: [
      tab("collection", "Сбор данных", "system-collection", "system-collection-page"),
      tab("failures", "Сбои", "system-failures"),
      tab("history", "Заявки на историю", "system-history-requests"),
      tab("agent-keys", "Доступ ИИ-агентов", "system-agent-keys"),
      {
        ...tab("onlyfans-api", "OnlyFans API", "system-onlyfans-api", "system-onlyfans-collection", "system-onlyfans-tools", "system-onlyfans-media", "system-onlyfans-exports", "system-onlyfans-actions"),
        note: "выключено с 1 ноября",
      },
      {
        ...tab("dev", "Для разработчика", "system-dev-log", "system-dev-run", "system-dev-queue", "system-dev-database", "system-dev-extension", "system-dev-config"),
        listedInSideMenu: true,
      },
    ],
  },
];

const SECTION_BY_ID: ReadonlyMap<SectionId, Section> = new Map(SECTIONS.map((section) => [section.id, section]));

export function sectionById(id: SectionId): Section | null {
  return SECTION_BY_ID.get(id) ?? null;
}

/** A tab's screens this role can open, deep ones left out. */
export function tabRow(sectionTab: SectionTab, role: Role): Screen[] {
  return sectionTab.screens.map(screenById).filter((screen) => screenVisible(screen, role) && !screen.deep);
}

/** The tabs of a section this role has at least one screen on. */
export function visibleSectionTabs(section: Section, role: Role): SectionTab[] {
  return section.tabs.filter((item) => tabRow(item, role).length > 0);
}

export function tabOfScreen(section: Section, screenId: string): SectionTab | null {
  return section.tabs.find((item) => item.screens.includes(screenId)) ?? null;
}

/** Where a menu item leads for this role. */
export function sectionHome(section: Section, role: Role): string {
  const first = visibleSectionTabs(section, role)[0];
  const screen = first ? tabRow(first, role)[0] : undefined;
  return screen?.path ?? "/";
}

/** The menu of this role: Главная · Деньги · Фаны · Команда for a team lead. */
export function menuOf(role: Role): Section[] {
  return SECTIONS.filter((section) => !section.ownerOnly || role === "owner");
}

// ── A page's card ────────────────────────────────────────────────────────

/** The tabs of a page's card, as its platform and the viewer's role have them. */
export function pageCardTabs(page: { label: string; platform: string }, role: Role): { to: string; label: string; screenId: string }[] {
  const base = `/pages/${pathSegment(page.label)}`;
  const rows: { to: string; label: string; screenId: string }[] = [{ to: base, label: "Сводка", screenId: "page" }];
  for (const [id, segment] of [["page-account", "account"], ["page-promo", "promo"], ["page-mass-messages", "mass-messages"]] as const) {
    const screen = screenById(id);
    if (!screenVisible(screen, role)) continue;
    if (screen.platforms && !(screen.platforms as readonly string[]).includes(page.platform)) continue;
    rows.push({ to: `${base}/${segment}`, label: screen.label, screenId: id });
  }
  return rows;
}
