/**
 * What the search (Ctrl/⌘K) can take you to, and how a typed query picks from
 * it. The entries come from the one table of screens, so a screen is found by
 * the name it carries everywhere else, by the old words a habit remembers, and a
 * team lead finds only what they can open. The search only navigates and changes
 * the theme: it writes nothing.
 */
import { configHomeHref } from "@/pages/settings/featureCatalog";
import { buildFanProfileNavigation, buildFansRoute, buildPageCollectionRoute, buildPageRoute, buildPageSectionRoute, type FanProfileNavigationState } from "./navigation.js";
import { THEME_OPTIONS, type ThemePreference } from "./theme.js";
import {
  SCREENS,
  SECTIONS,
  pageCardTabs,
  screenVisible,
  tabOfScreen,
  tabRow,
  visibleSectionTabs,
  type Role,
  type Screen,
  type Section,
} from "./sections.js";
import { platformName } from "./platformUrls.js";

export type CommandGroup = "Разделы" | "Страницы" | "Фаны" | "Настройки" | "Система" | "Параметры" | "Оформление";

const GROUP_ORDER: readonly CommandGroup[] = ["Разделы", "Страницы", "Фаны", "Настройки", "Система", "Параметры", "Оформление"];

interface CommandBase {
  id: string;
  label: string;
  group: CommandGroup;
  /** Shown after the label: where the entry sits. */
  hint?: string | undefined;
  /** Words the entry is also found by. */
  keywords?: string | undefined;
  /** Kept out of the list until something is typed, so the empty palette
   *  stays short: every page's every view is there, but only on demand. */
  searchOnly?: boolean | undefined;
}

/** An entry either opens a screen or switches the theme. */
export type Command = CommandBase & (
  | { to: string; state?: FanProfileNavigationState | undefined; theme?: undefined }
  | { theme: ThemePreference; to?: undefined; state?: undefined }
);

export interface CommandPage {
  label: string;
  platform: string;
  modelName: string;
  username?: string | null | undefined;
}

const THEME_WORDS: Record<ThemePreference, string> = { system: "системная авто", light: "дневная light", dark: "ночная dark" };

function sectionGroup(section: Section): CommandGroup {
  return section.id === "settings" ? "Настройки" : section.id === "system" ? "Система" : "Разделы";
}

/** Where a screen sits, in the menu's words. The name of a tab says it itself. */
function screenHint(section: Section, screen: Screen): string {
  const tab = tabOfScreen(section, screen.id);
  if (section.id === "home" || section.id === "publications") return "";
  return tab && tab.label !== screen.label ? `${section.label} · ${tab.label}` : section.label;
}

function sectionCommands(role: Role): Command[] {
  const commands: Command[] = [];
  for (const section of SECTIONS) {
    if (section.id === "page") continue;
    const visibleTabs = visibleSectionTabs(section, role);
    const firstOfTab = new Set(visibleTabs.map((item) => tabRow(item, role)[0]?.id));
    const group = sectionGroup(section);
    for (const screen of SCREENS) {
      if (screen.section !== section.id || screen.notSearched || !screenVisible(screen, role)) continue;
      commands.push({
        id: `screen:${screen.id}`,
        label: screen.label,
        group,
        to: screen.path,
        hint: screenHint(section, screen),
        keywords: `${section.label} ${screen.title} ${screen.keywords ?? ""}`,
        // The empty list: the menu and the tabs of its first level. Settings and
        // System are short, and are always listed in full.
        searchOnly: screen.deep === true || (group === "Разделы" && !firstOfTab.has(screen.id)),
      });
    }
  }
  return commands;
}

function pageCommands(pages: readonly CommandPage[], role: Role): Command[] {
  const owner = role === "owner";
  const commands: Command[] = [];
  for (const page of pages) {
    const platform = platformName(page.platform);
    const words = [page.modelName, platform, page.username ?? ""].join(" ");
    const hint = `${page.modelName} · ${platform}`;
    commands.push({ id: `page:${page.label}`, label: page.label, group: "Страницы", to: buildPageRoute(page.label), hint, keywords: words });
    const isFansly = page.platform === "fansly";
    const hasData = page.platform !== "telegram";
    const views: { label: string; to: string; keywords?: string }[] = [
      ...(hasData ? [
        { label: "Фаны", to: buildFansRoute("paying", page.label), keywords: "платящие топ фанов" },
        { label: "Подписчики", to: buildFansRoute("subscribers", page.label) },
        ...(isFansly ? [{ label: "Фолловеры", to: buildFansRoute("followers", page.label) }] : []),
        { label: "Операции", to: `/money/transactions?page=${encodeURIComponent(page.label)}` },
      ] : []),
      ...(owner && isFansly ? [{ label: "Статистика", to: `/stats?page=${encodeURIComponent(page.label)}`, keywords: "аналитика" }] : []),
      ...(owner && hasData ? [
        { label: "Публикации", to: `/publications?page=${encodeURIComponent(page.label)}` },
        { label: "Сбор данных", to: buildPageCollectionRoute(page.label), keywords: "синк" },
      ] : []),
      ...(owner && isFansly ? [{ label: "Войти в Fansly", to: buildPageSectionRoute(page.label, "browser-login"), keywords: "вход в браузер" }] : []),
      ...pageCardTabs(page, role).slice(1).map((tab) => ({ label: tab.label, to: tab.to })),
    ];
    for (const view of views) {
      commands.push({
        id: `page:${page.label}:${view.to}`,
        label: `${page.label} — ${view.label}`,
        group: "Страницы",
        to: view.to,
        hint,
        keywords: `${words} ${view.keywords ?? ""}`,
        searchOnly: true,
      });
    }
  }
  return commands;
}

/** A setting by its Russian name, leading to the screen it is worked with
 *  (design/ia.md §6). Secrets are not searched. */
export interface CommandSetting {
  key: string;
  title: string;
  subsystem: string;
}

export function buildCommands({ role, pages, settings = [] }: {
  role: Role;
  pages: readonly CommandPage[];
  settings?: readonly CommandSetting[];
}): Command[] {
  const commands = [...sectionCommands(role), ...pageCommands(pages, role)];
  for (const setting of settings) {
    const home = configHomeHref(setting.key);
    commands.push({
      id: `setting:${setting.key}`,
      label: setting.title,
      group: "Параметры",
      to: home.to,
      hint: home.hint,
      keywords: setting.subsystem,
      searchOnly: true,
    });
  }
  for (const option of THEME_OPTIONS) {
    commands.push({ id: `theme:${option.value}`, label: `Тема: ${option.label.toLowerCase()}`, group: "Оформление", theme: option.value, keywords: `оформление ${THEME_WORDS[option.value]}`, searchOnly: true });
  }
  return commands;
}

export interface CommandFan {
  fan: { platform: string; platformUserId: string; username: string | null; displayName: string | null };
  pages: readonly { pageLabel: string }[];
}

/** Fans the server found: each opens on the first of its pages. */
export function fanCommands(fans: readonly CommandFan[], backTo: string): Command[] {
  const commands: Command[] = [];
  for (const { fan, pages } of fans) {
    const [first, ...rest] = pages;
    if (!first) continue;
    const name = fan.displayName ?? fan.username ?? fan.platformUserId;
    const navigation = buildFanProfileNavigation(first.pageLabel, fan.platform, fan.platformUserId, backTo, name);
    commands.push({
      id: `fan:${fan.platform}:${fan.platformUserId}`,
      label: name,
      group: "Фаны",
      to: navigation.to,
      state: navigation.state,
      hint: [first.pageLabel, ...rest.map((page) => page.pageLabel)].join(", "),
    });
  }
  return commands;
}

// A query typed with the wrong keyboard layout ("jfnab" for «обзор») still
// finds its entry: the console is Russian, the URLs and page names Latin.
const EN = "`qwertyuiop[]asdfghjkl;'zxcvbnm,.";
const RU = "ёйцукенгшщзхъфывапролджэячсмитьбю";
const toRu = new Map([...EN].map((char, index) => [char, RU[index]!]));
const toEn = new Map([...RU].map((char, index) => [char, EN[index]!]));

function normalize(text: string): string {
  return text.toLowerCase().replaceAll("ё", "е").trim();
}

function swapLayout(text: string, map: ReadonlyMap<string, string>): string {
  return [...text].map((char) => map.get(char) ?? char).join("");
}

type Match = "word" | "anywhere";

function words(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function score(command: Command, tokens: readonly string[], match: Match): number | null {
  const label = normalize(command.label);
  const haystack = normalize(`${command.label} ${command.hint ?? ""} ${command.keywords ?? ""}`);
  const found = match === "word"
    ? (token: string) => words(haystack).some((word) => word.startsWith(token))
    : (token: string) => haystack.includes(token);
  if (!tokens.every((token) => words(token).every(found))) return null;
  const query = tokens.join(" ");
  if (label === query) return 0;
  if (label.startsWith(query)) return 1;
  if (tokens.every((token) => label.includes(token))) return 2;
  return 3;
}

function rank(commands: readonly Command[], query: string, match: Match): Command[] | null {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  const scored = commands
    .map((command, order) => ({ command, order, score: score(command, tokens, match) }))
    .filter((entry): entry is { command: Command; order: number; score: number } => entry.score !== null);
  if (scored.length === 0) return null;
  // Stable within a score: the order of the tables is the order of the console.
  return scored.sort((a, b) => a.score - b.score || a.order - b.order).map((entry) => entry.command);
}

/** The entries a query finds, best first; the short default list when empty.
 *  Words are matched from their start ("тема" is not inside «Система»); only
 *  when that finds nothing does a fragment anywhere count. */
export function searchCommands(commands: readonly Command[], query: string): Command[] {
  if (!normalize(query)) return commands.filter((command) => !command.searchOnly);
  const lower = query.toLowerCase();
  const spellings = [lower, swapLayout(lower, toRu), swapLayout(lower, toEn)];
  for (const match of ["word", "anywhere"] as const) {
    for (const spelling of spellings) {
      const found = rank(commands, spelling, match);
      if (found) return found;
    }
  }
  return [];
}

/** Results under their group headings, in the console's order. */
export function groupCommands(commands: readonly Command[]): { group: CommandGroup; items: Command[] }[] {
  const groups = new Map<CommandGroup, Command[]>();
  for (const command of commands) {
    const items = groups.get(command.group);
    if (items) items.push(command);
    else groups.set(command.group, [command]);
  }
  return GROUP_ORDER.flatMap((group) => {
    const items = groups.get(group);
    return items ? [{ group, items }] : [];
  });
}
