/**
 * Old addresses lead to new ones (products plan §2.3, §7.3): ONE table of every address people and programs open
 * today that lands somewhere else now — the released extension 3.29.1, the agents' skills, the owner's bookmarks, the
 * links Hub's server wrote into matters and messages — and Workboard's own rule for its old paths. A moved address
 * gets a row and a redirect, never a second screen. `tests/old-addresses.test.ts` walks every row through the layers
 * that answer it: Hub's server (a Workboard address on the console's name goes to the team's name through the
 * one-time hand-off, `signin-handoff.ts workboardOnConsoleRedirect`), the console (`/team/*`,
 * `apps/dashboard/src/lib/workboard.ts`), and Workboard's router (`workboardOldAddress` below). The browser keeps an
 * address's `#…` across a server's redirects.
 */

/** An address inside Workboard's router: its path without Workboard's base (`/my/shifts/12`), its query and its anchor. */
export interface RouterAddress {
  pathname: string;
  search: string;
  hash: string;
}

/**
 * Where an old path of Workboard leads now, with what it carried; null when the path is not an old one. Applied by the
 * router (apps/workboard/src/app/routes.tsx `OldAddress`), whoever opens it — a screen checks the role itself.
 */
export function workboardOldAddress(at: RouterAddress): RouterAddress | null {
  const path = at.pathname.replace(/\/+$/, "") || "/";
  // «Ждут вас» was «Решения» (matters written before the rename, bookmarks, agents' links).
  if (path === "/decisions") return { ...at, pathname: "/waiting" };
  // The old screen «Смена» is the «Отчёт» board: a chatter's address (the extension, Telegram reminders) and the team's.
  const shift = /^\/(?:my\/shifts|shifts\/report)\/([^/]+)$/.exec(path);
  if (shift) return { ...at, pathname: `/report/${shift[1]}` };
  // «Мои смены» is «Смены → Мои» (products package W; the released extension opens it), and so is the first chatter
  // screen, «Мои отчёты»: a shift and its report are one row there; `?days=`, `?week=`, `?report=` carry over.
  if (path === "/my/shifts") return { ...at, pathname: "/shifts/mine" };
  if (path === "/my/reports") return { pathname: "/shifts/mine", search: at.search, hash: "" };
  // «Выплаты» is «Деньги» (products plan §2.3): its two views are the tabs «Долги» and «Отчёты»; the rest it carried
  // (the period, `person`, `questions`) stays.
  if (path === "/payouts") {
    const search = new URLSearchParams(at.search);
    const reports = search.get("view") === "reports";
    search.delete("view");
    const query = search.toString();
    return { pathname: reports ? "/money/reports" : "/money/debts", search: query ? `?${query}` : "", hash: at.hash };
  }
  // «Что продаёт» opens its first tab.
  if (path === "/sales") return { pathname: "/sales/price", search: at.search, hash: "" };
  // «Люди» is «Команда» (products plan §4.3): the team at work. A person's old «Смены» and «Работа» are Работа, the
  // other work tabs keep their names; «Доступ и входы» (`access`) is the registry's, Hub's — `registryTabLanding` below.
  if (path === "/people") return { ...at, pathname: "/team" };
  const person = /^\/people\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (person) {
    const tab = person[2] === "sales" || person[2] === "schedule" || person[2] === "access" ? person[2] : undefined;
    return { ...at, pathname: `/team/${person[1]}${tab ? `/${tab}` : ""}` };
  }
  // «Доступ» was inside «Люди»: `?person=<login>` is that login's person on «Доступ и входы» (Hub's now).
  if (path === "/access") {
    const search = new URLSearchParams(at.search);
    const login = search.get("person");
    search.delete("person");
    const query = search.toString();
    return { pathname: login && /^\d+$/.test(login) ? `/team/${login}/access` : "/team", search: query ? `?${query}` : "", hash: "" };
  }
  return null;
}

/**
 * A tab of a person's card that was Workboard's and is the registry's now (`/team/:ref/access`, «Доступ и входы», where
 * every old address of a person's access lands): the owner opens the person's logins in Hub «Люди» (a Hub path, through
 * the sign-in hand-off), anyone else — a team lead with an old link — the person's «Команда» card. Null for any other
 * address. Applied by Workboard's card of a person (apps/workboard/src/screens/team/PersonRoute.tsx).
 */
export function registryTabLanding(at: RouterAddress, owner: boolean): { hub: string } | { workboard: RouterAddress } | null {
  const path = at.pathname.replace(/\/+$/, "");
  const tab = /^\/team\/([^/]+)\/access$/.exec(path);
  if (!tab) return null;
  return owner ? { hub: `/people/${tab[1]}/logins` } : { workboard: { pathname: `/team/${tab[1]}`, search: at.search, hash: "" } };
}

/**
 * «Публикации» and «Статистика контента» are ContentOps' screens (products plan §2.4, package C2): Hub's old addresses
 * of them (`/content/publications…`, `/stats/content…`, and the older ones the console leads there) land in ContentOps
 * with everything they carried. ContentOps' `/hub/<screen>` finds the model of the page named in `?page=` (else the
 * person's own) and opens its screen there, framing Hub's bare page with the same query. Null for any other address.
 * Applied by the console's router (apps/dashboard/src/App.tsx), whoever opens it: ContentOps checks the sign-in. The
 * bare pages themselves stay on Hub's name (`/frame/publications`): they open when ContentOps does not.
 */
export function contentScreenOldAddress(pathAndQuery: string, contentops: string = CONTENTOPS): string | null {
  const [path = "", query = ""] = pathAndQuery.split("?", 2);
  const clean = path.replace(/\/+$/, "");
  const screen = clean === "/content/publications" ? "publications" : clean === "/stats/content" ? "stats" : null;
  if (screen === null) return null;
  return `${contentops}/hub/${screen}${query ? `?${query}` : ""}`;
}

/** Workboard's router paths of its old addresses (routes.tsx registers `OldAddress` on each). */
export const WORKBOARD_OLD_PATHS: readonly string[] = [
  "decisions", "my/shifts", "my/shifts/:shiftId", "shifts/report/:shiftId", "my/reports", "sales", "people", "people/:ref", "people/:ref/:tab", "access", "payouts",
];

/** One address opened today and where it lands: both absolute, as a browser shows them. */
export interface OldAddressRow {
  from: string;
  to: string;
  /** Who opens it. */
  who: string;
}

const HUB = "https://hub.gosling-agency.ru";
const TEAM = "https://chatgoose.gosling-agency.ru";
const CONTENTOPS = "https://contentops.gosling-agency.ru";

/** Every address opened today that must keep working, and where it lands now (an address of a person's access: the owner's landing). */
export const OLD_ADDRESSES: readonly OldAddressRow[] = [
  // The released extension 3.29.1: «Мои смены» by its one-time link, Workboard's plain address, the shift to hand in.
  { who: "extension 3.29.1", from: `${TEAM}/workboard/my/shifts`, to: `${TEAM}/workboard/shifts/mine` },
  { who: "extension 3.29.1", from: `${TEAM}/workboard/`, to: `${TEAM}/workboard/` },
  { who: "extension 3.29.1, matter", from: `${TEAM}/workboard/my/shifts/812`, to: `${TEAM}/workboard/report/812` },
  { who: "extension, matter", from: `${TEAM}/workboard/report/812`, to: `${TEAM}/workboard/report/812` },
  // The agents' skills.
  { who: "agents' skills", from: `${TEAM}/workboard/customs`, to: `${TEAM}/workboard/customs` },
  { who: "agents' skills", from: `${HUB}/workboard/customs`, to: `${TEAM}/workboard/customs` },
  { who: "agents' skills", from: `${HUB}/team/applications/2`, to: `${HUB}/team/applications/2` },
  // The owner's bookmarks on the console's name: the same screen on the team's name, signed in.
  { who: "owner's bookmark", from: `${HUB}/workboard/shifts?days=30`, to: `${TEAM}/workboard/shifts?days=30` },
  { who: "owner's bookmark", from: `${HUB}/workboard/people`, to: `${TEAM}/workboard/team` },
  { who: "owner's bookmark", from: `${HUB}/workboard/people/alex/schedule?days=7`, to: `${TEAM}/workboard/team/alex/schedule?days=7` },
  { who: "owner's bookmark", from: `${HUB}/workboard/people/7/access`, to: `${HUB}/people/7/logins` },
  { who: "owner's bookmark", from: `${HUB}/workboard/payouts?view=reports`, to: `${TEAM}/workboard/money/reports` },
  { who: "owner's bookmark", from: `${TEAM}/workboard/payouts?week=2026-11-02`, to: `${TEAM}/workboard/money/debts?week=2026-11-02` },
  { who: "matter, before «Деньги»", from: `${TEAM}/workboard/payouts?person=kate-v`, to: `${TEAM}/workboard/money/debts?person=kate-v` },
  // «Решения» on the console's name is the owner's whole «Ждут вас» in Hub (a window's parameter: Workboard's).
  { who: "owner's bookmark", from: `${HUB}/workboard/decisions`, to: `${HUB}/waiting` },
  { who: "owner's bookmark", from: `${HUB}/workboard/decisions#held`, to: `${HUB}/waiting#held` },
  { who: "owner's bookmark", from: `${HUB}/workboard/decisions?send=a1#held`, to: `${TEAM}/workboard/waiting?send=a1#held` },
  { who: "owner's bookmark", from: `${HUB}/workboard/my/shifts`, to: `${TEAM}/workboard/shifts/mine` },
  { who: "matter, a post to fix", from: `${TEAM}/workboard/my/shifts?week=2026-11-09&report=2026-11-10`, to: `${TEAM}/workboard/shifts/mine?week=2026-11-09&report=2026-11-10` },
  // The console's old «Команда» (apps/dashboard/src/lib/workboard.ts).
  { who: "console's old «Команда»", from: `${HUB}/team/shifts?period=30d`, to: `${TEAM}/workboard/shifts?days=30` },
  { who: "console's old «Команда»", from: `${HUB}/team/payouts#disputes`, to: `${TEAM}/workboard/waiting#reports` },
  { who: "console's old «Команда»", from: `${HUB}/held-sends`, to: `${TEAM}/workboard/waiting#held` },
  { who: "console's old «Команда»", from: `${HUB}/team/people/12`, to: `${HUB}/people/12/logins` },
  // «Фаны» and «Рассылки» moved from the console to Workboard (products package M, `movedToWorkboard`).
  { who: "owner's bookmark", from: `${HUB}/fans?page=mia-1&period=30d`, to: `${TEAM}/workboard/fans?page=mia-1&period=30d` },
  { who: "owner's bookmark, «Операции»", from: `${HUB}/fans/mia-1/fansly/7409?period=all`, to: `${TEAM}/workboard/fans/mia-1/fansly/7409?period=all` },
  { who: "owner's bookmark", from: `${HUB}/fans/by-spend/600-plus?page=mia-1#copy`, to: `${TEAM}/workboard/fans/by-spend/600-plus?page=mia-1#copy` },
  { who: "console's «Контент»", from: `${HUB}/content/mass-messages?page=mia-1`, to: `${TEAM}/workboard/sales/mass?page=mia-1` },
  // «Публикации» and «Статистика контента» are ContentOps' screens (package C2): the owner's bookmarks, the matters Hub
  // wrote before, the console's own links (Сбои, Настройки ИИ) and the older addresses the console leads there.
  { who: "owner's bookmark, matter", from: `${HUB}/content/publications?status=draft&window=all&page=all`, to: `${CONTENTOPS}/hub/publications?status=draft&window=all&page=all` },
  { who: "owner's bookmark", from: `${HUB}/content/publications?page=mia-1&status=draft&window=all&publication=55`, to: `${CONTENTOPS}/hub/publications?page=mia-1&status=draft&window=all&publication=55` },
  { who: "console's «Сбои»", from: `${HUB}/content/publications?page=mia-1&panel=settings`, to: `${CONTENTOPS}/hub/publications?page=mia-1&panel=settings` },
  { who: "owner's bookmark", from: `${HUB}/publications?page=mia-1`, to: `${CONTENTOPS}/hub/publications?page=mia-1` },
  { who: "owner's bookmark", from: `${HUB}/publication-settings`, to: `${CONTENTOPS}/hub/publications?panel=settings` },
  { who: "owner's bookmark", from: `${HUB}/stats/content?page=mia-1&period=30d&media=77`, to: `${CONTENTOPS}/hub/stats?page=mia-1&period=30d&media=77` },
  { who: "owner's bookmark", from: `${HUB}/stats?tab=content&days=7&page=mia-1`, to: `${CONTENTOPS}/hub/stats?page=mia-1&period=7d` },
  // Matters about a publication name ContentOps' address (matters-mirror.ts `publicationLink`).
  { who: "matter", from: `${CONTENTOPS}/hub/publications?page=mia-1&status=draft&window=all&publication=55`, to: `${CONTENTOPS}/hub/publications?page=mia-1&status=draft&window=all&publication=55` },
  // Links Hub's server wrote (matters: a path on whichever name shows it; people's messages: the team's name).
  { who: "matter before the rename", from: `${TEAM}/workboard/decisions?dispute=5#questions`, to: `${TEAM}/workboard/waiting?dispute=5#questions` },
  { who: "matter on Hub's Главная", from: `${HUB}/workboard/waiting#customs`, to: `${TEAM}/workboard/waiting#customs` },
  { who: "matter, sale's chain", from: `${TEAM}/workboard/shifts/report/77?sale=9`, to: `${TEAM}/workboard/report/77?sale=9` },
  { who: "matter", from: `${TEAM}/workboard/people/7/access`, to: `${HUB}/people/7/logins` },
  { who: "matter", from: `${TEAM}/workboard/people/alex`, to: `${TEAM}/workboard/team/alex` },
  { who: "matter", from: `${TEAM}/workboard/people`, to: `${TEAM}/workboard/team` },
  { who: "people's message", from: `${TEAM}/workboard/customs/K-14`, to: `${TEAM}/workboard/customs/K-14` },
  // Workboard's own older addresses.
  { who: "Workboard, old", from: `${TEAM}/workboard/my/reports?days=14`, to: `${TEAM}/workboard/shifts/mine?days=14` },
  { who: "Workboard, old", from: `${TEAM}/workboard/access?person=7`, to: `${HUB}/people/7/logins` },
  { who: "Workboard, old", from: `${TEAM}/workboard/sales`, to: `${TEAM}/workboard/sales/price` },
  { who: "Workboard, old", from: `${TEAM}/workboard/people/7/shifts`, to: `${TEAM}/workboard/team/7` },
  { who: "Workboard, old", from: `${TEAM}/workboard/people/7/sales?days=14`, to: `${TEAM}/workboard/team/7/sales?days=14` },
];
