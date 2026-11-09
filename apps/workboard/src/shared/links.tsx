import { ArrowLeft } from "lucide-react";
import { useCallback, useMemo, type ReactNode } from "react";
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

/**
 * The tabs of Человек (spec §4.4, D2): Работа · Продажи · Доступ. `shifts` is
 * the old Смены tab: its address redirects to Работа (app/routes.tsx).
 */
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

/**
 * `/shifts/:userId/:shiftStart`, with the period and the page filter carried
 * (D3): the review reads only the page, but the menu and «←» of the review take
 * the period from its address.
 */
export function shiftPath(userId: number, startedAt: string, search: URLSearchParams | string = ""): string {
  return withSearch(`/shifts/${userId}/${shiftKey(startedAt)}`, carryParams(search));
}

/** Where «←» of a deep screen goes: the screen it was opened from, with its filters. */
export interface BackTarget {
  to: string;
  label: string;
  /**
   * That screen's own router state (its own «←», D16): «← alex.k» from a review
   * opened in the card returns to a card whose «←» still says «Смены».
   */
  state?: unknown;
}

/** How deep «←» remembers the screens before: a chain longer than this forgets the oldest. */
const BACK_DEPTH = 4;

/** A screen's router state as the next screen keeps it for «←»: without the one-time scroll request, at most BACK_DEPTH deep. */
function keptState(state: unknown, depth = BACK_DEPTH): unknown {
  if (state === null || typeof state !== "object") return undefined;
  const { restoreScroll: _once, back, ...rest } = state as { restoreScroll?: unknown; back?: unknown };
  const kept: Record<string, unknown> = { ...rest };
  if (depth > 1 && back !== null && typeof back === "object") {
    const target = back as Partial<BackTarget>;
    if (typeof target.to === "string" && typeof target.label === "string") {
      const inner = keptState(target.state, depth - 1);
      kept.back = { to: target.to, label: target.label, ...(inner === undefined ? {} : { state: inner }) };
    }
  }
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/** The back target of the screen showing now, under `label` («Смены», «alex.k»). */
function backHere(location: { pathname: string; search: string; state: unknown }, label: string): BackTarget {
  const state = keptState(location.state);
  return { to: `${location.pathname}${location.search}`, label, ...(state === undefined ? {} : { state }) };
}

/**
 * The state a drill-down leaves for its «←»: this screen, with its filters and
 * its own «←», under `label` («Смены», «alex.k»). The place on the page comes
 * back by itself (the shell remembers the scroll of every address, D16).
 */
export function useBackState(label: string): { back: BackTarget } {
  const location = useLocation();
  return useMemo(() => ({ back: backHere(location, label) }), [location, label]);
}

/**
 * The same for every row of a table: `<Table rowHref={…} rowState={useRowBackState("Смены")} />`.
 * A plain click on the row then opens the deep screen with «← Смены» back here,
 * this very week and page; ⌘-click and the middle button open a new tab as usual.
 */
export function useRowBackState(label: string): () => { back: BackTarget } {
  const state = useBackState(label);
  return useCallback(() => state, [state]);
}

/** The «←» of a deep screen: where it was opened from, else the fallback. Only paths of this app. */
export function useBackTarget(fallback: BackTarget): BackTarget {
  const state = useLocation().state as { back?: Partial<BackTarget> } | null;
  const back = state?.back;
  if (back && typeof back.to === "string" && back.to.startsWith("/") && !back.to.startsWith("//") && typeof back.label === "string") {
    return { to: back.to, label: back.label, ...(back.state === undefined ? {} : { state: back.state }) };
  }
  return fallback;
}

/**
 * «←» of a deep screen (ScreenHeader puts it): back to the screen it came from,
 * with its filters, its own «←» and the place it was scrolled to (D16) — the
 * shell scrolls there as soon as the screen is tall enough.
 */
export function BackLink({ back, className = "wb-back" }: { back: BackTarget; className?: string }) {
  const state = back.state !== null && typeof back.state === "object" ? back.state : {};
  return (
    <Link to={back.to} state={{ ...state, restoreScroll: true }} className={className} aria-label={`Назад: ${back.label}`}>
      <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
      <span>{back.label}</span>
    </Link>
  );
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
  const state = backLabel ? { back: backHere(location, backLabel) } : undefined;
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
      state={{ back: backHere(location, backLabel) }}
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
