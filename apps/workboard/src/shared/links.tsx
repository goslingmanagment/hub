import type { ReactNode } from "react";
import { Link, useLocation, type To } from "react-router";
import { Person, type PersonStatus } from "@agency_hub_core/ui";
import { pickPeriodParams } from "@agency_hub_core/ui/period";

/**
 * The app's addresses and the links between screens. Every drill-down carries
 * the period and the page filter of where it starts (spec §3: «week 19–25 Oct
 * → the profile of 19–25 Oct», never of this week).
 */

/** The period (`week`/`days`/`from`/`to`) and the page filter (`page`) of an address. */
export function carryParams(search: URLSearchParams | string): URLSearchParams {
  const source = typeof search === "string" ? new URLSearchParams(search) : search;
  const carried = pickPeriodParams(source);
  const page = source.get("page");
  if (page) carried.set("page", page);
  return carried;
}

function withSearch(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export type PersonTab = "work" | "shifts" | "sales" | "access";

/** `/people/:userId` (the «Работа» tab) or one of its tabs, with the period and page carried. */
export function personPath(userId: number, search: URLSearchParams | string = "", tab: PersonTab = "work"): string {
  return withSearch(`/people/${userId}${tab === "work" ? "" : `/${tab}`}`, carryParams(search));
}

/**
 * A shift in the address: its start in Moscow to the minute (`2026-11-07T09:12`)
 * when the start is a whole minute, the exact ISO instant otherwise. Both read back exactly.
 */
export function shiftKey(startedAt: string): string {
  const instant = new Date(startedAt);
  if (Number.isNaN(instant.getTime())) return encodeURIComponent(startedAt);
  if (instant.getUTCSeconds() === 0 && instant.getUTCMilliseconds() === 0) {
    // Moscow is UTC+3 all year (no summer time since 2014).
    return new Date(instant.getTime() + 3 * 3_600_000).toISOString().slice(0, 16);
  }
  return encodeURIComponent(instant.toISOString());
}

/** The instant a shift key names (ISO), or null when it names none. */
export function parseShiftKey(key: string | undefined): string | null {
  if (!key) return null;
  const decoded = decodeURIComponent(key);
  const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(decoded) ? new Date(`${decoded}:00+03:00`) : new Date(decoded);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

/** `/shifts/:userId/:shiftStart`, with the page filter carried. */
export function shiftPath(userId: number, startedAt: string, search: URLSearchParams | string = ""): string {
  const source = typeof search === "string" ? new URLSearchParams(search) : search;
  const params = new URLSearchParams();
  const page = source.get("page");
  if (page) params.set("page", page);
  return withSearch(`/shifts/${userId}/${shiftKey(startedAt)}`, params);
}

/** Where «←» of a deep screen goes: the screen it was opened from, with its filters. */
export interface BackTarget {
  to: string;
  label: string;
}

/** The state a drill-down leaves for its «←». */
export function useBackState(label: string): { back: BackTarget } {
  const location = useLocation();
  return { back: { to: `${location.pathname}${location.search}`, label } };
}

/** The «←» of a deep screen: where it was opened from, else the fallback. Only paths of this app. */
export function useBackTarget(fallback: BackTarget): BackTarget {
  const state = useLocation().state as { back?: Partial<BackTarget> } | null;
  const back = state?.back;
  if (back && typeof back.to === "string" && back.to.startsWith("/") && !back.to.startsWith("//") && typeof back.label === "string") {
    return { to: back.to, label: back.label };
  }
  return fallback;
}

/**
 * A person's name that opens their card (`/people/:userId`) for the same period
 * and page. Not inside a table row that already opens something: there use
 * <Person> and the row's own link.
 */
export function PersonLink({ userId, name, status, hint, tab = "work", backLabel, className }: {
  userId: number;
  name: string;
  status?: PersonStatus;
  hint?: ReactNode;
  tab?: PersonTab;
  /** Words of the card's «←» back here: «Смены», «Решения». */
  backLabel?: string;
  className?: string;
}) {
  const location = useLocation();
  const state = backLabel ? { back: { to: `${location.pathname}${location.search}`, label: backLabel } } : undefined;
  return (
    <Link to={personPath(userId, location.search, tab)} state={state} className={["ui-quiet-link", className].filter(Boolean).join(" ")}>
      <Person name={name} {...(status ? { status } : {})} {...(hint !== undefined ? { hint } : {})} />
    </Link>
  );
}

/**
 * A link to one shift's review (`/shifts/:userId/:shiftStart`). Its «←» returns
 * here, with this screen's filters (`backLabel`: «Смены», «alex.k»).
 */
export function ShiftLink({ userId, startedAt, backLabel, children, className, title }: {
  userId: number;
  startedAt: string;
  backLabel: string;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const location = useLocation();
  const to: To = shiftPath(userId, startedAt, location.search);
  return (
    <Link
      to={to}
      state={{ back: { to: `${location.pathname}${location.search}`, label: backLabel } satisfies BackTarget }}
      className={className ?? "ui-quiet-link"}
      title={title}
    >
      {children}
    </Link>
  );
}

/**
 * An address of the console on this host (another app: a full page load). A
 * page's card, a fan's card: `consoleHref("/pages/mia-1")`.
 */
export function consoleHref(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/** The console's card of a fan. */
export function consoleFanHref(pageLabel: string, platform: string, fanRef: string): string {
  return consoleHref(`/fans/${encodeURIComponent(pageLabel)}/${encodeURIComponent(platform)}/${encodeURIComponent(fanRef)}`);
}

/** The console's card of a page. */
export function consolePageHref(pageLabel: string): string {
  return consoleHref(`/pages/${encodeURIComponent(pageLabel)}`);
}
