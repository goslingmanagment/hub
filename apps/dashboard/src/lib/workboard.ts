/**
 * Workboard (apps/workboard): the team's control, served by Hub on this host at
 * /workboard/ with the same sign-in. It replaced the console's «Команда»
 * (owner, 2026-11-10): the menu item leads there, and every old `/team/*`
 * address lands on its Workboard screen with what it carried — the person, the
 * dates, the page, the tab (8-docs/2026-11-07-workboard/old-new-map.md §5).
 * Only «Анкеты» (`/team/applications`) stay in the console.
 *
 * Workboard is another app: the console's router cannot open it, a link to it
 * is a plain `<a href>` and an old address leaves with `location.replace`.
 */
import { addDays, isMoscowDay, moscowToday, type MoscowDay } from "@agency_hub_core/ui/moscow";
import { ALL_PAGES_PARAM } from "./pageParam.js";
import { decodedPath } from "./path.js";

/** Workboard's address on this host: its Vite `base` (apps/workboard/src/base.ts). */
export const WORKBOARD_HREF = "/workboard/";

/** A Workboard address: `workboardHref("people/7", search)` → `/workboard/people/7?…`. */
export function workboardHref(path = "", search: URLSearchParams | string = "", hash = ""): string {
  const query = search.toString();
  const anchor = hash && !hash.startsWith("#") ? `#${hash}` : hash;
  return `${WORKBOARD_HREF}${path.replace(/^\/+/, "")}${query ? `?${query}` : ""}${anchor}`;
}

/** The address is Workboard's, not a console screen's: it needs a real navigation. */
export function isWorkboardHref(to: string): boolean {
  return to === WORKBOARD_HREF.slice(0, -1) || to.startsWith(WORKBOARD_HREF);
}

/** One person's card: Работа for whoever has shifts, Доступ for anyone else. */
export function workboardPersonHref(userId: number, works = true): string {
  return workboardHref(`people/${userId}${works ? "" : "/access"}`);
}

/** Workboard's screens, for the console's search: the old words find them too. */
export const WORKBOARD_SCREENS: ReadonlyArray<{ path: string; label: string; keywords: string; ownerOnly?: boolean }> = [
  { path: "shifts", label: "Смены", keywords: "команда заработок кто работал на смене неделя журнал разбор смены без автора" },
  { path: "people", label: "Люди", keywords: "чаттеры сотрудники кабинет чаттера числа" },
  { path: "sales/price", label: "Что продаёт", keywords: "продажи цена скорость ответа ppv платные возврат фанов подходы приветствия кто ждал пустые часы рассылки" },
  { path: "decisions", label: "Решения", keywords: "споры по продажам кастомы проверить отправки зависшие" },
  { path: "payouts", label: "Выплаты", keywords: "отчёты смен выгрузка таблица выплат кто не подтвердил" },
  { path: "access", label: "Доступ", keywords: "сотрудники приглашение пользователи устройства логины страницы", ownerOnly: true },
];

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
 * Where an old address of «Команда» lands in Workboard, or null when it is not
 * one (`/team/applications` stays in the console). An unknown or removed screen
 * of the section lands on the nearest Workboard screen.
 */
export function teamToWorkboard(url: string, today: MoscowDay = moscowToday()): string | null {
  const parsed = new URL(url, "https://hub.invalid");
  const pathname = decodedPath(parsed.pathname).replace(/\/+$/, "") || "/";
  const old = parsed.searchParams;
  const hash = parsed.hash;

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
      return who === null ? workboardHref("shifts") : workboardHref(`people/${who}`);
    }
    case "coverage":
      carryPeriod(old.get("period"));
      carryPage();
      return workboardHref("sales/greetings", query);
    case "held-sends":
      carryPage();
      return workboardHref("decisions", query, "held");
    case "customs":
      carryPage();
      return workboardHref("decisions", query, "customs");
    case "chatters":
    case "numbers": {
      carryPeriod(old.get("period"));
      const user = screen === "chatters" ? positiveId(rest) : null;
      return workboardHref(user === null ? "people" : `people/${user}`, query);
    }
    case "chatter-stats": {
      const days = old.get("days");
      carryPeriod(days === null ? null : `${days}d`);
      const user = positiveId(old.get("user"));
      return workboardHref(user === null ? "people" : `people/${user}`, query);
    }
    case "payouts":
    case "shift-reports": {
      if (hash === "#disputes") return workboardHref("decisions", "", "disputes");
      for (const name of ["from", "to", "chatter"]) {
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
    case "people": {
      const user = positiveId(rest);
      return user === null ? workboardHref("access") : workboardPersonHref(user, false);
    }
    default:
      return workboardHref("shifts");
  }
}
