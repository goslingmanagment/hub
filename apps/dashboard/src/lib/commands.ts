/**
 * What the console's search (Ctrl/⌘K) can take you to besides the screens of
 * the owner's place (packages/ui/src/palette.ts, the same in Workboard): the
 * pages and their views, the settings by their Russian names, the fans the
 * server finds. The search only navigates and changes the theme: it writes nothing.
 */
import { screenCommands, themeCommands, type Command as PlaceCommand } from "@agency_hub_core/ui/palette";
import { pageCardTabs, type Role } from "@agency_hub_core/ui/screens";
import { configHomeHref } from "@/pages/settings/featureCatalog";
import { buildFanProfileNavigation, buildFansRoute, buildPageCollectionRoute, buildPageRoute, buildPageSectionRoute, type FanProfileNavigationState } from "./navigation.js";
import { platformName } from "./platformUrls.js";

export { groupCommands, searchCommands, type CommandGroup } from "@agency_hub_core/ui/palette";

/** An entry either opens a screen (a fan's card with its way back) or switches the theme. */
export type Command = PlaceCommand<FanProfileNavigationState>;

export interface CommandPage {
  label: string;
  platform: string;
  modelName: string;
  username?: string | null | undefined;
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
  const commands: Command[] = [...screenCommands(role), ...pageCommands(pages, role)];
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
  return [...commands, ...themeCommands()];
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
