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
  // The first chatter screen, «Мои отчёты»: a shift and its report are one row of «Мои смены»; `?days=` is the app's period.
  if (path === "/my/reports") return { pathname: "/my/shifts", search: at.search, hash: "" };
  // «Что продаёт» opens its first tab.
  if (path === "/sales") return { pathname: "/sales/price", search: at.search, hash: "" };
  // A person's old «Смены» tab is Работа (the shift table lives there).
  const personShifts = /^\/people\/([^/]+)\/shifts$/.exec(path);
  if (personShifts) return { ...at, pathname: `/people/${personShifts[1]}` };
  // «Доступ» is inside «Люди»: `?person=<login>` is that login's person on «Доступ и входы».
  if (path === "/access") {
    const search = new URLSearchParams(at.search);
    const person = search.get("person");
    search.delete("person");
    const query = search.toString();
    return { pathname: person && /^\d+$/.test(person) ? `/people/${person}/access` : "/people", search: query ? `?${query}` : "", hash: "" };
  }
  return null;
}

/** Workboard's router paths of its old addresses (routes.tsx registers `OldAddress` on each). */
export const WORKBOARD_OLD_PATHS: readonly string[] = [
  "decisions", "my/shifts/:shiftId", "shifts/report/:shiftId", "my/reports", "sales", "people/:ref/shifts", "access",
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

/** Every address opened today that must keep working, and where it lands now. */
export const OLD_ADDRESSES: readonly OldAddressRow[] = [
  // The released extension 3.29.1: «Мои смены» by its one-time link, Workboard's plain address, the shift to hand in.
  { who: "extension 3.29.1", from: `${TEAM}/workboard/my/shifts`, to: `${TEAM}/workboard/my/shifts` },
  { who: "extension 3.29.1", from: `${TEAM}/workboard/`, to: `${TEAM}/workboard/` },
  { who: "extension 3.29.1, matter", from: `${TEAM}/workboard/my/shifts/812`, to: `${TEAM}/workboard/report/812` },
  { who: "extension, matter", from: `${TEAM}/workboard/report/812`, to: `${TEAM}/workboard/report/812` },
  // The agents' skills.
  { who: "agents' skills", from: `${TEAM}/workboard/customs`, to: `${TEAM}/workboard/customs` },
  { who: "agents' skills", from: `${HUB}/workboard/customs`, to: `${TEAM}/workboard/customs` },
  { who: "agents' skills", from: `${HUB}/team/applications/2`, to: `${HUB}/team/applications/2` },
  // The owner's bookmarks on the console's name: the same screen on the team's name, signed in.
  { who: "owner's bookmark", from: `${HUB}/workboard/shifts?days=30`, to: `${TEAM}/workboard/shifts?days=30` },
  { who: "owner's bookmark", from: `${HUB}/workboard/people`, to: `${TEAM}/workboard/people` },
  { who: "owner's bookmark", from: `${HUB}/workboard/payouts?view=reports`, to: `${TEAM}/workboard/payouts?view=reports` },
  // «Решения» on the console's name is the owner's whole «Ждут вас» in Hub (a window's parameter: Workboard's).
  { who: "owner's bookmark", from: `${HUB}/workboard/decisions`, to: `${HUB}/waiting` },
  { who: "owner's bookmark", from: `${HUB}/workboard/decisions#held`, to: `${HUB}/waiting#held` },
  { who: "owner's bookmark", from: `${HUB}/workboard/decisions?send=a1#held`, to: `${TEAM}/workboard/waiting?send=a1#held` },
  { who: "owner's bookmark", from: `${HUB}/workboard/my/shifts`, to: `${TEAM}/workboard/my/shifts` },
  // The console's old «Команда» (apps/dashboard/src/lib/workboard.ts).
  { who: "console's old «Команда»", from: `${HUB}/team/shifts?period=30d`, to: `${TEAM}/workboard/shifts?days=30` },
  { who: "console's old «Команда»", from: `${HUB}/team/payouts#disputes`, to: `${TEAM}/workboard/waiting#reports` },
  { who: "console's old «Команда»", from: `${HUB}/held-sends`, to: `${TEAM}/workboard/waiting#held` },
  { who: "console's old «Команда»", from: `${HUB}/team/people/12`, to: `${TEAM}/workboard/people/12/access` },
  // «Фаны» and «Рассылки» moved from the console to Workboard (products package M, `movedToWorkboard`).
  { who: "owner's bookmark", from: `${HUB}/fans?page=mia-1&period=30d`, to: `${TEAM}/workboard/fans?page=mia-1&period=30d` },
  { who: "owner's bookmark, «Операции»", from: `${HUB}/fans/mia-1/fansly/7409?period=all`, to: `${TEAM}/workboard/fans/mia-1/fansly/7409?period=all` },
  { who: "owner's bookmark", from: `${HUB}/fans/by-spend/600-plus?page=mia-1#copy`, to: `${TEAM}/workboard/fans/by-spend/600-plus?page=mia-1#copy` },
  { who: "console's «Контент»", from: `${HUB}/content/mass-messages?page=mia-1`, to: `${TEAM}/workboard/sales/mass?page=mia-1` },
  // Links Hub's server wrote (matters: a path on whichever name shows it; people's messages: the team's name).
  { who: "matter before the rename", from: `${TEAM}/workboard/decisions?dispute=5#questions`, to: `${TEAM}/workboard/waiting?dispute=5#questions` },
  { who: "matter on Hub's Главная", from: `${HUB}/workboard/waiting#customs`, to: `${TEAM}/workboard/waiting#customs` },
  { who: "matter, sale's chain", from: `${TEAM}/workboard/shifts/report/77?sale=9`, to: `${TEAM}/workboard/report/77?sale=9` },
  { who: "matter", from: `${TEAM}/workboard/people/7/access`, to: `${TEAM}/workboard/people/7/access` },
  { who: "people's message", from: `${TEAM}/workboard/customs/K-14`, to: `${TEAM}/workboard/customs/K-14` },
  // Workboard's own older addresses.
  { who: "Workboard, old", from: `${TEAM}/workboard/my/reports?days=14`, to: `${TEAM}/workboard/my/shifts?days=14` },
  { who: "Workboard, old", from: `${TEAM}/workboard/access?person=7`, to: `${TEAM}/workboard/people/7/access` },
  { who: "Workboard, old", from: `${TEAM}/workboard/sales`, to: `${TEAM}/workboard/sales/price` },
  { who: "Workboard, old", from: `${TEAM}/workboard/people/7/shifts`, to: `${TEAM}/workboard/people/7` },
];
