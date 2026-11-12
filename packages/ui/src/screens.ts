/**
 * The owner's place in one table (design/ia.md §1.3, ecosystem plan §3.1): every
 * screen of the console, and Workboard's screens, with its address, its words,
 * who sees it, what the page filter and the period do on it. The menu of both
 * apps, the tabs, the crumbs, the search and the browser tab all read these
 * tables, so a screen is named the same everywhere and a new one has one place
 * to go: a new screen of «Команда» is one row here (section `team`), and both
 * apps list it.
 *
 * Addresses are the host's: a console screen's path, a Workboard screen's under
 * /workboard/ (Hub serves Workboard there on the same name).
 */
import { matchPath } from "react-router";
import type { Platform } from "@agency_hub_core/shared";
import { decodedPath, pathSegment } from "./path.js";

export type Role = "owner" | "team_lead" | string;

/** The console's period values (apps/dashboard/src/lib/period.ts names and orders them). */
export type PeriodKey = "today" | "24h" | "3d" | "7d" | "14d" | "30d" | "90d" | "180d" | "365d" | "all" | "day" | "week" | "month";

/** Which app draws a screen: the console, or Workboard at /workboard/ on the same host (a page load between them). */
export type ScreenApp = "console" | "workboard";

/** Workboard's address on the host: its Vite `base` (apps/workboard/src/base.ts). */
export const WORKBOARD_PATH = "/workboard/";

/** The icons of the menu (lucide-react names; components/Place.tsx draws them). */
export type MenuIcon =
  | "House" | "Inbox" | "Wallet" | "Heart" | "ChartColumn" | "Newspaper" | "Megaphone" | "ClipboardList"
  | "CalendarClock" | "Users" | "TrendingUp" | "Banknote" | "Package" | "Flag" | "Settings" | "Wrench";

/** Where a menu item's number comes from: one read for both apps (place.ts). */
export type MenuCount = "waiting";

/**
 * A row a menu lists only while something about the person is true; the app
 * that draws the menu answers it (absent: listed whenever the role may open it):
 * - `newcomer` — a newcomer with a step of «Начало» still open (Workboard's `accountStart`).
 */
export type MenuWhen = "newcomer";

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

export type SectionId = "home" | "waiting" | "money" | "fans" | "stats" | "content" | "traffic" | "team" | "applications" | "settings" | "system";

export interface Crumb {
  label: string;
  to?: string;
}

/**
 * A section of a screen that holds several things on one page (OnlyFans API,
 * Разработчик): its anchor in the address (`/system/dev#queue`; `#config-<key>`
 * opens `config` too), its name and its one sentence. The screen draws them in
 * this order; the search finds each by its name and old words.
 */
export interface ScreenPart {
  id: string;
  label: string;
  why: string;
  /** The owner's alone on a screen a team lead opens too. */
  ownerOnly?: boolean;
  keywords?: string;
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
  /** Workboard draws it (absent: the console). */
  app?: "workboard";
  ownerOnly?: boolean;
  /** Who opens it, when it is not the owner and team leads (`ownerOnly`: the owner alone). */
  roles?: readonly Role[];
  /** Where a menu lists the screen as itself (a screen of «Команда», Workboard's own menu). */
  icon?: MenuIcon;
  /** Listed only while this holds; its address opens whatever the menu says. */
  when?: MenuWhen;
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
  /** The screen draws its period itself: «Операции» has a fifth value, «Свои даты» (design/screens/home-money.md §4). */
  periodInBody?: boolean;
  /** Old names: the search finds a screen by the word a habit remembers. */
  keywords?: string;
  /** The header is the object itself, under crumbs; no section tabs. */
  deep?: boolean;
  crumbs?: (params: Readonly<Record<string, string | undefined>>) => Crumb[];
  /** Not offered by the search on its own (a parameter is in its path). */
  notSearched?: boolean;
  /** The address's filters can make the period not the screen's to choose. */
  forcedPeriod?: (search: URLSearchParams) => ForcedPeriod | null;
  /** The screen is one page of sections (ScreenPart), each opened by its anchor. */
  parts?: readonly ScreenPart[];
}

const COMMON_PERIODS: readonly PeriodKey[] = ["today", "7d", "30d", "all"];
const SPENDER_PERIODS: readonly PeriodKey[] = ["today", "7d", "30d", "90d", "180d", "all"];
const STATS_PERIODS: readonly PeriodKey[] = ["7d", "30d", "90d", "180d", "365d"];

const REPORTED: readonly Platform[] = ["fansly", "onlyfans"];
const FANSLY: readonly Platform[] = ["fansly"];

/** Настройки › Модели и страницы › the page: where a page's own Fansly screens sit. */
const pageCrumbs = (page?: string): Crumb[] => [
  { label: "Настройки", to: "/settings/pages" },
  { label: "Модели и страницы", to: "/settings/pages" },
  ...(page ? [{ label: page, to: `/settings/pages#page-${pathSegment(page)}` }] : []),
];

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

/** Every screen of the owner's place: the console's, and Workboard's that a menu lists. The order inside a section is the order of its tabs. */
export const SCREENS: readonly Screen[] = [
  {
    id: "home", path: "/", label: "Главная", title: "Главная", section: "home",
    why: "Сколько заработали, что выросло и упало, что ждёт вас и кто на смене.",
    pageFilter: "any", platforms: REPORTED,
    platformsNote: "Hub не собирает данные Telegram.",
    period: { class: "shared", options: COMMON_PERIODS },
    keywords: "обзор старт сводка доход выручка деньги заработок тренды",
  },

  // ── Ждут вас ───────────────────────────────────────────────────────────
  // Workboard's list of what waits for the owner (it was «Решения»); its number is the one read of «Ждут вас» (place.ts).
  {
    id: "waiting", path: "/workboard/decisions", label: "Ждут вас", title: "Ждут вас", section: "waiting", app: "workboard", icon: "Inbox",
    why: "Что ждёт вашего слова: вопросы, отчёты смен, кастомы, отправки.",
    pageFilter: "any",
    keywords: "решения чья продажа вопросы генгар отчёты посты не разобраны оплаченный день изменён кастомы проверить отправки зависшие",
  },

  // ── Деньги ─────────────────────────────────────────────────────────────
  {
    // The agency's month as the ledger keeps it (its month card, read by Hub); its first line beside Главная's income.
    id: "money-month", path: "/money/month", label: "Месяц", title: "Деньги: месяц", section: "money", ownerOnly: true,
    why: "Месяц агентства по ledger: доход страниц, мимо площадок, оборот и где заработанное сейчас.",
    pageFilter: "all",
    keywords: "месяц карточка месяца ledger оборот заработано пришло едет мимо площадок доход страниц",
  },
  {
    id: "transactions", path: "/money/transactions", label: "Операции", title: "Операции", section: "money",
    why: "Из каких операций сложилась сумма.",
    pageFilter: "any", platforms: REPORTED,
    platformsNote: "Hub не собирает данные Telegram.",
    period: { class: "shared", options: COMMON_PERIODS },
    periodInBody: true,
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
    id: "costs-onlyfans-api", path: "/money/costs/onlyfans-api", label: "OnlyFans API", title: "OnlyFans API", section: "money", ownerOnly: true,
    why: "Сколько кредитов осталось и на что они ушли.",
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

  // ── Контент ────────────────────────────────────────────────────────────
  // Публикации and Рассылки here; План, Приехало and Библиотека are ContentOps' (links of the section).
  {
    id: "publications", path: "/content/publications", label: "Публикации", title: "Публикации", section: "content", ownerOnly: true,
    why: "Что и когда выйдет на стенах страниц.",
    pageFilter: "any", platforms: REPORTED,
    platformsNote: "Hub не публикует в Telegram.",
    telegramNote: { title: "Hub не публикует в Telegram", text: "У страниц Telegram публикаций нет." },
    keywords: "посты стена расписание утвердить настройки публикации",
  },
  {
    // A page's mass messages (a tab of the page's card until 12.11).
    id: "content-mass-messages", path: "/content/mass-messages", label: "Рассылки", title: "Рассылки", section: "content", ownerOnly: true,
    why: "Массовые рассылки страницы: что ушло, кому и сколько принесло.",
    pageFilter: "one", onePageWay: "picker", platforms: FANSLY,
    platformsNote: "Рассылки Hub собирает только у страниц Fansly.", platformsShort: "только Fansly",
    keywords: "рассылки массовые сообщения mass messages",
  },

  // ── Трафик ─────────────────────────────────────────────────────────────
  // The traffic routine stays on the owner's Mac; its daily summary comes here as an agent's report (package O).
  {
    id: "traffic", path: "/traffic", label: "Сводка", title: "Трафик: сводка", section: "traffic", ownerOnly: true,
    why: "Каналы трафика: что работает и что ждёт решения. Сводку пишет агент трафика.",
    pageFilter: "none",
    keywords: "трафик каналы подрядчики циклы доска сводка агент",
  },
  {
    // A page's promo (a tab of the page's card until 12.11): Fansly's own, or the OnlyFans links as of 1 November.
    id: "traffic-promo", path: "/traffic/promo", label: "Продвижение", title: "Трафик: продвижение", section: "traffic", ownerOnly: true,
    why: "Ссылки и промо страницы: откуда пришли подписчики и деньги.",
    pageFilter: "one", onePageWay: "picker", platforms: REPORTED,
    platformsNote: "Hub не собирает данные Telegram.",
    keywords: "продвижение промо ссылки трекинг кампании маркетинг ofapi marketing",
  },

  // ── Команда: Workboard ─────────────────────────────────────────────────
  // The team's screens are Workboard's (owner, 2026-11-10). A row here is an item under «Команда» for the
  // owner and team leads, and an item of Workboard's own menu for whoever opens it there (a chatter: «Мои смены»).
  {
    // A newcomer's way to the first shift (package J), and their home until every step is done.
    id: "start", path: "/workboard/start", label: "Начало", title: "Начало", section: "team", app: "workboard", roles: ["chatter"], icon: "Flag", when: "newcomer",
    why: "Шаги до первой смены: расширение, вход, страницы, первая работа, куда платить.",
    pageFilter: "none",
    notSearched: true,
  },
  {
    id: "my-shifts", path: "/workboard/my/shifts", label: "Мои смены", title: "Мои смены", section: "team", app: "workboard", roles: ["chatter"], icon: "CalendarClock",
    why: "Свои смены и отчёты по ним.",
    pageFilter: "none",
    notSearched: true,
  },
  {
    id: "shifts", path: "/workboard/shifts", label: "Смены", title: "Смены", section: "team", app: "workboard", icon: "CalendarClock",
    why: "Кто работал, сколько продал и как работал.",
    pageFilter: "any",
    keywords: "команда заработок кто работал на смене неделя журнал разбор смены без автора",
  },
  {
    id: "people", path: "/workboard/people", label: "Люди", title: "Люди", section: "team", app: "workboard", icon: "Users",
    why: "Кто в команде: работа, продажи, доступ и входы, график и условия.",
    pageFilter: "any",
    keywords: "чаттеры сотрудники кабинет чаттера числа доступ приглашение пользователи устройства логины страницы",
  },
  {
    // Заказы кастомов (package I): the owner and the person who leads customs see every order, a team lead and a
    // chatter the orders of their pages (Hub decides).
    id: "customs", path: "/workboard/customs", label: "Кастомы", title: "Кастомы", section: "team", app: "workboard", roles: ["owner", "team_lead", "chatter"], icon: "Package",
    why: "Заказы кастомов: что заказано, оплачено, снято и отдано.",
    pageFilter: "any",
    keywords: "кастомы заказы кастомов съёмка видео фото ведущий кастомы отдать оплачен",
  },
  {
    id: "sales", path: "/workboard/sales", label: "Что продаёт", title: "Что продаёт", section: "team", app: "workboard", icon: "TrendingUp",
    why: "Что и по какой цене покупают, как быстро отвечают.",
    pageFilter: "any",
    // «Возврат фанов» and «Приветствия и охват» left its tabs on 12.11 (0 opened in 14 days): their addresses still open.
    keywords: "продажи цена скорость ответа ppv платные",
  },
  {
    // People's pay is the owner's alone (the ledger's answer reaches no other session).
    id: "payouts", path: "/workboard/payouts", label: "Выплаты", title: "Выплаты", section: "team", app: "workboard", ownerOnly: true, icon: "Banknote",
    why: "Сколько начислено, к выплате и выплачено каждому.",
    pageFilter: "any",
    keywords: "долги начислено выплачено отчёты смен отчётность сумма изменена пост не разобран",
  },

  // ── Анкеты ─────────────────────────────────────────────────────────
  // The questionnaires stayed in the console when «Команда» became Workboard, at their old addresses.
  {
    id: "team-applications", path: "/team/applications", label: "Анкеты", title: "Анкеты моделей", section: "applications", ownerOnly: true,
    why: "Кто сейчас заполняет анкету модели на сайте, кто бросил, кто отправил.",
    pageFilter: "none",
    keywords: "анкета модели сайт найм заявки кандидатки",
  },
  {
    id: "team-application", path: "/team/applications/:ref", label: "Анкета", title: "Анкета модели", section: "applications", ownerOnly: true,
    why: "Ответы одной анкеты по разделам.",
    pageFilter: "none",
    deep: true, notSearched: true,
    crumbs: () => [{ label: "Анкеты", to: "/team/applications" }],
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
    // A page's own Fansly screens (they were tabs of the page's card, which left on 12.11): under its row here.
    id: "settings-page-account", path: "/settings/pages/:pageLabel/account", label: "Аккаунт на Fansly", title: "Аккаунт на Fansly", section: "settings", ownerOnly: true,
    why: "Как страница выглядит и как настроена на самом Fansly.",
    pageFilter: "none", platforms: FANSLY,
    platformsNote: "Этот экран есть только у страниц Fansly.",
    deep: true, notSearched: true,
    crumbs: (params) => pageCrumbs(params.pageLabel),
  },
  {
    id: "settings-page-login", path: "/settings/pages/:pageLabel/login", label: "Вход в Fansly", title: "Вход в Fansly", section: "settings", ownerOnly: true,
    why: "Браузер страницы входит в Fansly со своего устройства и IP.",
    pageFilter: "none", platforms: FANSLY,
    platformsNote: "Этот экран есть только у страниц Fansly.",
    deep: true, notSearched: true,
    crumbs: (params) => pageCrumbs(params.pageLabel),
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
    id: "system-agent-keys", path: "/system/agent-keys", label: "Агенты и ключи", title: "Агенты и ключи", section: "system", ownerOnly: true,
    why: "Ключи агентов и их права.",
    pageFilter: "none",
    keywords: "ключи агентов",
  },
  {
    id: "system-reports", path: "/system/reports", label: "Отчёты агентов", title: "Отчёты агентов", section: "system", ownerOnly: true,
    why: "Страницы, которые публикуют агенты: что есть и когда обновлялось.",
    pageFilter: "none",
    keywords: "отчёты агентов доски сводки страницы агентов трафик",
  },
  {
    id: "system-report", path: "/system/reports/:slug", label: "Отчёт агента", title: "Отчёт агента", section: "system", ownerOnly: true,
    why: "Страница, которую опубликовал агент.",
    pageFilter: "none",
    deep: true, notSearched: true,
    crumbs: () => [{ label: "Система", to: "/system/collection" }, { label: "Отчёты агентов", to: "/system/reports" }],
  },
  {
    id: "system-state", path: "/system/state", label: "Состояние", title: "Состояние", section: "system", ownerOnly: true,
    why: "Всё, что работает само: на сервере, на маке и на ПК, и копии. Проблемы наверху.",
    pageFilter: "none",
    keywords: "рутины копии бэкапы мак openclaw launchd задачи расписание здоровье",
  },
  {
    id: "system-people-messages", path: "/system/people-messages", label: "Сообщения людям", title: "Сообщения людям", section: "system", ownerOnly: true,
    why: "Что сервер сам написал бы людям в Telegram: каждый вид, его текст и что задержано. Включается по одному.",
    pageFilter: "none",
    keywords: "telegram телеграм бот отправка напоминания отчётность карточка выплата приглашение",
  },
  {
    // Six screens until 12.11 (five never opened in 14 days): one page of sections now, each at its anchor.
    // A team lead opens it too and gets «Медиа» and «Выгрузки» alone, as before.
    id: "system-onlyfans-api", path: "/system/onlyfans-api", label: "OnlyFans API", title: "OnlyFans API", section: "system",
    why: "OnlyFans API: включён ли, что собирал и что с ним можно сделать.",
    pageFilter: "none",
    keywords: "ofapi onlyfans",
    parts: [
      { id: "state", label: "Состояние", why: "Включён ли он, что это значит и где что лежит.", ownerOnly: true, keywords: "вебхук страницы кредиты приём событий" },
      { id: "collection", label: "Правила сбора", why: "Что и как часто собирал Hub и сколько кредитов это стоило.", ownerOnly: true, keywords: "сбор onlyfans" },
      { id: "tools", label: "События и ключ", why: "События и восстановление, сохранённые ответы, права ключа, словарь слов.", ownerOnly: true, keywords: "вебхук запрещённые слова" },
      { id: "media", label: "Медиа", why: "Каталог и загрузки медиатеки OnlyFans.", keywords: "медиатека файлы волт" },
      { id: "exports", label: "Выгрузки", why: "Выгрузки OnlyFans API и посетители профиля по дням.", keywords: "посетители" },
      { id: "actions", label: "Действия с аккаунтом", why: "Сырые действия OnlyFans API и их история. Без ключа не выполняются.", ownerOnly: true, keywords: "управление аккаунтом" },
    ],
  },
  {
    // Six screens until 12.11 (none opened in 14 days): one page of sections now, each at its anchor;
    // `#config-<key>` opens «Все параметры» on that key. «Расширение: замеры» keeps its own period, drawn in its section.
    id: "system-dev", path: "/system/dev", label: "Разработчик", title: "Разработчик", section: "system", ownerOnly: true,
    why: "Для разработчика: журнал сбора, очередь, база, замеры расширения и все параметры сервера.",
    pageFilter: "none",
    period: { class: "own", options: ["today", "7d", "30d"], default: "7d" },
    periodInBody: true,
    keywords: "для разработчика наблюдение",
    parts: [
      { id: "log", label: "Журнал сбора", why: "События старого сбора OnlyFans: последние 100 записей.", keywords: "журнал аномалии синка" },
      { id: "queue", label: "Очередь задач", why: "Фоновые задачи сервера: последние 100 записей." },
      { id: "database", label: "База данных", why: "Размер таблиц и миграции.", keywords: "db" },
      { id: "extension", label: "Расширение: замеры", why: "Скорость, версии и счётчики расширения. Без имён людей, страниц и фанов.", keywords: "client health" },
      { id: "config", label: "Все параметры", why: "Полный список параметров сервера. Меняйте, только если понимаете последствия.", keywords: "конфигурация настройки сервера" },
    ],
  },
  {
    id: "system-dev-run", path: "/system/dev/log/:runId", label: "Запуск сбора", title: "Запуск сбора", section: "system", ownerOnly: true,
    why: "Один запуск сбора: события и обращения к площадке.",
    pageFilter: "none",
    deep: true, notSearched: true,
    crumbs: () => [{ label: "Система", to: "/system/collection" }, { label: "Разработчик", to: "/system/dev" }, { label: "Журнал сбора", to: "/system/dev#log" }],
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
  return { mode: screen.pageFilter, onePageWay: screen.pageFilter === "one" ? screen.onePageWay ?? "picker" : null };
}

/** The period the header draws today; null when there is none or the screen draws its own. */
export function headerPeriodOf(screen: Screen): ScreenPeriod | null {
  return screen.period && !screen.periodInBody ? screen.period : null;
}

/** The period the address's filters force on this screen today, if any. */
export function forcedPeriodOf(screen: Screen, search: URLSearchParams): ForcedPeriod | null {
  return screen.forcedPeriod?.(search) ?? null;
}

/** The sections of a screen of parts that this role opens, in the screen's order. */
export function screenParts(screen: Pick<Screen, "parts">, role: Role): ScreenPart[] {
  return (screen.parts ?? []).filter((part) => !part.ownerOnly || role === "owner");
}

/** The section an address's anchor opens: `#queue` opens `queue`, `#config-<key>` opens `config` on that key. */
export function partOfAnchor(parts: readonly ScreenPart[], hash: string): ScreenPart | null {
  const anchor = decodedPath(hash.replace(/^#/, ""));
  return parts.find((part) => anchor === part.id || anchor.startsWith(`${part.id}-`)) ?? null;
}

/** Without `roles`, a screen is the owner's and team leads' (`ownerOnly`: the owner's alone), never a chatter's. */
export function screenVisible(screen: Screen, role: Role): boolean {
  if (screen.roles) return screen.roles.includes(role);
  if (role === "chatter") return false;
  return !screen.ownerOnly || role === "owner";
}

/** The app that draws a screen. */
export function appOf(screen: Pick<Screen, "app">): ScreenApp {
  return screen.app ?? "console";
}

/** The app an address of the host belongs to: Workboard's are under /workboard/. */
export function addressApp(to: string): ScreenApp {
  return to === WORKBOARD_PATH.slice(0, -1) || to.startsWith(WORKBOARD_PATH) ? "workboard" : "console";
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
  /** Not in the row itself: under «Ещё» at its end (a list nobody opened, kept: it costs nothing). */
  more?: boolean;
}

export interface Section {
  id: SectionId;
  label: string;
  /** The screen header's title: the section, not the tab. */
  title: string;
  icon: MenuIcon;
  ownerOnly?: boolean;
  /**
   * The menu lists the section's screens as items of their own, under the
   * section's name (a heading, not a link): «Команда». Its tabs are its screens.
   */
  group?: boolean;
  /** The menu item's number (one read for both apps, place.ts). */
  count?: MenuCount;
  /** Under the rule at the bottom of the menu. */
  lower?: boolean;
  /**
   * The section's places elsewhere, after its tabs. ContentOps': they open it on
   * the model of the chosen page (it keeps a model's content at `/<model>/<path>`).
   * Workboard's: a list whose one place is a Workboard screen, linked from here
   * (a page load on this host), for the roles that open it.
   */
  outside?:
    | { site: "contentops"; label: string; links: readonly { label: string; path: string }[] }
    | { site: "workboard"; links: readonly { label: string; to: string; title: string; ownerOnly?: boolean }[] };
  nav: "tabs" | "side" | "none";
  tabs: readonly SectionTab[];
}

const tab = (id: string, label: string, ...screens: string[]): SectionTab => ({ id, label, screens });
/** A tab under «Ещё» (L2, 12.11: not opened in 14 days, not a duplicate). */
const moreTab = (id: string, label: string, ...screens: string[]): SectionTab => ({ id, label, screens, more: true });

/** The menu's order is this table's: Главная, Ждут вас, the console's sections, «Команда» last above the rule. */
export const SECTIONS: readonly Section[] = [
  {
    id: "home", label: "Главная", title: "Главная", icon: "House", nav: "none",
    tabs: [tab("home", "Главная", "home")],
  },
  {
    // One list of what waits for the owner (Workboard's, at its old address), right under Главная.
    id: "waiting", label: "Ждут вас", title: "Ждут вас", icon: "Inbox", nav: "none", count: "waiting",
    tabs: [tab("waiting", "Ждут вас", "waiting")],
  },
  {
    id: "money", label: "Деньги", title: "Деньги", icon: "Wallet", nav: "tabs",
    tabs: [
      tab("month", "Месяц", "money-month"),
      tab("costs", "Расходы", "costs-ai", "costs-anthropic", "costs-onlyfans-api"),
      tab("transactions", "Операции", "transactions"),
    ],
    // The shift reports' list has one place, Команда → Выплаты → Отчёты (L2, 12.11); Деньги links it.
    outside: { site: "workboard", links: [
      { label: "Отчёты смен", to: "/workboard/payouts?view=reports", title: "Отчёты смен в Команда, Выплаты", ownerOnly: true },
    ] },
  },
  {
    id: "fans", label: "Фаны", title: "Фаны", icon: "Heart", nav: "tabs",
    tabs: [
      tab("fans", "Платящие", "fans", "fan", "fan-any-page"),
      tab("by-spend", "По сумме трат", "fans-by-spend", "fans-by-spend-list"),
      moreTab("subscribers", "Подписчики", "fans-subscribers"),
      moreTab("followers", "Фолловеры", "fans-followers"),
      moreTab("gone", "Ушли", "fans-gone"),
    ],
  },
  {
    id: "stats", label: "Статистика", title: "Статистика Fansly", icon: "ChartColumn", ownerOnly: true, nav: "tabs",
    tabs: [
      tab("stats", "Главное", "stats"),
      tab("income", "Доход Fansly", "stats-income"),
      moreTab("content", "Контент", "stats-content"),
      moreTab("audience", "Аудитория", "stats-audience"),
    ],
  },
  {
    // «Публикации» until 12.11: the content, the hub's part and ContentOps' (the model of the chosen page).
    id: "content", label: "Контент", title: "Контент", icon: "Newspaper", ownerOnly: true, nav: "tabs",
    tabs: [tab("publications", "Публикации", "publications"), tab("mass-messages", "Рассылки", "content-mass-messages")],
    outside: { site: "contentops", label: "ContentOps", links: [
      { label: "План", path: "plan" },
      { label: "Приехало", path: "inbox" },
      { label: "Библиотека", path: "library" },
    ] },
  },
  {
    id: "traffic", label: "Трафик", title: "Трафик", icon: "Megaphone", ownerOnly: true, nav: "tabs",
    tabs: [tab("summary", "Сводка", "traffic"), tab("promo", "Продвижение", "traffic-promo")],
  },
  {
    id: "applications", label: "Анкеты", title: "Анкеты моделей", icon: "ClipboardList", ownerOnly: true, nav: "none",
    tabs: [tab("applications", "Анкеты", "team-applications", "team-application")],
  },
  {
    // Workboard's screens, listed in place (owner, 2026-11-10: the team's control). Each row of the table's
    // section «team» is one item here, in the table's order.
    id: "team", label: "Команда", title: "Команда", icon: "Users", nav: "none", group: true,
    tabs: SCREENS.filter((screen) => screen.section === "team").map((screen) => tab(screen.id, screen.label, screen.id)),
  },
  {
    id: "settings", label: "Настройки", title: "Настройки", icon: "Settings", ownerOnly: true, lower: true, nav: "side",
    tabs: [
      tab("pages", "Модели и страницы", "settings-pages", "settings-connect", "settings-connect-profile", "settings-page-account", "settings-page-login"),
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
      tab("agent-keys", "Агенты и ключи", "system-agent-keys"),
      tab("reports", "Отчёты агентов", "system-reports", "system-report"),
      tab("state", "Состояние", "system-state"),
      tab("people-messages", "Сообщения людям", "system-people-messages"),
      tab("onlyfans-api", "OnlyFans API", "system-onlyfans-api"),
      tab("dev", "Разработчик", "system-dev", "system-dev-run"),
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

/** The screen a menu item opens for this role: the first of its first tab. */
function homeScreen(section: Section, role: Role): Screen | undefined {
  const first = visibleSectionTabs(section, role)[0];
  return first ? tabRow(first, role)[0] : undefined;
}

/** Where a menu item leads for this role. */
export function sectionHome(section: Section, role: Role): string {
  return homeScreen(section, role)?.path ?? "/";
}

/** The sections of this role's menu: Главная · Ждут вас · Деньги · Фаны · Команда for a team lead. */
export function menuOf(role: Role): Section[] {
  return SECTIONS.filter((section) => (!section.ownerOnly || role === "owner") && visibleSectionTabs(section, role).length > 0);
}

// ── The menu of the owner's place, item by item ──────────────────────────

/** A row with a condition is listed only while the app says it holds. */
function listed(screen: Screen, holds: Partial<Record<MenuWhen, boolean>>): boolean {
  return screen.when === undefined || holds[screen.when] === true;
}

/** One item of the menu: a section, or a screen of a group («Команда»). */
export interface MenuItem {
  /** The section's id; a group's screen's own id. */
  id: string;
  label: string;
  icon: MenuIcon;
  /** Where it leads for this role: an address of the host. */
  to: string;
  /** The app at that address: another app's item is a page load, nothing else differs. */
  app: ScreenApp;
  /** The group it is listed under («Команда»). */
  group?: string;
  count?: MenuCount;
}

/**
 * The menu of the owner's place for a role, the same in the console and in
 * Workboard: the items above the rule and under it. A section without a screen
 * the role may open is not there.
 */
export function placeMenu(role: Role, holds: Partial<Record<MenuWhen, boolean>> = {}): { upper: MenuItem[]; lower: MenuItem[] } {
  const upper: MenuItem[] = [];
  const lower: MenuItem[] = [];
  // The owner's place is the owner's and team leads'; a chatter's menu is Workboard's own (`teamMenu`).
  if (role === "chatter") return { upper, lower };
  for (const section of menuOf(role)) {
    const home = homeScreen(section, role);
    const items: MenuItem[] = section.group
      ? visibleSectionTabs(section, role).flatMap((item) => tabRow(item, role).slice(0, 1)).filter((screen) => listed(screen, holds)).map((screen) => ({
        id: screen.id, label: screen.label, icon: screen.icon ?? section.icon, to: screen.path, app: appOf(screen), group: section.label,
      }))
      : home ? [{
        id: section.id, label: section.label, icon: section.icon, to: home.path, app: appOf(home), ...(section.count ? { count: section.count } : {}),
      }] : [];
    (section.lower ? lower : upper).push(...items);
  }
  return { upper, lower };
}

/**
 * Workboard's own short menu (the team's place: a chatter, anyone on the team's
 * name): the Workboard screens the role opens, in the table's order, with
 * their own icons. Never a section of the console.
 */
export function teamMenu(role: Role, holds: Partial<Record<MenuWhen, boolean>> = {}): MenuItem[] {
  return menuOf(role).flatMap((section) => visibleSectionTabs(section, role).flatMap((item) => tabRow(item, role).slice(0, 1)))
    .filter((screen) => appOf(screen) === "workboard" && listed(screen, holds))
    .map((screen) => {
      const section = sectionById(screen.section);
      return {
        id: section?.group ? screen.id : screen.section, label: screen.label, icon: screen.icon ?? section?.icon ?? "Inbox", to: screen.path, app: "workboard" as const,
        ...(section?.count ? { count: section.count } : {}),
      };
    });
}

/** The first two segments of a Workboard address (`/workboard/people/7` → `/workboard/people`): a screen and everything under it. */
function workboardBranch(pathname: string): string | null {
  const parts = decodedPath(pathname).split("/");
  return parts[1] === WORKBOARD_PATH.slice(1, -1) && parts[2] ? `/${parts[1]}/${parts[2]}` : null;
}

/**
 * The menu item an address lights: its section's, or within a group its own
 * screen's. A Workboard address lights the screen it is under (a person's card
 * lights «Люди», a review «Смены»); an address with no item lights nothing.
 */
export function menuItemAt(pathname: string): string | null {
  let screen = matchScreen(pathname)?.screen ?? null;
  if (!screen) {
    const branch = workboardBranch(pathname);
    screen = branch === null ? null : SCREENS.find((candidate) => appOf(candidate) === "workboard" && workboardBranch(candidate.path) === branch) ?? null;
  }
  if (!screen) return null;
  const section = sectionById(screen.section);
  if (!section) return null;
  return section.group ? screen.id : section.id;
}

// ── A page's own screens ─────────────────────────────────────────────────

/**
 * What a page has of its own beside the filter (its card left on 12.11: the
 * page is a filter now), as its platform and the viewer's role have them: its
 * Fansly account and login under Настройки, its promo under Трафик, its mass
 * messages under Публикации.
 */
export function pagePlaces(page: { label: string; platform: string }, role: Role): { to: string; label: string; screenId: string }[] {
  const label = pathSegment(page.label);
  const query = new URLSearchParams({ page: page.label }).toString();
  const rows: { to: string; label: string; screenId: string }[] = [];
  for (const [id, to] of [
    ["settings-page-account", `/settings/pages/${label}/account`],
    ["traffic-promo", `/traffic/promo?${query}`],
    ["content-mass-messages", `/content/mass-messages?${query}`],
  ] as const) {
    const screen = screenById(id);
    if (!screenVisible(screen, role)) continue;
    if (screen.platforms && !(screen.platforms as readonly string[]).includes(page.platform)) continue;
    rows.push({ to, label: screen.label, screenId: id });
  }
  return rows;
}
