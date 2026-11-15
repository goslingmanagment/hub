/**
 * Workboard (apps/workboard): the chat team's product, with Hub's sign-in, at
 * one address for every role, the team's name (`chatgoose.…/workboard/`). It
 * replaced the console's «Команда» (owner, 2026-11-10) and is a product of its
 * own (products plan §2.3): every old `/team/*` address lands on its Workboard
 * screen with what it carried — the person, the dates, the page, the tab
 * (8-docs/2026-11-07-workboard/old-new-map.md §5). Only «Анкеты»
 * (`/team/applications`) stay in Hub.
 *
 * Workboard is another app: the console's router cannot open it, a link to it
 * is a plain `<a href>` and an old address leaves with `location.replace` — on
 * the console's name through the hand-off to the team's (navigation.ts
 * `workboardHere`; Hub's server redirects such an address there too).
 */
import { addDays, isMoscowDay, moscowToday, type MoscowDay } from "@agency_hub_core/ui/moscow";
import { decodedPath } from "@agency_hub_core/ui/path";
import { hubPersonPath, type HubPersonTab } from "@agency_hub_core/ui/people/paths";
import { WORKBOARD_PATH } from "@agency_hub_core/ui/screens";
import { ALL_PAGES_PARAM } from "./pageParam.js";

/** Workboard's address on its name: its Vite `base` (apps/workboard/src/base.ts). */
export const WORKBOARD_HREF = WORKBOARD_PATH;

/** A Workboard address: `workboardHref("team/7", search)` → `/workboard/team/7?…`. */
export function workboardHref(path = "", search: URLSearchParams | string = "", hash = ""): string {
  const query = search.toString();
  const anchor = hash && !hash.startsWith("#") ? `#${hash}` : hash;
  return `${WORKBOARD_HREF}${path.replace(/^\/+/, "")}${query ? `?${query}` : ""}${anchor}`;
}

/** The address is Workboard's, not a console screen's: it needs a real navigation. */
export function isWorkboardHref(to: string): boolean {
  return to === WORKBOARD_HREF.slice(0, -1) || to.startsWith(WORKBOARD_HREF);
}

/**
 * One person by a login: their work in Workboard «Команда» for whoever has shifts (`works`), else their card in Hub
 * «Люди» on `tab` (the logins, by default).
 */
export function personHref(userId: number, works = true, tab: HubPersonTab = "logins"): string {
  return works ? workboardHref(`team/${userId}`) : hubPersonPath(userId, tab);
}

/**
 * The console's old «Команда → Люди» (`/team/people`, `/team/people/12`): the registry, Hub «Люди» now — the list, or
 * the login's person on «Входы и устройства». Null for any other address.
 */
export function teamPeopleInHub(url: string): string | null {
  const parsed = new URL(url, "https://hub.invalid");
  const pathname = decodedPath(parsed.pathname).replace(/\/+$/, "");
  if (pathname === "/team/people") return "/people";
  const user = /^\/team\/people\/(\d+)$/.exec(pathname)?.[1];
  return user === undefined ? null : hubPersonPath(user, "logins");
}

/**
 * The console's `?period=` as Workboard's period (map §5): it has 14 and 30
 * days by name, any other number of days back from today is a range of dates,
 * and no period is no parameter — Workboard then opens the one last used in the
 * tab, or this week.
 */
function periodOf(value: string | null, today: MoscowDay): Record<string, string> {
  const days = /^(\d+)d$/.exec(value ?? "")?.[1];
  if (days === "14" || days === "30") return { days };
  const count = Number(days);
  if (!Number.isInteger(count) || count < 1 || count > 366) return {};
  return { from: addDays(today, -(count - 1)), to: today };
}

/**
 * A shift in Workboard's address (apps/workboard/src/shared/links.tsx `shiftKey`):
 * its start in Moscow to the minute when the instant is a whole minute, the
 * exact ISO instant otherwise. Hub finds the shift an instant falls into, so a
 * moment inside the shift opens it too.
 */
function shiftKey(at: string): string | null {
  const instant = new Date(at);
  if (Number.isNaN(instant.getTime())) return null;
  if (instant.getUTCSeconds() === 0 && instant.getUTCMilliseconds() === 0) {
    // Moscow is UTC+3 all year.
    return new Date(instant.getTime() + 3 * 3_600_000).toISOString().slice(0, 16);
  }
  return encodeURIComponent(instant.toISOString());
}

/** The old review's «what to show» (`kind`, `show`) as Workboard's one `show`. */
function reviewShow(kind: string | null, show: string | null): string | null {
  if (show === "waited" || show === "unanswered") return show;
  if (show === "money") return "paid";
  // The separate kinds are gone: their chats are in «Все».
  if (kind === "all" || kind === "touch" || kind === "colleague" || kind === "waiting") return "all";
  return null;
}

function positiveId(value: string | null | undefined): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * «Фаны» and «Рассылки» (products package M) are Workboard's screens now: the console's `/fans…` lands on the same
 * path in Workboard, `/content/mass-messages` on «Что продаёт → Рассылки», with the query and the anchor.
 */
export function movedToWorkboard(url: string): string | null {
  const parsed = new URL(url, "https://hub.invalid");
  const pathname = decodedPath(parsed.pathname).replace(/\/+$/, "") || "/";
  const tail = `${parsed.search}${parsed.hash}`;
  if (pathname === "/fans" || pathname.startsWith("/fans/")) return `${WORKBOARD_HREF}${parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "")}${tail}`;
  if (pathname === "/content/mass-messages") return `${WORKBOARD_HREF}sales/mass${tail}`;
  return null;
}

/**
 * Where an old address of «Команда» lands in Workboard, or null when it is not
 * one (`/team/applications` stays in the console). An unknown or removed screen
 * of the section lands on the nearest Workboard screen.
 */
export function teamToWorkboard(url: string, today: MoscowDay = moscowToday()): string | null {
  const parsed = new URL(url, "https://hub.invalid");
  const pathname = decodedPath(parsed.pathname).replace(/\/+$/, "") || "/";
  const old = parsed.searchParams;
  const hash = parsed.hash;

  const moved = movedToWorkboard(url);
  if (moved !== null) return moved;
  if (pathname === "/held-sends") return teamToWorkboard(`/team/held-sends${parsed.search}${hash}`, today);
  if (pathname !== "/team" && !pathname.startsWith("/team/")) return null;
  const [, , screen = "", rest = ""] = pathname.split("/");
  if (screen === "applications") return null;

  const query = new URLSearchParams();
  const page = old.get("page");
  const carryPage = () => {
    if (page && page !== ALL_PAGES_PARAM) query.set("page", page);
  };
  const carryPeriod = (value: string | null) => {
    for (const [key, text] of Object.entries(periodOf(value, today))) query.set(key, text);
  };

  switch (screen) {
    case "":
    case "shifts": {
      // Its own period: a calendar week (`at`, any day of it) unless 14 or 30 days.
      const period = old.get("period");
      const at = old.get("at");
      if (period === "14d" || period === "30d") carryPeriod(period);
      else if (isMoscowDay(at)) query.set("week", at);
      carryPage();
      if (hash === "#authors") query.set("authors", "1");
      return workboardHref("shifts", query);
    }
    case "authors":
      // «Без автора» is a drawer of Смены, of the current period only.
      carryPage();
      query.set("authors", "1");
      return workboardHref("shifts", query);
    case "review": {
      const user = positiveId(old.get("user"));
      const key = user === null ? null : shiftKey(old.get("at") ?? "");
      if (user !== null && key !== null) {
        const chat = old.get("chat");
        if (chat) query.set("chat", chat);
        const pick = old.get("pick");
        if (pick && /^\d+-\d+$/.test(pick)) query.set("span", pick);
        carryPage();
        const show = reviewShow(old.get("kind"), old.get("show"));
        if (show) query.set("show", show);
        return workboardHref(`shifts/${user}/${key}`, query);
      }
      // The choice of a shift: one person's shifts are in their card, everyone's in the journal.
      const who = positiveId(old.get("who")) ?? user;
      return who === null ? workboardHref("shifts") : workboardHref(`team/${who}`);
    }
    case "coverage":
      carryPeriod(old.get("period"));
      carryPage();
      return workboardHref("sales/greetings", query);
    case "held-sends":
      carryPage();
      return workboardHref("waiting", query, "held");
    case "customs":
      carryPage();
      return workboardHref("waiting", query, "customs");
    case "chatters":
    case "numbers": {
      carryPeriod(old.get("period"));
      const user = screen === "chatters" ? positiveId(rest) : null;
      return workboardHref(user === null ? "team" : `team/${user}`, query);
    }
    case "chatter-stats": {
      const days = old.get("days");
      carryPeriod(days === null ? null : `${days}d`);
      const user = positiveId(old.get("user"));
      return workboardHref(user === null ? "team" : `team/${user}`, query);
    }
    case "payouts":
    case "shift-reports": {
      // Hub's sale disputes are gone with its marks: what waits about the reports is «Ждут вас», «Отчёты».
      if (hash === "#disputes") return workboardHref("waiting", "", "reports");
      for (const name of ["from", "to"]) {
        const value = old.get(name);
        if (value) query.set(name, value);
      }
      return workboardHref("payouts", query);
    }
    case "sales":
      carryPeriod(old.get("period"));
      carryPage();
      return workboardHref("sales/price", query);
    case "win-back":
    case "approaches": {
      // The console opened it on 30 days, whatever was remembered.
      const days = screen === "approaches" ? old.get("days") : null;
      carryPeriod(days !== null ? `${days}d` : old.get("period") ?? "30d");
      return workboardHref("sales/win-back", query);
    }
    case "people":
      // The registry is Hub's (`teamPeopleInHub`): App.tsx answers these before this table; Workboard's own «Команда» else.
      return workboardHref("team");
    default:
      return workboardHref("shifts");
  }
}
