/**
 * The console's information architecture in one place: which screens form a
 * section, what each is called, and who sees it. The sidebar, the section
 * tabs, the side navigation of Settings and System and the breadcrumbs all
 * read these tables, so a screen is named the same everywhere.
 */
import { buildPageRoute, buildPageSectionRoute, type SettingsTab } from "./navigation.js";

export type Role = "owner" | "team_lead" | string;

export interface SectionLink {
  to: string;
  label: string;
  /** Owner-only screens are hidden from a team lead. */
  ownerOnly?: boolean;
  /** Extra path prefixes that mark this link current. */
  match?: readonly string[];
}

export interface TabbedSection {
  id: "onlyfans" | "costs" | "attention" | "publications" | "team";
  title: string;
  tabs: readonly SectionLink[];
}

export const TABBED_SECTIONS: Readonly<Record<TabbedSection["id"], TabbedSection>> = {
  onlyfans: {
    id: "onlyfans",
    title: "OnlyFans",
    tabs: [
      { to: "/ofapi-marketing", label: "Ссылки", ownerOnly: true },
      { to: "/ofapi-media", label: "Медиа" },
      { to: "/ofapi-exports", label: "Выгрузки" },
      { to: "/ofapi-actions", label: "Управление аккаунтом", ownerOnly: true },
    ],
  },
  costs: {
    id: "costs",
    title: "Расходы",
    tabs: [
      { to: "/ofapi-credits", label: "OnlyFans API", ownerOnly: true },
      { to: "/usage", label: "AI", ownerOnly: true },
      { to: "/ai-spend", label: "Траты на ИИ", ownerOnly: true },
    ],
  },
  // Wall posts through Hub (docs/plans/2026-10-23-wall-posts): the schedule of
  // every page and each page's publishing settings. Owner-only, like the routes.
  publications: {
    id: "publications",
    title: "Публикации",
    tabs: [
      { to: "/publications", label: "Расписание", ownerOnly: true },
      { to: "/publication-settings", label: "Страницы", ownerOnly: true },
    ],
  },
  // Chat Memory (docs/roadmap.md): the team's actual shifts from the chat
  // extension. The owner and team leads, like the route behind it (`session`).
  team: {
    id: "team",
    title: "Команда",
    tabs: [
      { to: "/team/shifts", label: "Смены" },
      { to: "/team/authors", label: "Авторы" },
      { to: "/team/numbers", label: "Числа" },
      { to: "/team/approaches", label: "Подходы" },
      { to: "/team/customs", label: "Кастомы" },
      { to: "/team/shift-reports", label: "Отчёты смен" },
      { to: "/team/sales", label: "Продажи" },
      { to: "/team/coverage", label: "Покрытие" },
    ],
  },
  attention: {
    id: "attention",
    title: "Требует внимания",
    tabs: [
      { to: "/held-sends", label: "Зависшие отправки" },
      { to: "/agent-hydration", label: "Дозагрузка истории", ownerOnly: true },
      { to: "/incidents", label: "Инциденты", ownerOnly: true },
    ],
  },
};

export function visibleTabs(section: TabbedSection, role: Role): SectionLink[] {
  return section.tabs.filter((tab) => !tab.ownerOnly || role === "owner");
}

/** Where the sidebar item of a tabbed section leads for this role. */
export function sectionHome(section: TabbedSection, role: Role): string | null {
  return visibleTabs(section, role)[0]?.to ?? null;
}

export function sectionOfPath(pathname: string): TabbedSection["id"] | null {
  for (const section of Object.values(TABBED_SECTIONS)) {
    if (section.tabs.some((tab) => pathname === tab.to || pathname.startsWith(`${tab.to}/`))) {
      return section.id;
    }
  }
  return null;
}

/** The views of one page, as its tabs show them. Followers are a Fansly
 *  notion; an OnlyFans page has subscribers only. The profile (0336) is read
 *  out of Fansly's `/account/me` and carries the earnings balance: the
 *  owner's, like the statistics. */
const PAGE_VIEWS: readonly { section: string | null; label: string; platforms?: readonly string[]; ownerOnly?: boolean }[] = [
  { section: null, label: "Обзор" },
  { section: "subscribers", label: "Подписчики" },
  { section: "followers", label: "Фолловеры", platforms: ["fansly"] },
  { section: "top-supporters", label: "Топ фанов" },
  { section: "deleted-fans", label: "Удалённые фаны" },
  { section: "profile", label: "Профиль", platforms: ["fansly"], ownerOnly: true },
];

export function pageViews(page: { label: string; platform: string }, role: Role): SectionLink[] {
  return PAGE_VIEWS
    .filter((view) => !view.platforms || view.platforms.includes(page.platform))
    .filter((view) => !view.ownerOnly || role === "owner")
    .map((view) => ({
      to: view.section ? buildPageSectionRoute(page.label, view.section) : buildPageRoute(page.label),
      label: view.label,
    }));
}

export interface SideNavGroup {
  id: string;
  label: string;
  links: readonly SectionLink[];
}

const settingsTab = (tab: SettingsTab) => `/settings?tab=${tab}`;

/** Owner settings: what the agency is made of and how it works. */
export const SETTINGS_GROUPS: readonly SideNavGroup[] = [
  {
    id: "agency",
    label: "Агентство",
    links: [
      { to: settingsTab("pages"), label: "Модели и страницы" },
      { to: settingsTab("users"), label: "Команда" },
      { to: settingsTab("personas"), label: "AI-персоны" },
    ],
  },
  {
    id: "work",
    label: "Работа",
    links: [
      { to: settingsTab("collection"), label: "Сбор OnlyFans" },
      { to: settingsTab("notifications"), label: "Уведомления" },
    ],
  },
];

/** Everything that is about the machine rather than the agency. */
export const SYSTEM_GROUPS: readonly SideNavGroup[] = [
  {
    id: "sync",
    label: "Сбор данных",
    links: [
      { to: settingsTab("engine"), label: "Fansly" },
      { to: settingsTab("sync"), label: "OnlyFans" },
      { to: settingsTab("ofapi"), label: "OnlyFans API" },
    ],
  },
  {
    id: "config",
    label: "Конфигурация",
    links: [
      { to: settingsTab("features"), label: "Возможности" },
      { to: settingsTab("configuration"), label: "Все параметры" },
      { to: settingsTab("agentKeys"), label: "Ключи агентов" },
    ],
  },
  {
    id: "watch",
    label: "Наблюдение",
    links: [
      { to: "/dev/incidents", label: "Аномалии синка" },
      { to: "/dev/log", label: "Журнал", match: ["/dev/sync-status"] },
      { to: "/dev/queue", label: "Очередь задач" },
      { to: "/dev/db-stats", label: "База данных" },
      { to: "/dev/client-health", label: "Расширение" },
    ],
  },
];

/** Settings tabs that render inside System rather than Settings. */
export const SYSTEM_SETTINGS_TABS: ReadonlySet<SettingsTab> = new Set<SettingsTab>([
  "engine",
  "sync",
  "ofapi",
  "features",
  "configuration",
  "agentKeys",
]);

export const SYSTEM_HOME = settingsTab("engine");

export function isSystemPath(pathname: string, search: string): boolean {
  if (pathname.startsWith("/dev/")) return true;
  if (pathname !== "/settings") return false;
  const tab = new URLSearchParams(search).get("tab");
  return tab !== null && SYSTEM_SETTINGS_TABS.has(tab as SettingsTab);
}

/** The link of a side-nav group list that the current location is on. */
export function currentSideLink(
  groups: readonly SideNavGroup[],
  pathname: string,
  search: string,
): SectionLink | null {
  const params = new URLSearchParams(search);
  for (const group of groups) {
    for (const link of group.links) {
      const [path, query] = link.to.split("?");
      if (link.match?.some((prefix) => pathname.startsWith(prefix))) return link;
      if (path !== pathname) continue;
      if (!query) return link;
      const want = new URLSearchParams(query);
      if ([...want.entries()].every(([key, value]) => params.get(key) === value)) return link;
    }
  }
  return null;
}
