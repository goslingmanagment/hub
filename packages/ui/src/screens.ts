/**
 * The agency's screens in one table (design/ia.md §1.3, products plan §7): every
 * screen of Hub (the console, apps/dashboard) and of Workboard (apps/workboard),
 * with its product, its address, its words, who sees it, what the page filter
 * and the period do on it. Each product's menu, the tabs, the crumbs, the search
 * and the browser tab all read these tables, so a screen is named the same
 * everywhere and a new one has one place to go: a row here, with its product.
 *
 * A product has its own frame and its own menu (products plan §2.1): Hub's menu
 * is its sections, Workboard's its screens; no product lists another's screens,
 * and the frame's switcher crosses between them. Addresses are the host's: a Hub
 * screen's path, a Workboard screen's under /workboard/ (the team's name).
 */
import { matchPath } from "react-router";
import type { Platform } from "@agency_hub_core/shared";
import { decodedPath, pathSegment } from "./path.js";

export type Role = "owner" | "team_lead" | string;

/** The console's period values (apps/dashboard/src/lib/period.ts names and orders them). */
export type PeriodKey = "today" | "24h" | "3d" | "7d" | "14d" | "30d" | "90d" | "180d" | "365d" | "all" | "day" | "week" | "month";

/** Which app draws a screen: the console, or Workboard at /workboard/ (a page load between them). */
export type ScreenApp = "console" | "workboard";

/**
 * The product a screen belongs to: Hub (the owner's place, drawn by the console) or Workboard (the chat team's, every
 * role). The frame and the menu are chosen by the product, never by the role or the host.
 */
export type ScreenProduct = "hub" | "workboard";

/** Workboard's address on the host: its Vite `base` (apps/workboard/src/base.ts). */
export const WORKBOARD_PATH = "/workboard/";

/** The icons of the menu (lucide-react names; components/Place.tsx draws them). */
export type MenuIcon =
  | "House" | "Inbox" | "Wallet" | "Heart" | "ChartColumn" | "Newspaper" | "Megaphone" | "ClipboardList"
  | "CalendarClock" | "Users" | "TrendingUp" | "Banknote" | "Package" | "Flag" | "Settings" | "Wrench" | "BookOpen";

/** Where a menu item's number comes from: one read for both apps (place.ts). */
export type MenuCount = "waiting";

/**
 * A row a menu lists only while something about the person is true; the app
 * that draws the menu answers it (absent: listed whenever the role may open it):
 * - `newcomer` — a newcomer with a step of «Начало» still open (Workboard's `accountStart`);
 * - `leads` — the owner, a team lead, or anyone who leads a team by its records (products package T, `me.teams.lead`);
 * - `money` — the owner, or a person whose right «видит свои деньги» is on (Workboard's `accountPay` says `enabled`);
 * - `learn` — a page of «Обучение» the viewer reads: the owner, one published; anyone else, one the owner approved.
 */
export type MenuWhen = "newcomer" | "leads" | "money" | "learn";

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

export type SectionId = "home" | "waiting" | "money" | "fans" | "stats" | "content" | "traffic" | "team" | "applications" | "people" | "settings" | "system";

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
  /** The product it belongs to: Hub's screens the console draws, Workboard's Workboard. */
  product: ScreenProduct;
  ownerOnly?: boolean;
  /** Who opens it, when it is not the owner and team leads (`ownerOnly`: the owner alone). */
  roles?: readonly Role[];
  /** Workboard's menu lists its screens as themselves, with this icon. */
  icon?: MenuIcon;
  /** Listed only while this holds; its address opens whatever the menu says. */
  when?: MenuWhen;
  /** Workboard's menu item's number (one read in both products, place.ts). */
  count?: MenuCount;
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
  /** A Workboard screen reached through the tabs of the screen with this id: the menu lists that one, and lights it here. */
  tabOf?: string;
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
  { label: "Фаны", to: "/workboard/fans" },
  ...(page ? [{ label: page, to: `/workboard/fans?page=${encodeURIComponent(page)}` }] : []),
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
    id: "home", path: "/", label: "Главная", title: "Главная", section: "home", product: "hub",
    why: "Сколько заработали, что выросло и упало, что ждёт вас и что в продуктах.",
    pageFilter: "any", platforms: REPORTED,
    platformsNote: "Hub не собирает данные Telegram.",
    period: { class: "shared", options: COMMON_PERIODS },
    keywords: "обзор старт сводка доход выручка деньги заработок тренды",
  },

  // ── Ждут вас ───────────────────────────────────────────────────────────
  // The owner's whole list in Hub, grouped «Hub · Workboard · ContentOps» (products plan §4.4); the menu's number is
  // the one read of «Ждут вас» (place.ts). `hub.…/workboard/decisions` leads here.
  {
    id: "hub-waiting", path: "/waiting", label: "Ждут вас", title: "Ждут вас", section: "waiting", product: "hub", ownerOnly: true,
    why: "Всё, что ждёт вашего слова, по продуктам: Hub, Workboard, ContentOps.",
    pageFilter: "any",
    keywords: "решения дела чья продажа вопросы отчёты кастомы отправки люди доступ сбои ledger публикации контент",
  },

  // ── Деньги ─────────────────────────────────────────────────────────────
  {
    // The agency's month as the ledger keeps it (its month card, read by Hub); its first line beside Главная's income.
    id: "money-month", path: "/money/month", label: "Месяц", title: "Деньги: месяц", section: "money", product: "hub", ownerOnly: true,
    why: "Месяц агентства по ledger: доход страниц, мимо площадок, оборот и где заработанное сейчас.",
    pageFilter: "all",
    keywords: "месяц карточка месяца ledger оборот заработано пришло едет мимо площадок доход страниц",
  },
  {
    id: "transactions", path: "/money/transactions", label: "Операции", title: "Операции", section: "money", product: "hub",
    why: "Из каких операций сложилась сумма.",
    pageFilter: "any", platforms: REPORTED,
    platformsNote: "Hub не собирает данные Telegram.",
    period: { class: "shared", options: COMMON_PERIODS },
    periodInBody: true,
    keywords: "транзакции продажи платежи",
  },
  {
    id: "costs-ai", path: "/money/costs/ai", label: "ИИ", title: "Траты на ИИ", section: "money", product: "hub", ownerOnly: true,
    why: "Сколько денег на ИИ осталось, сколько ушло, на что и кем.",
    pageFilter: "all",
    keywords: "расходы траты ai anthropic",
  },
  {
    id: "costs-anthropic", path: "/money/costs/anthropic", label: "Сверка с Anthropic", title: "Сверка с Anthropic", section: "money", product: "hub", ownerOnly: true,
    why: "Сходится ли учёт Hub со счётом Anthropic.",
    pageFilter: "all",
    keywords: "расходы счёт csv выгрузка",
  },
  {
    id: "costs-onlyfans-api", path: "/money/costs/onlyfans-api", label: "OnlyFans API", title: "OnlyFans API", section: "money", product: "hub", ownerOnly: true,
    why: "Сколько кредитов осталось и на что они ушли.",
    pageFilter: "all",
    keywords: "кредиты расходы ofapi",
  },

  // ── Статистика ─────────────────────────────────────────────────────────
  {
    id: "stats", path: "/stats", label: "Главное", title: "Статистика Fansly", section: "stats", product: "hub", ownerOnly: true,
    why: "Как сам Fansly видит страницу: охват, деньги, подписчики.",
    pageFilter: "one", onePageWay: "substitute", platforms: FANSLY,
    platformsNote: "Статистику Hub собирает только для Fansly.", platformsShort: "только Fansly",
    period: { class: "shared", options: STATS_PERIODS },
    keywords: "аналитика обзор",
  },
  {
    id: "stats-audience", path: "/stats/audience", label: "Аудитория", title: "Статистика Fansly: аудитория", section: "stats", product: "hub", ownerOnly: true,
    why: "Откуда и когда смотрят, по каким тегам находят.",
    pageFilter: "one", onePageWay: "substitute", platforms: FANSLY,
    platformsNote: "Статистику Hub собирает только для Fansly.", platformsShort: "только Fansly",
    period: { class: "shared", options: STATS_PERIODS },
    keywords: "аналитика теги страны",
  },
  {
    id: "stats-income", path: "/stats/income", label: "Доход Fansly", title: "Статистика Fansly: доход", section: "stats", product: "hub", ownerOnly: true,
    why: "Доход по данным Fansly: по дням, по месяцам, сверка с Hub.",
    pageFilter: "one", onePageWay: "substitute", platforms: FANSLY,
    platformsNote: "Статистику Hub собирает только для Fansly.", platformsShort: "только Fansly",
    period: { class: "shared", options: STATS_PERIODS },
    keywords: "аналитика трафик",
  },

  // ── Контент ────────────────────────────────────────────────────────────
  // «Публикации» and «Статистика → Контент» are ContentOps' own screens since package C2 (their old addresses:
  // apps/runtime/src/services/content-screens-moved.ts). Рассылки are Workboard's.
  {
    // A page's mass messages (a tab of the page's card until 12.11).
    id: "content-mass-messages", tabOf: "sales", path: "/workboard/sales/mass", label: "Рассылки", title: "Рассылки", section: "team", product: "workboard", ownerOnly: true,
    why: "Массовые рассылки страницы: что ушло, кому и сколько принесло.",
    pageFilter: "one", onePageWay: "picker", platforms: FANSLY,
    platformsNote: "Рассылки Hub собирает только у страниц Fansly.", platformsShort: "только Fansly",
    keywords: "рассылки массовые сообщения mass messages",
  },

  // ── Трафик ─────────────────────────────────────────────────────────────
  {
    // The OnlyFans links by source: which source brings fans, day by day, over two weeks (ofLinksChannelsGet).
    id: "traffic-sources", path: "/traffic/sources", label: "Источники", title: "Трафик: источники", section: "traffic", product: "hub", ownerOnly: true,
    why: "Какой источник и в какой день привёл фанов.",
    pageFilter: "none",
    keywords: "трафик источники ссылки фаны график по дням onlyfans каналы подрядчики",
  },
  {
    // One traffic source: what it brought against what its contractor was paid, its days over eight weeks, its links
    // and payments (ofLinksChannelsGet with channelKey, ofLinksGet).
    id: "traffic-source", path: "/traffic/source/:key", label: "Источник", title: "Трафик: источник", section: "traffic", product: "hub", ownerOnly: true,
    why: "Один источник: что принёс, сколько заплачено и в какие дни.",
    pageFilter: "none",
    deep: true, notSearched: true,
    crumbs: () => [{ label: "Трафик", to: "/traffic/sources" }, { label: "Источники", to: "/traffic/sources" }],
  },
  {
    // One OnlyFans link: its facts, its money, its new fans day by day over eight weeks (ofLinksGet, ofLinksHistoryGet).
    id: "traffic-link", path: "/traffic/link/:pageId/:kind/:ref", label: "Ссылка", title: "Трафик: ссылка", section: "traffic", product: "hub", ownerOnly: true,
    why: "Одна ссылка: что принесла и в какие дни.",
    pageFilter: "none",
    deep: true, notSearched: true,
    crumbs: () => [{ label: "Трафик", to: "/traffic/sources" }, { label: "Источники", to: "/traffic/sources" }],
  },
  // The traffic routine stays on the owner's Mac; its daily summary comes here as an agent's report (package O).
  {
    id: "traffic", path: "/traffic", label: "Сводка", title: "Трафик: сводка", section: "traffic", product: "hub", ownerOnly: true,
    why: "Каналы трафика: что работает и что ждёт решения. Сводку пишет агент трафика.",
    pageFilter: "none",
    keywords: "трафик каналы подрядчики циклы доска сводка агент",
  },
  {
    // A page's promo (a tab of the page's card until 12.11): Fansly's own, or the OnlyFans links as of 1 November.
    id: "traffic-promo", path: "/traffic/promo", label: "Продвижение", title: "Трафик: продвижение", section: "traffic", product: "hub", ownerOnly: true,
    why: "Ссылки и промо страницы: откуда пришли подписчики и деньги.",
    pageFilter: "one", onePageWay: "picker", platforms: REPORTED,
    platformsNote: "Hub не собирает данные Telegram.",
    keywords: "продвижение промо ссылки трекинг кампании маркетинг ofapi marketing",
  },

  // ── Workboard ──────────────────────────────────────────────────────────
  // The chat team's product, every role's (products plan §2.3). A row here is an item of Workboard's menu, in this
  // order, for whoever opens it (a chatter: «Мои смены»); Hub lists none of them.
  {
    // A newcomer's way to the first shift (package J), and their home until every step is done.
    id: "start", path: "/workboard/start", label: "Начало", title: "Начало", section: "team", product: "workboard", roles: ["chatter"], icon: "Flag", when: "newcomer",
    why: "Шаги до первой смены: расширение, вход, страницы, первая работа, куда платить.",
    pageFilter: "none",
    notSearched: true,
  },
  {
    // The home of every role (products plan §2.3, package W): the person's own day and the teams they lead; `/workboard/`
    // leads here.
    id: "today", path: "/workboard/today", label: "Сегодня", title: "Сегодня", section: "team", product: "workboard", roles: ["owner", "team_lead", "chatter"], icon: "House",
    why: "Что сегодня: смена, что ждёт, неделя; у тимлида кто на смене, отчёты и разборы.",
    pageFilter: "none",
    keywords: "главная дом начало дня от прошлой смены моя смена неделя кто на смене не вышел график дыры разборы первый день",
  },
  // Workboard's list of what waits (it was «Решения» at /workboard/decisions): a team lead's and a chatter's whole,
  // the owner's Workboard part (its number is that part of the same read).
  {
    id: "waiting", path: "/workboard/waiting", label: "Ждут вас", title: "Ждут вас", section: "team", product: "workboard", icon: "Inbox", count: "waiting",
    roles: ["owner", "team_lead", "chatter"],
    why: "Что ждёт вашего слова: вопросы, отчёты смен, кастомы, отправки.",
    pageFilter: "any",
    keywords: "решения чья продажа вопросы генгар отчёты посты не разобраны оплаченный день изменён кастомы проверить отправки зависшие",
  },
  {
    // «Мои» of «Смены» (products package W: one «Смены»; `/workboard/my/shifts` leads here): a chatter's own shifts with
    // their reports. The owner and a team lead land on the journal of their own shifts.
    id: "my-shifts", tabOf: "shifts", path: "/workboard/shifts/mine", label: "Мои", title: "Смены", section: "team", product: "workboard", roles: ["owner", "team_lead", "chatter"],
    why: "Свои смены и отчёты по ним.",
    pageFilter: "none",
    notSearched: true,
  },
  {
    // Everyone's (products package T): the owner every team, anyone else their teams' (Hub cuts the reads).
    id: "shifts", path: "/workboard/shifts", label: "Смены", title: "Смены", section: "team", product: "workboard", roles: ["owner", "team_lead", "chatter"], icon: "CalendarClock",
    why: "Кто работал, сколько продал и как работал.",
    pageFilter: "any",
    keywords: "команда заработок кто работал на смене неделя журнал разбор смены без автора",
  },
  {
    // The team at work (products plan §2.3, §4.3; it was «Люди» at /workboard/people, which leads here): the owner every
    // team, a team lead theirs, and a chatter who leads a team by its records (`leads`); a plain chatter has no item.
    id: "team", path: "/workboard/team", label: "Команда", title: "Команда", section: "team", product: "workboard", icon: "Users",
    roles: ["owner", "team_lead", "chatter"], when: "leads",
    why: "Кто в команде и как работает: смены, продажи, качество, график и условия.",
    pageFilter: "any",
    keywords: "люди чаттеры сотрудники кабинет чаттера числа график условия оплаты новички",
  },
  // ── Фаны ───────────────────────────────────────────────────────────────
  // Workboard's since products package M: everyone's, Hub answers by the viewer's teams (services/fan-reads.ts). The
  // console's old /fans… addresses lead here (apps/dashboard/src/lib/workboard.ts `movedToWorkboard`).
  {
    id: "fans", path: "/workboard/fans", label: "Фаны", title: "Платящие", icon: "Heart", section: "team", product: "workboard", roles: ["owner", "team_lead", "chatter"],
    why: "Кто приносит деньги, кто реже покупает, кого вернуть.",
    pageFilter: "any", platforms: REPORTED,
    platformsNote: "Hub не собирает данные Telegram.",
    period: { class: "shared", options: SPENDER_PERIODS },
    forcedPeriod: fansForcedPeriod,
    keywords: "топ фанов спендеры",
  },
  {
    id: "fans-subscribers", tabOf: "fans", path: "/workboard/fans/subscribers", label: "Подписчики", title: "Подписчики", section: "team", product: "workboard", roles: ["owner", "team_lead", "chatter"],
    why: "Кто подписан сейчас, у кого кончается, кто без автопродления.",
    pageFilter: "one", onePageWay: "picker", platforms: REPORTED,
    platformsNote: "Hub не собирает данные Telegram.",
    keywords: "подписки",
  },
  {
    id: "fans-followers", tabOf: "fans", path: "/workboard/fans/followers", label: "Фолловеры", title: "Фолловеры", section: "team", product: "workboard", roles: ["owner", "team_lead", "chatter"],
    why: "Кто фолловит страницу Fansly.",
    pageFilter: "one", onePageWay: "picker", platforms: FANSLY,
    platformsNote: "У страниц OnlyFans нет фолловеров.", platformsShort: "нет фолловеров",
    keywords: "фоллоу",
  },
  {
    id: "fans-gone", tabOf: "fans", path: "/workboard/fans/gone", label: "Ушли", title: "Ушли", section: "team", product: "workboard", roles: ["owner", "team_lead", "chatter"],
    why: "Кто удалил аккаунт или перестал быть виден.",
    pageFilter: "one", onePageWay: "picker", platforms: REPORTED,
    platformsNote: "Hub не собирает данные Telegram.",
    keywords: "удалённые фаны",
  },
  {
    id: "fans-by-spend", tabOf: "fans", path: "/workboard/fans/by-spend", label: "По сумме трат", title: "По сумме трат", section: "team", product: "workboard", roles: ["owner", "team_lead", "chatter"],
    why: "Списки фанов по сумме трат: имена для списков на площадке.",
    pageFilter: "one", onePageWay: "picker", platforms: REPORTED,
    platformsNote: "Hub не собирает данные Telegram.",
    period: { class: "own", options: SPENDER_PERIODS, default: "all" },
    keywords: "спендеры автосписки",
  },
  {
    id: "fans-by-spend-list", tabOf: "fans", path: "/workboard/fans/by-spend/:bucketKey", label: "Список по сумме трат", title: "Список по сумме трат", section: "team", product: "workboard", roles: ["owner", "team_lead", "chatter"],
    why: "Фаны одной корзины.",
    pageFilter: "one", onePageWay: "picker", platforms: REPORTED,
    platformsNote: "Hub не собирает данные Telegram.",
    period: { class: "own", options: SPENDER_PERIODS, default: "all" },
    deep: true, notSearched: true,
    crumbs: () => [...fansCrumbs(), { label: "По сумме трат", to: "/workboard/fans/by-spend" }],
  },
  {
    id: "fan", tabOf: "fans", path: "/workboard/fans/:pageLabel/:platform/:platformUserId", label: "Карточка фана", title: "Карточка фана", section: "team", product: "workboard", roles: ["owner", "team_lead", "chatter"],
    why: "Кто этот фан для этой страницы и на других страницах.",
    pageFilter: "none",
    period: { class: "shared", options: SPENDER_PERIODS },
    deep: true, notSearched: true,
    crumbs: (params) => fansCrumbs(params.pageLabel),
  },
  {
    id: "fan-any-page", tabOf: "fans", path: "/workboard/fans/:platform/:platformUserId", label: "Карточка фана", title: "Карточка фана", section: "team", product: "workboard", roles: ["owner", "team_lead", "chatter"],
    why: "Открывает страницу, на которой этот фан потратил больше всего.",
    pageFilter: "none",
    deep: true, notSearched: true,
    crumbs: () => fansCrumbs(),
  },

  {
    // Заказы кастомов (package I): the owner and the person who leads customs see every order, a team lead and a
    // chatter the orders of their pages (Hub decides).
    id: "customs", path: "/workboard/customs", label: "Кастомы", title: "Кастомы", section: "team", product: "workboard", roles: ["owner", "team_lead", "chatter"], icon: "Package",
    why: "Заказы кастомов: что заказано, оплачено, снято и отдано.",
    pageFilter: "any",
    keywords: "кастомы заказы кастомов съёмка видео фото ведущий кастомы отдать оплачен",
  },
  {
    // «Продажи» (it was «Что продаёт»; products plan §2.3): every role's, Hub cuts each read to the viewer's teams.
    id: "sales", path: "/workboard/sales", label: "Продажи", title: "Продажи", section: "team", product: "workboard", roles: ["owner", "team_lead", "chatter"], icon: "TrendingUp",
    why: "Что и по какой цене покупают, как быстро отвечают, чья каждая продажа.",
    pageFilter: "any",
    // «Возврат фанов» and «Приветствия и охват» left its tabs on 12.11 (0 opened in 14 days): their addresses still open.
    keywords: "что продаёт продажи цена скорость ответа ppv платные",
  },
  {
    // Every sale of the viewer's teams: whose it is and why, the report it is in; the amount opens the sale's chain.
    id: "sales-list", tabOf: "sales", path: "/workboard/sales/list", label: "Список продаж", title: "Список продаж", section: "team", product: "workboard", roles: ["owner", "team_lead", "chatter"],
    why: "Каждая продажа: чья она и почему, в каком отчёте.",
    pageFilter: "any",
    keywords: "список продаж чья продажа правило отчёт цепочка",
  },
  {
    // «Деньги» (products plan §2.3; it was «Выплаты» at /workboard/payouts, which leads here): the owner's «Долги» and
    // «Отчёты» — people's pay, the ledger's answer to no other session — and a person's own «Мои деньги», listed only
    // while their right «видит свои деньги» is on. The address opens the role's tab.
    id: "money", path: "/workboard/money", label: "Деньги", title: "Деньги", section: "team", product: "workboard", roles: ["owner", "team_lead", "chatter"], icon: "Banknote", when: "money",
    why: "Сколько начислено, к выплате и выплачено.",
    pageFilter: "any",
    keywords: "деньги выплаты долги начислено выплачено отчёты смен отчётность мои деньги",
  },
  {
    id: "money-debts", tabOf: "money", path: "/workboard/money/debts", label: "Долги", title: "Долги", section: "team", product: "workboard", ownerOnly: true,
    why: "Кому сколько агентство должно, за какие дни, расчёт выплаты человеку.",
    pageFilter: "any",
    keywords: "долги выплаты начислено выплачено расчёт выплаты",
  },
  {
    id: "money-reports", tabOf: "money", path: "/workboard/money/reports", label: "Отчёты", title: "Отчёты смен", section: "team", product: "workboard", ownerOnly: true,
    why: "Отчёты смен: что отправлено, что изменено, что не разобрано.",
    pageFilter: "any",
    keywords: "отчёты смен отчётность сумма изменена пост не разобран",
  },
  {
    id: "money-mine", tabOf: "money", path: "/workboard/money/mine", label: "Мои деньги", title: "Мои деньги", section: "team", product: "workboard", roles: ["team_lead", "chatter"],
    why: "Сколько вам начислено, к выплате и выплачено.",
    pageFilter: "any",
    keywords: "мои деньги начислено к выплате выплачено",
  },

  {
    // «Обучение» (products plan §2.3): the pages an agent publishes from /OS (a chatter's job description, the SOPs),
    // listed only while the viewer has one to read — the owner, a published one to approve; anyone else, an approved one.
    id: "learn", path: "/workboard/learn", label: "Обучение", title: "Обучение", section: "team", product: "workboard", roles: ["owner", "team_lead", "chatter"], icon: "BookOpen", when: "learn",
    why: "Инструкции и правила работы в чатах.",
    pageFilter: "any",
    keywords: "обучение инструкция правила соп ди чаттера как работать",
  },
  {
    id: "learn-page", tabOf: "learn", path: "/workboard/learn/:slug", label: "Страница обучения", title: "Обучение", section: "team", product: "workboard", roles: ["owner", "team_lead", "chatter"],
    why: "Одна страница обучения.",
    pageFilter: "any",
    deep: true, notSearched: true,
    crumbs: () => [{ label: "Обучение", to: "/workboard/learn" }],
  },

  // ── Анкеты ─────────────────────────────────────────────────────────
  // The questionnaires are Hub's: they stayed in the console when «Команда» became Workboard, at their old addresses.
  {
    id: "team-applications", path: "/team/applications", label: "Анкеты", title: "Анкеты моделей", section: "applications", product: "hub", ownerOnly: true,
    why: "Кто сейчас заполняет анкету модели на сайте, кто бросил, кто отправил.",
    pageFilter: "none",
    keywords: "анкета модели сайт найм заявки кандидатки",
  },
  {
    id: "team-application", path: "/team/applications/:ref", label: "Анкета", title: "Анкета модели", section: "applications", product: "hub", ownerOnly: true,
    why: "Ответы одной анкеты по разделам.",
    pageFilter: "none",
    deep: true, notSearched: true,
    crumbs: () => [{ label: "Анкеты", to: "/team/applications" }],
  },

  // ── Люди ───────────────────────────────────────────────────────────────
  // The people registry (products plan §2.2, §4.3): who a person is and what they may — the person, logins and
  // devices, access to pages, teams and rights, history; «Пригласить»; the agents' proposals. The work of each person
  // is Workboard «Команда» (the card links it). The old addresses of a person's access lead here.
  {
    id: "hub-people", path: "/people", label: "Люди", title: "Люди", section: "people", product: "hub", ownerOnly: true,
    why: "Кто есть в агентстве, с какими входами и правами; приглашение нового человека.",
    pageFilter: "none",
    keywords: "реестр сотрудники чаттеры тимлиды агенты доступ приглашение пригласить пользователи устройства логины входы права",
  },
  {
    id: "hub-person", path: "/people/:ref/:tab?", label: "Человек", title: "Человек", section: "people", product: "hub", ownerOnly: true,
    why: "Один человек: кто он, входы и устройства, страницы, команды и права, история.",
    pageFilter: "none",
    deep: true, notSearched: true,
    crumbs: () => [{ label: "Люди", to: "/people" }],
  },

  // ── Настройки ──────────────────────────────────────────────────────────
  {
    id: "settings-pages", path: "/settings/pages", label: "Модели и страницы", title: "Модели и страницы", section: "settings", product: "hub", ownerOnly: true,
    why: "Из чего состоит агентство: модели, их страницы и кто на них работает.",
    pageFilter: "none",
    keywords: "агентство модели страницы каталог добавить страницу отключить браузеры страниц",
  },
  {
    id: "settings-connect", path: "/settings/pages/connect", label: "Подключить страницу Fansly", title: "Подключить страницу Fansly", section: "settings", product: "hub", ownerOnly: true,
    why: "Прокси и черновик браузера новой страницы.",
    pageFilter: "none",
    deep: true,
    keywords: "новый браузер страницы подключение",
    crumbs: () => [{ label: "Настройки", to: "/settings/pages" }, { label: "Модели и страницы", to: "/settings/pages" }],
  },
  {
    id: "settings-connect-profile", path: "/settings/pages/connect/:profileId", label: "Подключить страницу Fansly", title: "Подключить страницу Fansly", section: "settings", product: "hub", ownerOnly: true,
    why: "Браузер на сервере, выходной IP, вход, создать страницу.",
    pageFilter: "none",
    deep: true, notSearched: true,
    crumbs: () => [{ label: "Настройки", to: "/settings/pages" }, { label: "Модели и страницы", to: "/settings/pages" }],
  },
  {
    // A page's own Fansly screens (they were tabs of the page's card, which left on 12.11): under its row here.
    id: "settings-page-account", path: "/settings/pages/:pageLabel/account", label: "Аккаунт на Fansly", title: "Аккаунт на Fansly", section: "settings", product: "hub", ownerOnly: true,
    why: "Как страница выглядит и как настроена на самом Fansly.",
    pageFilter: "none", platforms: FANSLY,
    platformsNote: "Этот экран есть только у страниц Fansly.",
    deep: true, notSearched: true,
    crumbs: (params) => pageCrumbs(params.pageLabel),
  },
  {
    id: "settings-page-login", path: "/settings/pages/:pageLabel/login", label: "Вход в Fansly", title: "Вход в Fansly", section: "settings", product: "hub", ownerOnly: true,
    why: "Браузер страницы входит в Fansly со своего устройства и IP.",
    pageFilter: "none", platforms: FANSLY,
    platformsNote: "Этот экран есть только у страниц Fansly.",
    deep: true, notSearched: true,
    crumbs: (params) => pageCrumbs(params.pageLabel),
  },
  {
    id: "settings-personas", path: "/settings/ai/personas", label: "Персоны", title: "Персоны ИИ", section: "settings", product: "hub", ownerOnly: true,
    why: "Образы для ответов ИИ: их пишет владелец, выбирают чаттеры.",
    pageFilter: "none",
    keywords: "ai персоны ии инструкция промпт образ первые сообщения hi",
  },
  {
    id: "settings-persona", path: "/settings/ai/personas/:key", label: "Персона", title: "Персона", section: "settings", product: "hub", ownerOnly: true,
    why: "Образ для ответов ИИ: его выбирают чаттеры.",
    pageFilter: "none",
    deep: true, notSearched: true,
    crumbs: () => [{ label: "Настройки", to: "/settings/pages" }, { label: "ИИ", to: "/settings/ai/personas" }, { label: "Персоны", to: "/settings/ai/personas" }],
  },
  {
    id: "settings-new-persona", path: "/settings/ai/new-persona", label: "Новая персона", title: "Новая персона", section: "settings", product: "hub", ownerOnly: true,
    why: "Новый образ для ответов ИИ.",
    pageFilter: "none",
    deep: true, notSearched: true,
    crumbs: () => [{ label: "Настройки", to: "/settings/pages" }, { label: "ИИ", to: "/settings/ai/personas" }, { label: "Персоны", to: "/settings/ai/personas" }],
  },
  {
    id: "settings-features", path: "/settings/ai/features", label: "Функции ИИ", title: "Функции ИИ", section: "settings", product: "hub", ownerOnly: true,
    why: "Что из ИИ включено и какая модель, усилие и окно у каждой функции.",
    pageFilter: "none",
    keywords: "возможности функции ai модель усилие effort окно голосовые досье факты",
  },
  {
    id: "settings-feature", path: "/settings/ai/features/:featureId", label: "Параметры функции", title: "Параметры функции", section: "settings", product: "hub", ownerOnly: true,
    why: "Все параметры одной функции и что будет, если её отключить.",
    pageFilter: "none",
    deep: true, notSearched: true,
    crumbs: () => [{ label: "Настройки", to: "/settings/pages" }, { label: "ИИ", to: "/settings/ai/personas" }, { label: "Функции ИИ", to: "/settings/ai/features" }],
  },
  {
    id: "settings-limits", path: "/settings/ai/limits", label: "Лимиты", title: "Лимиты ИИ на день", section: "settings", product: "hub", ownerOnly: true,
    why: "Сколько ИИ может стоить человеку за день по Москве.",
    pageFilter: "none",
    keywords: "ai лимиты личный лимит котёл общий запас",
  },
  {
    id: "settings-notifications", path: "/settings/notifications", label: "Оповещения", title: "Оповещения в Telegram", section: "settings", product: "hub", ownerOnly: true,
    why: "Куда и что присылает Hub в Telegram, и ежедневный отчёт о доходе.",
    pageFilter: "none",
    keywords: "уведомления telegram телеграм бот отчёт сбои оповещения",
  },

  // ── Система ────────────────────────────────────────────────────────────
  {
    id: "system-collection", path: "/system/collection", label: "Сбор данных", title: "Сбор данных", section: "system", product: "hub", ownerOnly: true,
    why: "Все страницы: собирается ли и что нажать.",
    pageFilter: "any",
    keywords: "синк синхронизация fansly onlyfans",
  },
  {
    id: "system-collection-page", path: "/system/collection/:pageLabel", label: "Сбор данных страницы", title: "Сбор данных страницы", section: "system", product: "hub", ownerOnly: true,
    why: "Что у этой страницы не собирается и как исправить.",
    pageFilter: "none",
    deep: true, notSearched: true,
    crumbs: () => [{ label: "Система", to: "/system/collection" }, { label: "Сбор данных", to: "/system/collection" }],
  },
  {
    id: "system-failures", path: "/system/failures", label: "Сбои", title: "Сбои", section: "system", product: "hub", ownerOnly: true,
    why: "Что сломалось, что делать и где чинить.",
    pageFilter: "any",
    keywords: "инциденты аномалии",
  },
  {
    id: "system-history-requests", path: "/system/history-requests", label: "Заявки на историю", title: "Заявки на историю", section: "system", product: "hub", ownerOnly: true,
    why: "Заявки агентов на старую переписку: что ждёт решения и что уже было.",
    pageFilter: "any",
    keywords: "дозагрузка истории",
  },
  {
    id: "system-agent-keys", path: "/system/agent-keys", label: "Агенты и ключи", title: "Агенты и ключи", section: "system", product: "hub", ownerOnly: true,
    why: "Ключи агентов и их права.",
    pageFilter: "none",
    keywords: "ключи агентов",
  },
  {
    id: "system-reports", path: "/system/reports", label: "Отчёты агентов", title: "Отчёты агентов", section: "system", product: "hub", ownerOnly: true,
    why: "Страницы, которые публикуют агенты: что есть и когда обновлялось.",
    pageFilter: "none",
    keywords: "отчёты агентов доски сводки страницы агентов трафик",
  },
  {
    id: "system-report", path: "/system/reports/:slug", label: "Отчёт агента", title: "Отчёт агента", section: "system", product: "hub", ownerOnly: true,
    why: "Страница, которую опубликовал агент.",
    pageFilter: "none",
    deep: true, notSearched: true,
    crumbs: () => [{ label: "Система", to: "/system/collection" }, { label: "Отчёты агентов", to: "/system/reports" }],
  },
  {
    id: "system-state", path: "/system/state", label: "Состояние", title: "Состояние", section: "system", product: "hub", ownerOnly: true,
    why: "Всё, что работает само: на сервере, на маке и на ПК, и копии. Проблемы наверху.",
    pageFilter: "none",
    keywords: "рутины копии бэкапы мак openclaw launchd задачи расписание здоровье",
  },
  {
    id: "system-people-messages", path: "/system/people-messages", label: "Сообщения людям", title: "Сообщения людям", section: "system", product: "hub", ownerOnly: true,
    why: "Что сервер сам написал бы людям в Telegram: каждый вид, его текст и что задержано. Включается по одному.",
    pageFilter: "none",
    keywords: "telegram телеграм бот отправка напоминания отчётность карточка выплата приглашение",
  },
  {
    // Six screens until 12.11 (five never opened in 14 days): one page of sections now, each at its anchor.
    // A team lead opens it too and gets «Медиа» and «Выгрузки» alone, as before.
    id: "system-onlyfans-api", path: "/system/onlyfans-api", label: "OnlyFans API", title: "OnlyFans API", section: "system", product: "hub",
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
    id: "system-dev", path: "/system/dev", label: "Разработчик", title: "Разработчик", section: "system", product: "hub", ownerOnly: true,
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
    id: "system-dev-run", path: "/system/dev/log/:runId", label: "Запуск сбора", title: "Запуск сбора", section: "system", product: "hub", ownerOnly: true,
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

/**
 * The name menu's own screen (at the foot of either app's menu, everyone's): «Аккаунт и устройства», a Workboard
 * screen that no section lists. With the menu above it is what a chatter can open from Workboard's frame
 * (tests/narrow-session-screens.test.ts walks both).
 */
export const NAME_MENU_ACCOUNT = { id: "account", path: "/workboard/account", label: "Аккаунт и устройства" } as const;

/** Without `roles`, a screen is the owner's and team leads' (`ownerOnly`: the owner's alone), never a chatter's. */
export function screenVisible(screen: Screen, role: Role): boolean {
  if (screen.roles) return screen.roles.includes(role);
  if (role === "chatter") return false;
  return !screen.ownerOnly || role === "owner";
}

/** The app that draws a screen: Hub's screens are the console's. */
export function appOf(screen: Pick<Screen, "product">): ScreenApp {
  return screen.product === "workboard" ? "workboard" : "console";
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
  /** The product whose menu lists it: Hub's sections are its menu; Workboard's one section holds its screens. */
  product: ScreenProduct;
  ownerOnly?: boolean;
  /** The menu item's number (one read in both products, place.ts). */
  count?: MenuCount;
  /** Under the rule at the bottom of the menu. */
  lower?: boolean;
  /**
   * The section's places elsewhere, after its tabs: another section of Hub, or a
   * list whose one place is a Workboard screen, linked from here (another product:
   * the team's name), for the roles that open it.
   */
  outside?:
    | { site: "workboard"; links: readonly { label: string; to: string; title: string; ownerOnly?: boolean }[] }
    | { site: "hub"; links: readonly { label: string; to: string; title: string }[] };
  nav: "tabs" | "side" | "none";
  tabs: readonly SectionTab[];
}

const tab = (id: string, label: string, ...screens: string[]): SectionTab => ({ id, label, screens });

/** Hub's menu is this table's order (Главная, Ждут вас, its sections, then Настройки and Система under the rule); then Workboard's section. */
export const SECTIONS: readonly Section[] = [
  {
    id: "home", label: "Главная", title: "Главная", icon: "House", product: "hub", nav: "none",
    tabs: [tab("home", "Главная", "home")],
  },
  {
    // What waits for the owner, right under Главная: the whole list, grouped by product.
    id: "waiting", label: "Ждут вас", title: "Ждут вас", icon: "Inbox", product: "hub", nav: "none", count: "waiting",
    tabs: [tab("waiting", "Ждут вас", "hub-waiting")],
  },
  {
    id: "money", label: "Деньги", title: "Деньги", icon: "Wallet", product: "hub", nav: "tabs",
    tabs: [
      tab("month", "Месяц", "money-month"),
      tab("costs", "Расходы", "costs-ai", "costs-anthropic", "costs-onlyfans-api"),
      tab("transactions", "Операции", "transactions"),
    ],
    // The shift reports' list has one place, Workboard → Деньги → Отчёты (L2, 12.11); Деньги links it.
    outside: { site: "workboard", links: [
      { label: "Отчёты смен", to: "/workboard/money/reports", title: "Отчёты смен в Workboard, Деньги", ownerOnly: true },
    ] },
  },

  {
    // The pages' Fansly statistics (it was «Статистика»; its screens and addresses are the same).
    id: "stats", label: "Страницы", title: "Страницы", icon: "ChartColumn", product: "hub", ownerOnly: true, nav: "tabs",
    tabs: [
      tab("stats", "Главное", "stats"),
      tab("income", "Доход Fansly", "stats-income"),
      tab("audience", "Аудитория", "stats-audience"),
    ],
    outside: { site: "hub", links: [{ label: "Модели и страницы", to: "/settings/pages", title: "Модели и страницы в Настройках" }] },
  },
  {
    id: "traffic", label: "Трафик", title: "Трафик", icon: "Megaphone", product: "hub", ownerOnly: true, nav: "tabs",
    tabs: [tab("sources", "Источники", "traffic-sources", "traffic-source", "traffic-link"), tab("summary", "Сводка", "traffic"), tab("promo", "Продвижение", "traffic-promo")],
  },
  {
    id: "applications", label: "Анкеты", title: "Анкеты моделей", icon: "ClipboardList", product: "hub", ownerOnly: true, nav: "none",
    tabs: [tab("applications", "Анкеты", "team-applications", "team-application")],
  },
  {
    // The people registry (products plan §2.2): the owner's; the team at work is Workboard «Команда».
    id: "people", label: "Люди", title: "Люди", icon: "Users", product: "hub", ownerOnly: true, nav: "none",
    tabs: [tab("people", "Люди", "hub-people", "hub-person")],
  },
  {
    id: "settings", label: "Настройки", title: "Настройки", icon: "Settings", product: "hub", ownerOnly: true, lower: true, nav: "side",
    tabs: [
      tab("pages", "Модели и страницы", "settings-pages", "settings-connect", "settings-connect-profile", "settings-page-account", "settings-page-login"),
      tab("ai", "ИИ", "settings-personas", "settings-persona", "settings-new-persona", "settings-features", "settings-feature", "settings-limits"),
      tab("notifications", "Оповещения", "settings-notifications"),
    ],
  },
  {
    id: "system", label: "Система", title: "Система", icon: "Wrench", product: "hub", ownerOnly: true, lower: true, nav: "side",
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
  {
    // Workboard's screens (the table's section «team»), each its own item of Workboard's menu (`productMenu`).
    id: "team", label: "Workboard", title: "Workboard", icon: "Users", product: "workboard", nav: "none",
    tabs: SCREENS.filter((screen) => screen.section === "team").map((screen) => tab(screen.id, screen.label, screen.id)),
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

/** Hub's sections this role has: the owner's alone (a team lead has no Hub, products plan §2.2). */
export function menuOf(role: Role): Section[] {
  if (role !== "owner") return [];
  return SECTIONS.filter((section) => section.product === "hub" && visibleSectionTabs(section, role).length > 0);
}

// ── A product's menu, item by item ────────────────────────────────────────

/** A row with a condition is listed only while the app says it holds. */
function listed(screen: Screen, holds: Partial<Record<MenuWhen, boolean>>): boolean {
  return screen.when === undefined || holds[screen.when] === true;
}

/** One item of a product's menu: a section of Hub, a screen of Workboard. */
export interface MenuItem {
  /** Hub: the section's id; Workboard: the screen's own id. */
  id: string;
  label: string;
  icon: MenuIcon;
  /** Where it leads for this role: an address of the product (a Workboard address is under /workboard/). */
  to: string;
  /** The app at that address: an item of another product is a page load, on that product's name. */
  app: ScreenApp;
  count?: MenuCount;
}

/**
 * A product's menu for a role, the items above the rule and under it, from the one table:
 * - Hub, the owner's alone: its sections (Главная · Ждут вас · Деньги · Фаны · Страницы · Контент · Трафик · Анкеты ·
 *   Люди, then Настройки · Система under the rule); a section without a screen the owner may open is not there.
 * - Workboard, every role's: its screens the role opens, in the table's order, with their own icons (one menu, products
 *   plan §2.3: Сегодня · Ждут вас · Смены · Команда · Фаны · Кастомы · …; «Начало» first while a newcomer's step is
 *   open, «Команда» while they lead a team).
 */
export function productMenu(product: ScreenProduct, role: Role, holds: Partial<Record<MenuWhen, boolean>> = {}): { upper: MenuItem[]; lower: MenuItem[] } {
  const upper: MenuItem[] = [];
  const lower: MenuItem[] = [];
  if (product === "workboard") {
    for (const screen of SCREENS) {
      if (screen.product !== "workboard" || screen.deep || screen.tabOf || !screenVisible(screen, role) || !listed(screen, holds)) continue;
      const section = sectionById(screen.section);
      upper.push({
        id: screen.id, label: screen.label, icon: screen.icon ?? section?.icon ?? "Inbox", to: screen.path, app: "workboard",
        ...(screen.count ? { count: screen.count } : {}),
      });
    }
    return { upper, lower };
  }
  for (const section of menuOf(role)) {
    const home = homeScreen(section, role);
    if (!home) continue;
    (section.lower ? lower : upper).push({
      id: section.id, label: section.label, icon: section.icon, to: home.path, app: appOf(home), ...(section.count ? { count: section.count } : {}),
    });
  }
  return { upper, lower };
}

/** The first two segments of a Workboard address (`/workboard/team/7` → `/workboard/team`): a screen and everything under it. */
function workboardBranch(pathname: string): string | null {
  const parts = decodedPath(pathname).split("/");
  return parts[1] === WORKBOARD_PATH.slice(1, -1) && parts[2] ? `/${parts[1]}/${parts[2]}` : null;
}

/**
 * The menu item an address lights: a Hub screen's section, a Workboard screen itself. A Workboard address lights the
 * screen it is under (a person's card lights «Команда», a review «Смены»); an address with no item lights nothing.
 */
export function menuItemAt(pathname: string): string | null {
  let screen = matchScreen(pathname)?.screen ?? null;
  if (!screen) {
    const branch = workboardBranch(pathname);
    screen = branch === null ? null : SCREENS.find((candidate) => candidate.product === "workboard" && workboardBranch(candidate.path) === branch) ?? null;
  }
  if (!screen) return null;
  if (screen.product === "workboard") return screen.tabOf ?? screen.id;
  return sectionById(screen.section)?.id ?? null;
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
    ["content-mass-messages", `/workboard/sales/mass?${query}`],
  ] as const) {
    const screen = screenById(id);
    if (!screenVisible(screen, role)) continue;
    if (screen.platforms && !(screen.platforms as readonly string[]).includes(page.platform)) continue;
    rows.push({ to, label: screen.label, screenId: id });
  }
  return rows;
}
