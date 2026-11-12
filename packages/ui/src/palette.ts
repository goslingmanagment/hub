/**
 * What the search (Ctrl/⌘K) of the owner's place takes you to, and how a typed
 * query picks from it — the same in the console and in Workboard. The screens'
 * entries come from the one table of screens (screens.ts), so a screen is found
 * by the name it carries everywhere else, by the old words a habit remembers,
 * and a team lead finds only what they can open; a screen of the other app is a
 * page load. An app adds what only it can find (the console: pages, fans,
 * settings). The search only navigates and changes the theme: it writes nothing.
 */
import {
  SCREENS,
  SECTIONS,
  screenParts,
  screenVisible,
  tabOfScreen,
  tabRow,
  visibleSectionTabs,
  type Role,
  type Screen,
  type Section,
} from "./screens.js";
import { THEME_OPTIONS, type ThemePreference } from "./theme.js";

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

/** An entry either opens an address of the host or switches the theme. */
export type Command<State = unknown> = CommandBase & (
  | { to: string; state?: State | undefined; theme?: undefined }
  | { theme: ThemePreference; to?: undefined; state?: undefined }
);

const THEME_WORDS: Record<ThemePreference, string> = { system: "системная авто", light: "дневная light", dark: "ночная dark" };

function sectionGroup(section: Section): CommandGroup {
  return section.id === "settings" ? "Настройки" : section.id === "system" ? "Система" : "Разделы";
}

/** Where a screen sits, in the menu's words. The name of a tab says it itself. */
function screenHint(section: Section, screen: Screen): string {
  const tab = tabOfScreen(section, screen.id);
  if (section.id === "home" || section.id === "waiting" || section.id === "publications") return "";
  return tab && tab.label !== screen.label ? `${section.label} · ${tab.label}` : section.label;
}

/** Every screen of both apps this role opens, by its name, its section and its old words. */
export function screenCommands(role: Role): Command<never>[] {
  const commands: Command<never>[] = [];
  for (const section of SECTIONS) {
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
      // A screen of sections: each is found by its own name and old words, and opens at its anchor.
      for (const part of screenParts(screen, role)) {
        commands.push({
          id: `part:${screen.id}:${part.id}`,
          label: part.label,
          group,
          to: `${screen.path}#${part.id}`,
          hint: `${section.label} · ${screen.label}`,
          keywords: `${screen.label} ${screen.keywords ?? ""} ${part.keywords ?? ""}`,
          searchOnly: true,
        });
      }
    }
  }
  return commands;
}

/** The three themes, found by typing. */
export function themeCommands(): Command<never>[] {
  return THEME_OPTIONS.map((option) => ({
    id: `theme:${option.value}`,
    label: `Тема: ${option.label.toLowerCase()}`,
    group: "Оформление" as const,
    theme: option.value,
    keywords: `оформление ${THEME_WORDS[option.value]}`,
    searchOnly: true,
  }));
}

// A query typed with the wrong keyboard layout ("jfnab" for «обзор») still
// finds its entry: the screens are Russian, the URLs and page names Latin.
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

function score(command: CommandBase, tokens: readonly string[], match: Match): number | null {
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

function rank<T extends CommandBase>(commands: readonly T[], query: string, match: Match): T[] | null {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  const scored = commands
    .map((command, order) => ({ command, order, score: score(command, tokens, match) }))
    .filter((entry): entry is { command: T; order: number; score: number } => entry.score !== null);
  if (scored.length === 0) return null;
  // Stable within a score: the order of the tables is the order of the menu.
  return scored.sort((a, b) => a.score - b.score || a.order - b.order).map((entry) => entry.command);
}

/** The entries a query finds, best first; the short default list when empty.
 *  Words are matched from their start ("тема" is not inside «Система»); only
 *  when that finds nothing does a fragment anywhere count. */
export function searchCommands<T extends CommandBase>(commands: readonly T[], query: string): T[] {
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

/** Results under their group headings, in the menu's order. */
export function groupCommands<T extends CommandBase>(commands: readonly T[]): { group: CommandGroup; items: T[] }[] {
  const groups = new Map<CommandGroup, T[]>();
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
