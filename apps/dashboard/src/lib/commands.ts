/**
 * What the command palette (Ctrl/⌘K) can take you to, and how a typed query
 * picks from it. The entries come from the same tables as the sidebar, the
 * section tabs and the side navigation, so a screen is found by the name it
 * carries everywhere else and a team lead finds only what they can open.
 */
import { buildAnalyticsRoute } from "./navigation.js";
import {
  SETTINGS_GROUPS,
  SYSTEM_GROUPS,
  TABBED_SECTIONS,
  pageViews,
  visibleTabs,
  type Role,
} from "./sections.js";

export type CommandGroup = "Разделы" | "Страницы" | "Настройки" | "Система";

export interface Command {
  id: string;
  label: string;
  group: CommandGroup;
  to: string;
  /** Shown after the label: where the entry sits. */
  hint?: string | undefined;
  /** Words the entry is also found by. */
  keywords?: string | undefined;
  /** Kept out of the list until something is typed, so the empty palette
   *  stays short: every page's every view is there, but only on demand. */
  searchOnly?: boolean | undefined;
}

export interface CommandPage {
  label: string;
  platform: string;
  modelName: string;
  username?: string | null | undefined;
}

const PLATFORM_NAMES: Record<string, string> = { fansly: "Fansly", onlyfans: "OnlyFans" };

export function buildCommands({ role, pages }: { role: Role; pages: readonly CommandPage[] }): Command[] {
  const owner = role === "owner";
  const commands: Command[] = [{ id: "overview", label: "Обзор", group: "Разделы", to: "/", keywords: "доход выручка главная" }];
  if (owner) commands.push({ id: "analytics", label: "Аналитика", group: "Разделы", to: buildAnalyticsRoute(null), keywords: "fansly статистика" });

  for (const section of [TABBED_SECTIONS.onlyfans, TABBED_SECTIONS.attention, TABBED_SECTIONS.costs]) {
    for (const tab of visibleTabs(section, role)) {
      commands.push({ id: `section:${tab.to}`, label: tab.label, group: "Разделы", to: tab.to, hint: section.title, keywords: section.title });
    }
  }

  for (const page of pages) {
    const platform = PLATFORM_NAMES[page.platform] ?? page.platform;
    const words = [page.modelName, platform, page.username ?? ""].join(" ");
    for (const [index, view] of pageViews(page).entries()) {
      commands.push(index === 0
        ? { id: `page:${page.label}`, label: page.label, group: "Страницы", to: view.to, hint: `${page.modelName} · ${platform}`, keywords: words }
        : { id: `page:${page.label}:${view.to}`, label: `${page.label} — ${view.label}`, group: "Страницы", to: view.to, hint: `${page.modelName} · ${platform}`, keywords: words, searchOnly: true });
    }
  }

  if (owner) {
    for (const [group, groups] of [["Настройки", SETTINGS_GROUPS], ["Система", SYSTEM_GROUPS]] as const) {
      for (const sideGroup of groups) {
        for (const link of sideGroup.links) {
          commands.push({ id: `${group}:${link.to}`, label: link.label, group, to: link.to, hint: `${group} · ${sideGroup.label}`, keywords: `${group} ${sideGroup.label}` });
        }
      }
    }
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

function score(command: Command, tokens: readonly string[]): number | null {
  const label = normalize(command.label);
  const haystack = normalize(`${command.label} ${command.hint ?? ""} ${command.keywords ?? ""}`);
  if (!tokens.every((token) => haystack.includes(token))) return null;
  const query = tokens.join(" ");
  if (label === query) return 0;
  if (label.startsWith(query)) return 1;
  if (tokens.every((token) => label.includes(token))) return 2;
  return 3;
}

function rank(commands: readonly Command[], query: string): Command[] | null {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  const scored = commands
    .map((command, order) => ({ command, order, score: score(command, tokens) }))
    .filter((entry): entry is { command: Command; order: number; score: number } => entry.score !== null);
  if (scored.length === 0) return null;
  // Stable within a score: the order of the tables is the order of the console.
  return scored.sort((a, b) => a.score - b.score || a.order - b.order).map((entry) => entry.command);
}

/** The entries a query finds, best first; the short default list when empty. */
export function searchCommands(commands: readonly Command[], query: string): Command[] {
  if (!normalize(query)) return commands.filter((command) => !command.searchOnly);
  const lower = query.toLowerCase();
  return rank(commands, query)
    ?? rank(commands, swapLayout(lower, toRu))
    ?? rank(commands, swapLayout(lower, toEn))
    ?? [];
}

/** Results under their group headings, a group placed by its best entry. */
export function groupCommands(commands: readonly Command[]): { group: CommandGroup; items: Command[] }[] {
  const groups = new Map<CommandGroup, Command[]>();
  for (const command of commands) {
    const items = groups.get(command.group);
    if (items) items.push(command);
    else groups.set(command.group, [command]);
  }
  return [...groups].map(([group, items]) => ({ group, items }));
}
